# pi-image-fallback

A [pi](https://pi.dev) extension that lets a **text-only** model "see" images through a
**vision sidecar** — without ever switching models.

## How it works

When your active model can't take images, pi still pastes an image as a **file path in
the prompt text**. This extension detects that path, runs a one-shot
"describe this image" call against a configured vision model, and injects the
resulting text into the turn's context — so the text-only model reads the image
**as text**.

```
text-only model (e.g. deepseek) ──────────────────────────────────────┐
                                                                       │
  user pastes an image (path in the prompt)                            │
      │                                                                │
      ▼                                                                │
  ┌────────────────────────────┐                                       │
  │  detect image path         │                                       │
  │  read + base64 the file    │                                       │
  │  vision one-shot:          │                                       │
  │    registry.complete(...)  │ ◀── one call to the vision model      │
  │  inject text description   │     (the session model is NEVER       │
  └────────────────────────────┘      switched)                        │
      │                                                                │
      │                     image description text                     │
      ▼                                                                │
  text-only model answers  ◀───────────────────────────────────────────┘
```

## Why a sidecar (vs. switching models)

- **No `pi.setModel`** — your `settings.json` `defaultModel`/`defaultProvider` are
  never rewritten on image turns.
- The text-only model stays active, so its **prompt cache stays warm**, and switching
  back and forth between two models doesn't trash both caches.
- Descriptions are plain text in the conversation history → **follow-ups just work**.
- Vision calls carry only `system + image`, are small, and are **cached per image path**.

**Trade-off:** the main model only sees a text description, not the live pixels — so
deep "zoom in on that region again" questions aren't supported. For reading
screenshots, UIs, code, and tables this is almost always enough.

## Behavior details

### Image paths are detected, not attachments

pi pastes an image as a **path string** in the prompt (e.g. `pi-clipboard-*.png`),
not as an image content block — so `event.images` is always empty. The extension
therefore scans the **prompt text** for image file paths. It handles:

- paste paths without spaces (`/var/folders/.../pi-clipboard-<uuid>.png`)
- rooted paths with spaces (`~/Desktop/스크린샷 2026-08-07 09.55.36.png`),
  including shell-escaped `\ ` forms
- bare filenames (`image.png`)

### Idle vs. queued (mid-stream) images

| Scenario | Handling | Description visibility |
|---|---|---|
| **Idle turn** | `before_agent_start` → injects an internal message | hidden (`display: false`) |
| **Queued turn** (submit while the model is still replying) | pi injects via `steer`/`followUp`, which bypasses `before_agent_start`; handled on the `input` event by baking into the message text | visible |
| **Agent loop (`read` tool)** | the model itself calls `read image.png`; handled on `message_end` by replacing the tool result's image block with the description | visible (part of the tool result) |

Note: there is currently **no reliable way to hide** a description for queued
messages (the `context`/`before_provider_request` hooks are only wired on the SDK
path, and hidden steer injection is timing-unreliable), so queued descriptions show
in the transcript.

### Agent-loop images (`read` tool)

When the model reads an image file via the `read` tool, pi's tool result contains a
text note (`Read image file [image/png]`) **plus an image content block** — and for
text-only models the image is dropped with
`[Current model does not support images. The image will be omitted from this request.]`
That's the agent-loop analogue of the paste case: the model calls `read` and gets
nothing.

The extension covers this too:

1. `tool_execution_start` remembers the file path per `toolCallId`.
2. `message_end` (fires for every `toolResult` message) finds image blocks, runs the
   same one-shot vision call against the sidecar model, and **replaces the image
   block with the description text**.

The replacement is applied in-place before the message is persisted, so the
description lands in session history and follow-ups just work. The original file is
preferred over the tool's (possibly resized) base64 data; when the file can't be
reached, the base64 data in the message is described directly. Descriptions are
cached per resolved path / data hash, and the cache is shared with the paste path.

### Status indicator

While a description is being generated, the footer shows:

```
img-fb:openai/gpt-5.6-luna (describing…)
```

then flashes a `✓` and settles back to `img-fb:openai/gpt-5.6-luna`.

## Install

```bash
# from npm (recommended)
pi install npm:pi-image-fallback

# or try it without installing
pi -e npm:pi-image-fallback

# or from a local checkout
# pi install /Users/ms/dev/pi-image-fallback
```

Published on [npm](https://www.npmjs.com/package/pi-image-fallback).

## Usage

```
/image-model        # pick the vision sidecar model (searchable picker)
/image-model clear  # unset / disable the sidecar
/image-model status # show the current setting
```

Config is persisted to `~/.pi/agent/image-fallback.json`:

```json
{ "imageModel": { "provider": "openrouter", "id": "openai/gpt-5.6-luna" } }
```

### Timeout & output cap

Vision calls are guarded against stalls: a sidecar request that neither responds
nor errors (e.g. an OpenRouter reasoning model sitting in its processing phase)
would otherwise leave the footer stuck on `describing…` and block the turn
forever. By default a call is aborted after **90s** and capped at **1500
completion tokens**; on timeout the image is skipped (logged as `describe
timed out`) and the turn proceeds without a description.

```json
{
  "imageModel": { "provider": "openrouter", "id": "openai/gpt-5.6-luna" },
  "timeoutMs": 60000,
  "maxTokens": 2000
}
```
