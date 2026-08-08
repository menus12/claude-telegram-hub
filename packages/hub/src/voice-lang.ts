/**
 * Per-language voice selection for a bilingual room (#71). TTS voices are
 * language-specific (unlike Whisper's auto-detect), so a reply in the "other"
 * language is spoken with the wrong phonetics unless we pick a matching voice.
 */

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[A-Za-z]/;

/**
 * Detect a reply's language by dominant script. Cyrillic vs Latin letter counts
 * cover the RU/EN case; ties and script-less text (digits/symbols only) default to
 * `"en"`. Returns a lowercase language code to look up in the voice map.
 */
export function detectLang(text: string): string {
  let cyr = 0;
  let lat = 0;
  for (const ch of text) {
    if (CYRILLIC.test(ch)) cyr++;
    else if (LATIN.test(ch)) lat++;
  }
  return cyr > lat ? "ru" : "en";
}

/**
 * Pick the TTS voice for a reply: the per-language override for its detected
 * language, else the default voice. An empty/absent map → always the default
 * (behaviour unchanged from a single-voice deployment).
 */
export function pickVoice(
  text: string,
  defaultVoice: string | undefined,
  map: Record<string, string> | undefined,
): string | undefined {
  if (!map) return defaultVoice;
  return map[detectLang(text)] ?? defaultVoice;
}
