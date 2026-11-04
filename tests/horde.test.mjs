import test from "node:test"
import assert from "node:assert/strict"
import { createHordeClient, waitForResult, _internal } from "../lib/horde.mjs"
import { AIHordeTools } from "../index.mjs"

const ID = "11111111-2222-4333-8444-555555555555"
const IMG = "https://example.com/generated-image.webp"
const ok = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })

function fakeClient(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const path = new URL(url).pathname
    const handler = routes[`${init.method} ${path}`]
    if (!handler) throw new Error(`Unexpected call ${init.method} ${path}`)
    return typeof handler === "function" ? handler(init) : handler
  }
  return { client: createHordeClient({ fetchImpl, baseUrl: "http://localhost:9876/api/v2" }), calls }
}

test("the plugin exports four valid zero-dependency tools", async () => {
  const plugin = await AIHordeTools({}, { nsfwDefault: false })
  assert.deepEqual(Object.keys(plugin.tool).sort(), ["cancel_image", "generate_image", "image_status", "list_models"])
  for (const tool of Object.values(plugin.tool)) {
    assert.equal(typeof tool.execute, "function")
    assert.equal(tool.args.type, "object")
    assert.equal(typeof tool.description, "string")
  }
})

test("submission uses correct API, anon key, negative prompt, NSFW and dimensions", async () => {
  const { client, calls } = fakeClient({ "POST /api/v2/generate/async": ok({ id: ID, kudos: 5 }, 202) })
  const result = await client.submit({ prompt: "anime moon shrine", negative_prompt: "blurred", nsfw: true, width: 640, height: 512, count: 2, steps: 30, model: "an-available-model" })
  assert.equal(result.job_id, ID)
  const call = calls[0]
  assert.equal(call.init.headers.apikey, "0000000000")
  assert.match(call.init.headers["Client-Agent"], /aihorde-magpie/)
  const body = JSON.parse(call.init.body)
  assert.equal(body.prompt, "anime moon shrine###blurred")
  assert.deepEqual(body.models, ["an-available-model"])
  assert.equal(body.params.width, 640)
  assert.equal(body.params.n, 2)
  assert.equal(body.nsfw, true)
  assert.equal(body.r2, true)
})

test("rejects invalid dimensions and dangerous/invalid params before network access", () => {
  assert.throws(() => _internal.buildPayload({ prompt: "a", width: 513 }), /multiples of 64/)
  assert.throws(() => _internal.buildPayload({ prompt: "a", count: 5 }), /count/)
  assert.throws(() => _internal.buildPayload({ prompt: "a", nsfw: "yes" }), /nsfw/)
  assert.throws(() => _internal.buildPayload({ prompt: "a###b" }), /separator/)
  assert.throws(() => _internal.buildPayload({ prompt: "a", cfg_scale: -4 }), /cfg_scale/)
  assert.throws(() => _internal.jobId("../admin"), /UUID/)
})

test("queued jobs return fast and preserve the job ID for subsequent status checks", async () => {
  const { client, calls } = fakeClient({ ["GET /api/v2/generate/check/" + ID]: ok({ done: false, wait_time: 80, queue_position: 42, waiting: 1, processing: 0 }) })
  const result = await waitForResult(client, ID, 0)
  assert.equal(result.job_id, ID)
  assert.equal(result.done, false)
  assert.equal(calls.length, 0)
  const checked = await client.check(ID)
  assert.equal(checked.queue_position, 42)
  assert.equal(checked.wait_time_seconds, 80)
})

test("finished jobs return HTTPS picture URLs, markdown preview and metadata", async () => {
  const { client } = fakeClient({
    ["GET /api/v2/generate/check/" + ID]: ok({ done: true, finished: 1 }),
    ["GET /api/v2/generate/status/" + ID]: ok({ done: true, finished: 1, generations: [{ img: IMG, seed: "123", model: "anime-model", worker_name: "worker-1" }] }),
  })
  const result = await waitForResult(client, ID, 10)
  assert.equal(result.done, true)
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].url, IMG)
  assert.equal(result.images[0].model, "anime-model")
  assert.equal(result.markdown, `![AI Horde image 1](${IMG})`)
})

test("rejects unsafe URL schemes in worker-provided image URLs", () => {
  const result = _internal.imageView({ done: true, generations: [{ img: "javascript:alert(1)" }, { img: "data:image/png;base64,AAA" }, { img: IMG }] }, ID)
  assert.equal(result.images.length, 1)
  assert.match(result.note, /no safe HTTPS/)
})

test("lists only image models, sorted and search-filtered", async () => {
  const { client, calls } = fakeClient({
    "GET /api/v2/status/models": ok([{ name: "Anime XXX", count: 1 }, { name: "General", count: 100 }, { name: "anime turbo", count: 3 }]),
  })
  const models = await client.models(2, "anime")
  assert.deepEqual(models.models.map((m) => m.name), ["anime turbo", "Anime XXX"])
  assert.match(calls[0].url, /\?type=image$/)
})

test("cancellation calls DELETE on status endpoint", async () => {
  const { client, calls } = fakeClient({ ["DELETE /api/v2/generate/status/" + ID]: ok({ message: "cancelled" }) })
  assert.equal((await client.cancel(ID)).cancelled, true)
  assert.equal(calls[0].init.method, "DELETE")
})

test("API error message is surfaced instead of claiming success", async () => {
  const { client } = fakeClient({ "POST /api/v2/generate/async": ok({ message: "no workers match" }, 400) })
  await assert.rejects(() => client.submit({ prompt: "moon" }), /AI Horde HTTP 400: no workers match/)
})
