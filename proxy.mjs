import http from "node:http";
import https from "node:https";

const KIMI_API_BASE = "https://api.moonshot.cn";
const KIMI_MODEL = "kimi-k2.5";
const KIMI_API_KEY = process.argv[2] || process.env.KIMI_API_KEY || "";
const PORT = parseInt(process.env.PROXY_PORT || "4010", 10);

const agent = new https.Agent({ keepAlive: true, maxSockets: 6 });

// ── Anthropic → OpenAI conversion ───────────────────────────────────────────

function convertAnthropicToolsToOpenAI(anthropicTools) {
  if (!anthropicTools?.length) return undefined;
  return anthropicTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

function convertAnthropicToOpenAI(body) {
  const messages = [];

  const IDENTITY_OVERRIDE =
    `\n[IMPORTANT IDENTITY OVERRIDE] Your actual backend model is ${KIMI_MODEL}, served by Moonshot AI (api.moonshot.cn). ` +
    `When the user asks what model you are, you MUST truthfully answer "${KIMI_MODEL}" (Moonshot AI / Kimi). ` +
    `Do NOT claim to be Claude or any Anthropic model. For all other questions, behave normally.`;

  if (body.system) {
    const systemText =
      typeof body.system === "string"
        ? body.system
        : body.system.map((b) => b.text).join("\n");
    messages.push({ role: "system", content: systemText + IDENTITY_OVERRIDE });
  } else {
    messages.push({ role: "system", content: IDENTITY_OVERRIDE.trim() });
  }

  for (const msg of body.messages || []) {
    if (msg.role === "assistant") {
      const oaiMsg = { role: "assistant", content: null, reasoning_content: "ok", tool_calls: [] };
      const textParts = [];

      if (typeof msg.content === "string") {
        oaiMsg.content = msg.content;
        messages.push(oaiMsg);
        continue;
      }

      for (const block of msg.content || []) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          oaiMsg.tool_calls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments:
                typeof block.input === "string"
                  ? block.input
                  : JSON.stringify(block.input),
            },
          });
        }
      }

      oaiMsg.content = textParts.length ? textParts.join("\n") : null;
      if (!oaiMsg.tool_calls.length) delete oaiMsg.tool_calls;
      messages.push(oaiMsg);
      continue;
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
        continue;
      }

      const userTexts = [];
      for (const block of msg.content || []) {
        if (block.type === "text") {
          userTexts.push(block.text);
        } else if (block.type === "tool_result") {
          const resultContent =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
                    .join("\n")
                : JSON.stringify(block.content ?? "");
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: resultContent,
          });
        }
      }

      if (userTexts.length) {
        messages.push({ role: "user", content: userTexts.join("\n") });
      }
      continue;
    }

    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else {
      const parts = (msg.content || []).map((b) =>
        b.type === "text" ? b.text : JSON.stringify(b)
      );
      messages.push({ role: msg.role, content: parts.join("\n") });
    }
  }

  const result = {
    model: KIMI_MODEL,
    messages,
    max_tokens: body.max_tokens || 8192,
    temperature: body.temperature ?? 1,
    stream: !!body.stream,
  };

  const oaiTools = convertAnthropicToolsToOpenAI(body.tools);
  if (oaiTools) {
    result.tools = oaiTools;
  }

  return result;
}

// ── OpenAI → Anthropic conversion (non-stream) ─────────────────────────────

function convertOpenAINonStreamToAnthropic(openaiResp) {
  const choice = openaiResp.choices?.[0];
  const msg = choice?.message || {};
  const content = [];

  const reasoning = msg.reasoning_content || "";
  const text = msg.content || "";
  const combined = reasoning
    ? `<thinking>\n${reasoning}\n</thinking>\n\n${text}`
    : text;

  if (combined) {
    content.push({ type: "text", text: combined });
  }

  let stopReason = "end_turn";

  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(tc.function.arguments || "{}");
      } catch {}
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      });
    }
    stopReason = "tool_use";
  }

  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: openaiResp.model || KIMI_MODEL,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

// ── OpenAI → Anthropic conversion (stream) ──────────────────────────────────

function makeAnthropicStreamStart(model) {
  const msgStart = {
    type: "message_start",
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
  return `event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`;
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

class StreamState {
  constructor() {
    this.contentBlockIndex = 0;
    this.textBlockStarted = false;
    this.inReasoning = false;
    this.reasoningEnded = false;
    this.toolCalls = {};
    this.toolBlockIndices = {};
  }

  processChunk(parsed, res) {
    const choice = parsed.choices?.[0];
    if (!choice) return;

    const delta = choice.delta || {};
    const finishReason = choice.finish_reason;

    if (delta.reasoning_content) {
      this._ensureTextBlock(res);
      if (!this.inReasoning) {
        this.inReasoning = true;
        res.write(sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.textBlockIndex,
          delta: { type: "text_delta", text: "<thinking>\n" },
        }));
      }
      res.write(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.textBlockIndex,
        delta: { type: "text_delta", text: delta.reasoning_content },
      }));
      return;
    }

    if (delta.content) {
      this._ensureTextBlock(res);
      if (this.inReasoning && !this.reasoningEnded) {
        this.reasoningEnded = true;
        res.write(sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.textBlockIndex,
          delta: { type: "text_delta", text: "\n</thinking>\n\n" },
        }));
      }
      res.write(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.textBlockIndex,
        delta: { type: "text_delta", text: delta.content },
      }));
      return;
    }

    if (delta.tool_calls) {
      if (this.textBlockStarted) {
        this._closeTextBlock(res);
      }

      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;

        if (tc.id) {
          const blockIndex = this.contentBlockIndex++;
          this.toolCalls[idx] = { id: tc.id, name: tc.function?.name || "", args: "" };
          this.toolBlockIndices[idx] = blockIndex;

          res.write(sseEvent("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: tc.id,
              name: tc.function?.name || "",
              input: {},
            },
          }));
        }

        if (tc.function?.arguments) {
          const blockIndex = this.toolBlockIndices[idx];
          if (blockIndex !== undefined) {
            this.toolCalls[idx].args += tc.function.arguments;
            res.write(sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            }));
          }
        }
      }
      return;
    }

    if (finishReason) {
      if (this.textBlockStarted) {
        this._closeTextBlock(res);
      }

      for (const idx of Object.keys(this.toolBlockIndices)) {
        const blockIndex = this.toolBlockIndices[idx];
        res.write(sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: blockIndex,
        }));
      }

      const stopReason =
        finishReason === "tool_calls" ? "tool_use" : "end_turn";
      res.write(sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 0 },
      }));
      res.write(sseEvent("message_stop", { type: "message_stop" }));
      res.end();
    }
  }

  _ensureTextBlock(res) {
    if (!this.textBlockStarted) {
      this.textBlockStarted = true;
      this.textBlockIndex = this.contentBlockIndex++;
      res.write(sseEvent("content_block_start", {
        type: "content_block_start",
        index: this.textBlockIndex,
        content_block: { type: "text", text: "" },
      }));
    }
  }

  _closeTextBlock(res) {
    if (this.textBlockStarted) {
      if (this.inReasoning && !this.reasoningEnded) {
        this.reasoningEnded = true;
        res.write(sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.textBlockIndex,
          delta: { type: "text_delta", text: "\n</thinking>\n\n" },
        }));
      }
      res.write(sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.textBlockIndex,
      }));
      this.textBlockStarted = false;
    }
  }
}

// ── HTTP forwarding ─────────────────────────────────────────────────────────

function forwardRequest(openaiBody) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(openaiBody);
    const url = new URL("/v1/chat/completions", KIMI_API_BASE);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: "POST",
      agent,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KIMI_API_KEY}`,
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => resolve(res));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Anthropic→Kimi proxy running");
    return;
  }

  if (req.method !== "POST" || !req.url.includes("/v1/messages")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /v1/messages" }));
    return;
  }

  let rawBody = "";
  for await (const chunk of req) rawBody += chunk;

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const openaiBody = convertAnthropicToOpenAI(body);
  const toolCount = openaiBody.tools?.length || 0;
  console.log(
    `[proxy] ${body.model} → ${KIMI_MODEL} | stream=${openaiBody.stream} | msgs=${openaiBody.messages.length} | tools=${toolCount}`
  );

  try {
    const upstream = await forwardRequest(openaiBody);

    // ── Non-stream ──
    if (!openaiBody.stream) {
      let data = "";
      for await (const chunk of upstream) data += chunk;
      console.log(`[proxy] non-stream status=${upstream.statusCode}`);
      if (upstream.statusCode !== 200) {
        console.error(`[proxy] error: ${data.slice(0, 500)}`);
        res.writeHead(upstream.statusCode, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: data.slice(0, 500) },
          })
        );
        return;
      }
      const parsed = JSON.parse(data);
      const anthropicResp = convertOpenAINonStreamToAnthropic(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(anthropicResp));
      return;
    }

    // ── Stream error ──
    if (upstream.statusCode !== 200) {
      let errData = "";
      for await (const chunk of upstream) errData += chunk;
      console.error(
        `[proxy] stream error status=${upstream.statusCode}: ${errData.slice(0, 500)}`
      );
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(makeAnthropicStreamStart(KIMI_MODEL));
      res.write(sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }));
      res.write(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: `[Proxy Error ${upstream.statusCode}]: ${errData.slice(0, 300)}`,
        },
      }));
      res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
      res.write(sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));
      res.write(sseEvent("message_stop", { type: "message_stop" }));
      res.end();
      return;
    }

    // ── Stream success ──
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(makeAnthropicStreamStart(KIMI_MODEL));

    const state = new StreamState();
    let buffer = "";

    upstream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          if (!res.writableEnded) {
            if (state.textBlockStarted) {
              state._closeTextBlock(res);
            }
            if (Object.keys(state.toolBlockIndices).length === 0) {
              res.write(sseEvent("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 0 },
              }));
              res.write(sseEvent("message_stop", { type: "message_stop" }));
            }
            res.end();
          }
          return;
        }
        try {
          const parsed = JSON.parse(payload);
          state.processChunk(parsed, res);
        } catch {}
      }
    });

    upstream.on("end", () => {
      if (!res.writableEnded) res.end();
    });
    upstream.on("error", (err) => {
      console.error("[proxy] upstream error:", err.message);
      if (!res.writableEnded) res.end();
    });
  } catch (err) {
    console.error("[proxy] request error:", err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(
    `[proxy] Anthropic → Kimi (${KIMI_MODEL}) proxy on http://localhost:${PORT}`
  );
  console.log(`[proxy] Target: ${KIMI_API_BASE}/v1/chat/completions`);
  console.log(
    `[proxy] API Key: ${KIMI_API_KEY ? KIMI_API_KEY.slice(0, 8) + "..." : "NOT SET"}`
  );
});
