/**
 * MCP Tool Bridge for the Anthropic Agent SDK Harness.
 *
 * Wraps OpenClaw's internal tools as in-process MCP tools using the Agent SDK's
 * `createSdkMcpServer()`. Claude Code (spawned by the Agent SDK) can call these
 * tools via the standard MCP protocol without any subprocess or network overhead.
 *
 * Only OpenClaw-specific tools are bridged — Claude Code's native tools (Read,
 * Write, Edit, Bash, Glob, Grep) are used directly for filesystem/exec operations.
 */

import {
  createSdkMcpServer,
  tool,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const log = createSubsystemLogger("anthropic-harness:mcp-bridge");

/** Minimal tool interface matching what OpenClaw tool factories return. */
export type BridgeableTool = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
    isError?: boolean;
  }>;
};

/**
 * Names of Claude Code built-in tools that we do NOT bridge — Claude Code
 * handles these natively with its own implementations.
 */
const CLAUDE_CODE_NATIVE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "grep",
  "find",
  "ls",
  "bash",
  "exec",
  "process",
  "glob",
  // Agent SDK also handles these
  "agent",
  "subagent",
]);

/**
 * Check if a tool should be bridged to the Agent SDK or left to Claude Code.
 */
function shouldBridgeTool(toolName: string): boolean {
  return !CLAUDE_CODE_NATIVE_TOOLS.has(toolName.toLowerCase());
}

/**
 * Convert an OpenClaw tool's JSON Schema parameters into a Zod v4 object shape.
 *
 * The Agent SDK's `SdkMcpToolDefinition` expects a Zod raw shape for `inputSchema`.
 * Since OpenClaw tools use JSON Schema (via TypeBox), we convert the top-level
 * properties into a permissive `z.any()` shape — the actual validation happens
 * in the tool's execute handler, not at the MCP layer.
 */
function jsonSchemaToZodShape(
  schema: Record<string, unknown> | undefined,
): Record<string, z.ZodType> {
  if (!schema) {
    return {};
  }
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const shape: Record<string, z.ZodType> = {};
  for (const key of Object.keys(properties)) {
    // Use z.any() with .optional() for all fields — the tool handler validates internally
    shape[key] = z.any().optional();
  }
  return shape;
}

/**
 * Convert an OpenClaw tool result into an MCP CallToolResult.
 */
function toCallToolResult(result: {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}): CallToolResult {
  const content: CallToolResult["content"] = [];

  if (result.content) {
    for (const block of result.content) {
      if (block.type === "text" && block.text) {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "image" && block.data) {
        content.push({
          type: "image",
          data: block.data as string,
          mimeType: (block.mimeType as string) ?? "image/png",
        });
      } else if (block.text) {
        // Fallback: treat any block with text as text content
        content.push({ type: "text", text: block.text });
      }
    }
  }

  // Ensure at least one content block
  if (content.length === 0) {
    content.push({ type: "text", text: result.isError ? "Tool execution failed." : "Done." });
  }

  return {
    content,
    isError: result.isError ?? false,
  };
}

/**
 * Convert a single OpenClaw tool into an Agent SDK MCP tool definition.
 */
function bridgeTool(openclawTool: BridgeableTool): SdkMcpToolDefinition {
  const zodShape = jsonSchemaToZodShape(openclawTool.parameters);

  return tool(
    openclawTool.name,
    openclawTool.description ?? `OpenClaw tool: ${openclawTool.name}`,
    zodShape,
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const toolCallId = `mcp-bridge-${openclawTool.name}-${Date.now()}`;
      try {
        log.debug(`bridging tool call: ${openclawTool.name}`, { args });
        const result = await openclawTool.execute(toolCallId, args);
        return toCallToolResult(result);
      } catch (err) {
        log.error(`tool bridge error: ${openclawTool.name}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [
            {
              type: "text",
              text: `Error executing ${openclawTool.name}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * Create an in-process MCP server that exposes OpenClaw-specific tools
 * to the Agent SDK's Claude Code subprocess.
 *
 * @param tools - All OpenClaw tools (from createOpenClawCodingTools)
 * @returns MCP server config to pass to Agent SDK's `mcpServers` option
 */
export function createOpenClawMcpBridge(tools: BridgeableTool[]) {
  const bridgedTools = tools.filter((t) => shouldBridgeTool(t.name));

  log.info(
    `bridging ${bridgedTools.length} OpenClaw tools to Agent SDK MCP server ` +
      `(${tools.length - bridgedTools.length} native tools skipped)`,
  );

  if (bridgedTools.length > 0) {
    log.debug(
      `bridged tools: ${bridgedTools.map((t) => t.name).join(", ")}`,
    );
  }

  const mcpTools = bridgedTools.map(bridgeTool);

  return createSdkMcpServer({
    name: "crystalclaw",
    version: "1.0.0",
    tools: mcpTools,
  });
}
