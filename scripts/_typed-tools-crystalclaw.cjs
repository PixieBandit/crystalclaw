/**
 * Patch: Inject Anthropic server-side web search/fetch tools into API payload
 *
 * Inserts a createTypedToolsWrapper after createOpenAIResponsesContextManagementWrapper
 * in applyExtraParamsToAgent(). Handles web_search_20260209 and web_fetch_20260209.
 *
 * Note: As of CrystalClaw rebuild (2026-03-17), upstream now natively handles:
 *   - tool_search_tool_regex (createAnthropicDeferredLoadingWrapper)
 *   - programmatic calling (createAnthropicProgrammaticCallingWrapper)
 * So this patch now ONLY injects web_search_20260209 and web_fetch_20260209.
 *
 * Config: Q:\Apps\Moltbot\config\typed-tools.json
 * Only activates for Anthropic provider + claude-*-4* models.
 */

const fs = require('fs');
const path = require('path');

const distDir = 'Q:/Projects/crystalclaw/dist';

if (!fs.existsSync(distDir)) {
  console.error('Could not find OpenClaw dist directory');
  process.exit(2);
}

const PATCH_MARKER = '// PATCHED: typed-tools-web-search-v2';

const allJsFiles = fs.readdirSync(distDir).filter(f =>
  f.endsWith('.js') && !f.includes('helpers')
);

const pluginSdkDir = path.join(distDir, 'plugin-sdk');
if (fs.existsSync(pluginSdkDir)) {
  fs.readdirSync(pluginSdkDir).filter(f => f.endsWith('.js'))
    .forEach(f => allJsFiles.push(path.join('plugin-sdk', f)));
}

let patched = 0;
let already = 0;

for (const fname of allJsFiles) {
  const filePath = path.join(distDir, fname);
  let content = fs.readFileSync(filePath, 'utf8');

  if (!content.includes('function applyExtraParamsToAgent(')) continue;
  if (!content.includes('createOpenAIResponsesContextManagementWrapper')) continue;

  if (content.includes(PATCH_MARKER)) {
    already++;
    continue;
  }

  // Injection point: right after createOpenAIResponsesContextManagementWrapper line
  // The line ends with either:
  //   createOpenAIResponsesContextManagementWrapper(agent.streamFn, merged);
  // (with various indentation)
  const INJECT_AFTER = 'agent.streamFn = createOpenAIResponsesContextManagementWrapper(agent.streamFn, merged);';

  if (!content.includes(INJECT_AFTER)) {
    console.error(`Injection anchor not found in ${fname}`);
    continue;
  }

  // ============================================================
  // WRAPPER FUNCTION
  // ============================================================
  const wrapperFn = `
${PATCH_MARKER}
var _ttConfigPath = "Q:\\\\Apps\\\\Moltbot\\\\config\\\\typed-tools.json";
var _ttLogPath = "Q:\\\\Apps\\\\Moltbot\\\\logs\\\\typed-tools.log";
var _ttLoggedModels = {};
function _ttLog(msg, onceKey) {
\ttry {
\t\tif (onceKey) {
\t\t\tif (_ttLoggedModels[onceKey]) return;
\t\t\t_ttLoggedModels[onceKey] = true;
\t\t}
\t\tvar line = new Date().toISOString() + " " + msg + "\\n";
\t\tfs.appendFileSync(_ttLogPath, line);
\t} catch(e) {}
}
function _ttLoadConfig() {
\ttry {
\t\tif (!fs.existsSync(_ttConfigPath)) return null;
\t\treturn JSON.parse(fs.readFileSync(_ttConfigPath, "utf8"));
\t} catch(e) {
\t\t_ttLog("[TypedTools] Config load error: " + e.message);
\t\treturn null;
\t}
}
function createTypedToolsWrapper(baseStreamFn, provider, modelId) {
\treturn function(model, context, options) {
\t\t// Only Anthropic + claude-*-4* models
\t\tif (provider !== "anthropic" || !modelId || !/4[-.]\\d/.test(modelId)) {
\t\t\treturn baseStreamFn(model, context, options);
\t\t}
\t\tvar cfg = _ttLoadConfig();
\t\tif (!cfg || cfg.enabled === false) {
\t\t\treturn baseStreamFn(model, context, options);
\t\t}
\t\tvar wsEnabled = cfg.webSearch && cfg.webSearch.enabled;
\t\tvar wfEnabled = cfg.webFetch && cfg.webFetch.enabled;
\t\tif (!wsEnabled && !wfEnabled) {
\t\t\treturn baseStreamFn(model, context, options);
\t\t}
\t\tvar origOnPayload = options && options.onPayload;
\t\tvar newOptions = Object.assign({}, options, {
\t\t\tonPayload: function(payload) {
\t\t\t\tif (!payload || typeof payload !== "object") {
\t\t\t\t\tif (origOnPayload) origOnPayload(payload);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\t// Double-check payload model (may differ due to fallback)
\t\t\t\tvar pm = payload.model || "";
\t\t\t\tvar isSupported = /claude.*(sonnet|opus)-4/i.test(pm);
\t\t\t\tif (!isSupported) {
\t\t\t\t\tif (origOnPayload) origOnPayload(payload);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tvar tools = payload.tools || [];
\t\t\t\t// --- Web Search ---
\t\t\t\tif (wsEnabled) {
\t\t\t\t\t// Remove Brave web_search if present
\t\t\t\t\ttools = tools.filter(function(t) {
\t\t\t\t\t\treturn !(t.name === "web_search" && (!t.type || t.type === "custom"));
\t\t\t\t\t});
\t\t\t\t\t// Add Anthropic server-side web search if not already present
\t\t\t\t\tvar hasWS = tools.some(function(t) { return t.type === "web_search_20260209"; });
\t\t\t\t\tif (!hasWS) {
\t\t\t\t\t\tvar wsTool = { type: "web_search_20260209", name: "web_search" };
\t\t\t\t\t\tvar wsCfg = cfg.webSearch;
\t\t\t\t\t\tif (wsCfg.maxUses) wsTool.max_uses = wsCfg.maxUses;
\t\t\t\t\t\tif (wsCfg.allowedDomains && wsCfg.allowedDomains.length) wsTool.allowed_domains = wsCfg.allowedDomains;
\t\t\t\t\t\tif (wsCfg.blockedDomains && wsCfg.blockedDomains.length) wsTool.blocked_domains = wsCfg.blockedDomains;
\t\t\t\t\t\tif (wsCfg.userLocation) wsTool.user_location = wsCfg.userLocation;
\t\t\t\t\t\ttools.push(wsTool);
\t\t\t\t\t\t_ttLog("[TypedTools] Injected web_search_20260209 for " + pm, "ws_" + pm);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\t// --- Web Fetch ---
\t\t\t\tif (wfEnabled) {
\t\t\t\t\t// Remove Brave web_fetch if present
\t\t\t\t\ttools = tools.filter(function(t) {
\t\t\t\t\t\treturn !(t.name === "web_fetch" && (!t.type || t.type === "custom"));
\t\t\t\t\t});
\t\t\t\t\tvar hasWF = tools.some(function(t) { return t.type === "web_fetch_20260209"; });
\t\t\t\t\tif (!hasWF) {
\t\t\t\t\t\tvar wfTool = { type: "web_fetch_20260209", name: "web_fetch" };
\t\t\t\t\t\tvar wfCfg = cfg.webFetch;
\t\t\t\t\t\tif (wfCfg.maxUses) wfTool.max_uses = wfCfg.maxUses;
\t\t\t\t\t\tif (wfCfg.allowedDomains && wfCfg.allowedDomains.length) wfTool.allowed_domains = wfCfg.allowedDomains;
\t\t\t\t\t\tif (wfCfg.blockedDomains && wfCfg.blockedDomains.length) wfTool.blocked_domains = wfCfg.blockedDomains;
\t\t\t\t\t\ttools.push(wfTool);
\t\t\t\t\t\t_ttLog("[TypedTools] Injected web_fetch_20260209 for " + pm, "wf_" + pm);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tpayload.tools = tools;
\t\t\t\tif (origOnPayload) origOnPayload(payload);
\t\t\t}
\t\t});
\t\t// No beta header needed — web search is GA
\t\treturn baseStreamFn(model, context, newOptions);
\t};
}
`;

  // Find function signatures (multiple variants)
  const funcSigs = [
    'function applyExtraParamsToAgent(agent, cfg, provider, modelId, extraParamsOverride, thinkingLevel, agentId, sessionKey) {',
    'function applyExtraParamsToAgent(agent, cfg, provider, modelId, extraParamsOverride, thinkingLevel, agentId) {',
    'function applyExtraParamsToAgent(agent, cfg, provider, modelId, extraParamsOverride) {',
  ];
  const funcSig = funcSigs.find(s => content.includes(s));
  if (!funcSig) {
    console.error(`applyExtraParamsToAgent signature not found in ${fname}`);
    continue;
  }

  // Inject wrapper function before applyExtraParamsToAgent
  content = content.replace(funcSig, wrapperFn + '\n' + funcSig);

  // Inject wrapper call right after the ContextManagementWrapper line
  content = content.replace(
    INJECT_AFTER,
    INJECT_AFTER + '\n\tagent.streamFn = createTypedToolsWrapper(agent.streamFn, provider, modelId);'
  );

  fs.writeFileSync(filePath, content);
  patched++;
  console.log(`Patched: ${fname}`);
}

if (patched === 0 && already > 0) {
  console.log(`Already patched (${already} file(s))`);
  process.exit(1);
}
if (patched === 0) {
  console.error('No files patched');
  process.exit(2);
}
console.log(`Typed tools web search patch applied to ${patched} file(s)`);
process.exit(0);
