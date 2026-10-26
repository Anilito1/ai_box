import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeRecord, encodeRecord, type TurnRecord } from '../shared/costs';

const FILE = /^turns-(\d{4})-(\d{2})\.jsonl$/;
const monthFile = (at: number) => {
  const d = new Date(at);
  return `turns-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
};

/**
 * What every turn of every session spent, one JSON line per turn appended to a file per month (UTC) in
 * `<userData>/usage`. Written as turns end, read only when the cost panel or /cost asks: nothing runs at rest.
 */
export class CostLog {
  private readonly dir: string;
  /** Appends in order, one at a time. */
  private tail: Promise<unknown> = Promise.resolve();
  /** When the log started: costs before it are not known by turn. */
  readonly since: number;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'usage');
    this.since = this.readSince();
  }

  private readSince(): number {
    const file = join(this.dir, 'since.json');
    try {
      const at = (JSON.parse(readFileSync(file, 'utf8')) as { since?: unknown }).since;
      if (typeof at === 'number' && Number.isFinite(at)) return at;
    } catch {
      // First start with the log: it starts now.
    }
    const now = Date.now();
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ since: now }));
    } catch {
      // Not writable: the panel says "since now" until it is.
    }
    return now;
  }

  append(record: TurnRecord): void {
    const line = `${encodeRecord(record)}\n`;
    this.tail = this.tail
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(join(this.dir, monthFile(record.at)), line, 'utf8');
      })
      .catch(() => undefined); // Disk full or locked: this turn is missing from the history, the next ones are not.
  }

  /** Turns in [from, to), oldest first; only the months the range touches are read. */
  async read(from: number, to: number): Promise<TurnRecord[]> {
    await this.tail; // Turns just written are included.
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: TurnRecord[] = [];
    for (const name of names) {
      const m = FILE.exec(name);
      if (!m) continue;
      const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
      const end = Date.UTC(Number(m[1]), Number(m[2]), 1);
      if (end <= from || start >= to) continue;
      let text: string;
      try {
        text = await readFile(join(this.dir, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const r = line ? decodeRecord(line) : null;
        if (r && r.at >= from && r.at < to) out.push(r);
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }
}
