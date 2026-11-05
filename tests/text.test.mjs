import test from "node:test"
import assert from "node:assert/strict"
import { AIHordeProvider } from "../index.mjs"
import { API_ROOT, DEFAULT_MODEL, providerFetch } from "../lib/provider.mjs"
import {
  TEXT_API_ROOT, encodeTextModelName, decodeTextModelName,
  textModelsFromApi, listTextModels, forwardChat,
} from "../lib/text.mjs"

const JSONResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
})
const MODEL_NAME = "koboldcpp/Qwen3-4B"
const MODEL_ID = encodeTextModelName(MODEL_NAME)

test("text model IDs are reversible and distinct from the image picker", () => {
  assert.equal(MODEL_ID, "horde-text--koboldcpp%2FQwen3%2D4B")
  assert.equal(decodeTextModelName(MODEL_ID), MODEL_NAME)
  assert.equal(decodeTextModelName(encodeTextModelName("Worker Model (v2)/中文")), "Worker Model (v2)/中文")
  assert.notEqual(encodeTextModelName("Model-A"), encodeTextModelName("Model A"))
  assert.throws(() => decodeTextModelName(DEFAULT_MODEL), /Unsupported/)
  assert.throws(() => decodeTextModelName("horde-text--bad%ZZ"), /Malformed/)
  assert.throws(() => decodeTextModelName("horde-text--bad%2dmodel"), /Malformed/)
})

test("official OpenAI model list becomes text-only Magpie models", () => {
  const models = textModelsFromApi({ object: "list", data: [
    { id: MODEL_NAME, context_length: 8192 },
    { id: "koboldcpp/L3-8B-Stheno-v3.2", name: "Stheno 8B", context_length: 16384 },
    { id: MODEL_NAME },
    { id: "offline", available: false },
    { id: "" },
    { id: 23 },
  ] })
  assert.deepEqual(Object.keys(models), [MODEL_ID, encodeTextModelName("koboldcpp/L3-8B-Stheno-v3.2")])
  assert.deepEqual(models[MODEL_ID].modalities, { input: ["text"], output: ["text"] })
  assert.deepEqual(models[MODEL_ID].limit, { context: 8192, output: 1024 })
  assert.equal(models[MODEL_ID].tool_call, false)
  assert.equal(models[MODEL_ID].reasoning, false)
  assert.equal(models[encodeTextModelName("koboldcpp/L3-8B-Stheno-v3.2")].name, "Stheno 8B")
  assert.deepEqual(textModelsFromApi({ error: "broken" }), {})
})

test("text discovery calls official Horde OpenAI front with same anonymous API key", async () => {
  let called
  const models = await listTextModels({
    fetchImpl: async (url, init) => {
      called = { url, init }
      return JSONResponse({ data: [{ id: MODEL_NAME }] })
    },
    clientAgent: "test-client:1:test",
  })
  assert.equal(called.url, `${TEXT_API_ROOT}/models`)
  assert.equal(called.init.headers.authorization, "Bearer 0000000000")
  assert.equal(called.init.headers["client-agent"], "test-client:1:test")
  assert.ok(models[MODEL_ID])
})

test("model discovery handles upstream errors without fabricating models", async () => {
  assert.deepEqual(await listTextModels({ fetchImpl: async () => JSONResponse({ message: "offline" }, 503) }), {})
  assert.deepEqual(await listTextModels({ fetchImpl: async () => { throw Error("network down") } }), {})
})

test("non-streamed chat forwards actual Horde model, messages, settings and key", async () => {
  let captured
  const mock = async (url, init) => {
    captured = { url, init }
    return JSONResponse({
      id: "chatcmpl-example", object: "chat.completion", model: MODEL_NAME,
      choices: [{ index: 0, message: { role: "assistant", content: "anime palace" }, finish_reason: "stop" }],
    })
  }
  const user = { role: "user", content: "請描述這場景" }
  const system = { role: "system", content: "Write an English illustration prompt." }
  const res = await providerFetch(`${API_ROOT}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: MODEL_ID, messages: [system, user],
      stream: false, temperature: 0.4, top_p: 0.92, max_tokens: 256,
    }),
  }, { key: "registered-key", fetchImpl: mock })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).choices[0].message.content, "anime palace")
  assert.equal(captured.url, `${TEXT_API_ROOT}/chat/completions`)
  assert.equal(captured.init.headers.authorization, "Bearer registered-key")
  assert.match(captured.init.headers["client-agent"], /^aihorde-magpie:/)
  assert.deepEqual(JSON.parse(captured.init.body), {
    model: MODEL_NAME, messages: [system, user],
    stream: false, temperature: 0.4, top_p: 0.92, max_tokens: 256,
  })
})

test("streaming OpenAI SSE is passed through without buffering or changing chunks", async () => {
  const sse = [
    'data: {"id":"a","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
    "",
    'data: {"id":"a","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n")
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse))
      controller.close()
    },
  })
  let captured
  const upstream = new Response(stream, { headers: { "content-type": "text/event-stream" } })
  const res = await providerFetch(`${API_ROOT}/chat/completions`, {
    method: "POST", body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "Hello" }], stream: true }),
  }, { fetchImpl: (url, init) => { captured = { url, init }; return Promise.resolve(upstream) } })
  assert.equal(res, upstream, "do not buffer or rewrite the upstream Response")
  assert.equal(res.headers.get("content-type"), "text/event-stream")
  assert.equal(captured.init.headers.accept, "text/event-stream")
  assert.equal(JSON.parse(captured.init.body).model, MODEL_NAME)
  assert.equal(await res.text(), sse)
})

test("tool message shape passes through (worker support remains provider-specific)", async () => {
  const messages = [
    { role: "assistant", content: null, tool_calls: [{ id: "tool-1", type: "function", function: { name: "search", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "tool-1", content: "{}" },
    { role: "user", content: "Next" },
  ]
  let payload
  await forwardChat({ model: MODEL_ID, messages, tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }] }, {
    fetchImpl: async (_url, init) => { payload = JSON.parse(init.body); return JSONResponse({ choices: [] }) },
  })
  assert.deepEqual(payload.messages, messages)
  assert.equal(payload.tools[0].function.name, "search")
})

test("bad chat payloads are rejected before contacting the Horde front", async () => {
  let called = false
  const fetchImpl = async () => { called = true; throw Error("should never call") }
  for (const body of [
    { model: DEFAULT_MODEL, messages: [{ role: "user", content: "hello" }] },
    { model: MODEL_ID, messages: [] },
    { model: MODEL_ID, messages: ["bad"] },
    { model: "horde-text--bad%ZZ", messages: [{ role: "user", content: "hello" }] },
  ]) {
    const res = await providerFetch(`${API_ROOT}/chat/completions`, { body: JSON.stringify(body) }, { fetchImpl })
    assert.equal(res.status, 400)
  }
  assert.equal(called, false)
  const badJson = await providerFetch(`${API_ROOT}/chat/completions`, { body: "invalid json" }, { fetchImpl })
  assert.equal(badJson.status, 400)
})

test("provider propagates Horde front HTTP failures and maps network failures", async () => {
  const request = { body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "test" }] }) }
  const denied = await providerFetch(`${API_ROOT}/chat/completions`, request, {
    fetchImpl: async () => JSONResponse({ detail: "No eligible chat worker" }, 503),
  })
  assert.equal(denied.status, 503)
  assert.match((await denied.json()).detail, /No eligible/)
  const offline = await providerFetch(`${API_ROOT}/chat/completions`, request, {
    fetchImpl: async () => { throw Error("DNS unavailable") },
  })
  assert.equal(offline.status, 502)
  assert.match((await offline.json()).error.message, /DNS unavailable/)
})

test("provider model hook includes image and text offerings without conflating their formats", async () => {
  const plugin = await AIHordeProvider({ magpie: { option: () => true } })
  const config = {}
  await plugin.config(config)
  assert.equal(config.provider.aihorde.npm, "@ai-sdk/openai-compatible")
  assert.equal(config.provider.aihorde.name, "AI Horde (images + text)")
  const before = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes("/status/models?type=image")) return JSONResponse([{ name: "HolyMix ILXL", count: 2 }])
    if (String(url).includes("/v1/models")) return JSONResponse({ data: [{ id: MODEL_NAME }] })
    throw Error(`Unexpected model lookup: ${url}`)
  }
  try {
    const models = await plugin.provider.models({ models: config.provider.aihorde.models }, { auth: { type: "api", key: "test-key" } })
    assert.ok(models[DEFAULT_MODEL])
    assert.deepEqual(models[DEFAULT_MODEL].modalities.output, ["image"])
    assert.ok(models[MODEL_ID])
    assert.deepEqual(models[MODEL_ID].modalities.output, ["text"])
  } finally {
    globalThis.fetch = before
  }
})
