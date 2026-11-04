// AI Horde v2 client. Zero external dependencies; works in Bun and Node 20+.
const API_ROOT = "https://aihorde.net/api/v2"
const DEFAULT_AGENT = "aihorde-magpie:0.1.0:https://github.com/darkautism/aihorde-magpie"
const ANON_KEY = "0000000000"
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function integer(value, name, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}
function nonempty(value, name, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(`${name} must be a non-empty string of at most ${limit} characters`)
  }
  return value.trim()
}
function jobId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error("job_id must be an AI Horde UUID returned by generate_image")
  }
  return id
}
function safeImageUrl(value) {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}
function statusView(status, id) {
  return {
    job_id: id,
    done: status.done === true,
    faulted: status.faulted === true,
    possible: status.is_possible !== false,
    waiting: status.waiting ?? null,
    processing: status.processing ?? null,
    finished: status.finished ?? null,
    wait_time_seconds: status.wait_time ?? null,
    queue_position: status.queue_position ?? null,
    kudos: status.kudos ?? null,
  }
}
function imageView(status, id) {
  const raw = Array.isArray(status.generations) ? status.generations : []
  const images = raw.map((entry, index) => {
    const url = safeImageUrl(entry.img)
    return url ? {
      index: index + 1,
      url,
      markdown: `![AI Horde image ${index + 1}](${url})`,
      seed: entry.seed ?? null,
      model: entry.model ?? null,
      worker: entry.worker_name ?? null,
      censored: entry.censored === true,
    } : null
  }).filter(Boolean)
  return {
    ...statusView(status, id),
    images,
    markdown: images.map((img) => img.markdown).join("\n\n"),
    ...(raw.length > images.length ? { note: "One or more results had no safe HTTPS image link." } : {}),
  }
}
function buildPayload(args = {}, nsfwDefault = true) {
  const prompt = nonempty(args.prompt, "prompt", 4000)
  const negative = args.negative_prompt === undefined || args.negative_prompt === ""
    ? "" : nonempty(args.negative_prompt, "negative_prompt", 2000)
  if (negative.includes("###") || prompt.includes("###")) {
    throw new Error("Use negative_prompt rather than embedding the AI Horde ### separator in prompt")
  }
  const width = integer(args.width, "width", 512, 256, 1024)
  const height = integer(args.height, "height", 512, 256, 1024)
  if (width % 64 !== 0 || height % 64 !== 0) {
    throw new Error("width and height must be multiples of 64")
  }
  const params = {
    width,
    height,
    steps: integer(args.steps, "steps", 25, 1, 60),
    n: integer(args.count, "count", 1, 1, 4),
    cfg_scale: args.cfg_scale === undefined ? 7.5 : Number(args.cfg_scale),
  }
  if (!Number.isFinite(params.cfg_scale) || params.cfg_scale < 1 || params.cfg_scale > 20) {
    throw new Error("cfg_scale must be a number between 1 and 20")
  }
  if (args.seed !== undefined && args.seed !== "") {
    params.seed = nonempty(String(args.seed), "seed", 32)
  }
  if (args.sampler !== undefined && args.sampler !== "") {
    params.sampler_name = nonempty(args.sampler, "sampler", 60)
  }
  if (args.nsfw !== undefined && typeof args.nsfw !== "boolean") {
    throw new Error("nsfw must be boolean")
  }
  const payload = {
    prompt: negative ? `${prompt}###${negative}` : prompt,
    params,
    nsfw: args.nsfw ?? nsfwDefault,
    censor_nsfw: false,
    r2: true,
    shared: false,
  }
  if (args.model !== undefined && args.model !== "") {
    payload.models = [nonempty(args.model, "model", 200)]
  }
  return payload
}

export function createHordeClient({
  fetchImpl = fetch,
  apiKey = ANON_KEY,
  baseUrl = API_ROOT,
  clientAgent = DEFAULT_AGENT,
  requestTimeoutMs = 12000,
} = {}) {
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(baseUrl)) {
    throw new Error("AI Horde API URL must use HTTPS (localhost is allowed for testing)")
  }
  const root = baseUrl.replace(/\/+$/, "")
  async function request(path, { method = "GET", body, signal } = {}) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error("AI Horde request timed out")), requestTimeoutMs)
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "apikey": apiKey,
          "Client-Agent": clientAgent,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const raw = await response.text()
      let data
      try { data = raw ? JSON.parse(raw) : {} } catch { data = { message: raw.slice(0, 300) } }
      if (!response.ok) {
        const message = data.message || data.error || data.detail || response.statusText || "unknown error"
        const readable = typeof message === "string" ? message : JSON.stringify(message)
        throw new Error(`AI Horde HTTP ${response.status}: ${readable.slice(0, 600)}`)
      }
      return data
    } catch (err) {
      if (signal?.aborted) throw new Error("AI Horde request cancelled")
      if (controller.signal.aborted) throw new Error("AI Horde request timed out")
      throw err
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
    }
  }
  return {
    async submit(args, nsfwDefault = true, signal) {
      const payload = buildPayload(args, nsfwDefault)
      const result = await request("/generate/async", { method: "POST", body: payload, signal })
      if (typeof result.id !== "string" || !ID_PATTERN.test(result.id)) {
        throw new Error(`AI Horde did not return a valid generation id: ${JSON.stringify(result).slice(0, 500)}`)
      }
      return {
        job_id: result.id,
        message: "Queued. Use image_status with this job_id if it has not finished.",
        kudos_estimate: result.kudos ?? null,
        warnings: result.warnings ?? [],
      }
    },
    async check(id, signal) {
      id = jobId(id)
      const result = await request(`/generate/check/${id}`, { signal })
      return statusView(result, id)
    },
    async result(id, signal) {
      id = jobId(id)
      const result = await request(`/generate/status/${id}`, { signal })
      return imageView(result, id)
    },
    async cancel(id, signal) {
      id = jobId(id)
      await request(`/generate/status/${id}`, { method: "DELETE", signal })
      return { job_id: id, cancelled: true }
    },
    async models(limit = 20, search = "", signal) {
      const models = await request("/status/models?type=image", { signal })
      if (!Array.isArray(models)) throw new Error("AI Horde returned an unexpected models response")
      const term = search.trim().toLowerCase()
      return {
        models: models
          .filter((m) => typeof m?.name === "string" && (!term || m.name.toLowerCase().includes(term)))
          .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
          .slice(0, limit)
          .map((m) => ({ name: m.name, workers: m.count ?? null, queued: m.queued ?? null, eta_seconds: m.eta ?? null, max_pixels: m.max_pixels ?? null })),
        note: "Worker counts change continuously. Pass the exact model name to generate_image.",
      }
    },
  }
}

export async function waitForResult(client, id, seconds = 20, signal) {
  const max = integer(seconds, "wait_seconds", 20, 0, 35)
  if (max === 0) return { job_id: jobId(id), done: false, message: "Not waited. Use image_status to fetch results." }
  const deadline = Date.now() + max * 1000
  let last
  do {
    last = await client.check(id, signal)
    if (last.done || last.faulted) {
      const result = await client.result(id, signal)
      if (result.done && result.images?.length) {
        result.message = "Image generated. Display the markdown/image URL to the user."
      } else if (result.faulted) {
        result.message = "AI Horde reported a failed request; try another model or settings."
      }
      return result
    }
    if (!last.possible) {
      return { ...last, message: "No compatible workers available for this request; try another model or a smaller size." }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, Math.min(2500, remaining))
      const onAbort = () => { clearTimeout(timer); reject(new Error("AI Horde wait cancelled")) }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener("abort", onAbort, { once: true })
    })
  } while (Date.now() < deadline)
  return { ...last, message: "Still queued. Call image_status again with this job_id; do not submit the same prompt twice." }
}

export const _internal = { buildPayload, statusView, imageView, safeImageUrl, jobId }
