# AI Horde image + text provider for Magpie

Native **Provider** integration for Magpie, supporting both image checkpoints and chat/text models from the free AI Horde network. Image checkpoints appear in **Settings → Images → Image generation**; text models appear in the regular chat model picker. Image requests use Horde's image queue; chat requests use the official OpenAI-compatible front at `https://oai.aihorde.net/v1`. No Python bridge, separate server, Docker or extra npm dependency is needed.

## Install or upgrade

If you installed the previous v0.1.0 tools version, **remove it** from **Plugins → Installed**, then install the updated repository:

```bash
magpie plugin add github:darkautism/aihorde-magpie
```

Or use **Plugins → Add plugin** and paste `github:darkautism/aihorde-magpie`. The plugin should now say **AI Horde Image + Text Provider** (v0.4.0) and list **AI Horde (images + text)** as the provider. It should **not** list `generate_image` or other MCP tools.

In Magpie's **Providers / External** area, find **AI Horde (image generation)** and sign in:
- **Use anonymously (free / low priority)** — one click, no API key.
- **AI Horde personal API key** — paste your key to improve queue priority.

Then open **Settings → Images → Image generation** for image checkpoints (e.g. `aihorde/stable-diffusion-horde`), or the **regular chat model picker** for AI Horde text models (e.g. `aihorde/horde-text--koboldcpp%2FQwen3%2D4B`, when offered by a worker). The latter example is an ID format, not a promise that the model is currently online. Models are refreshed from the official Horde API when Magpie discovers the provider.

To test through Magpie CLI (if your version supports it):

```bash
magpie tool generate_image "an anime castle at night" --model aihorde/stable-diffusion-horde --size 512x512 -o image.png
```

## Text / chat models (v0.4.0)

- **Same AI Horde account:** the existing anonymous login (`0000000000`) or personal API key serves both images and chat. There is no separate signup.
- **Dynamic discovery:** the plugin queries the official `GET https://oai.aihorde.net/v1/models`, then displays those chat models in Magpie as text-only models. It does not show invented offline text entries if the API is down.
- **Chat requests:** Magpie's OpenAI-compatible `/chat/completions` request is forwarded to `POST https://oai.aihorde.net/v1/chat/completions`. The underlying Horde model name is restored from the plugin's stable text model ID, preserving messages, system instructions, sampling options and OpenAI JSON responses.
- **Streaming:** a `stream: true` request passes through the official front's SSE response unchanged; the plugin does not synthesize or buffer token chunks.
- **Capabilities:** tools, multimodal inputs and structured outputs depend on the individual online Horde chat workers. Models are conservatively advertised as text-only without guaranteed tool calling. Worker model selection and queue times change, and requests may be refused.
- **Privacy and policy:** prompts are processed by volunteer workers. A model's self-description as 'uncensored' does not override Horde or worker content rules. Do not submit secrets or private player records without consent.

For **Isekai's Image Prompt Binding**, you can either call this provider through Magpie's model gateway, or use the upstream **directly** as an OpenAI-compatible API:

```text
Base URL: https://oai.aihorde.net/v1
API key: your AI Horde key (or 0000000000 for anonymous)
Model: choose an actual id from GET /v1/models
POST /chat/completions
```

Magpie's encoded id (e.g. `horde-text--koboldcpp%2FQwen3%2D4B`) is **only for the Magpie provider**. When calling the official front directly, use its original model id (e.g. `koboldcpp/Qwen3-4B`), not the encoded id.

The official OpenAI-compatible front is documented at <https://oai.aihorde.net/docs>. As with images, availability and latency depend on volunteer worker capacity.

## How this works

Magpie sends the plugin an OpenAI-style POST to `images/generations`, and the plugin:
1. Submits `POST https://aihorde.net/api/v2/generate/async`.
2. Polls `generate/check/{id}` every ~3 seconds.
3. Retrieves `generate/status/{id}` after completion.
4. Returns `{"created": ..., "data": [{"url": "https://..."}]}` to Magpie.

The default model lets AI Horde choose a compatible worker. The image picker now includes **all models with online workers** (no artificial 12-model cap) and the **official 163-name registered model catalog**, including **HolyMix ILXL**. Models with no active workers are clearly labeled `(offline · 0 workers)` and cannot generate images until a worker becomes available. The catalog is a snapshot of the official Haidra-Org image-model reference; online counts are refreshed from Horde at plugin model discovery time. When AI Horde's worker-status API fails, registered models remain visible as `(availability unknown)` instead of disappearing from the picker; this does not claim any worker is available.

**Stable IDs, clean labels:** The plugin preserves the `stable-diffusion-horde--` technical prefix in model IDs for Magpie image routing, but puts the actual checkpoint name in the separate `name` display field, e.g. `HolyMix ILXL` rather than the encoded ID. Previous `--stable-diffusion` suffix IDs (v0.3.3) and original Base64 IDs (v0.2.0) are still accepted. Interfaces that deliberately show raw IDs instead of model names may still show the prefix; a Provider plugin cannot change that upstream UI.

**Upgrading from v0.2.0:** previously selected Base64 model IDs are still accepted for image generation, but new model listings use the readable IDs. Remove and reinstall the plugin if Magpie retains the old cached list; then reselect the desired image model.

**Important limitation:** A normal image Provider request is synchronous, while AI Horde is a queue. This plugin waits up to **115 seconds**, after which it returns an error containing the queued job ID. Magpie or a calling agent can also time out earlier; the operation is not guaranteed to complete. Anonymous free queues can be slow, so choosing a model with more active workers or using a personal API key may help. This plugin does not provide polling tools; image editing is supported through the native /images/edits endpoint.

## Image + text image generation (v0.3.0)

The native image Provider now supports `POST /v1/images/edits` in addition to `/v1/images/generations`. No additional MCP tools are required.

- One source image + prompt: AI Horde `source_image` with `source_processing: img2img`.
- Image + mask + prompt: defaults to `inpainting`.
- Accepts multipart form-data uploads and JSON with source image URLs or base64 image data.
- Optional `denoising_strength` between 0.01 and 1 (default 0.75).
- Supported source modes: `img2img`, `inpainting`, `outpainting`, `remix`. Worker/model availability varies.
- One source image and optionally one mask are supported; multiple reference images are not yet supported.
- Image size: dimensions from 256 to 1024 in multiples of 64; prompt maximum: 4000 characters.

Example: POST to Magpie's `/v1/images/edits` with `model=aihorde/stable-diffusion-horde`, `prompt`, and a multipart image file.
Source images go to volunteer AI Horde workers; never submit sensitive personal photos.

## Model ID and display name (v0.3.4)

Model IDs remain technical and stable, for example `stable-diffusion-horde--HolyMix-ILXL`.
The Provider supplies a separate `name` field, for example `HolyMix ILXL` (or `HolyMix ILXL (offline · 0 workers)` when unavailable). Magpie's normal model-name UI reads `name`; the `stable-diffusion` ID marker is needed by Magpie's image routing.

Offline catalog models are listed for discovery, not a promise that AI Horde can run them. Only worker availability determines whether an image request can be executed.
## Actual checkpoint verification (v0.3.6)

For a named checkpoint such as `HolyMix ILXL`, the adapter sends the exact `models: ["HolyMix ILXL"]` parameter to AI Horde. After generation, if the upstream `/generate/status/{id}` response contains a different `generations[].model`, the adapter returns a 502 error with the requested name, actual model, worker name (if reported), and job ID instead of silently accepting an incorrect checkpoint.

Automatic model selection remains unrestricted. Older workers/responses that omit `generations[].model` cannot be verified, so the adapter does not invent a model mismatch when the metadata is missing. This protection verifies the returned checkpoint; it does not change AI Horde scheduling or make offline models available.

## Sampling defaults (v0.3.7)

To match the AI Horde Studio default controls, the Provider now explicitly sends the following values in both `/images/generations` and `/images/edits`:

| Parameter | Sent to AI Horde |
| --- | --- |
| Steps | `steps: 30` |
| CFG Scale | `cfg_scale: 5` |
| Sampler | `sampler_name: "k_euler_a"` |
| Schedule | `scheduler: "karras"` |
| CLIP Skip | `clip_skip: 2` |
| Seamless tiling | `tiling: false` |
| Seed | Omitted (random) |

These are plugin defaults, not per-model tuned settings. The requested image size and model selection are still honored. Workers and checkpoints may have their own supported sampling constraints.

## Default image size (v0.3.2)

- **All accounts, including anonymous:** when no size or `auto` is specified, defaults to **576×576**.
- **Explicit size is always respected** for anonymous and personal API keys. AI Horde may reject larger sizes due to Kudos, model, or Worker restrictions; no silent resizing occurs.
- This default is an adapter choice, **not an official free-resolution limit**.
- The same rule applies to text-to-image and image+text editing (`/images/edits`).
- Current accepted explicit sizes must have dimensions in 64-pixel increments from 256 through 1024. The worker may impose other restrictions.

## NSFW setting

The provider option **Enable NSFW generation** is enabled by default. It sets `nsfw: true` in the Horde API request, which enables volunteer workers that allow adult content. Turn it off from the provider's **Plugin options** to set `nsfw: false`. All AI Horde global safety restrictions and worker policies still apply.

## Privacy and limits

- Prompts and image jobs are processed by AI Horde's **volunteer workers**, so do not submit secrets, private photos or sensitive content.
- AI Horde decides which workers accept each prompt. `nsfw: true` is an opt-in routing hint, not a moderation bypass.
- The plugin requests `r2: true` and `shared: false`; anonymous requests may still have different sharing/privacy rules under AI Horde's own policies.
- It returns temporary HTTPS image URLs. Download or save generated images promptly.
- There is no guaranteed processing time, uptime, or free quota. Anonymous use has low priority. The text API is independently hosted from the image API, so one can work while the other is unavailable.

## Development

```bash
npm test
```

Unit tests use mocked AI Horde responses only, including native chat SSE. The plugin has **not** been end-to-end tested with a live Magpie installation or real AI Horde workers. Please report failures with your Magpie version and redacted logs.

AI Horde official OpenAI-compatible chat front: https://oai.aihorde.net/docs  
Magpie API docs: https://usemagpie.ai/docs/plugins  
Magpie provider image integration: https://github.com/yetone/magpie/blob/main/docs/subsystems/provider-plugins.md  
AI Horde API docs: https://aihorde.net/api/

MIT licensed. Unofficial community integration.
