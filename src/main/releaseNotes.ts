import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import source from '../../docs/notes-de-version.md';
import { markSeen, parseNotes, pendingNotes, readMemory, type NoteEntry, type Notes, type NotesMemory } from '../shared/releaseNotes';

// The release notes of this build (docs/notes-de-version.md, bundled) against the lines already shown, kept in the
// user-data folder. Worked out once per start; nothing reaches the network.

const FILE = 'release-notes.json';

export class ReleaseNotes {
  private readonly entries: NoteEntry[] = parseNotes(source).entries;
  private memory: NotesMemory | null;
  private pending: Notes | null;

  /** `fresh`: a new install (the first-run setup not done), which records the notes without showing them. */
  constructor(
    private readonly dataDir: string,
    fresh: boolean,
  ) {
    this.memory = this.load();
    this.pending = pendingNotes(this.entries, this.memory, fresh);
    if (!this.memory && !this.pending) this.seen();
  }

  /** What to show at this start, null for nothing; null too once shown (a reload of the window shows it no more). */
  notes(): Notes | null {
    return this.pending;
  }

  /** The window showed the notes. */
  seen(): void {
    this.pending = null;
    this.memory = markSeen(this.entries, this.memory);
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = join(this.dataDir, `${FILE}.tmp`);
      writeFileSync(tmp, JSON.stringify(this.memory));
      renameSync(tmp, join(this.dataDir, FILE));
    } catch {
      // A failed write only means the same notes may show at the next start.
    }
  }

  private load(): NotesMemory | null {
    try {
      return readMemory(JSON.parse(readFileSync(join(this.dataDir, FILE), 'utf8')));
    } catch {
      return null;
    }
  }
}
