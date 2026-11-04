import { createHordeClient, waitForResult } from "./lib/horde.mjs"

// JSON Schema avoids a runtime dependency on zod / @opencode-ai/plugin.
// Magpie exposes these tools to its agents through the built-in MCP router.
const idArg = { type: "string", description: "AI Horde job UUID returned by generate_image" }
const waitArg = { type: "integer", minimum: 0, maximum: 35, description: "Seconds to wait before returning. 0 means immediate status only; maximum 35 to avoid Magpie's 55-second tool timeout." }

export const AIHordeTools = async (_input, options = {}) => {
  // The environment variable is preferred so a secret need not be stored in plugins.json.
  const apiKey = process.env.AI_HORDE_API_KEY?.trim() || options?.apiKey?.trim() || "0000000000"
  const client = createHordeClient({ apiKey })
  const nsfwDefault = typeof options?.nsfwDefault === "boolean" ? options.nsfwDefault : true
  return {
    tool: {
      generate_image: {
        description: "Generate an image with AI Horde's community GPUs (including adult/anime models where allowed). Submit once; if still queued, call image_status with the returned job_id rather than resubmitting. Returns Markdown image preview URLs when ready. Queue times vary and generation is not guaranteed.",
        args: {
          type: "object",
          properties: {
            prompt: { type: "string", maxLength: 4000, description: "Positive image prompt; use details like subject, style, composition and lighting." },
            negative_prompt: { type: "string", maxLength: 2000, description: "Optional concepts to exclude (sent through AI Horde's ### negative-prompt format)." },
            model: { type: "string", description: "Optional exact AI Horde model name; see list_models. Omit to let the service choose." },
            width: { type: "integer", minimum: 256, maximum: 1024, description: "Width in pixels, multiple of 64. Default 512." },
            height: { type: "integer", minimum: 256, maximum: 1024, description: "Height in pixels, multiple of 64. Default 512." },
            steps: { type: "integer", minimum: 1, maximum: 60, description: "Diffusion steps; default 25." },
            count: { type: "integer", minimum: 1, maximum: 4, description: "Number of images, default 1." },
            cfg_scale: { type: "number", minimum: 1, maximum: 20, description: "Prompt guidance, default 7.5." },
            seed: { type: "string", description: "Optional reproducible seed." },
            sampler: { type: "string", description: "Optional sampler name, e.g. k_euler_a." },
            nsfw: { type: "boolean", description: "Route to workers accepting adult content. Default true; adult-content safety rules still apply." },
            wait_seconds: { ...waitArg, description: "Wait for result, at most 35 seconds; default 15. Return job_id if still queued." },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        async execute(args, ctx) {
          const job = await client.submit(args, nsfwDefault, ctx?.abort)
          const result = await waitForResult(client, job.job_id, args.wait_seconds ?? 15, ctx?.abort)
          return { ...job, ...result }
        },
      },
      image_status: {
        description: "Check or wait for an AI Horde image job. When done, returns HTTPS image URLs and Markdown previews. Re-call with the same job_id until completed; do not submit a duplicate generation request.",
        args: {
          type: "object",
          properties: { job_id: idArg, wait_seconds: { ...waitArg, description: "Optional seconds to wait for completion (default 0)." } },
          required: ["job_id"], additionalProperties: false,
        },
        async execute(args, ctx) {
          if ((args.wait_seconds ?? 0) > 0) return await waitForResult(client, args.job_id, args.wait_seconds, ctx?.abort)
          const check = await client.check(args.job_id, ctx?.abort)
          return (check.done || check.faulted) ? await client.result(args.job_id, ctx?.abort) : {
            ...check,
            message: "Still processing. Call image_status again with this job_id later.",
          }
        },
      },
      list_models: {
        description: "List currently available AI Horde image models, sorted by online worker count. Useful for finding anime or other specialized models before generating.",
        args: {
          type: "object",
          properties: {
            search: { type: "string", description: "Optional case-insensitive model-name filter, e.g. anime, pony, illustrious." },
            limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum models to show, default 20." },
          }, additionalProperties: false,
        },
        async execute(args, ctx) {
          return await client.models(args.limit ?? 20, args.search ?? "", ctx?.abort)
        },
      },
      cancel_image: {
        description: "Cancel a previously submitted AI Horde generation job that is still queued or processing.",
        args: { type: "object", properties: { job_id: idArg }, required: ["job_id"], additionalProperties: false },
        async execute(args, ctx) {
          return await client.cancel(args.job_id, ctx?.abort)
        },
      },
    },
  }
}
