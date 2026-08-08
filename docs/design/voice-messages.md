# Design & decision doc: voice messages over the hub (#37)

Status: **Phase 1 (inbound voice → text) implemented** — broadcast/recipient-set addressing
([#53](https://github.com/menus12/claude-telegram-hub/pull/53)), the `TranscriptionService` seam
([#54](https://github.com/menus12/claude-telegram-hub/pull/54)), voice addressing + transcript echo
([#55](https://github.com/menus12/claude-telegram-hub/pull/55)), and Telegram `voice` handling
(this). What remains is **deployment** (stand up a self-hosted Whisper sidecar) — no more app code.
Phase 2 (opt-in outbound TTS) is future. This is the deliverable
for [#37](https://github.com/menus12/claude-telegram-hub/issues/37): a concrete, privacy-compatible
STT (and optional TTS) recommendation, where it runs, format handling, cost/latency, and a phased
plan — with voice framed as a **modality inside our existing shared-room, co-worker conventions**,
not a new coordination surface.

> Sourcing: the technology comparison below is grounded in a multi-source, adversarially-verified
> research pass (Aug 2026). Figures are approximate and hardware/model dependent; a few widely-cited
> numbers turned out to be single-sourced marketing (flagged inline as **low-confidence**).

---

## 1. TL;DR recommendation

- **Inbound STT (phase 1 — the clear win):** run **self-hosted `faster-whisper` (CTranslate2, INT8)
  on CPU** as a small **sidecar service** co-located with / reachable from the hub, behind a
  pluggable `TranscriptionService` interface (`HUB_STT_URL`). Model: **`medium`** when Russian is in
  scope (better RU accuracy), **`small`** for English-mostly rooms (≈3.4% WER, ~2 GB RAM). Transcode
  the Telegram OGG/Opus voice note to **16 kHz mono PCM WAV via ffmpeg** before handing it to the
  engine. This is **near-real-time for short voice notes on CPU (~1–3 s)**, needs **no GPU**, has
  **~zero marginal cost**, and keeps audio inside the estate — the right fit for the EMU privacy
  posture and a low-volume chat workload.
- **Cloud STT** (OpenAI Whisper `$0.006/min`, Deepgram Nova-3 `$0.0043/min`, Azure `$1.00/hr`) is a
  documented **fallback** for deployments without a privacy constraint — cheaper than a dedicated GPU
  at our volumes, but sends audio to a second third party. Keep it behind the same interface so it's
  a config swap.
- **Outbound TTS (phase 2 — optional, opt-in):** **Piper** (MIT, CPU-light, on-prem) as the default;
  **Kokoro** (Apache-2.0) if higher quality is wanted. Avoid **Coqui/XTTS** — its license restricts
  commercial use, a problem for an enterprise deployment. Text stays the source of truth; voice is a
  supplementary rendering of **short** messages only.

**Why not self-host on GPU?** Break-even analysis from the research: a dedicated GPU only pays off
above roughly **25–65+ audio-hours/month** (one analysis: ~553 hrs vs a $199/mo GPU server). A
coordination room produces a handful of short voice notes a day — nowhere near that. **CPU
self-hosting sidesteps the GPU break-even entirely**: near-zero marginal cost *and* privacy, which is
exactly our situation.

---

## 2. Voice as a modality inside the existing conventions

Operator and agents are co-workers in one project room; a voice note is just *how a colleague speaks*
there. Design principle: **transcribe at the edge, then feed the existing pipeline unchanged.** A
voice note becomes an ordinary `InboundMessage` whose `text` is the transcript; everything downstream
— allowlist/access (#38), `@tag`/reply-to routing (#35/#45), the loop governor, presence (#34), the
response SLA (#28) — applies exactly as for typed text. No new coordination rules.

### 2.1 The hard problem: addressing a voice note (no `@tags` in speech)

Text routing is mention-only, but a voice note **has no caption** (Telegram voice messages can't
carry one) and STT won't reliably emit a literal `@platform` from speech. Two robust signals, both
natural co-worker behaviour, in priority order:

1. **Reply-to (primary).** You address a colleague by *replying* to their message. A Telegram reply
   carrying a voice note resolves to that agent via the existing reply-to resolution (#35 index + #45
   attribution fallback) — deterministic, no speech parsing. This is the canonical way to speak to a
   specific agent.
2. **Leading-name fuzzy match (secondary, best-effort).** If the transcript *starts* with a token
   that fuzzy-matches a live agent name ("Platform, please redeploy" → `@platform`), treat it as a
   mention. Bounded to the leading 1–2 tokens against the live registry to avoid mis-routes.
3. **DM / single-agent room:** no addressing needed — the one agent gets it, same as text today.

Unresolved voice in a multi-agent room → treated like untagged text (not routed; optional "who's that
for?" notice). Consistent with explicit-mention-only routing.

### 2.2 Scenarios (each honouring the coordination protocol)

- **S1 — Operator voice → agent acts.** Reply to `@platform` with a voice note "bump log level to
  debug and redeploy". Hub: download → transcode → transcribe → `InboundMessage{text, mentions:[platform]}`
  → route. The agent's *first message is the result* (Part A rule 3) — no "on it" ceremony.
- **S2 — Transcript echo (anti-wrong-action safeguard).** Because a bad transcript can drive a wrong
  action, the hub posts a one-line echo — `🎙️ heard @platform: "bump the log level to debug and
  redeploy"` — a co-worker paraphrase giving the operator a correction window. Hub `kind:"notice"`,
  governor-neutral, one line (Part A: no ceremony). It also makes the transcript legible/searchable
  (Part A rule 6: the text is the durable artifact of the voice).
- **S3 — Garbled / empty / low-confidence.** Silence/noise → no route + `couldn't make out that
  voice note — try again or type it`. Low-confidence → echo with a `(low confidence)` marker. An
  ambiguous request → the agent **asks in the channel** (Part A rule 7), never a blocking terminal prompt.
- **S4 — Destructive spoken ask.** No special rule: the agent already confirms irreversible asks
  in-channel, and the S2 echo gives a correction window. Optional `HUB_VOICE_CONFIRM=high-stakes` to
  force a confirm for voice-driven destructive ops; default off.
- **S5 — Agent voice reply (TTS, phase 2, opt-in).** Text is **always** posted (the source of truth);
  TTS is a supplementary rendering of **short** messages for a hands-free operator, never voice-only
  (code/links/lists don't work as audio; Part A: depth goes in the artifact).
- **S6 — Agent↔agent stays text.** Voice is a human-edge modality only; agent→agent remains text
  re-injection bounded by the governor.

---

## 3. STT technology comparison (verified research)

### 3.1 Self-hosted Whisper on CPU — the recommendation

| Engine | Notes (from research) |
|---|---|
| **faster-whisper** (CTranslate2) | ~4× faster than `openai/whisper`, **same accuracy**, INT8 on CPU / FP16 on CUDA. On CPU INT8, ~1 hour of audio in ~6 min (~0.1× RTF, i.e. **~10× faster than real time**) for suitable model sizes. GPU (large-v3) ~12× real-time. **Recommended.** |
| **whisper.cpp** (pywhispercpp) | CPU-only, tiny footprint (as little as 512 MB RAM). ~**1.2 s for 30 s audio**, ~6.1 s for a 5-min clip — near-real-time on CPU. Needs 16 kHz WAV input. Great lightweight alternative. |
| **WhisperX** | faster-whisper + VAD + word-timestamps + diarization. Overkill for chat (we don't need diarization); more moving parts. |

Model-size tradeoff (CPU): **`small`** ≈ 3.4% WER (EN), ~2 GB RAM, fast — good for English rooms.
**`medium`** ≈ real-time on CPU, better **Russian** accuracy — recommended when RU is in scope.
`large-v3` is most accurate/multilingual but heavy on CPU (a 45 s clip can take ~9–10 s CPU-only);
`large-v3-turbo` is far faster (~<20 s vs ~143 s for large-v3 on one CPU faster-whisper benchmark).
For **5–30 s voice notes**, `small`/`medium` on CPU comfortably hit a chat-natural few-seconds.

> Low-confidence: some circulated "faster-whisper 1.1 min / WhisperX 1.4 min on a 60-min podcast"
> figures trace to a single GPU-rental marketing blog with no stated methodology — do not rely on them.

### 3.2 Cloud STT — fallback (non-privacy-sensitive deploys)

| Provider | Price | Accuracy / notes |
|---|---|---|
| **OpenAI Whisper API** | **$0.006/min** (~$0.36/hr) | Simple; OGG/Opus accepted. Sends audio off-estate. |
| **Deepgram Nova-3** | **$0.0043/min** batch | Self-reported WER 5.26%; independent benchmarks ~7–10%. Node SDK. |
| **Azure Speech** | **$1.00/hr** standard; free tier 5 audio-hrs/month | **JS/Node SDK does *not* accept compressed OGG/Opus** — must transcode to 16 kHz mono PCM WAV first (C#/Python SDKs do). |
| **Google STT** | high (≈$4,800/mo at volume in one comparison) | Not recommended on cost. |

Break-even: cloud STT is *cheaper than a dedicated GPU* below ~25–65 audio-hrs/month — but CPU
self-hosting beats both on marginal cost while keeping data on-prem, so cloud is a fallback only.

### 3.3 Format / transcode

Telegram voice notes are **OGG/Opus**. **As implemented, the hub sends the OGG bytes as-is** to the
OpenAI-compatible STT endpoint, which decodes them (faster-whisper / whisper.cpp servers and the
OpenAI API all ingest OGG/Opus via their bundled ffmpeg). **No hub-side transcode is needed** for the
recommended path — the hub stays free of an ffmpeg dependency, and the voice path reuses the existing
`downloadFile` (#36). A transcode step (ffmpeg → 16 kHz mono WAV) is only required for a WAV-only
endpoint (e.g. the Azure JS SDK, which we don't use); if such an endpoint is ever targeted, add it as
an opt-in behind the `TranscriptionService` — the seam already isolates this choice.

---

## 4. TTS technology (phase 2, optional)

| Engine | License | Notes |
|---|---|---|
| **Piper** | MIT | Lightweight, **CPU-friendly**, on-device/on-prem; RU + EN voices. Best default for a low-footprint, privacy-first opt-in. |
| **Kokoro** | Apache-2.0 | 2026's default recommendation for **high-quality** TTS when you don't need voice cloning; commercial-friendly license — fine for EMU. |
| **Coqui / XTTS v2** | restricted | Voice cloning, but its license **restricts commercial use** — avoid for an enterprise deployment. |

Recommendation: **Piper** for the opt-in phase-2 voice replies (CPU, MIT, on-prem), upgrade to
**Kokoro** if quality demands it. Verify per-voice **Russian** quality before enabling RU TTS.

---

## 5. Where it runs — a pluggable transcription seam

Mirror the `TransportAdapter` philosophy; keep the hub core AI-agnostic:

```ts
interface TranscriptionService {
  transcribe(audio: Buffer, mimeType: string, opts?: { lang?: string }):
    Promise<{ text: string; lang?: string; confidence?: number }>
}
```

- Default impl: an HTTP client POSTing the transcoded audio to a **self-hosted faster-whisper sidecar**
  (e.g. a small container exposing an OpenAI-compatible `/v1/audio/transcriptions`, or a thin
  Python/`faster-whisper` service) at `HUB_STT_URL`, in the same Azure tenant/VNet as the hub.
- Heavy inference stays out of the hub process; the model can be pinned/scaled independently.
- `HUB_STT_URL` unset → voice notes get a `voice transcription isn't enabled here` notice (graceful
  degradation, like other opt-in features).
- Fully testable with a **fake transcriber** (like the fake Bot API / loopback adapter) — no model in CI.

**Privacy, stated honestly:** the audio already transits Telegram's servers before we receive it. On-prem
STT means the audio isn't handed to a *second* third party and the transcript never leaves the estate —
a real data-residency/compliance gain, but not "the audio never leaves the building."

### Proposed config surface (minimal)

| Var | Purpose |
|---|---|
| `HUB_STT_URL` | Transcription service endpoint (unset = voice disabled). |
| `HUB_STT_MODEL` | e.g. `small` / `medium` (default per deployment). |
| `HUB_STT_LANG` | `auto` (default) / `ru` / `en`. |
| `HUB_VOICE_ECHO` | on/off (default on) — post the transcript echo to the room. |
| `HUB_VOICE_CONFIRM` | (optional) force confirm on voice-driven high-stakes ops. |
| `HUB_TTS_URL` | (phase 2) TTS service endpoint for opt-in voice replies. |

---

## 6. Latency & cost budget

- **Latency target:** chat-natural, a few seconds end-to-end. For a 5–30 s note: Telegram download
  (~sub-second) + ffmpeg transcode (~tens of ms) + CPU `small`/`medium` transcription (~1–3 s) →
  well within budget. If latency ever bites, drop model size or add a "transcribing…" reaction.
- **Cost:** CPU self-host = **~zero marginal** (runs on the existing hub host or a small sidecar; no
  GPU). Cloud fallback ~$0.004–0.006/min if ever used. TTS (Piper) CPU = ~zero marginal.

---

## 7. Phased implementation plan

- **Phase 1 — inbound voice → text (primary).**
  1. `TranscriptionService` seam + config (`HUB_STT_URL`, model, lang).
  2. Telegram adapter: recognize `voice` (and optionally `audio`/`video_note`) messages → reuse
     `downloadFile` → ffmpeg transcode OGG/Opus → 16 kHz mono WAV → `transcribe()`.
  3. Build the `InboundMessage` (text = transcript); route via reply-to (primary) + leading-name
     fuzzy match (secondary).
  4. Transcript echo (`HUB_VOICE_ECHO`); failure/empty/low-confidence notices.
  5. Allowlist check **before** transcribing (don't spend compute on non-allowlisted senders).
  6. Fake transcriber + loopback/fake-Bot-API tests. Ship the self-hosted faster-whisper sidecar as
     a documented deploy (compose service / ACI sidecar).
- **Phase 2 — optional outbound TTS.** `HUB_TTS_URL`; render **short** agent replies to voice
  alongside the text; opt-in per deployment; Piper default.
- **Phase 3 (stretch) — quality/UX.** Confidence-gated confirmation, per-agent voice on/off,
  streaming/partial transcripts if latency demands, per-room language hints.

Splitting Phase 1 into implementation issues (transcription seam; Telegram voice handling + transcode;
routing + echo; deploy the STT sidecar) is the natural next step once this recommendation is accepted.

---

## 8. Key decisions, summarized

1. **Self-hosted faster-whisper on CPU (small/medium), sidecar behind `HUB_STT_URL`** — privacy + near-zero cost + chat-natural latency; cloud STT as a config-swap fallback.
2. **Transcribe at the edge; reuse the whole existing pipeline** — voice adds no coordination rules.
3. **Reply-to is the primary addressing signal for voice** (speech has no `@tags`); leading-name fuzzy match secondary.
4. **Transcript echo** is the human-in-the-loop safeguard against wrong actions — one line, governor-neutral.
5. **TTS is phase-2, opt-in, short-message, text-always-authoritative** — Piper (MIT) / Kokoro (Apache-2.0), not Coqui/XTTS.
