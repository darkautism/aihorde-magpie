# AI Horde image provider for Magpie

Native **Provider** integration for Magpie. The image models appear in **Providers** and **Settings → Images → Image generation**, not in Tool plugins. An OpenAI-compatible `/v1/images/generations` request is translated into AI Horde's async image-generation queue, and the plugin returns the resulting picture URL to Magpie. No Python bridge, separate server, Docker or external dependency is needed.

## Install or upgrade

If you installed the previous v0.1.0 tools version, **remove it** from **Plugins → Installed**, then install the updated repository:

```bash
magpie plugin add github:darkautism/aihorde-magpie
```

Or use **Plugins → Add plugin** and paste `github:darkautism/aihorde-magpie`. The plugin should now say **AI Horde Image Provider** (v0.2.0) and list **AI Horde (image generation)** as the provider. It should **not** list `generate_image` or other MCP tools.

In Magpie's **Providers / External** area, find **AI Horde (image generation)** and sign in:
- **Use anonymously (free / low priority)** — one click, no API key.
- **AI Horde personal API key** — paste your key to improve queue priority.

Then open **Settings → Images → Image generation**, select the `aihorde` image model **AI Horde · Automatic (image)** or a named active image model. Example model ID: `aihorde/stable-diffusion-horde`. The plugin uses Magpie's existing built-in image generation UI and gateway; it does not add a new chat LLM.

To test through Magpie CLI (if your version supports it):

```bash
magpie tool generate_image "an anime castle at night" --model aihorde/stable-diffusion-horde --size 512x512 -o image.png
```

## How this works

Magpie sends the plugin an OpenAI-style POST to `images/generations`, and the plugin:
1. Submits `POST https://aihorde.net/api/v2/generate/async`.
2. Polls `generate/check/{id}` every ~3 seconds.
3. Retrieves `generate/status/{id}` after completion.
4. Returns `{"created": ..., "data": [{"url": "https://..."}]}` to Magpie.

The default model allows AI Horde to choose a compatible worker. A live list of up to 30 online worker models also appears in the image picker. Those models' opaque IDs start with `stable-diffusion-horde-` so Magpie classifies them as image models; their human-readable labels show the real Horde model names.

**Important limitation:** A normal image Provider request is synchronous, while AI Horde is a queue. This plugin waits up to **115 seconds**, after which it returns an error containing the queued job ID. Magpie or a calling agent can also time out earlier; the operation is not guaranteed to complete. Anonymous free queues can be slow, so choosing a model with more active workers or using a personal API key may help. This plugin does not provide polling tools or image edits.

## NSFW setting

The provider option **Enable NSFW generation** is enabled by default. It sets `nsfw: true` in the Horde API request, which enables volunteer workers that allow adult content. Turn it off from the provider's **Plugin options** to set `nsfw: false`. All AI Horde global safety restrictions and worker policies still apply.

## Privacy and limits

- Prompts and image jobs are processed by AI Horde's **volunteer workers**, so do not submit secrets, private photos or sensitive content.
- AI Horde decides which workers accept each prompt. `nsfw: true` is an opt-in routing hint, not a moderation bypass.
- The plugin requests `r2: true` and `shared: false`; anonymous requests may still have different sharing/privacy rules under AI Horde's own policies.
- It returns temporary HTTPS image URLs. Download or save generated images promptly.
- There is no guaranteed processing time, uptime, or free quota. Anonymous use has low priority.

## Development

```bash
npm test
```

Unit tests use mocked AI Horde responses only. The plugin has **not** been end-to-end tested with a live Magpie installation or real AI Horde workers. Please report failures with your Magpie version and redacted logs.

Magpie API docs: https://usemagpie.ai/docs/plugins  
Magpie provider image integration: https://github.com/yetone/magpie/blob/main/docs/subsystems/provider-plugins.md  
AI Horde API docs: https://aihorde.net/api/

MIT licensed. Unofficial community integration.
