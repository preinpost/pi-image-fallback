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

Note: there is currently **no reliable way to hide** a description for queued
messages (the `context`/`before_provider_request` hooks are only wired on the SDK
path, and hidden steer injection is timing-unreliable), so queued descriptions show
in the transcript.

### Status indicator

While a description is being generated, the footer shows:

```
img-fb:openai/gpt-5.6-luna (describing…)
```

then flashes a `✓` and settles back to `img-fb:openai/gpt-5.6-luna`.

## Install

```bash
pi install /Users/ms/dev/pi-image-fallback
```

or try it without installing:

```bash
pi -e /Users/ms/dev/pi-image-fallback
```

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
