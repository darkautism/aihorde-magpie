// AI Horde image-only provider adapter for Magpie / OpenCode plugin hosts.
// Translates OpenAI /images/generations to AI Horde async queue + polling.
export const PROVIDER_ID = "aihorde"
export const API_ROOT = "https://aihorde.net/api/v2"
export const CLIENT_AGENT = "aihorde-magpie:0.2.1:https://github.com/darkautism/aihorde-magpie"
export const ANONYMOUS_KEY = "0000000000"
export const DEFAULT_MODEL = "stable-diffusion-horde"
const MODEL_PREFIX = "stable-diffusion-horde-"
const MAX_WAIT_MS = 115_000
const FETCH_TIMEOUT_MS = 20_000
const POLL_MS = 3_000

// A model ID must contain "stable-diffusion" for Magpie's image picker.
// Keep original Horde checkpoint spelling (including punctuation) via reversible
// percent escapes, but render ordinary spaces as hyphens for readable IDs.
const READABLE_PREFIX = "stable-diffusion-horde--"
export function encodeModelName(name) {
  if (typeof name !== "string" || !name.trim() || name.length > 150) throw new Error("Invalid AI Horde model name")
  return READABLE_PREFIX + encodeURIComponent(name).replaceAll("-", "%2D").replaceAll("%20", "-")
}
export function decodeModelName(id) {
  if (id === DEFAULT_MODEL) return null // Let AI Horde select a compatible checkpoint.
  if (typeof id !== "string") throw new Error("Unsupported AI Horde model")
  if (id.startsWith(READABLE_PREFIX)) {
    let name
    try { name = decodeURIComponent(id.slice(READABLE_PREFIX.length).replaceAll("-", "%20")) }
    catch { throw new Error("Malformed AI Horde model ID") }
    if (!name || name.length > 150 || encodeModelName(name) !== id) throw new Error("Malformed AI Horde model ID")
    return name
  }
  // Compatibility with model IDs created by v0.2.0. New selections do not use Base64.
  if (!id.startsWith(MODEL_PREFIX)) throw new Error("Unsupported AI Horde model")
  const suffix = id.slice(MODEL_PREFIX.length)
  if (!/^[a-zA-Z0-9_-]{2,200}$/.test(suffix)) throw new Error("Malformed legacy AI Horde model ID")
  const name = Buffer.from(suffix, "base64url").toString("utf8")
  if (!name || name.length > 150 || MODEL_PREFIX + Buffer.from(name, "utf8").toString("base64url") !== id) {
    throw new Error("Malformed legacy AI Horde model ID")
  }
  return name
}
const modelTemplate = Object.freeze({
  limit: { context: 4096, output: 4096 },
  modalities: { input: ["text"], output: ["image"] },
  tool_call: false,
  reasoning: false,
  free: true,
})
export function defaultModels() {
  return {
    [DEFAULT_MODEL]: { ...modelTemplate, id: DEFAULT_MODEL, name: "AI Horde · Automatic (image)" },
  }
}
export function modelsFromWorkers(workers, limit = 12) {
  const models = defaultModels()
  if (!Array.isArray(workers)) return models
  const seen = new Set()
  const online = workers
    .filter(x => typeof x?.name === "string" && x.name.trim() && Number(x.count) > 0)
    .sort((a, b) => Number(b.count) - Number(a.count))
  // Keep popular anime checkpoints discoverable even if general-purpose models
  // happen to have more workers online. Then fill the rest by worker count.
  const anime = /pony|illustrious|anime|animagine|anything|hassaku|noobai|novelai|pdxl|wai[-_ ]/i
  const featured = online.filter(x => anime.test(x.name)).slice(0, Math.min(6, limit))
  for (const worker of [...featured, ...online]) {
    if (seen.size >= limit) break
    const name = worker.name.trim()
    if (name.length > 150 || seen.has(name)) continue
    seen.add(name)
    const id = encodeModelName(name)
    models[id] = {
      ...modelTemplate, id,
      name: `AI Horde · ${name} (${worker.count} workers)`,
    }
  }
  return models
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } })
}
function error(message, status = 502) {
  return json({ error: { message: String(message).slice(0, 700), type: "aihorde_error", code: status } }, status)
}
function timeoutSignal(timeoutMs, parent) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("AI Horde request timeout")), timeoutMs)
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); parent?.removeEventListener("abort", abort) } }
}
async function horde(path, { method = "GET", body, key, signal, fetchImpl, apiRoot = API_ROOT }) {
  const { signal: scoped, cleanup } = timeoutSignal(FETCH_TIMEOUT_MS, signal)
  try {
    const response = await fetchImpl(`${apiRoot}${path}`, {
      method, signal: scoped,
      headers: { apikey: key, "client-agent": CLIENT_AGENT, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    let data
    const raw = await response.text()
    try { data = raw ? JSON.parse(raw) : {} } catch { data = { message: raw.slice(0, 200) } }
    if (!response.ok) {
      const reason = data.message ?? data.error ?? response.statusText
      throw new Error(`AI Horde HTTP ${response.status}: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`)
    }
    return data
  } finally { cleanup() }
}
function parseSize(size) {
  if (size === undefined || size === "auto") return [512, 512]
  const match = /^([0-9]{3,4})x([0-9]{3,4})$/.exec(size)
  if (!match) throw new Error("Unsupported image size. Use 512x512, 768x768, 1024x1024 etc.")
  const [width, height] = [Number(match[1]), Number(match[2])]
  if ([width, height].some(x => x < 256 || x > 1024 || x % 64 !== 0)) {
    throw new Error("Image dimensions must be multiples of 64 from 256 to 1024")
  }
  return [width, height]
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("Image generation cancelled"))
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve() }, ms)
  const abort = () => { clearTimeout(timer); reject(new Error("Image generation cancelled")) }
  signal?.addEventListener("abort", abort, { once: true })
})
export async function generateImage(request, { key = ANONYMOUS_KEY, nsfw = true, fetchImpl = fetch, signal, apiRoot = API_ROOT, maxWaitMs = MAX_WAIT_MS } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return error("Expected an OpenAI images request", 400)
  const { prompt, model = DEFAULT_MODEL } = request
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) return error("prompt must be a nonempty string under 4000 characters", 400)
  if (prompt.includes("###")) return error("Do not embed ### in prompt", 400)
  let modelName, width, height
  try { modelName = decodeModelName(model); [width, height] = parseSize(request.size) }
  catch (e) { return error(e.message, 400) }
  const n = request.n ?? 1
  if (!Number.isInteger(n) || n < 1 || n > 4) return error("n must be an integer from 1 to 4", 400)
  // Standard OpenAI APIs do not have an NSFW field; the plugin's provider switch controls it.
  const body = {
    prompt: prompt.trim(),
    params: { width, height, n, steps: 25 },
    nsfw, censor_nsfw: false, r2: true, shared: false,
    ...(modelName ? { models: [modelName] } : {}),
  }
  let jobId
  try {
    const submitted = await horde("/generate/async", { method: "POST", body, key, signal, fetchImpl, apiRoot })
    jobId = submitted.id
    if (typeof jobId !== "string" || !/^[a-f\d-]{32,36}$/i.test(jobId)) return error("AI Horde returned an invalid generation ID")
    const deadline = Date.now() + maxWaitMs
    let status
    while (Date.now() < deadline) {
      status = await horde(`/generate/check/${encodeURIComponent(jobId)}`, { key, signal, fetchImpl, apiRoot })
      if (status.faulted) return error(`AI Horde job failed (${jobId})`)
      if (status.is_possible === false) return error(`No AI Horde workers can satisfy this request (${jobId}). Try another model or smaller size.`, 503)
      if (status.done) {
        const result = await horde(`/generate/status/${encodeURIComponent(jobId)}`, { key, signal, fetchImpl, apiRoot })
        const imgs = (result.generations ?? [])
          .map(x => x.img)
          .filter(url => { try { return new URL(url).protocol === "https:" } catch { return false } })
        if (!imgs.length) return error(`AI Horde completed (${jobId}) but returned no image URLs`)
        return json({ created: Math.floor(Date.now()/1000), data: imgs.map(url => ({ url })) })
      }
      await sleep(Math.min(POLL_MS, Math.max(50, deadline - Date.now())), signal)
    }
    // A synchronous images API has no standard job polling endpoint.
    // Keep the job alive at AI Horde; show ID in error so it can be inspected manually.
    return error(`AI Horde job ${jobId} is still queued after ${Math.round(maxWaitMs/1000)} seconds. The image may finish later. Try a more available model or your personal AI Horde key.`, 504)
  } catch (e) {
    if (signal?.aborted) return error("Image generation request was cancelled", 499)
    return error(e instanceof Error ? e.message : String(e), 502)
  }
}
export async function providerFetch(input, init = {}, { key = ANONYMOUS_KEY, nsfw = true, fetchImpl = fetch, apiRoot = API_ROOT, maxWaitMs } = {}) {
  const url = new URL(typeof input === "string" ? input : input.url)
  const signal = init.signal ?? (typeof input === "object" ? input.signal : undefined)
  if (url.pathname.endsWith("/images/generations")) {
    if (init.method && init.method.toUpperCase() !== "POST") return error("Only POST is supported", 405)
    let request
    try { request = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)) }
    catch { return error("Expected JSON image generation request", 400) }
    return generateImage(request, { key, nsfw, fetchImpl, signal, apiRoot, maxWaitMs })
  }
  if (url.pathname.endsWith("/images/edits")) return error("AI Horde Magpie provider currently supports text-to-image only", 400)
  return error("AI Horde is an image-only provider; chat completions are not supported", 404)
}
export async function listWorkerModels({ fetchImpl = fetch, key = ANONYMOUS_KEY, apiRoot = API_ROOT, signal } = {}) {
  try {
    const result = await horde("/status/models?type=image", { fetchImpl, key, apiRoot, signal })
    return modelsFromWorkers(result)
  } catch {
    return defaultModels()
  }
}
