# Deploy voice (speech-to-text and text-to-speech)

Voice is **opt-in** in **two directions**, each behind an **OpenAI-compatible**
speech service (design & rationale: [../design/voice-messages.md](../design/voice-messages.md)):

- **Inbound (STT)** — the hub transcribes a Telegram voice note by POSTing its audio
  to `HUB_STT_URL` (`POST <url>/v1/audio/transcriptions`), then routes the transcript
  like a typed message. Unset `HUB_STT_URL` → disabled.
- **Outbound (TTS)** — an agent that sets `voice: true` on a short `reply` gets it
  rendered as a voice note; the hub POSTs the text to `HUB_TTS_URL`
  (`POST <url>/v1/audio/speech`, `response_format: opus`) and sends the OGG/Opus back
  as a captioned voice note. Unset `HUB_TTS_URL` → agents can't reply with voice.

Both are a **config swap, not a code change** — self-hosted for on-prem privacy, or a
cloud API. You can run either direction alone.

> **Privacy, stated honestly.** A voice note already transits Telegram's servers
> before the hub receives it. Self-hosting STT means the audio isn't handed to a
> *second* third party and the transcript never leaves your estate — a real
> data-residency gain, not "the audio never leaves the building."

## Recommendation (from the research)

- **Engine:** self-hosted **faster-whisper on CPU** — near-real-time for short voice
  notes, no GPU, ~zero marginal cost. A dedicated GPU only pays off above ~25–65
  audio-hours/month, far above a chat workload.
- **Model:** `small` for English-mostly rooms; **`medium`** when Russian is in scope
  (better RU accuracy). Short notes stay chat-natural (a few seconds) on CPU.
- **No transcoding needed:** the hub sends the OGG/Opus bytes as-is; faster-whisper
  servers decode them.

## Docker Compose (the simplest path)

An opt-in overlay ships in the repo: [`docker-compose.voice.yml`](../../docker-compose.voice.yml).
It adds a faster-whisper service and sets `HUB_STT_URL` on the hub.

```sh
docker compose -f docker-compose.yml -f docker-compose.voice.yml up -d
```

- The STT service publishes **no port** — only the hub reaches it on the compose
  network (`http://stt:8000`).
- Models download on first use and are cached on a volume (`HF_HOME`), so the **first
  voice note is slow**; subsequent ones are fast.
- Set `HUB_STT_MODEL` to the id **your server expects** (faster-whisper servers such
  as [speaches](https://github.com/speaches-ai/speaches) — formerly
  `faster-whisper-server` — take a HuggingFace id like `Systran/faster-whisper-small`;
  others accept a bare `small`). Confirm the current image tag, port, and model-id
  format against that server's docs.

## Azure (Container Apps / Container Instances)

Run the STT engine as a **sidecar in the same container group / app** as the hub, so
they share a private network and the audio never leaves it:

- **Azure Container Apps** — add a second container to the app (sidecar pattern);
  the hub reaches it on **`http://localhost:8000`** (containers in one app share
  `localhost`). Set `HUB_STT_URL=http://localhost:8000`.
- **Azure Container Instances** — add the STT container to the same **container
  group**; containers in a group share `localhost`, so again
  `HUB_STT_URL=http://localhost:8000`.
- Mount a volume (e.g. an Azure Files share) at the model cache path (`HF_HOME`) so
  the model isn't re-downloaded on every restart — the same persistence pattern as
  [azure-container-instances.md § Persistent state](azure-container-instances.md#3-persistent-state-runtime-allowlist-management).
- CPU sizing is fine for short voice notes; give the sidecar ~1–2 vCPU / 2–4 GB for
  a `small`/`medium` model.

## Text-to-speech (outbound — agents reply with voice)

Symmetric to STT: point `HUB_TTS_URL` at an OpenAI-compatible **speech** server
(`POST /v1/audio/speech`) and set `HUB_TTS_MODEL` + `HUB_TTS_VOICE`. The compose
overlay adds a `tts` service alongside `stt`; the same sidecar pattern applies on
Azure. Notes:

- **Engine:** **Piper** (MIT, CPU-light, explicit **RU + EN** voices) is the
  pragmatic default for a bilingual room; **Kokoro** (Apache-2.0) for higher EN
  quality. Avoid Coqui/XTTS (commercial-use license).
- **Must return OGG/Opus.** The hub requests `response_format: opus` and only sends a
  Telegram **voice note** for `audio/ogg`; if your server returns mp3/wav instead, the
  hub falls back to posting the reply as **text** — so confirm your server supports
  opus.
- **Voice is language-specific** (unlike STT's auto-detect): `HUB_TTS_VOICE` picks the
  voice, so choose one matching the language your agents reply in.
- Some servers (e.g. speaches) expose **both** endpoints, so you can point
  `HUB_STT_URL` and `HUB_TTS_URL` at one instance.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HUB_STT_URL` | — | STT service base URL. Unset = inbound voice disabled. |
| `HUB_STT_MODEL` | `small` | STT model id (server-specific format). |
| `HUB_STT_LANG` | `auto` | `auto` (detect) or `ru` / `en`. |
| `HUB_VOICE_ECHO` | `true` | Echo `🎙️ heard → @…: "transcript"` into the room. |
| `HUB_TTS_URL` | — | TTS service base URL. Unset = agents can't reply with voice. |
| `HUB_TTS_MODEL` | — | TTS model id (required with `HUB_TTS_URL`). |
| `HUB_TTS_VOICE` | — | TTS voice id, language-specific (required with `HUB_TTS_URL`). |
| `HUB_TTS_FORMAT` | `opus` | Response format; keep `opus` for Telegram voice notes. |
| `HUB_TTS_MAX_CHARS` | `300` | Skip voicing a reply longer than this (posts text). |

See [../configuration.md](../configuration.md) for the full surface.

## Use & verify

- **Address a voice note** the way you'd address a colleague: **reply** to an agent's
  message, or **open by naming** them — "Platform, redeploy" (unicast), "Platform and
  GitOps, sync up" (multicast), "Everyone, stand down" (broadcast). The hub echoes the
  transcript **and the resolved recipients**, so a mis-hear or mis-address is visible
  before agents act.
- **Verify:** send a voice note and watch the hub logs for `transcribed voice note`
  (the hub fetched + transcribed it) followed by `voice note routed`. If you see a
  `🎙️ voice messages aren't enabled here` notice, `HUB_STT_URL` isn't set; a
  `couldn't make out that voice note` means the STT service returned an empty
  transcript (check its logs / the model).
