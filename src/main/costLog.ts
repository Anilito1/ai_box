import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dayOf, decodeMission, decodeRecord, encodeMission, encodeRecord, sumUsage, type DayCost, type MissionEvent, type TurnRecord } from '../shared/costs';
import type { RateLimits } from '../shared/types';

const FILE = /^turns-(\d{4})-(\d{2})\.jsonl$/;
const MISSIONS = /^missions-(\d{4})-(\d{2})\.jsonl$/;
const monthFile = (at: number, kind = 'turns') => {
  const d = new Date(at);
  return `${kind}-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
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
  /** The cost of the turns of today (local day), kept as they are appended: the status bar shows it. */
  private day: DayCost;
  /** Last plan-limit figures written, per account: a reading that changes nothing is not written again. */
  private readonly lastLimits = new Map<string, string>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'usage');
    this.since = this.readSince();
    this.day = this.readDay(Date.now());
  }

  /** Today's cost; 0 from midnight on. */
  today(now = Date.now()): DayCost {
    const day = dayOf(now);
    if (this.day.day !== day) this.day = { day, cost: 0 };
    return this.day;
  }

  /** Read once at start, from the files of the UTC months the local day touches. */
  private readDay(now: number): DayCost {
    const day = dayOf(now);
    const end = dayOf(day + 36 * 3_600_000);
    let cost = 0;
    for (const name of new Set([monthFile(day), monthFile(end - 1)])) {
      let text: string;
      try {
        text = readFileSync(join(this.dir, name), 'utf8');
      } catch {
        continue; // No turn that month yet.
      }
      for (const line of text.split('\n')) {
        const r = line ? decodeRecord(line) : null;
        if (r && r.at >= day && r.at < end) cost += sumUsage(r.models).cost;
      }
    }
    return { day, cost };
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
    const today = this.today();
    if (dayOf(record.at) === today.day) this.day = { ...today, cost: today.cost + sumUsage(record.models).cost };
    this.tail = this.tail
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(join(this.dir, monthFile(record.at)), line, 'utf8');
      })
      .catch(() => undefined); // Disk full or locked: this turn is missing from the history, the next ones are not.
  }

  /**
   * A plan-limit reading (5 h, 7 days, Fable), written to `limits-YYYY-MM.jsonl` when one of its figures changes. Set
   * against the turns of the same hours, these readings show how the plan counts each kind of token (cache reads and
   * writes included), which the plan's own pages do not say.
   */
  limits(at: number, account: string, l: RateLimits): void {
    const key = JSON.stringify([l.fiveHourPct, l.sevenDayPct, l.fablePct ?? null, l.fiveHourResetsAt, l.sevenDayResetsAt]);
    if (this.lastLimits.get(account) === key) return;
    this.lastLimits.set(account, key);
    const line = `${JSON.stringify({ t: at, a: account, h5: l.fiveHourPct, r5: l.fiveHourResetsAt, d7: l.sevenDayPct, r7: l.sevenDayResetsAt, ...(l.fablePct == null ? {} : { fb: l.fablePct }) })}\n`;
    this.tail = this.tail
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(join(this.dir, monthFile(at, 'limits')), line, 'utf8');
      })
      .catch(() => undefined); // Disk full or locked: one reading less, the next change is written.
  }

  /** A mission handed out (missions-YYYY-MM.jsonl): its turns carry its id, the cost panel puts them together. */
  mission(e: MissionEvent): void {
    const line = `${encodeMission(e)}\n`;
    this.tail = this.tail
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(join(this.dir, monthFile(e.at, 'missions')), line, 'utf8');
      })
      .catch(() => undefined); // Disk full or locked: this mission's turns go uncounted as a mission, not lost as turns.
  }

  /** Mission events in [from, to), oldest first, from the months the range touches and the one before (a mission may start earlier). */
  async readMissions(from: number, to: number): Promise<MissionEvent[]> {
    await this.tail;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: MissionEvent[] = [];
    for (const name of names) {
      const m = MISSIONS.exec(name);
      if (!m) continue;
      const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
      const end = Date.UTC(Number(m[1]), Number(m[2]), 1);
      if (end <= from - 31 * 86_400_000 || start >= to) continue;
      const text = await readFile(join(this.dir, name), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        const e = line ? decodeMission(line) : null;
        if (e && e.at < to) out.push(e);
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Each session's current mission, from this month's and last month's log: read once at start, so a restart keeps it. */
  lastMissions(now = Date.now()): Map<string, string> {
    const out = new Map<string, string>();
    const d = new Date(now);
    for (const at of [Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15), now]) {
      let text = '';
      try {
        text = readFileSync(join(this.dir, monthFile(at, 'missions')), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const e = line ? decodeMission(line) : null;
        if (e) out.set(e.id, e.mission);
      }
    }
    return out;
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
