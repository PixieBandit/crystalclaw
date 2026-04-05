/**
 * Anthropic Agent SDK Harness Runner.
 *
 * Replaces pi-ai's direct Anthropic API calls with the Claude Agent SDK.
 * Claude Code (spawned by the Agent SDK) makes first-party API requests,
 * avoiding Anthropic's third-party billing restrictions.
 *
 * This runner implements the same interface as runEmbeddedPiAgent() so it
 * can be swapped in at the dispatch point in attempt-execution.ts.
 */

import os from "node:os";
import { query, type Options as AgentSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { buildEmbeddedSystemPrompt } from "../pi-embedded-runner/system-prompt.js";
import { resolveAgentIdentity } from "../identity.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { createOpenClawMcpBridge, type BridgeableTool } from "./mcp-tool-bridge.js";
import { processAgentSdkStream, type ReplyCallbacks } from "./event-adapter.js";
import type { EmbeddedPiRunResult, EmbeddedPiRunMeta } from "../pi-embedded-runner/types.js";

const log = createSubsystemLogger("anthropic-harness");

/**
 * Parameters for the Anthropic harness runner.
 * A subset of RunEmbeddedPiAgentParams — only what we need.
 */
export type AnthropicHarnessParams = {
  // Core
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId: string;
  prompt: string;
  workspaceDir: string;

  // Model
  model?: string;
  provider?: string;

  // Timeouts
  timeoutMs: number;
  abortSignal?: AbortSignal;

  // OpenClaw config for building system prompt
  config?: OpenClawConfig;

  // System prompt (pre-built by OpenClaw, overrides auto-build)
  systemPrompt?: string;

  // Extra system prompt to append
  extraSystemPrompt?: string;

  // Channel context
  messageChannel?: string;
  senderIsOwner?: boolean;

  // Skills
  skillsPrompt?: string;

  // OpenClaw tools to bridge via MCP
  tools?: BridgeableTool[];

  // Reply callbacks (same as pi-embedded-runner)
  onPartialReply?: ReplyCallbacks["onPartialReply"];
  onBlockReply?: ReplyCallbacks["onBlockReply"];
  onBlockReplyFlush?: ReplyCallbacks["onBlockReplyFlush"];
  onReasoningStream?: ReplyCallbacks["onReasoningStream"];
  onReasoningEnd?: ReplyCallbacks["onReasoningEnd"];
  onToolResult?: ReplyCallbacks["onToolResult"];
  onAgentEvent?: ReplyCallbacks["onAgentEvent"];
  onAssistantMessageStart?: ReplyCallbacks["onAssistantMessageStart"];

  // Agent SDK resume
  resumeSessionId?: string;

  // Extra Agent SDK options
  agentSdkOptions?: Partial<AgentSdkOptions>;
};

/**
 * Map CrystalClaw's model IDs to what the Agent SDK/Claude Code expects.
 */
function resolveAgentSdkModel(model?: string): string | undefined {
  if (!model) return undefined;
  // Strip provider prefix if present (e.g., "anthropic/claude-opus-4-6" → "claude-opus-4-6")
  const parts = model.split("/");
  return parts.length > 1 ? parts[parts.length - 1] : model;
}

/**
 * Build the OpenClaw system prompt with full identity, personality, memory hints,
 * channel context, tools, etc. Falls back to a simplified version if the full
 * builder isn't available.
 */
function buildOpenClawSystemPrompt(params: AnthropicHarnessParams): string {
  if (params.systemPrompt) {
    return params.systemPrompt;
  }

  const cfg = params.config ?? loadConfig();
  const agentId = params.agentId ?? "main";
  const model = resolveAgentSdkModel(params.model) ?? "claude-sonnet-4-6";

  try {
    const systemPrompt = buildEmbeddedSystemPrompt({
      workspaceDir: params.workspaceDir,
      extraSystemPrompt: params.extraSystemPrompt,
      reasoningTagHint: false,
      promptMode: "full",
      acpEnabled: false,
      runtimeInfo: {
        agentId,
        host: os.hostname(),
        os: `${os.platform()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
        model,
        provider: params.provider ?? "anthropic",
        channel: params.messageChannel,
      },
      tools: [],
      modelAliasLines: buildModelAliasLines(cfg),
      userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      skillsPrompt: params.skillsPrompt,
    });

    log.debug("built OpenClaw system prompt", {
      length: systemPrompt.length,
      agentId,
    });

    return systemPrompt;
  } catch (err) {
    log.warn("failed to build full system prompt, using minimal", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Minimal fallback — at least include identity name
    const identity = resolveAgentIdentity(cfg, agentId);
    return identity?.name
      ? `You are ${identity.name}.`
      : "You are a helpful AI assistant.";
  }
}

/**
 * Build the prompt string that gets sent to the Agent SDK.
 *
 * Prepends the OpenClaw system prompt (with identity, personality, memory,
 * channel context, etc.) as system context so Claude Code sees the full
 * personality bootstrap.
 */
function buildEffectivePrompt(params: AnthropicHarnessParams): string {
  const systemPrompt = buildOpenClawSystemPrompt(params);
  return (
    `<system-context>\n${systemPrompt}\n</system-context>\n\n` +
    params.prompt
  );
}

/**
 * Run a single agent turn using the Claude Agent SDK.
 *
 * This spawns Claude Code as a subprocess, which makes first-party API calls.
 * OpenClaw-specific tools are exposed via an in-process MCP server.
 *
 * @returns Result compatible with EmbeddedPiRunResult
 */
export async function runAnthropicHarness(
  params: AnthropicHarnessParams,
): Promise<EmbeddedPiRunResult> {
  const startedAt = Date.now();

  log.info("starting Anthropic harness run", {
    runId: params.runId,
    model: params.model,
    sessionKey: params.sessionKey,
    hasTools: (params.tools?.length ?? 0) > 0,
  });

  // Emit lifecycle start
  params.onAgentEvent?.({
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt,
      runId: params.runId,
      harness: "anthropic-agent-sdk",
    },
  });

  try {
    // Build MCP bridge for OpenClaw tools
    const mcpBridge = params.tools?.length
      ? createOpenClawMcpBridge(params.tools)
      : undefined;

    // Resolve model for Agent SDK
    const sdkModel = resolveAgentSdkModel(params.model);

    // Build Agent SDK options
    const sdkOptions: AgentSdkOptions = {
      model: sdkModel,
      cwd: params.workspaceDir,
      includePartialMessages: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      // Let Claude Code use all its native tools + our MCP tools
      tools: { type: "preset", preset: "claude_code" },
      // Allow all native tools without prompting
      allowedTools: [
        "Read", "Write", "Edit", "Bash", "Glob", "Grep",
        "WebSearch", "WebFetch", "Agent",
        // MCP tools are auto-allowed by permission mode
      ],
      // Connect our MCP bridge
      ...(mcpBridge
        ? {
            mcpServers: {
              crystalclaw: mcpBridge,
            },
          }
        : {}),
      // Resume from previous session if available
      ...(params.resumeSessionId
        ? { resume: params.resumeSessionId }
        : {}),
      // Session ID
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      // Thinking mode — adaptive for latest models
      thinking: { type: "adaptive" },
      // Env vars — identify as CrystalClaw
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "crystalclaw/1.0.0",
      },
      // Merge any extra options from config
      ...params.agentSdkOptions,
    };

    // Set up abort handling
    if (params.abortSignal) {
      sdkOptions.abortController = new AbortController();
      params.abortSignal.addEventListener("abort", () => {
        sdkOptions.abortController?.abort();
      });
    }

    // Build the prompt
    const effectivePrompt = buildEffectivePrompt(params);

    log.debug("launching Agent SDK query", {
      model: sdkModel,
      promptLength: effectivePrompt.length,
      mcpBridge: mcpBridge ? "crystalclaw" : "none",
    });

    // Launch the Agent SDK query
    const queryStream = query({
      prompt: effectivePrompt,
      options: sdkOptions,
    });

    // Process the stream through our event adapter
    const adapterResult = await processAgentSdkStream(
      queryStream as AsyncGenerator<Record<string, unknown>, void>,
      {
        onPartialReply: params.onPartialReply,
        onBlockReply: params.onBlockReply,
        onBlockReplyFlush: params.onBlockReplyFlush,
        onReasoningStream: params.onReasoningStream,
        onReasoningEnd: params.onReasoningEnd,
        onToolResult: params.onToolResult,
        onAgentEvent: params.onAgentEvent,
        onAssistantMessageStart: params.onAssistantMessageStart,
      },
    );

    const durationMs = Date.now() - startedAt;

    log.info("Anthropic harness run completed", {
      runId: params.runId,
      durationMs,
      numTurns: adapterResult.numTurns,
      stopReason: adapterResult.stopReason,
      isError: adapterResult.isError,
      usage: adapterResult.usage,
    });

    // Build the result in OpenClaw's expected format
    const meta: EmbeddedPiRunMeta = {
      durationMs,
      agentMeta: {
        sessionId: adapterResult.sessionId ?? params.sessionId ?? "unknown",
        provider: "anthropic",
        model: sdkModel ?? "unknown",
        usage: {
          input: adapterResult.usage.input,
          output: adapterResult.usage.output,
          cacheRead: adapterResult.usage.cacheRead,
          cacheWrite: adapterResult.usage.cacheWrite,
          total: adapterResult.usage.total,
        },
      },
      aborted: params.abortSignal?.aborted === true,
      stopReason: adapterResult.stopReason ?? undefined,
    };

    if (adapterResult.isError) {
      meta.error = {
        kind: "retry_limit" as const,
        message: adapterResult.errorMessage ?? "Agent SDK error",
      };
    }

    const payloads = adapterResult.resultText
      ? [{ text: adapterResult.resultText, isError: adapterResult.isError }]
      : [];

    return {
      payloads,
      meta,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    log.error("Anthropic harness run failed", {
      runId: params.runId,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    });

    // Emit lifecycle error
    params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "error",
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      },
    });

    return {
      payloads: [
        {
          text: `Anthropic harness error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      ],
      meta: {
        durationMs,
        error: {
          kind: "retry_limit",
          message: err instanceof Error ? err.message : String(err),
        },
        aborted: params.abortSignal?.aborted === true,
      },
    };
  }
}

/**
 * Check whether the Anthropic Agent SDK harness should be used for a request.
 */
export function shouldUseAnthropicHarness(params: {
  provider?: string;
  agentSdkTransport?: "auto" | "enabled" | "disabled";
}): boolean {
  if (params.agentSdkTransport === "disabled") return false;
  if (params.agentSdkTransport === "enabled") return params.provider === "anthropic";
  // "auto" or undefined — use for Anthropic
  return params.provider === "anthropic";
}
