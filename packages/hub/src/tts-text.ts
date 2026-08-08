/**
 * Reduce a reply to what's worth *speaking*, or `null` if it isn't. Code, inline
 * code, and URLs don't work as speech (coordination protocol: depth goes in the
 * artifact), so they're stripped; the remainder is collapsed and trimmed. Returns
 * `null` when nothing speakable is left or it exceeds `maxChars` — the hub then
 * posts the reply as text instead of voicing it. The full text is still the source
 * of truth (it's the voice note's caption); this only shapes the spoken audio.
 */
export function speakableText(text: string, maxChars: number): string | null {
  const spoken = text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/https?:\/\/\S+/g, " ") // URLs
    .replace(/\s+/g, " ")
    .trim();
  if (spoken === "" || spoken.length > maxChars) return null;
  return spoken;
}
