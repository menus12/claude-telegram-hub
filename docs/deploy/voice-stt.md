# Deploy voice (speech-to-text)

Voice messages are **opt-in**: the hub transcribes a Telegram voice note by POSTing
its audio to an **OpenAI-compatible transcription service** (`POST
<url>/v1/audio/transcriptions`) at `HUB_STT_URL`, then routes the transcript like a
typed message (design & rationale: [../design/voice-messages.md](../design/voice-messages.md)).
Any server that speaks that protocol works — self-hosted Whisper for an on-prem
privacy posture, or a cloud API — so this is a **config swap, not a code change**.
Unset `HUB_STT_URL` → voice is cleanly disabled.

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

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HUB_STT_URL` | — | STT service base URL. Unset = voice disabled. |
| `HUB_STT_MODEL` | `small` | Model id (server-specific format). |
| `HUB_STT_LANG` | `auto` | `auto` (detect) or `ru` / `en`. |
| `HUB_VOICE_ECHO` | `true` | Echo `🎙️ heard → @…: "transcript"` into the room. |

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
