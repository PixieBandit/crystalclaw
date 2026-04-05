/**
 * Event Adapter for the Anthropic Agent SDK Harness.
 *
 * Converts the Agent SDK's SDKMessage stream into the callbacks that OpenClaw's
 * gateway delivery system expects (onPartialReply, onBlockReply, onToolResult,
 * onAgentEvent, etc.).
 *
 * The Agent SDK yields:
 * - SDKPartialAssistantMessage (type: 'stream_event') — token-level streaming
 * - SDKAssistantMessage (type: 'assistant') — complete assistant messages
 * - SDKResultMessage (type: 'result') — final result with usage
 * - SDKSystemMessage (type: 'system') — init events with session_id
 * - SDKToolProgressMessage (type: 'tool_progress') — tool execution progress
 */

import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const log = createSubsystemLogger("anthropic-harness:event-adapter");

export type ReplyCallbacks = {
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    isReasoning?: boolean;
  }) => void | Promise<void>;
  onBlockReplyFlush?: () => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string }) => void | Promise<void>;
  onReasoningEnd?: () => void | Promise<void>;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  onAssistantMessageStart?: () => void | Promise<void>;
};

export type EventAdapterResult = {
  sessionId: string | null;
  resultText: string;
  durationMs: number;
  numTurns: number;
  stopReason: string | null;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  isError: boolean;
  errorMessage?: string;
};

/**
 * Process the Agent SDK message stream and invoke OpenClaw reply callbacks.
 *
 * @param messages - AsyncGenerator from Agent SDK query()
 * @param callbacks - OpenClaw reply callbacks
 * @returns Aggregated result metadata
 */
export async function processAgentSdkStream(
  messages: AsyncGenerator<Record<string, unknown>, void>,
  callbacks: ReplyCallbacks,
): Promise<EventAdapterResult> {
  let sessionId: string | null = null;
  let resultText = "";
  let durationMs = 0;
  let numTurns = 0;
  let stopReason: string | null = null;
  let isError = false;
  let errorMessage: string | undefined;
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  let currentTextBuffer = "";
  let isStreaming = false;
  let hasEmittedStart = false;

  for await (const msg of messages) {
    const type = msg.type as string;

    switch (type) {
      // System init — capture session_id
      case "system": {
        const subtype = msg.subtype as string | undefined;
        if (subtype === "init") {
          sessionId = (msg.session_id as string) ?? null;
          log.debug(`session initialized: ${sessionId}`);

          callbacks.onAgentEvent?.({
            stream: "lifecycle",
            data: { phase: "start", sessionId },
          });
        }
        break;
      }

      // Token-level streaming events (BetaRawMessageStreamEvent)
      case "stream_event": {
        const event = msg.event as Record<string, unknown> | undefined;
        if (!event) break;

        const eventType = event.type as string;

        if (!hasEmittedStart && eventType === "message_start") {
          hasEmittedStart = true;
          await callbacks.onAssistantMessageStart?.();
        }

        // Content block deltas — the main streaming path
        if (eventType === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (!delta) break;

          const deltaType = delta.type as string;

          if (deltaType === "text_delta") {
            const text = delta.text as string;
            if (text) {
              isStreaming = true;
              currentTextBuffer += text;
              await callbacks.onPartialReply?.({ text });
            }
          } else if (deltaType === "thinking_delta") {
            const thinking = delta.thinking as string;
            if (thinking) {
              await callbacks.onReasoningStream?.({ text: thinking });
            }
          }
        }

        // Content block stop — flush accumulated text
        if (eventType === "content_block_stop") {
          const index = event.index as number | undefined;
          // Check the content block type from the original start event
          // For text blocks, emit a block reply
          if (isStreaming && currentTextBuffer) {
            await callbacks.onBlockReply?.({ text: currentTextBuffer });
            currentTextBuffer = "";
            isStreaming = false;
          }
        }

        // Thinking block end
        if (
          eventType === "content_block_start" &&
          (event.content_block as Record<string, unknown>)?.type === "thinking"
        ) {
          // Thinking block started — reasoning will stream
        }
        if (
          eventType === "content_block_stop"
        ) {
          // Could be thinking end — we check by whether we were in reasoning mode
          // The SDK doesn't clearly delineate, but onReasoningEnd is safe to call
        }

        break;
      }

      // Complete assistant message
      case "assistant": {
        const message = msg.message as Record<string, unknown> | undefined;
        if (!message) break;

        // Flush any remaining text buffer
        if (currentTextBuffer) {
          await callbacks.onBlockReply?.({ text: currentTextBuffer });
          currentTextBuffer = "";
        }
        await callbacks.onBlockReplyFlush?.();

        // Extract text from content blocks for the result
        const content = message.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              resultText += block.text as string;
            }
          }
        }

        // Check for errors
        const msgError = msg.error as string | undefined;
        if (msgError) {
          isError = true;
          errorMessage = msgError;
          log.warn(`assistant message error: ${msgError}`);
        }

        break;
      }

      // Tool execution progress
      case "tool_progress": {
        const toolName = msg.tool_name as string | undefined;
        const progress = msg.content as string | undefined;
        if (toolName && progress) {
          await callbacks.onToolResult?.({ text: `[${toolName}] ${progress}` });
        }
        break;
      }

      // Final result
      case "result": {
        const subtype = msg.subtype as string;
        durationMs = (msg.duration_ms as number) ?? 0;
        numTurns = (msg.num_turns as number) ?? 0;
        stopReason = (msg.stop_reason as string) ?? null;

        if (subtype === "success") {
          resultText = (msg.result as string) ?? resultText;
          isError = false;
        } else if (subtype === "error") {
          isError = true;
          errorMessage = (msg.error as string) ?? "Unknown Agent SDK error";
          log.error(`Agent SDK result error: ${errorMessage}`);
        }

        // Extract usage
        const msgUsage = msg.usage as Record<string, number> | undefined;
        if (msgUsage) {
          usage = {
            input: msgUsage.input_tokens ?? 0,
            output: msgUsage.output_tokens ?? 0,
            cacheRead: msgUsage.cache_read_input_tokens ?? 0,
            cacheWrite: msgUsage.cache_creation_input_tokens ?? 0,
            total:
              (msgUsage.input_tokens ?? 0) + (msgUsage.output_tokens ?? 0),
          };
        }

        callbacks.onAgentEvent?.({
          stream: "lifecycle",
          data: {
            phase: "end",
            durationMs,
            numTurns,
            stopReason,
            isError,
            usage,
          },
        });

        break;
      }

      // Rate limit events
      case "rate_limit_event": {
        log.warn("rate limit event from Agent SDK", { msg });
        break;
      }

      // API retry events
      case "api_retry": {
        const retryAfterMs = msg.retry_after_ms as number | undefined;
        log.info(`Agent SDK API retry, waiting ${retryAfterMs}ms`);
        break;
      }

      // Status updates (e.g., tool execution, compaction)
      case "status": {
        const statusMsg = msg.message as string | undefined;
        if (statusMsg) {
          log.debug(`status: ${statusMsg}`);
        }
        break;
      }

      default:
        // Log unknown message types for debugging
        log.debug(`unhandled SDK message type: ${type}`);
        break;
    }
  }

  // Flush any remaining text
  if (currentTextBuffer) {
    await callbacks.onBlockReply?.({ text: currentTextBuffer });
    resultText += currentTextBuffer;
    currentTextBuffer = "";
  }

  return {
    sessionId,
    resultText,
    durationMs,
    numTurns,
    stopReason,
    usage,
    isError,
    errorMessage,
  };
}
