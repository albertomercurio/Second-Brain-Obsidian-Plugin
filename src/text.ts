// Small helpers for names and dates, shared by the whole core.

/** Unicode NFC: macOS can return file names in NFD. */
export const nfc = (text: string): string => text.normalize("NFC");

/** Lowercase without diacritics, for tolerant comparisons (Muñoz ≈ munoz). */
export const fold = (text: string): string => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** Key used to resolve links: NFC and case-insensitive, as Obsidian does. */
export const linkKey = (text: string): string => nfc(text).toLowerCase();

/** Plain code-point order, stable across platforms and locales. */
export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The YYYY-MM-DD of a value, or null if it is not a real date (2020-02-30 is not). */
export function asDate(value: unknown): string | null {
  const day = typeof value === "string" ? value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/)?.[1] : undefined;
  if (!day) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

/** Day and time as "YYYY-MM-DDTHH:mm:ss", or null when the value has no valid time. */
export function asMoment(value: unknown): string | null {
  const day = asDate(value);
  const time = day && typeof value === "string" ? /[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim()) : null;
  return time ? `${day}T${time[1]}:${time[2]}:${time[3] ?? "00"}` : null;
}

/** The name of a note dated by its type: "Title (YYYY-MM-DD)". */
export const datedName = (title: string, day: string): string => `${title} (${day})`;

/** Title and day of a dated name, or null when the name does not end with a valid day in parentheses. */
export function splitDatedName(name: string): { title: string; day: string } | null {
  const match = /^(.*?)\s*\((\d{4}-\d{2}-\d{2})\)$/.exec(name.trim());
  return match && asDate(match[2]) ? { title: match[1], day: match[2] } : null;
}

/** Days from `from` to `to`, both YYYY-MM-DD. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** `day` moved by `days`. */
export const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Today in local time. */
export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The candidate most similar to `word` (edit distance), if similar enough. */
export function closest(word: string, candidates: string[], cutoff = 0.6): string | null {
  let best: string | null = null;
  let bestScore = cutoff;
  for (const candidate of candidates) {
    const score = 1 - editDistance(word, candidate) / Math.max(word.length, candidate.length, 1);
    if (score >= bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}
