# AI Horde Image Tools for Magpie

Use AI Horde's volunteer GPUs to generate images from any agent connected through [Magpie](https://usemagpie.ai/). This is a **native Magpie tool plugin**: **no Python, Docker, standalone proxy or npm publishing required**.

AI Horde accepts optional NSFW generation requests. Their safety rules still apply, and adult-capable volunteers may be fewer and slower. Do not send private prompts or photos to untrusted volunteer workers.

## Install from GitHub

```bash
magpie plugin add github:darkautism/aihorde-magpie
magpie plugin
```

Or open **Magpie → Settings → Plugins → Add plugin** and paste:

`github:darkautism/aihorde-magpie`

Magpie uses Bun to load the repository's root `package.json` and `index.mjs`. There is no build step and no runtime dependency. Tool IDs end in `generate_image`, `image_status`, `list_models`, and `cancel_image`; Magpie prepends a plugin-specific name. In **Plugins → Installed** you can see the exact names.

To expose tools to a connected coding agent, enable Magpie's **Library → MCP → AI Horde Image Tools** (or the built-in Plugin tools MCP server) for that agent and ensure its MCP router is active. Magpie documents this at [Writing plugins → Tools for every agent](https://usemagpie.ai/docs/plugins#tools-for-every-agent).

## Quick start

Ask an MCP-enabled agent:

> Use AI Horde to generate a 512x512 anime-style illustration of a moonlit shrine. If it is still in the queue, keep the job ID and check its status rather than generating again. Show me the image link when ready.

The `generate_image` tool can wait up to 35 seconds. When AI Horde takes longer (common on the free anonymous queue), it returns a `job_id`; ask the agent to call `image_status` with the same ID later. Magpie tools have an overall 55-second timeout, so the plugin **does not block until the entire queue finishes**.

Image results contain HTTPS links plus Markdown `![...](...)` preview text. **Whether the picture is displayed inline is up to the chat/agent client**; all clients can at least access its URL. Generated links may expire: download the image when available.

## API key (optional)

By default, the plugin uses the official AI Horde anonymous key `0000000000`. No sign-up is necessary, but anonymous queue priority is low. For a personal key, set the `AI_HORDE_API_KEY` environment variable **in the environment that launches the Magpie app or gateway**:

```bash
export AI_HORDE_API_KEY='your-ai-horde-key'
magpie # launch Magpie from this shell if you want it to inherit the key
```

Alternatively configure the plugin through `magpie plugin options` (stored **in plaintext** in Magpie's `plugins.json`; do not use this on shared computers):

```bash
magpie plugin options magpie-tools-ai-horde '{"apiKey":"your-ai-horde-key","nsfwDefault":true}'
```

Set `nsfwDefault` to `false` if you want NSFW routing disabled by default. Every individual generation can explicitly specify `nsfw: true` or `false`.

## Tools

| Tool | Purpose |
|---|---|
| `generate_image` | Submit a new text-to-image job, optionally wait for completion; negative prompt, model, size, seed, steps, count, NSFW. |
| `image_status` | Check a job, optionally wait up to 35 seconds, retrieve image URLs when complete. |
| `list_models` | Show active image models and number of online workers. |
| `cancel_image` | Cancel a pending generation. |

The model names and available resolutions depend on volunteer workers. Omit `model` to let AI Horde select one, or use `list_models` to see the live names. Settings beyond what a worker accepts can be rejected by AI Horde.

### Privacy and safeguards

- Every prompt is sent to AI Horde, then to volunteer GPU workers. Do not send private photos, identifying text or secrets.
- Adult-content routing (`nsfw=true`) is not a safety bypass. AI Horde's global restrictions and each worker's rules still apply.
- For anonymous accounts, AI Horde may share images for dataset improvement even when `shared: false` is requested. Use a personal key if that matters to you, and review AI Horde's privacy terms.
- Prompts can consume credits/Kudos and have unpredictable queue times. Avoid duplicate submissions; always check the original `job_id`.
- Only HTTPS URLs are returned for generated images; no automatically downloaded files are written to disk.

## Development

```bash
npm test
```

Tests use mocked API responses, and do not submit an actual image request or spend Kudos. This release has **not** been validated end-to-end against a live Magpie installation or a real AI Horde GPU. Report compatibility issues with the Magpie version, error message and (redacted) tool output.

## References

- [Magpie plugin authoring guide](https://usemagpie.ai/docs/plugins)
- [AI Horde API](https://aihorde.net/api/)
- [AI Horde integration guide](https://github.com/Haidra-Org/AI-Horde/blob/main/README_integration.md)

MIT licensed. This is an unofficial community integration and not affiliated with AI Horde or Magpie.
