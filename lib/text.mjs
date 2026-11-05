// OpenAI Chat Completions adapter for AI Horde's official OpenAI-compatible front.
// The front handles Horde queueing, model-specific chat templating and SSE.
export const TEXT_API_ROOT = "https://oai.aihorde.net/v1"
export const TEXT_MODEL_PREFIX = "horde-text--"

export class TextRequestError extends Error {}

function escapeName(name) {
  return encodeURIComponent(name).replaceAll("-", "%2D").replaceAll("%20", "-")
}

export function encodeTextModelName(name) {
  if (typeof name !== "string" || !name.trim() || name !== name.trim() || name.length > 250) {
    throw new TextRequestError("Invalid AI Horde text model name")
  }
  return TEXT_MODEL_PREFIX + escapeName(name)
}

export function decodeTextModelName(id) {
  if (typeof id !== "string" || !id.startsWith(TEXT_MODEL_PREFIX)) {
    throw new TextRequestError("Unsupported AI Horde text model")
  }
  const part = id.slice(TEXT_MODEL_PREFIX.length)
  let name
  try { name = decodeURIComponent(part.replaceAll("-", "%20")) }
  catch { throw new TextRequestError("Malformed AI Horde text model ID") }
  if (!name || name.length > 250 || escapeName(name) !== part) {
    throw new TextRequestError("Malformed AI Horde text model ID")
  }
  return name
}

const textModelTemplate = Object.freeze({
  limit: { context: 4096, output: 1024 },
  modalities: { input: ["text"], output: ["text"] },
  tool_call: false, // The worker pool is heterogeneous; tools are not guaranteed.
  reasoning: false,
  free: true,
})

export function textModelsFromApi(payload) {
  // The official front returns an OpenAI-shaped {object:"list", data:[{id,...}]}.
  const items = Array.isArray(payload?.data) ? payload.data : []
  const models = {}
  for (const item of items) {
    const name = typeof item?.id === "string" ? item.id.trim() : ""
    if (!name || name.length > 250 || item?.available === false) continue
    let id
    try { id = encodeTextModelName(name) } catch { continue }
    if (models[id]) continue
    const context = Number(item.context_length ?? item.context_window ?? item.max_context_length)
    const length = Number.isSafeInteger(context) && context >= 256 && context <= 1048576 ? context : 4096
    models[id] = {
      ...textModelTemplate, id,
      name: (typeof item.name === "string" && item.name.trim()) || name,
      limit: { context: length, output: Math.min(1024, length) },
    }
  }
  return models
}

export async function listTextModels({ key = "0000000000", clientAgent, fetchImpl = fetch, apiRoot = TEXT_API_ROOT, signal } = {}) {
  // A hung text front must not hold up the image model picker.
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("Horde text model discovery timed out")), 10_000)
  try {
    const response = await fetchImpl(`${apiRoot}/models`, {
      method: "GET", signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, ...(clientAgent ? { "client-agent": clientAgent } : {}) },
    })
    if (!response.ok) return {}
    return textModelsFromApi(await response.json())
  } catch {
    // Do not invent offline text models when the live model list is unavailable.
    return {}
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

export async function forwardChat(request, { key = "0000000000", clientAgent, fetchImpl = fetch, apiRoot = TEXT_API_ROOT, signal } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TextRequestError("Expected an OpenAI chat completions request")
  }
  const model = decodeTextModelName(request.model)
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new TextRequestError("messages must be a nonempty array")
  }
  if (!request.messages.every(m => m && typeof m === "object" && typeof m.role === "string")) {
    throw new TextRequestError("Invalid chat message")
  }
  // Pass through the OpenAI chat contract as-is, including stream, tools and
  // sampling options. The upstream returns either JSON or true streaming SSE.
  return fetchImpl(`${apiRoot}/chat/completions`, {
    method: "POST", signal,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: request.stream === true ? "text/event-stream" : "application/json",
      ...(clientAgent ? { "client-agent": clientAgent } : {}),
    },
    body: JSON.stringify({ ...request, model }),
  })
}
