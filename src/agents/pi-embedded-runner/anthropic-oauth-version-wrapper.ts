import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { log } from "./logger.js";

let cachedClaudeVersion: string | null = null;

function isAnthropicOAuthApiKey(apiKey: unknown): boolean {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

function resolveClaudeCodeVersion(): string | null {
  if (cachedClaudeVersion !== null) {
    return cachedClaudeVersion === "" ? null : cachedClaudeVersion;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const output = execSync("claude --version", {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = output.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      cachedClaudeVersion = match[1]!;
      log.debug(`resolved Claude Code version for OAuth user-agent: ${cachedClaudeVersion}`);
      return cachedClaudeVersion;
    }
  } catch {
    // Claude Code not installed or not in PATH — fall through to pi-ai default
  }
  cachedClaudeVersion = "";
  return null;
}

/**
 * Override user-agent for Anthropic OAuth requests to match the installed
 * Claude Code version. pi-ai hardcodes a version string that can drift
 * behind, causing Anthropic's server-side fingerprinting to reject it.
 */
export function createAnthropicOAuthVersionWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== "anthropic" || !isAnthropicOAuthApiKey(options?.apiKey)) {
      return underlying(model, context, options);
    }
    const version = resolveClaudeCodeVersion();
    if (!version) {
      return underlying(model, context, options);
    }
    return underlying(model, context, {
      ...options,
      headers: {
        ...options?.headers,
        "user-agent": `claude-cli/${version}`,
      },
    });
  };
}
