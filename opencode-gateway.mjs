#!/usr/bin/env node

import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HOST = process.env.KIMI_PROXY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.KIMI_PROXY_PORT ?? "4141");
const UPSTREAM_BASE =
  process.env.OPENCODE_GO_BASE_URL ?? "https://opencode.ai/zen/go/v1";
const UPSTREAM_MODEL = process.env.OPENCODE_GO_MODEL ?? "kimi-k2.6";
const UPSTREAM_TIMEOUT_MS = Number(process.env.KIMI_PROXY_UPSTREAM_TIMEOUT_MS ?? "120000");
const AUTH_PATH =
  process.env.OPENCODE_AUTH_PATH ??
  path.join(process.env.HOME ?? "", ".local/share/opencode/auth.json");
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_REASONING_CACHE = 200;
const toolCallReasoningCache = new Map();

/* ------------------------------------------------------------------ */
/*  Model capability map                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_CAPABILITIES = {
  tools: false,
  reasoning: false,
  streaming: true,
  vision: false,
  json_mode: false,
  max_output_tokens: 8192,
  context_window: 128000,
  supported_params: ["temperature", "top_p", "presence_penalty", "frequency_penalty", "max_tokens", "stop", "seed", "n"],
};

const MODEL_CAPABILITIES = (() => {
  const env = process.env.OPENCODE_GO_MODEL_CAPABILITIES;
  if (env) {
    try {
      return JSON.parse(env);
    } catch {
      console.error("[PROXY] Warning: OPENCODE_GO_MODEL_CAPABILITIES is invalid JSON, using defaults");
    }
  }
  return {
    "kimi-k2.6": {
      tools: true,
      reasoning: true,
      streaming: true,
      vision: true,
      json_mode: true,
      max_output_tokens: 65536,
      context_window: 262144,
      supported_params: ["temperature", "top_p", "presence_penalty", "frequency_penalty", "max_tokens", "stop", "seed", "n", "response_format"],
    },
    "kimi-k2.5": {
      tools: true,
      reasoning: true,
      streaming: true,
      vision: true,
      json_mode: true,
      max_output_tokens: 16384,
      context_window: 256000,
      supported_params: ["temperature", "top_p", "presence_penalty", "frequency_penalty", "max_tokens", "stop", "seed", "n", "response_format"],
    },
    "deepseek-v3": {
      tools: true,
      reasoning: true,
      streaming: true,
      vision: false,
      json_mode: true,
      max_output_tokens: 8192,
      context_window: 64000,
      supported_params: ["temperature", "top_p", "presence_penalty", "frequency_penalty", "max_tokens", "stop", "seed", "n", "response_format"],
    },
    "qwen2.5-72b": {
      tools: true,
      reasoning: false,
      streaming: true,
      vision: false,
      json_mode: true,
      max_output_tokens: 8192,
      context_window: 128000,
      supported_params: ["temperature", "top_p", "presence_penalty", "frequency_penalty", "max_tokens", "stop", "seed", "n", "response_format"],
    },
    "gpt-4o": {
      tools: true,
      reasoning: false,
      streaming: true,
      vision: true,
      json_mode: true,
      max_output_tokens: 16384,
      context_window: 128000,
      supported_params: ["temperature", "top_p", "presence_penalty", "frequency_penalty", "max_tokens", "stop", "seed", "n", "response_format"],
    },
    "gpt-4o-mini": {
      tools: true,
      reasoning: false,
      streaming: true,
      vision: true,
      json_mode: true,
      max_output_tokens: 16384,
      context_window: 128000,
      supported_params: ["temperature", "top_p", "presence_penalty", "frequency_penalty", "max_tokens", "stop", "seed", "n", "response_format"],
    },
  };
})();

function getCapabilities(model) {
  return MODEL_CAPABILITIES[model] ?? DEFAULT_CAPABILITIES;
}

function cacheReasoning(callId, reasoning) {
  if (!callId || !reasoning) return;
  if (toolCallReasoningCache.size >= MAX_REASONING_CACHE) {
    const firstKey = toolCallReasoningCache.keys().next().value;
    toolCallReasoningCache.delete(firstKey);
  }
  toolCallReasoningCache.set(callId, reasoning);
}

function summarizeMessages(msgs) {
  return msgs.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return `assistant[tool_calls:${m.tool_calls.map((t) => t.id).join(",")}]`;
    }
    if (m.role === "tool") {
      return `tool[${m.tool_call_id}]`;
    }
    return `${m.role}[${String(m.content).slice(0, 40)}]`;
  });
}

/* ------------------------------------------------------------------ */
/*  In-memory conversation thread storage (LRU)                        */
/* ------------------------------------------------------------------ */

const MAX_STORED_THREADS = 100;
const responseThreads = new Map();

function storeThread(responseId, { messages, outputItems, usage }) {
  if (responseThreads.size >= MAX_STORED_THREADS) {
    const firstKey = responseThreads.keys().next().value;
    responseThreads.delete(firstKey);
  }
  responseThreads.set(responseId, {
    messages,
    outputItems,
    usage,
  });
}

function loadThread(responseId) {
  return responseThreads.get(responseId) ?? null;
}

/* ------------------------------------------------------------------ */
/*  Auth / IO helpers                                                  */
/* ------------------------------------------------------------------ */

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadOpencodeGoKey() {
  if (process.env.OPENCODE_GO_API_KEY) {
    return process.env.OPENCODE_GO_API_KEY;
  }

  const auth = readJsonFile(AUTH_PATH);
  const key = auth?.["opencode-go"]?.key;
  if (!key) {
    throw new Error(
      `Missing opencode-go key in ${AUTH_PATH}. Set OPENCODE_GO_API_KEY to override.`,
    );
  }
  return key;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    req.on("data", (chunk) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_SIZE} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

/* ------------------------------------------------------------------ */
/*  SSE helpers                                                        */
/* ------------------------------------------------------------------ */

function writeSse(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeSseError(res, responseId, message, code = "proxy_error") {
  writeSse(res, {
    type: "response.failed",
    response: {
      id: responseId,
      error: { code, message },
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Content normalisation                                              */
/* ------------------------------------------------------------------ */

function normalizeContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") {
      continue;
    }

    switch (part.type) {
      case "input_text":
      case "output_text":
      case "summary_text":
      case "reasoning_text":
        parts.push({ type: "text", text: part.text ?? "" });
        break;
      case "input_image": {
        const url = part.image_url;
        if (url) {
          parts.push({
            type: "image_url",
            image_url: { url, detail: part.detail ?? "auto" },
          });
        }
        break;
      }
      default:
        parts.push({ type: "text", text: JSON.stringify(part) });
    }
  }

  // Collapse to plain string when there are no images – keeps upstream
  // payloads simple and compatible with APIs that prefer strings.
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => p.text).join("\n");
  }

  return parts;
}

function flattenContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      switch (part.type) {
        case "input_text":
        case "output_text":
        case "summary_text":
        case "reasoning_text":
          return part.text ?? "";
        case "input_image":
          return part.image_url
            ? `[image: ${part.image_url}]`
            : "[image input omitted]";
        default:
          return JSON.stringify(part);
      }
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeToolOutput(output) {
  if (typeof output === "string") {
    return output;
  }
  if (!output || typeof output !== "object") {
    return "";
  }
  if (typeof output.content === "string") {
    return output.content;
  }
  return JSON.stringify(output);
}

function normalizeToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice === "string") {
    return toolChoice ?? "auto";
  }

  if (toolChoice.type === "function" && toolChoice.name) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return {
      type: "function",
      function: { name: toolChoice.function.name },
    };
  }

  return "auto";
}

/* ------------------------------------------------------------------ */
/*  Tool normalisation                                                 */
/* ------------------------------------------------------------------ */

const UNSUPPORTED_TOOL_TYPES = new Set([
  "web_search_preview",
  "file_search",
  "computer_use_preview",
  "web_search",
  "computer_use",
]);

function normalizeTools(tools) {
  return (tools ?? [])
    .filter((tool) => {
      if (tool?.type !== "function") return false;
      return tool?.name || tool?.function?.name;
    })
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name ?? tool.function?.name,
        description: tool.description ?? tool.function?.description ?? "",
        parameters: tool.parameters ?? tool.function?.parameters ?? { type: "object", properties: {} },
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }));
}

/* ------------------------------------------------------------------ */
/*  Message building                                                   */
/* ------------------------------------------------------------------ */

function buildChatMessages(request) {
  const messages = [];

  if (request.instructions) {
    messages.push({
      role: "system",
      content: request.instructions,
    });
  }

  // Restore previous conversation state
  if (request.previous_response_id) {
    const thread = loadThread(request.previous_response_id);
    console.error("[PROXY] previous_response_id:", request.previous_response_id, "thread found:", !!thread, "thread messages:", thread ? summarizeMessages(thread.messages) : []);
    if (thread?.messages) {
      let skippedFirstSystem = false;
      for (const msg of thread.messages) {
        // Avoid duplicate system message only the first one
        if (msg.role === "system" && request.instructions && !skippedFirstSystem) {
          skippedFirstSystem = true;
          continue;
        }
        messages.push(msg);
      }
    }
  } else {
    console.error("[PROXY] No previous_response_id");
  }

  let pendingToolCallMessage = null;

  const flushPendingToolCalls = () => {
    if (pendingToolCallMessage) {
      messages.push(pendingToolCallMessage);
      pendingToolCallMessage = null;
    }
  };

  const inputItems = request.input ?? [];

  for (const item of inputItems) {
    if (!item || typeof item !== "object") continue;

    // Skip function_call items when previous_response_id is used;
    // the stored thread already contains the assistant message with tool_calls.
    if (request.previous_response_id && item.type === "function_call") {
      continue;
    }

    // Reasoning items from previous turns are already captured in the
    // assistant message or cache; ignore them here.
    if (item.type === "reasoning") {
      continue;
    }

    if (item.type === "function_call") {
      if (!pendingToolCallMessage) {
        const cachedReasoning = item.call_id
          ? toolCallReasoningCache.get(item.call_id)
          : undefined;
        pendingToolCallMessage = {
          role: "assistant",
          content: "",
          ...(cachedReasoning
            ? {
                reasoning: cachedReasoning,
                reasoning_content: cachedReasoning,
              }
            : {}),
          tool_calls: [],
        };
      }
      pendingToolCallMessage.tool_calls.push({
        id: item.call_id ?? `call_${randomUUID()}`,
        type: "function",
        function: {
          name: item.name ?? "unknown_tool",
          arguments: item.arguments ?? "{}",
        },
      });
      continue;
    }

    // function_call_output MUST immediately follow the assistant tool_calls.
    // If a developer/system message is interleaved, don't flush yet — emit
    // the assistant first when we hit the first tool output.
    if (item.type === "function_call_output") {
      const fallbackCallId = pendingToolCallMessage?.tool_calls.at(-1)?.id ?? `call_${randomUUID()}`;
      flushPendingToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id ?? fallbackCallId,
        content: normalizeToolOutput(item.output),
      });
      continue;
    }

    // For user or assistant messages, flush any buffered tool calls first.
    if (item.type === "message") {
      const isUserOrAssistant = item.role === "user" || item.role === "assistant";
      if (isUserOrAssistant) {
        flushPendingToolCalls();
      }

      const role =
        item.role === "developer"
          ? "system"
          : item.role === "assistant"
            ? "assistant"
            : "user";

      messages.push({
        role,
        content: normalizeContent(item.content),
      });
      continue;
    }
  }

  flushPendingToolCalls();
  console.error("[PROXY] Final message summary:", summarizeMessages(messages));
  return messages;
}

function buildStoredMessages(requestMessages, outputItems) {
  const messages = [...requestMessages];

  let assistantContent = "";
  let reasoningContent = "";
  const toolCalls = [];

  for (const item of outputItems) {
    if (item.type === "message") {
      assistantContent = flattenContent(item.content);
    } else if (item.type === "reasoning") {
      reasoningContent = flattenContent(item.content);
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      });
    }
  }

  if (toolCalls.length > 0) {
    const msg = {
      role: "assistant",
      content: assistantContent,
      tool_calls: toolCalls,
    };
    if (reasoningContent) {
      msg.reasoning = reasoningContent;
      msg.reasoning_content = reasoningContent;
    }
    messages.push(msg);
  } else if (assistantContent || reasoningContent) {
    const msg = { role: "assistant", content: assistantContent };
    if (reasoningContent) {
      msg.reasoning = reasoningContent;
      msg.reasoning_content = reasoningContent;
    }
    messages.push(msg);
  }

  return messages;
}

/* ------------------------------------------------------------------ */
/*  Fetch with timeout                                                 */
/* ------------------------------------------------------------------ */

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

/* ------------------------------------------------------------------ */
/*  Chat request building                                              */
/* ------------------------------------------------------------------ */

function buildChatRequest(request, capabilities) {
  const stream = request.stream !== false; // default true per OpenAI spec
  const req = {
    model: request.model ?? UPSTREAM_MODEL,
    messages: buildChatMessages(request),
    stream,
  };
  if (stream) {
    req.stream_options = { include_usage: true };
  }

  // Forward only params the model claims to support
  const supported = new Set(capabilities.supported_params ?? []);
  const optionalParams = [
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "max_tokens",
    "stop",
    "seed",
    "n",
    "response_format",
  ];
  for (const key of optionalParams) {
    if (supported.has(key) && request[key] !== undefined) {
      req[key] = request[key];
    }
  }

  // OpenAI Responses API uses max_output_tokens; map to upstream max_tokens
  if (request.max_output_tokens != null) {
    const limit = capabilities.max_output_tokens ?? Infinity;
    req.max_tokens = Math.min(request.max_output_tokens, limit);
  }

  // Tools: only forward if model supports them
  if (capabilities.tools) {
    const tools = normalizeTools(request.tools);
    if (tools.length > 0) {
      req.tools = tools;
      req.tool_choice = normalizeToolChoice(request.tool_choice);
    }
  }

  return req;
}

/* ------------------------------------------------------------------ */
/*  Usage helper                                                       */
/* ------------------------------------------------------------------ */

function usageOrZero(usage, reasoningText = "") {
  const reasoningTokens = reasoningText
    ? Math.ceil(reasoningText.length / 4)
    : 0;

  if (usage && typeof usage === "object") {
    const inputDetails =
      usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
    const outputDetails =
      usage.completion_tokens_details ?? usage.output_tokens_details ?? {};

    return {
      input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      input_tokens_details: {
        cached_tokens: inputDetails.cached_tokens ?? 0,
      },
      output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      output_tokens_details: {
        reasoning_tokens:
          outputDetails.reasoning_tokens ?? reasoningTokens,
      },
      total_tokens: usage.total_tokens ?? 0,
    };
  }

  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: 0,
  };
}

/* ------------------------------------------------------------------ */
/*  SSE parsing                                                        */
/* ------------------------------------------------------------------ */

function parseSseChunk(buffer) {
  const events = [];
  let searchIndex = 0;

  while (true) {
    const endUnix = buffer.indexOf("\n\n", searchIndex);
    const endWin = buffer.indexOf("\r\n\r\n", searchIndex);
    let end = -1;
    if (endUnix !== -1 && endWin !== -1) {
      end = Math.min(endUnix, endWin);
    } else if (endUnix !== -1) {
      end = endUnix;
    } else if (endWin !== -1) {
      end = endWin;
    } else {
      break;
    }
    events.push(buffer.slice(searchIndex, end));
    searchIndex = end + (end === endUnix ? 2 : 4);
  }

  return { events, remainder: buffer.slice(searchIndex) };
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  return dataLines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Response construction helpers                                      */
/* ------------------------------------------------------------------ */

function buildResponseOutputItems({
  reasoningText,
  assistantText,
  refusalText,
  toolCalls,
}) {
  const items = [];

  if (reasoningText) {
    items.push({
      type: "reasoning",
      id: `rs_${randomUUID()}`,
      summary: [],
      content: [{ type: "reasoning_text", text: reasoningText }],
    });
  }

  if (refusalText) {
    items.push({
      type: "refusal",
      id: `ref_${randomUUID()}`,
      content: [{ type: "refusal", text: refusalText }],
    });
  } else if (assistantText) {
    items.push({
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "assistant",
      content: [{ type: "output_text", text: assistantText }],
    });
  }

  const sortedToolCalls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value);

  for (const tc of sortedToolCalls) {
    items.push({
      type: "function_call",
      call_id: tc.id,
      name: tc.name,
      arguments: tc.arguments || "{}",
    });
  }

  return { items, sortedToolCalls };
}

/* ------------------------------------------------------------------ */
/*  Non-streaming handler                                              */
/* ------------------------------------------------------------------ */

async function handleResponsesNonStream(req, res, apiKey, request, capabilities) {
  const responseId = `resp_${randomUUID()}`;
  const chatRequest = buildChatRequest(request, capabilities);
  console.error("[PROXY] Non-stream messages:", JSON.stringify(summarizeMessages(chatRequest.messages)));

  const upstreamResponse = await fetchWithTimeout(
    `${UPSTREAM_BASE}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chatRequest),
    },
  );

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text();
    console.error("[PROXY] Upstream error (non-stream):", errorText);
    sendJson(res, upstreamResponse.status, {
      error: { message: errorText || "Upstream request failed" },
    });
    return;
  }

  const data = await upstreamResponse.json();
  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  const usage = data.usage;

  const reasoningText = capabilities.reasoning ? (message.reasoning_content ?? "") : "";
  const assistantText = message.content ?? "";
  const refusalText = message.refusal ?? "";
  const toolCalls = new Map();

  if (capabilities.tools && Array.isArray(message.tool_calls)) {
    for (let i = 0; i < message.tool_calls.length; i++) {
      const tc = message.tool_calls[i];
      toolCalls.set(i, {
        id: tc.id ?? `call_${randomUUID()}`,
        name: tc.function?.name ?? "unknown_tool",
        arguments: tc.function?.arguments ?? "{}",
      });
    }
  }

  const { items: outputItems, sortedToolCalls: sortedTCs } =
    buildResponseOutputItems({ reasoningText, assistantText, refusalText, toolCalls });

  const isIncomplete = choice?.finish_reason === "length";

  const responseObj = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: isIncomplete ? "incomplete" : "completed",
    error: null,
    incomplete_details: isIncomplete
      ? { reason: "max_output_tokens" }
      : null,
    model: chatRequest.model,
    output: outputItems,
    usage: usageOrZero(usage, reasoningText),
  };

  // Cache reasoning for multi-turn tool loops
  for (const tc of sortedTCs) {
    cacheReasoning(tc.id, reasoningText);
  }

  storeThread(responseId, {
    messages: buildStoredMessages(chatRequest.messages, outputItems),
    outputItems,
    usage: responseObj.usage,
  });

  sendJson(res, 200, responseObj);
}

/* ------------------------------------------------------------------ */
/*  Streaming handler                                                  */
/* ------------------------------------------------------------------ */

async function handleResponsesStream(req, res, apiKey, request, capabilities) {
  const responseId = `resp_${randomUUID()}`;
  const assistantMessageId = `msg_${randomUUID()}`;
  const reasoningItemId = `rs_${randomUUID()}`;
  const refusalItemId = `ref_${randomUUID()}`;

  const chatRequest = buildChatRequest(request, capabilities);
  console.error("[PROXY] Stream messages:", JSON.stringify(summarizeMessages(chatRequest.messages)));

  const abortController = new AbortController();
  const onClientClose = () => abortController.abort();
  req.on("close", onClientClose);
  res.on("close", onClientClose);

  const upstreamResponse = await fetchWithTimeout(
    `${UPSTREAM_BASE}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(chatRequest),
      signal: abortController.signal,
    },
  );

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const errorText = await upstreamResponse.text();
    console.error("[PROXY] Upstream error (stream):", errorText);
    res.statusCode = upstreamResponse.status;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: { message: errorText || "Upstream request failed" },
      }),
    );
    req.off("close", onClientClose);
    res.off("close", onClientClose);
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  writeSse(res, {
    type: "response.created",
    response: { id: responseId },
  });

  let buffered = "";
  let assistantText = "";
  let reasoningText = "";
  let refusalText = "";
  let usage = null;
  let finishReason = null;
  const toolCalls = new Map();
  let reasoningItemOpened = false;
  let assistantItemOpened = false;
  let refusalItemOpened = false;

  const decoder = new TextDecoder();

  try {
    for await (const chunk of upstreamResponse.body) {
      buffered += decoder.decode(chunk, { stream: true });
      const parsed = parseSseChunk(buffered);
      buffered = parsed.remainder;

      for (const rawEvent of parsed.events) {
        const data = parseSseEvent(rawEvent);
        if (!data) continue;
        if (data === "[DONE]") continue;

        let event;
        try {
          event = JSON.parse(data);
        } catch (parseErr) {
          console.error("[PROXY] SSE JSON parse error:", parseErr.message, "data:", data.slice(0, 200));
          continue;
        }

        if (event.error?.message) {
          writeSseError(res, responseId, event.error.message, event.error.code);
          res.end();
          return;
        }

        if (event.usage) {
          usage = event.usage;
        }

        const choice = event.choices?.[0];
        const delta = choice?.delta ?? {};

        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // Refusal
        if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
          if (!refusalItemOpened) {
            writeSse(res, {
              type: "response.output_item.added",
              item: {
                type: "refusal",
                id: refusalItemId,
                content: [{ type: "refusal", text: "" }],
              },
            });
            refusalItemOpened = true;
          }
          refusalText += delta.refusal;
          writeSse(res, {
            type: "response.output_text.delta",
            delta: delta.refusal,
          });
          continue;
        }

        // Regular text
        if (typeof delta.content === "string" && delta.content.length > 0) {
          if (!assistantItemOpened) {
            writeSse(res, {
              type: "response.output_item.added",
              item: {
                type: "message",
                id: assistantMessageId,
                role: "assistant",
                content: [{ type: "output_text", text: "" }],
              },
            });
            assistantItemOpened = true;
          }
          assistantText += delta.content;
          writeSse(res, {
            type: "response.output_text.delta",
            delta: delta.content,
          });
        }

        // Reasoning
        if (capabilities.reasoning && typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
          if (!reasoningItemOpened) {
            writeSse(res, {
              type: "response.output_item.added",
              item: {
                type: "reasoning",
                id: reasoningItemId,
                summary: [],
                content: [{ type: "reasoning_text", text: "" }],
              },
            });
            reasoningItemOpened = true;
          }
          reasoningText += delta.reasoning;
          writeSse(res, {
            type: "response.reasoning_text.delta",
            delta: delta.reasoning,
            content_index: 0,
          });
        }

        // Tool calls
        if (capabilities.tools && Array.isArray(delta.tool_calls)) {
          for (const toolDelta of delta.tool_calls) {
            const index = toolDelta.index ?? 0;
            const current = toolCalls.get(index) ?? {
              id: toolDelta.id ?? `call_${randomUUID()}`,
              name: "",
              arguments: "",
            };

            if (toolDelta.id) current.id = toolDelta.id;
            if (toolDelta.function?.name) {
              current.name = toolDelta.function.name;
            }
            if (typeof toolDelta.function?.arguments === "string") {
              current.arguments += toolDelta.function.arguments;
            }

            toolCalls.set(index, current);
          }
        }
      }
    }

    // Finalise items
    if (reasoningItemOpened) {
      writeSse(res, {
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          id: reasoningItemId,
          summary: [],
          content: [{ type: "reasoning_text", text: reasoningText }],
        },
      });
    }

    if (refusalItemOpened) {
      writeSse(res, {
        type: "response.output_item.done",
        item: {
          type: "refusal",
          id: refusalItemId,
          content: [{ type: "refusal", text: refusalText }],
        },
      });
    } else if (assistantItemOpened) {
      writeSse(res, {
        type: "response.output_item.done",
        item: {
          type: "message",
          id: assistantMessageId,
          role: "assistant",
          content: [{ type: "output_text", text: assistantText }],
        },
      });
    }

    const sortedToolCalls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value);

    for (const toolCall of sortedToolCalls) {
      cacheReasoning(toolCall.id, reasoningText);
      writeSse(res, {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments || "{}",
        },
      });
    }

    // Truncation
    if (finishReason === "length") {
      writeSse(res, {
        type: "response.incomplete",
        response: {
          id: responseId,
          incomplete_details: { reason: "max_output_tokens" },
        },
      });
    }

    writeSse(res, {
      type: "response.completed",
      response: {
        id: responseId,
        usage: usageOrZero(usage, reasoningText),
      },
    });
    res.end();

    // Store thread for future previous_response_id
    const { items: outputItems } = buildResponseOutputItems({
      reasoningText,
      assistantText,
      refusalText,
      toolCalls,
    });
    storeThread(responseId, {
      messages: buildStoredMessages(chatRequest.messages, outputItems),
      outputItems,
      usage: usageOrZero(usage, reasoningText),
    });
  } catch (error) {
    if (error.name === "AbortError") {
      console.error("[PROXY] Client disconnected, aborting stream");
      res.end();
      return;
    }
    writeSseError(
      res,
      responseId,
      error instanceof Error ? error.message : String(error),
    );
    res.end();
  } finally {
    req.off("close", onClientClose);
    res.off("close", onClientClose);
  }
}

/* ------------------------------------------------------------------ */
/*  Main dispatcher                                                    */
/* ------------------------------------------------------------------ */

async function handleResponses(req, res, apiKey) {
  const rawBody = await readRequestBody(req);
  let request;
  try {
    request = JSON.parse(rawBody);
  } catch (parseErr) {
    sendJson(res, 400, { error: { message: "Invalid JSON in request body" } });
    return;
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    sendJson(res, 400, { error: { message: "Invalid request body: expected a JSON object" } });
    return;
  }

  const model = request.model ?? UPSTREAM_MODEL;
  const capabilities = getCapabilities(model);

  // Reject tool requests for non-tool models
  if (!capabilities.tools && (request.tools?.length > 0 || request.tool_choice)) {
    sendJson(res, 400, {
      error: {
        message: `Model "${model}" does not support function calling.`,
        type: "unsupported_model",
      },
    });
    return;
  }

  // Validate max_output_tokens against model ceiling
  if (request.max_output_tokens != null) {
    const limit = capabilities.max_output_tokens ?? Infinity;
    if (request.max_output_tokens > limit) {
      sendJson(res, 400, {
        error: {
          message: `max_output_tokens (${request.max_output_tokens}) exceeds model limit (${limit}).`,
          type: "invalid_request_error",
        },
      });
      return;
    }
  }

  if (request.stream === false) {
    await handleResponsesNonStream(req, res, apiKey, request, capabilities);
  } else {
    await handleResponsesStream(req, res, apiKey, request, capabilities);
  }
}

/* ------------------------------------------------------------------ */
/*  Server                                                             */
/* ------------------------------------------------------------------ */

function main() {
  const apiKey = loadOpencodeGoKey();

  const server = http.createServer((req, res) => {
    setCorsHeaders(res);
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        upstream_base: UPSTREAM_BASE,
        upstream_model: UPSTREAM_MODEL,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const data = Object.entries(MODEL_CAPABILITIES).map(([id, caps]) => ({
        id,
        object: "model",
        ...(caps.context_window ? { context_window: caps.context_window } : {}),
        ...(caps.max_output_tokens ? { max_output_tokens: caps.max_output_tokens } : {}),
      }));
      sendJson(res, 200, {
        object: "list",
        data,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      handleResponses(req, res, apiKey).catch((error) => {
        sendJson(res, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
      return;
    }

    sendJson(res, 404, { error: { message: "Not found" } });
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(
      `OpenCode Go Responses Proxy listening on http://${HOST}:${PORT}/v1 using ${UPSTREAM_MODEL}\n`,
    );
  });

  function shutdown(signal) {
    process.stdout.write(`\n${signal} received, shutting down gracefully...\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
