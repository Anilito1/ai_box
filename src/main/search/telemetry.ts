import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What became of a search: `read-range` (the agent read lines the search pointed at), `read-whole` (it read one of
 * the files, from the top), `searched-again`, `grep` (it went back to Grep or Glob), `unused` (none of these in its
 * next calls).
 */
export type Outcome = 'read-range' | 'read-whole' | 'searched-again' | 'grep' | 'unused';
export interface SearchRecord { at: number; tool: string; results: number; unsure: boolean; outcome: Outcome; calls: number }

interface Open { tool: string; at: number; ranges: { path: string; start: number; end: number }[]; unsure: boolean; calls: number; grep: boolean }

/** A search is judged on the agent's next calls: past these, it was not used. */
const WATCH = 4;
const MAX_BYTES = 2 * 1024 * 1024;
const SEARCHES = /(^|__)(search_code|where_is|search_memory)$/;

/** The places an answer points at: every `path:start-end` at the start of a line or after `repo `. */
export function rangesOf(answer: string): Open['ranges'] {
  return [...answer.matchAll(/(?:^|\s)([^\s:]+\.[A-Za-z0-9]+):(\d+)-(\d+)/gm)].map((m) => ({ path: m[1].replace(/\\/g, '/'), start: Number(m[2]), end: Number(m[3]) }));
}

/**
 * Whether the local search earns its place: for each search, what the agent did next. Kept on this machine only,
 * and without a word of the question or a path: a line says which tool, how many results, and the outcome.
 * Only sessions whose tool calls are visible as Read and Grep (Claude Code) can be judged; the others are not recorded.
 */
export class SearchTelemetry {
  private readonly open = new Map<string, Open>();
  private readonly seen = new Map<string, string[]>();

  constructor(
    private readonly file: string,
    private readonly write: (record: SearchRecord) => void = (record) => this.append(record),
  ) {}

  private append(record: SearchRecord): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // One generation is kept: enough to see a trend, never a file that grows for ever.
      if ((statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(this.file, `${this.file}.old`);
      appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    } catch {
      // a measure that cannot be written is lost, the search itself is not concerned
    }
  }

  private close(session: string, outcome: Outcome): void {
    const o = this.open.get(session);
    if (!o) return;
    this.open.delete(session);
    this.write({ at: o.at, tool: o.tool, results: o.ranges.length, unsure: o.unsure, outcome, calls: o.calls });
  }

  /** A search answered a session. */
  searched(session: string, tool: string, answer: string): void {
    this.close(session, 'searched-again');
    this.open.set(session, { tool, at: Date.now(), ranges: rangesOf(answer), unsure: answer.startsWith('No confident match') || answer.startsWith('No result') || answer.startsWith('Nothing is named'), calls: 0, grep: false });
  }

  /** A tool call of a session, seen once whatever the number of times the program repeats it. */
  used(session: string, id: string, name: string, input: unknown): void {
    const o = this.open.get(session);
    if (!o || SEARCHES.test(name)) return;
    const ids = this.seen.get(session) ?? [];
    if (ids.includes(id)) return;
    this.seen.set(session, [...ids.slice(-49), id]);
    o.calls++;
    const args = (input && typeof input === 'object' ? input : {}) as { file_path?: unknown; offset?: unknown; limit?: unknown };
    if (name === 'Read' && typeof args.file_path === 'string') {
      const file = args.file_path.replace(/\\/g, '/');
      const hits = o.ranges.filter((r) => file === r.path || file.endsWith(`/${r.path}`));
      if (hits.length) {
        const from = typeof args.offset === 'number' ? args.offset : 0;
        const to = typeof args.limit === 'number' ? from + args.limit : Number.MAX_SAFE_INTEGER;
        return this.close(session, from > 0 && hits.some((r) => r.start <= to && r.end >= from) ? 'read-range' : 'read-whole');
      }
    }
    if (name === 'Grep' || name === 'Glob') o.grep = true;
    if (o.calls >= WATCH) this.close(session, o.grep ? 'grep' : 'unused');
  }

  /** The turn ended: what is still watched is settled. */
  settle(session: string): void {
    const o = this.open.get(session);
    if (o) this.close(session, o.grep ? 'grep' : 'unused');
  }
}
