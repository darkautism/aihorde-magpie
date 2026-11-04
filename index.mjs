import { PROVIDER_ID, API_ROOT, ANONYMOUS_KEY, defaultModels, providerFetch, listWorkerModels } from "./lib/provider.mjs"

// Provider plugin, not tool plugin. Magpie registers its image models under Settings > Images.
export async function AIHordeProvider(input) {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER_ID] ??= {
        name: "AI Horde (image generation)",
        npm: "@ai-sdk/openai-compatible",
        api: API_ROOT,
        models: defaultModels(),
      }
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api", keyless: true, label: "Use anonymously (free / low priority)",
          async authorize() { return { type: "success", key: ANONYMOUS_KEY, metadata: { accountId: "anonymous" } } },
        },
        {
          type: "api", label: "AI Horde personal API key", placeholder: "Your AI Horde API key",
        },
      ],
      options: [{
        key: "nsfw", label: "Enable NSFW generation", default: true,
        description: "Send nsfw=true to AI Horde, routing generation to consenting adult-content workers. AI Horde rules still apply.",
      }],
      async loader(getAuth) {
        const account = await getAuth()
        const key = account?.type === "api" && account.key ? account.key : ANONYMOUS_KEY
        return {
          apiKey: key,
          baseURL: API_ROOT,
          fetch: (request, init) => providerFetch(request, init, {
            key,
            nsfw: input.magpie?.option?.(PROVIDER_ID, "nsfw") ?? true,
          }),
        }
      },
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        // Include a deterministic default so the image picker works when Horde's worker API is down.
        const discovered = await listWorkerModels({ key: auth?.type === "api" ? auth.key : ANONYMOUS_KEY })
        const base = provider?.models?.["stable-diffusion-horde"] ?? defaultModels()["stable-diffusion-horde"]
        return Object.fromEntries(Object.entries(discovered).map(([id, model]) => [id, { ...base, ...model }]))
      },
    },
  }
}
