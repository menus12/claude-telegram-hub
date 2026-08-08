/**
 * Speech-shaping helpers shared by the hub (which does the voicing) and the
 * channel (which predicts, at reply time, whether a `voice: true` reply will
 * actually be voiced — so it can tell the sending agent; #74). Living here means
 * both sides agree exactly on the length/speakability decision.
 */

/** Strip what can't be spoken (code, inline code, URLs) and collapse whitespace. */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/https?:\/\/\S+/g, " ") // URLs
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduce a reply to what's worth *speaking*, or `null` if it isn't (nothing
 * speakable left, or it exceeds `maxChars`). The full text stays the source of
 * truth (it's the voice note's caption); this only shapes the spoken audio.
 */
export function speakableText(text: string, maxChars: number): string | null {
  const spoken = stripForSpeech(text);
  if (spoken === "" || spoken.length > maxChars) return null;
  return spoken;
}

/** TTS capability the hub advertises at registration, so the channel can predict fallback. */
export interface VoiceReplyCaps {
  /** Whether the hub can render replies as voice at all (TTS configured). */
  enabled: boolean;
  /** Speakable-text length above which the hub posts text instead of voicing. */
  maxChars: number;
}

export interface VoiceReplyOutcome {
  voiced: boolean;
  /** Present when `voiced` is false — an author-facing reason the voice didn't go out. */
  reason?: string;
}

/**
 * Predict whether a `voice: true` reply will be voiced, from the hub's advertised
 * caps — so the channel can report it to the *sending agent* in the `reply` tool
 * result (#74). Mirrors the hub's own `speakableText` decision for the length /
 * speakability cases (the dominant ones observed live); genuinely async failures
 * (TTS server down, non-OGG audio) can't be predicted here and are logged
 * hub-side instead (#67).
 */
export function checkVoiceReply(
  text: string,
  caps: VoiceReplyCaps | undefined,
): VoiceReplyOutcome {
  if (!caps?.enabled) {
    return {
      voiced: false,
      reason: "this hub has no text-to-speech, so the reply was posted as text.",
    };
  }
  const spoken = stripForSpeech(text);
  if (spoken === "") {
    return {
      voiced: false,
      reason: "nothing speakable here (all code / links / paths) — posted as text.",
    };
  }
  if (spoken.length > caps.maxChars) {
    return {
      voiced: false,
      reason:
        `voiced text would be ${spoken.length} chars, over this hub's ${caps.maxChars}-char cap — ` +
        `posted as text. To reply by voice, send a short spoken summary (gist + next action) ` +
        `and keep the detail in the text.`,
    };
  }
  return { voiced: true };
}
