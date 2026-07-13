/**
 * Shared stale-while-revalidate cache for the org's Resemble voices +
 * characters. Both the Voice Library and the per-script Casting screen read
 * from it so they paint instantly, then revalidate in the background — the
 * Resemble voice list is a slow, several-round-trip fetch and casting has no
 * reason to block on it every time a script is opened.
 *
 * Stored under a single localStorage key so the two screens share one copy:
 * loading the library warms casting, and vice-versa.
 */

export interface CachedVoice {
  uuid: string;
  name?: string;
  display_name?: string | null;
  has_preview?: boolean;
}

export interface CachedCharacter {
  id: string;
  name: string;
  display_name?: string | null;
  resemble_voice_id: string | null;
  language?: "he" | "en";
}

export interface VoiceCache {
  voices?: CachedVoice[];
  account?: unknown;
  chars?: CachedCharacter[];
}

export const VOICE_CACHE_KEY = "smrtvoice.library.v1";

export function readVoiceCache(): VoiceCache | null {
  try {
    const raw = localStorage.getItem(VOICE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as VoiceCache;
  } catch {
    return null;
  }
}

/** Merge-write: only the provided fields are replaced, the rest are preserved. */
export function writeVoiceCache(patch: VoiceCache): void {
  try {
    const prev = readVoiceCache() ?? {};
    localStorage.setItem(VOICE_CACHE_KEY, JSON.stringify({ ...prev, ...patch }));
  } catch {
    /* quota / serialization — non-fatal */
  }
}
