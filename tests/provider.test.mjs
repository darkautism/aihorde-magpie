import test from "node:test"
import assert from "node:assert/strict"
import { AIHordeProvider } from "../index.mjs"
import { DEFAULT_MODEL, API_ROOT, encodeModelName, decodeModelName, modelsFromWorkers, providerFetch, listWorkerModels } from "../lib/provider.mjs"
const ID = "11111111-2222-4333-8444-555555555555"
const IMAGE = "https://cdn.example.test/image.webp"
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status })
function fake(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const u = new URL(url)
    calls.push({ url, init })
    const k = `${init.method} ${u.pathname}`
    if (!routes[k]) throw Error(`Unexpected ${k}`)
    return typeof routes[k] === "function" ? routes[k](init) : routes[k]
  }
  return { fetchImpl, calls }
}
test("is a provider only, signs in anonymously without asking for a key", async () => {
  const plugin = await AIHordeProvider({ magpie: { option: () => true } })
  assert.equal(plugin.tool, undefined)
  assert.equal(plugin.auth.provider, "aihorde")
  const account = await plugin.auth.methods[0].authorize()
  assert.equal(plugin.auth.methods[0].keyless, true)
  assert.equal(account.key, "0000000000")
  assert.equal(plugin.auth.methods[1].type, "api")
  const config = {}
  await plugin.config(config)
  assert.equal(config.provider.aihorde.npm, "@ai-sdk/openai-compatible")
  assert.ok(config.provider.aihorde.models[DEFAULT_MODEL])
})
test("model IDs round-trip and match Magpie images-API keyword", () => {
  const model = "Pony Diffusion XL 🐴"
  const encoded = encodeModelName(model)
  assert.match(encoded, /stable-diffusion/)
  assert.equal(decodeModelName(encoded), model)
  assert.equal(decodeModelName(DEFAULT_MODEL), null)
  assert.throws(() => decodeModelName("../broken"))
})
test("active models are listed with real worker names plus fallback", () => {
  const items = modelsFromWorkers([{ name: "A", count: 4 }, { name: "B", count: 0 }, { name: "C", count: 1 }])
  assert.deepEqual(Object.keys(items), [DEFAULT_MODEL, encodeModelName("A"), encodeModelName("C")])
  assert.match(items[encodeModelName("A")].name, /4 workers/)
  assert.deepEqual(Object.keys(modelsFromWorkers(null)), [DEFAULT_MODEL])
})
test("provider fetch translates NSFW requests and returns OpenAI image URL", async () => {
  const { fetchImpl, calls } = fake({
    "POST /api/v2/generate/async": ok({ id: ID }),
    ["GET /api/v2/generate/check/" + ID]: ok({ done: true }),
    ["GET /api/v2/generate/status/" + ID]: ok({ generations: [{ img: IMAGE, seed: "123" }] }),
  })
  const response = await providerFetch(`${API_ROOT}/images/generations`, {
    method: "POST",
    body: JSON.stringify({ model: encodeModelName("Pony Diffusion XL"), prompt: "night sky anime", size: "768x512", n: 2 }),
  }, { fetchImpl, key: "mykey", nsfw: true })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, [{ url: IMAGE }])
  const submission = JSON.parse(calls[0].init.body)
  assert.equal(calls[0].init.headers.apikey, "mykey")
  assert.deepEqual(submission.models, ["Pony Diffusion XL"])
  assert.equal(submission.nsfw, true)
  assert.equal(submission.params.n, 2)
  assert.equal(submission.params.width, 768)
  assert.equal(submission.params.height, 512)
})
test("automatic default leaves model selection to AI Horde", async () => {
  const { fetchImpl, calls } = fake({
    "POST /api/v2/generate/async": ok({ id: ID }),
    ["GET /api/v2/generate/check/" + ID]: ok({ done: true }),
    ["GET /api/v2/generate/status/" + ID]: ok({ generations: [{ img: IMAGE }] }),
  })
  const res = await providerFetch(`${API_ROOT}/images/generations`, { body: JSON.stringify({ prompt: "castle" }) }, { fetchImpl, nsfw: false })
  assert.equal(res.status, 200)
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.models, undefined)
  assert.equal(sent.nsfw, false)
})
test("invalid inputs are rejected before upstream fetch", async () => {
  let calls = 0
  const fetchImpl = () => { calls++; throw Error("Should not contact Horde") }
  for (const body of [{ prompt: "" }, { prompt: "a", size: "513x512" }, { prompt: "a", n: 10 }, { prompt: "a", model: "invalid" }]) {
    const res = await providerFetch(`${API_ROOT}/images/generations`, { body: JSON.stringify(body) }, { fetchImpl })
    assert.equal(res.status, 400)
  }
  assert.equal(calls, 0)
})
test("does not expose chat or unsupported image edits", async () => {
  assert.equal((await providerFetch(`${API_ROOT}/images/edits`)).status, 400)
  assert.equal((await providerFetch(`${API_ROOT}/chat/completions`)).status, 404)
})
test("API failures surface instead of claiming success", async () => {
  const { fetchImpl } = fake({ "POST /api/v2/generate/async": ok({ message: "No matching workers" }, 400) })
  const res = await providerFetch(`${API_ROOT}/images/generations`, { body: JSON.stringify({ prompt: "castle" }) }, { fetchImpl })
  assert.equal(res.status, 502)
  assert.match((await res.json()).error.message, /No matching workers/)
})
test("queue waits only for a configured deadline", async () => {
  const { fetchImpl } = fake({
    "POST /api/v2/generate/async": ok({ id: ID }),
    ["GET /api/v2/generate/check/" + ID]: ok({ done: false, waiting: 1 }),
  })
  const res = await providerFetch(`${API_ROOT}/images/generations`, { body: JSON.stringify({ prompt: "castle" }) }, { fetchImpl, maxWaitMs: 10 })
  assert.equal(res.status, 504)
  assert.match((await res.json()).error.message, new RegExp(ID))
})
test("model discovery handles upstream failures", async () => {
  const { fetchImpl } = fake({ "GET /api/v2/status/models": ok({ error: "offline" }, 500) })
  const models = await listWorkerModels({ fetchImpl })
  assert.deepEqual(Object.keys(models), [DEFAULT_MODEL])
})
