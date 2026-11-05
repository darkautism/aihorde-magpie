import test from "node:test"
import assert from "node:assert/strict"
import { AIHordeProvider } from "../index.mjs"
import { DEFAULT_MODEL, API_ROOT, encodeModelName, decodeModelName, modelsFromWorkers, providerFetch, listWorkerModels } from "../lib/provider.mjs"
const ID = "11111111-2222-4333-8444-555555555555"
const IMAGE = "https://cdn.example.test/image.webp"
const SAMPLING = { steps: 30, cfg_scale: 5, sampler_name: "k_euler_a", scheduler: "karras", clip_skip: 2, tiling: false }
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
test("model IDs are stable and display names are separate", () => {
  const name = "Pony Diffusion XL 🐴"
  const encoded = encodeModelName(name)
  assert.equal(encoded, "stable-diffusion-horde--Pony-Diffusion-XL-%F0%9F%90%B4")
  assert.equal(decodeModelName(encoded), name)
  assert.equal(decodeModelName(DEFAULT_MODEL), null)
  assert.equal(decodeModelName("Pony-Diffusion-XL-%F0%9F%90%B4--stable-diffusion"), name)
  assert.equal(decodeModelName("stable-diffusion-horde-UG9ueSBEaWZmdXNpb24gWEw"), "Pony Diffusion XL")
  assert.equal(decodeModelName(encodeModelName("SDXL: Pony/Illustrious-v1.0_test")), "SDXL: Pony/Illustrious-v1.0_test")
  assert.equal(decodeModelName(encodeModelName("Foo-Bar")), "Foo-Bar")
  assert.notEqual(encodeModelName("Foo Bar"), encodeModelName("Foo-Bar"))
  assert.throws(() => decodeModelName("stable-diffusion-horde--invalid%ZZ"), /Malformed/)
})
test("active models are all listed with clean names, no 12-model cap", () => {
  const workers = Array.from({ length: 30 }, (_, i) => ({ name: "Model "+i, count: 31-i }))
  workers.push({ name: "Pony Diffusion XL", count: 2 })
  const models = modelsFromWorkers(workers, [])
  assert.equal(Object.keys(models).length, 32)
  assert.deepEqual(Object.keys(models).slice(0,3), [DEFAULT_MODEL, encodeModelName("Pony Diffusion XL"), encodeModelName("Model 0")])
  assert.equal(models[encodeModelName("Pony Diffusion XL")].name, "Pony Diffusion XL")
  assert.equal(models[encodeModelName("Model 0")].name, "Model 0")
  assert.ok(modelsFromWorkers(null)[encodeModelName("HolyMix ILXL")])
  assert.match(modelsFromWorkers(null)[encodeModelName("HolyMix ILXL")].name, /availability unknown/)
})
test("HolyMix ILXL and every registered offline model remain discoverable", () => {
  const online = [{ name: "Nova Flat XL", count: 2 }]
  const models = modelsFromWorkers(online)
  assert.equal(models[encodeModelName("Nova Flat XL")].name, "Nova Flat XL")
  assert.ok(models[encodeModelName("HolyMix ILXL")], "HolyMix ILXL is present in the official registry")
  assert.match(models[encodeModelName("HolyMix ILXL")].name, /offline.*0 workers/)
  assert.ok(Object.keys(models).length > 100)
  // Online checkpoints that also appear in the catalog are not duplicated.
  assert.equal(Object.keys(models).filter(id => id === encodeModelName("Nova Flat XL")).length, 1)
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
  for (const [name, value] of Object.entries(SAMPLING)) assert.equal(submission.params[name], value)
  assert.equal("seed" in submission.params, false, "Unspecified seed stays random")
})
test("named HolyMix requests cannot silently return a different Horde checkpoint", async () => {
  const { fetchImpl, calls } = fake({
    "POST /api/v2/generate/async": ok({ id: ID }),
    ["GET /api/v2/generate/check/" + ID]: ok({ done: true }),
    ["GET /api/v2/generate/status/" + ID]: ok({ generations: [{ img: IMAGE, model: "stable_diffusion", worker_name: "worker-x" }] }),
  })
  const res = await providerFetch(`${API_ROOT}/images/generations`, {
    method: "POST", body: JSON.stringify({ prompt: "anime palace", model: encodeModelName("HolyMix ILXL") }),
  }, { fetchImpl })
  const submission = JSON.parse(calls[0].init.body)
  assert.deepEqual(submission.models, ["HolyMix ILXL"])
  assert.equal(res.status, 502)
  const body = await res.json()
  assert.match(body.error.message, /requested "HolyMix ILXL"/)
  assert.match(body.error.message, /generated "stable_diffusion"/)
  assert.match(body.error.message, /worker-x/)
  assert.match(body.error.message, new RegExp(ID))
})
test("named HolyMix requests accept matching Horde model metadata", async () => {
  const { fetchImpl } = fake({
    "POST /api/v2/generate/async": ok({ id: ID }),
    ["GET /api/v2/generate/check/" + ID]: ok({ done: true }),
    ["GET /api/v2/generate/status/" + ID]: ok({ generations: [{ img: IMAGE, model: "HolyMix ILXL", worker_name: "worker-y" }] }),
  })
  const res = await providerFetch(`${API_ROOT}/images/generations`, {
    method: "POST", body: JSON.stringify({ prompt: "anime palace", model: encodeModelName("HolyMix ILXL") }),
  }, { fetchImpl })
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).data, [{ url: IMAGE }])
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
  assert.deepEqual([sent.params.width, sent.params.height], [576, 576])
})
test("anonymous generation preserves a caller-specified image size", async () => {
  const { fetchImpl, calls } = fake({
    "POST /api/v2/generate/async": ok({ id: ID }),
    ["GET /api/v2/generate/check/" + ID]: ok({ done: true }),
    ["GET /api/v2/generate/status/" + ID]: ok({ generations: [{ img: IMAGE }] }),
  })
  const res = await providerFetch(`${API_ROOT}/images/generations`, {
    method: "POST", body: JSON.stringify({ prompt: "portrait", size: "1024x1024" }),
  }, { fetchImpl, key: "0000000000" })
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(calls[0].init.body).params, { width: 1024, height: 1024, n: 1, ...SAMPLING })
})
test("personal API key keeps explicit resolution and defaults to 576x576", async () => {
  const { fetchImpl, calls } = fake({
    "POST /api/v2/generate/async": ok({ id: ID }),
    ["GET /api/v2/generate/check/" + ID]: ok({ done: true }),
    ["GET /api/v2/generate/status/" + ID]: ok({ generations: [{ img: IMAGE }] }),
  })
  const res = await providerFetch(`${API_ROOT}/images/generations`, {
    method: "POST", body: JSON.stringify({ prompt: "portrait" }),
  }, { fetchImpl, key: "user-personal-key" })
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(calls[0].init.body).params.width, 576)
  assert.equal(JSON.parse(calls[0].init.body).params.height, 576)
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
test("image+text multipart edits become AI Horde img2img jobs", async () => {
  const { fetchImpl, calls } = fake({
    "POST /api/v2/generate/async": ok({ id: ID }),
    ["GET /api/v2/generate/check/" + ID]: ok({ done: true }),
    ["GET /api/v2/generate/status/" + ID]: ok({ generations: [{ img: IMAGE }] }),
  })
  const form = new FormData()
  form.set("prompt", "red costume")
  form.set("model", encodeModelName("Pony Diffusion XL"))
  form.set("image", new File([Buffer.from("fakepng")], "reference.png", { type: "image/png" }))
  form.set("denoising_strength", "0.55")
  form.set("size", "448x576")
  const response = await providerFetch(`${API_ROOT}/images/edits`, { method: "POST", body: form }, { fetchImpl, nsfw: true })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, [{ url: IMAGE }])
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.source_processing, "img2img")
  assert.equal(sent.params.denoising_strength, 0.55)
  assert.equal(sent.source_image, Buffer.from("fakepng").toString("base64"))
  assert.equal(sent.nsfw, true)
  assert.equal(sent.params.width, 448)
  assert.equal(sent.params.height, 576)
  for (const [name, value] of Object.entries(SAMPLING)) assert.equal(sent.params[name], value)
})
test("JSON image+mask edits become inpainting jobs", async () => {
  const { fetchImpl, calls } = fake({
    "POST /api/v2/generate/async": ok({ id: ID }),
    ["GET /api/v2/generate/check/" + ID]: ok({ done: true }),
    ["GET /api/v2/generate/status/" + ID]: ok({ generations: [{ img: IMAGE }] }),
  })
  const response = await providerFetch(`${API_ROOT}/images/edits`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({prompt:"redraw outfit",image:"https://example.org/source.png",mask:"data:image/png;base64,YWJj"}),
  }, { fetchImpl })
  assert.equal(response.status, 200)
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.source_image, "https://example.org/source.png")
  assert.equal(sent.source_mask, "YWJj")
  assert.equal(sent.source_processing, "inpainting")
})
test("rejects missing image and unsupported chat requests", async () => {
  const result = await providerFetch(`${API_ROOT}/images/edits`, {
    method: "POST", headers: {"content-type":"application/json"},
    body: JSON.stringify({ prompt: "a" }),
  })
  assert.equal(result.status, 400)
  assert.equal((await providerFetch(`${API_ROOT}/chat/completions`)).status, 400)
  assert.equal((await providerFetch(`${API_ROOT}/unknown`)).status, 404)
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
  assert.ok(Object.keys(models).length > 100)
  assert.ok(models[encodeModelName("HolyMix ILXL")])
  assert.match(models[encodeModelName("HolyMix ILXL")].name, /availability unknown/)
})
