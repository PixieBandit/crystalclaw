/**
 * CrystalClaw Anthropic Agent SDK Harness.
 *
 * A standalone harness that routes Anthropic requests through the Claude Agent SDK
 * (spawning the real Claude Code binary) to achieve first-party API status.
 *
 * This is a separate flow from OpenClaw's pi-ai pipeline, designed to:
 * - Accept upstream OpenClaw updates without merge conflicts
 * - Only activate for Anthropic models
 * - Fall back to pi-ai for non-Anthropic providers
 */

export { runAnthropicHarness, shouldUseAnthropicHarness } from "./run.js";
export type { AnthropicHarnessParams } from "./run.js";
export { createOpenClawMcpBridge } from "./mcp-tool-bridge.js";
export type { BridgeableTool } from "./mcp-tool-bridge.js";
export { processAgentSdkStream } from "./event-adapter.js";
export type { ReplyCallbacks, EventAdapterResult } from "./event-adapter.js";
