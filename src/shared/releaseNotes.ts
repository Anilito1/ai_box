// The notes shown at start when the app changed since the last start: docs/notes-de-version.md, written by hand in
// French, is bundled into the build. Each line is known by a fingerprint of its text; the user-data folder keeps the
// ones already shown, so the lines of every build skipped since add up, and a build without a new line shows nothing.
// The logic here is pure; main/releaseNotes.ts reads and writes the files.

export const NOTE_SECTIONS = ['added', 'changed', 'removed'] as const;
export type NoteSection = (typeof NOTE_SECTIONS)[number];

/** Lines grouped by section, newest first. */
export type Notes = Record<NoteSection, string[]>;

/** One `## …` block of the file: a release, newest first. */
export interface NoteEntry extends Notes {
  title: string;
}

/** The lines already shown, by fingerprint. */
export interface NotesMemory {
  seen: string[];
}

/** Fingerprints kept: far more than the file ever holds, so a line dropped from it and put back is not shown again. */
const KEEP = 2000;

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** The `### …` headings the file may use, accents and case aside. */
const HEADINGS: Record<string, NoteSection> = {
  ajoute: 'added',
  ajouts: 'added',
  nouveau: 'added',
  nouveautes: 'added',
  added: 'added',
  modifie: 'changed',
  modifications: 'changed',
  corrige: 'changed',
  changed: 'changed',
  fixed: 'changed',
  supprime: 'removed',
  retire: 'removed',
  removed: 'removed',
};

export const emptyNotes = (): Notes => ({ added: [], changed: [], removed: [] });

/** The file's releases, and what it holds that is not a note (an unknown heading, a line outside a section). */
export function parseNotes(md: string): { entries: NoteEntry[]; problems: string[] } {
  const entries: NoteEntry[] = [];
  const problems: string[] = [];
  let entry: NoteEntry | null = null;
  let section: NoteSection | null = null;
  for (const [i, raw] of md.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const at = `ligne ${i + 1}`;
    if (/^##\s/.test(line)) {
      entry = { title: line.replace(/^##\s+/, ''), ...emptyNotes() };
      entries.push(entry);
      section = null;
    } else if (/^###\s/.test(line)) {
      section = HEADINGS[fold(line.replace(/^###\s+/, '').replace(/[\s:]+$/, ''))] ?? null;
      if (!entry || !section) problems.push(`${at} : section inconnue « ${line} » (Ajouté, Modifié ou Supprimé)`);
    } else if (/^[-*]\s/.test(line)) {
      const text = line.replace(/^[-*]\s+/, '');
      if (entry && section) entry[section].push(text);
      else problems.push(`${at} : ligne hors d'une section « ${line} »`);
    } else if (entry) problems.push(`${at} : ni titre ni ligne « - … » : « ${line} »`);
    // Before the first release: the file's own explanations.
  }
  return { entries, problems };
}

/** FNV-1a over the folded text: the same line keeps its fingerprint whatever its accents, case or spaces. */
export function fingerprint(section: NoteSection, text: string): string {
  let hash = 0x811c9dc5;
  for (const c of `${section}:${fold(text)}`) {
    hash ^= c.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const lines = (entries: NoteEntry[]) => entries.flatMap((e) => NOTE_SECTIONS.flatMap((s) => e[s].map((text) => ({ section: s, text, key: fingerprint(s, text) }))));

/**
 * What to show at this start, null for nothing. Without a memory, a new install (`fresh`) shows nothing, and a build
 * from before the notes existed shows its latest release only, not the whole history.
 */
export function pendingNotes(entries: NoteEntry[], memory: NotesMemory | null, fresh: boolean): Notes | null {
  if (!memory && fresh) return null;
  const seen = new Set(memory?.seen ?? []);
  const notes = emptyNotes();
  const shown = new Set<string>();
  for (const { section, text, key } of lines(memory ? entries : entries.slice(0, 1))) {
    if (seen.has(key) || shown.has(key)) continue;
    shown.add(key);
    notes[section].push(text);
  }
  return NOTE_SECTIONS.some((s) => notes[s].length > 0) ? notes : null;
}

/** The memory once every line of the file has been shown. */
export function markSeen(entries: NoteEntry[], memory: NotesMemory | null): NotesMemory {
  return { seen: [...new Set([...lines(entries).map((l) => l.key), ...(memory?.seen ?? [])])].slice(0, KEEP) };
}

/** Reads a memory file's contents; anything else than a list of fingerprints is no memory. */
export function readMemory(raw: unknown): NotesMemory | null {
  const seen = raw && typeof raw === 'object' ? (raw as { seen?: unknown }).seen : undefined;
  return Array.isArray(seen) ? { seen: seen.filter((s): s is string => typeof s === 'string').slice(0, KEEP) } : null;
}
