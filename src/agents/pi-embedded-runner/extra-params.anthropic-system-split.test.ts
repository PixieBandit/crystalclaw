import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { STABLE_PROMPT_BOUNDARY } from "../system-prompt.js";
import { applyExtraParamsToAgent } from "./extra-params.js";

function runAnthropicPayload(payload: Record<string, unknown>) {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, "anthropic", "claude-sonnet-4-6");

  const model = {
    api: "anthropic-messages",
    provider: "anthropic",
    id: "claude-sonnet-4-6",
  } as Model<"anthropic-messages">;
  const context: Context = { messages: [] };

  void agent.streamFn?.(model, context, {});
}

describe("extra-params: Anthropic system prompt stable/volatile split", () => {
  it("splits string system prompt at boundary into two cached text blocks", () => {
    const stableContent = "You are a helpful assistant.\n## Safety\nBe safe.";
    const volatileContent = "# Project Context\n## AGENTS.md\nWorkspace config";
    const payload: Record<string, unknown> = {
      system: `${stableContent}\n${STABLE_PROMPT_BOUNDARY}\n${volatileContent}`,
    };

    runAnthropicPayload(payload);

    expect(Array.isArray(payload.system)).toBe(true);
    const blocks = payload.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);

    expect(blocks[0]).toEqual({
      type: "text",
      text: stableContent,
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[1]).toEqual({
      type: "text",
      text: volatileContent,
      cache_control: { type: "ephemeral" },
    });
  });

  it("leaves system prompt unchanged when no boundary marker is present", () => {
    const systemText = "You are a helpful assistant. No boundary here.";
    const payload: Record<string, unknown> = {
      system: systemText,
    };

    runAnthropicPayload(payload);

    expect(payload.system).toBe(systemText);
  });

  it("handles boundary marker in array-form system prompt", () => {
    const stableContent = "Stable instructions";
    const volatileContent = "Volatile context files";
    const payload: Record<string, unknown> = {
      system: [
        {
          type: "text",
          text: `${stableContent}\n${STABLE_PROMPT_BOUNDARY}\n${volatileContent}`,
          cache_control: { type: "ephemeral" },
        },
      ],
    };

    runAnthropicPayload(payload);

    const blocks = payload.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "text",
      text: stableContent,
      cache_control: { type: "ephemeral" },
    });
    // Volatile block preserves the original block's cache_control
    expect(blocks[1]).toEqual({
      type: "text",
      text: volatileContent,
      cache_control: { type: "ephemeral" },
    });
  });

  it("preserves blocks before and after the split block in array form", () => {
    const payload: Record<string, unknown> = {
      system: [
        { type: "text", text: "Identity block" },
        {
          type: "text",
          text: `Stable\n${STABLE_PROMPT_BOUNDARY}\nVolatile`,
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: "Trailing block" },
      ],
    };

    runAnthropicPayload(payload);

    const blocks = payload.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: "text", text: "Identity block" });
    expect(blocks[1]).toEqual({
      type: "text",
      text: "Stable",
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[2]).toEqual({
      type: "text",
      text: "Volatile",
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[3]).toEqual({ type: "text", text: "Trailing block" });
  });

  it("does not apply to non-Anthropic providers", () => {
    const systemText = `Stable\n${STABLE_PROMPT_BOUNDARY}\nVolatile`;
    const payload: Record<string, unknown> = {
      messages: [{ role: "system", content: systemText }],
    };

    // Use OpenRouter instead of Anthropic
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload);
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
      baseUrl: "https://proxy.example.com/v1",
    } as unknown as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    // System text should remain as-is in messages (not split)
    expect((payload.messages as Array<{ content: string }>)[0].content).toBe(systemText);
  });

  it("chains correctly with existing onPayload hooks", () => {
    let downstreamCalled = false;
    const stableContent = "Stable";
    const volatileContent = "Volatile";
    const payload: Record<string, unknown> = {
      system: `${stableContent}\n${STABLE_PROMPT_BOUNDARY}\n${volatileContent}`,
    };

    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload);
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "anthropic", "claude-sonnet-4-6");

    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {
      onPayload: () => {
        downstreamCalled = true;
      },
    });

    expect(downstreamCalled).toBe(true);
    expect(Array.isArray(payload.system)).toBe(true);
  });

  it("handles empty volatile section gracefully", () => {
    const payload: Record<string, unknown> = {
      system: `Stable content only\n${STABLE_PROMPT_BOUNDARY}`,
    };

    runAnthropicPayload(payload);

    const blocks = payload.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "text",
      text: "Stable content only",
      cache_control: { type: "ephemeral" },
    });
  });

  it("handles empty stable section gracefully", () => {
    const payload: Record<string, unknown> = {
      system: `${STABLE_PROMPT_BOUNDARY}\nVolatile content only`,
    };

    runAnthropicPayload(payload);

    const blocks = payload.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "text",
      text: "Volatile content only",
      cache_control: { type: "ephemeral" },
    });
  });
});
