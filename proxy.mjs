import http from "node:http";
import https from "node:https";

const KIMI_API_BASE = "https://api.moonshot.cn";
const KIMI_MODEL = "kimi-k2.5";
const KIMI_API_KEY = process.argv[2] || process.env.KIMI_API_KEY || "";
const PORT = parseInt(process.env.PROXY_PORT || "4010", 10);

const agent = new https.Agent({ keepAlive: true, maxSockets: 6 });

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
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    const parts = [];
    for (const block of msg.content) {
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "tool_use")
        parts.push(`[tool_use id=${block.id} name=${block.name}] ${JSON.stringify(block.input)}`);
      else if (block.type === "tool_result")
        parts.push(`[tool_result id=${block.tool_use_id}] ${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`);
      else parts.push(JSON.stringify(block));
    }
    messages.push({ role: msg.role, content: parts.join("\n") });
  }

  return {
    model: KIMI_MODEL,
    messages,
    max_tokens: body.max_tokens || 8192,
    temperature: body.temperature ?? 1,
    stream: !!body.stream,
  };
}

function convertOpenAIChunkToAnthropicSSE(chunk, index) {
  if (!chunk.choices?.[0]) return null;
  const delta = chunk.choices[0].delta;
  const finishReason = chunk.choices[0].finish_reason;

  if (finishReason) {
    return null;
  }

  if (delta?.reasoning_content) {
    return `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: delta.reasoning_content },
    })}\n\n`;
  }

  if (delta?.content) {
    return `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: delta.content },
    })}\n\n`;
  }
  return null;
}

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
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  const blockStart = {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  };
  return (
    `event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`
  );
}

function convertOpenAINonStreamToAnthropic(openaiResp) {
  const choice = openaiResp.choices?.[0];
  const reasoning = choice?.message?.reasoning_content || "";
  const content = choice?.message?.content || "";
  const combined = reasoning
    ? `<thinking>\n${reasoning}\n</thinking>\n\n${content}`
    : content;
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: combined }],
    model: openaiResp.model || KIMI_MODEL,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

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
  console.log(`[proxy] ${body.model} → ${KIMI_MODEL} | stream=${openaiBody.stream} | msgs=${openaiBody.messages.length}`);

  try {
    const upstream = await forwardRequest(openaiBody);

    if (!openaiBody.stream) {
      let data = "";
      for await (const chunk of upstream) data += chunk;
      console.log(`[proxy] non-stream upstream status=${upstream.statusCode}`);
      if (upstream.statusCode !== 200) {
        console.error(`[proxy] upstream error body: ${data.slice(0, 500)}`);
        res.writeHead(upstream.statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: data.slice(0, 500) } }));
        return;
      }
      const parsed = JSON.parse(data);
      const anthropicResp = convertOpenAINonStreamToAnthropic(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(anthropicResp));
      return;
    }

    if (upstream.statusCode !== 200) {
      let errData = "";
      for await (const chunk of upstream) errData += chunk;
      console.error(`[proxy] stream upstream error status=${upstream.statusCode}: ${errData.slice(0, 500)}`);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(makeAnthropicStreamStart(KIMI_MODEL));
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: `[Proxy Error ${upstream.statusCode}]: ${errData.slice(0, 300)}` },
      })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(makeAnthropicStreamStart(KIMI_MODEL));

    let buffer = "";
    let inReasoning = false;
    let reasoningEnded = false;
    upstream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          const stop =
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n` +
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
          res.write(stop);
          res.end();
          return;
        }
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning_content && !inReasoning) {
            inReasoning = true;
            const tag = `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta", index: 0,
              delta: { type: "text_delta", text: "<thinking>\n" },
            })}\n\n`;
            res.write(tag);
          }
          if (delta?.content && inReasoning && !reasoningEnded) {
            reasoningEnded = true;
            const tag = `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta", index: 0,
              delta: { type: "text_delta", text: "\n</thinking>\n\n" },
            })}\n\n`;
            res.write(tag);
          }
          const sse = convertOpenAIChunkToAnthropicSSE(parsed, 0);
          if (sse) res.write(sse);
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
  console.log(`[proxy] Anthropic → Kimi (${KIMI_MODEL}) proxy listening on http://localhost:${PORT}`);
  console.log(`[proxy] Target: ${KIMI_API_BASE}/v1/chat/completions`);
  console.log(`[proxy] API Key: ${KIMI_API_KEY ? KIMI_API_KEY.slice(0, 8) + "..." : "NOT SET"}`);
});
