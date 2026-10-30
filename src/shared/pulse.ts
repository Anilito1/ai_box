import type { SessionView } from './types';

// What the working line says from what really came out of a session's process: how long it has been quiet, and whether
// that is normal for what it is doing. Pure, and the timers of the line play no part in it.

export type PulseTone = 'ok' | 'slow' | 'stuck' | 'neutral';

export interface PulseState {
  tone: PulseTone;
  /** No event of the process since this turn began, or since the last approval. */
  silent: boolean;
  /** Time shown: since the last event, or since the wait began when nothing came yet. */
  ms: number;
}

/** A model that streams says something all the time: a short silence already means something. One that may think in silence is never called stuck. */
const modelTone = (quiet: number, streams: boolean): PulseTone => (quiet < 30_000 ? 'ok' : quiet <= 120_000 || !streams ? 'slow' : 'stuck');
/** A tool, a compaction or an API retry waiting its delay has nothing to say until it ends: only its length can tell. */
const toolTone = (quiet: number): PulseTone => (quiet <= 120_000 ? 'ok' : quiet <= 600_000 ? 'slow' : 'stuck');

type Seen = Pick<SessionView, 'status' | 'busySince' | 'compacting' | 'retrying' | 'limit' | 'tool' | 'pulse' | 'approvedAt' | 'modelStreams'>;

/** Null: nothing to show. An approval waits for the user, not for the process. */
export function pulseState(s: Seen, now: number): PulseState | null {
  if (s.status === 'attention') return null;
  const { signalAt } = s.pulse;
  if (s.status !== 'busy') return signalAt === null ? null : { tone: 'neutral', silent: false, ms: Math.max(0, now - signalAt) };
  const waitFrom = Math.max(s.busySince ?? 0, s.approvedAt ?? 0);
  const silent = signalAt === null || signalAt < waitFrom;
  const ms = Math.max(0, now - (silent ? waitFrom : signalAt));
  // A limit is a known reason to wait: neither fine nor stuck.
  if (s.limit) return { tone: 'neutral', silent, ms };
  // Measured from the tool's start or its last event alike: a tool that keeps talking stays fine.
  const quiet = Math.max(0, now - Math.max(signalAt ?? 0, waitFrom));
  return { tone: s.tool || s.compacting || s.retrying ? toolTone(quiet) : modelTone(quiet, s.modelStreams), silent, ms };
}

/** The tokens of a turn, short and in the reader's language: "850", "3,2 k", "1,5 M". */
export function shortTokens(tokens: number, locale: string): string {
  const fr = locale.startsWith('fr');
  const one = (v: number) => {
    const text = v.toFixed(1).replace(/\.0$/, '');
    return fr ? `${text.replace('.', ',')} ` : text;
  };
  if (tokens >= 999_950) return `${one(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${one(tokens / 1000)}k`;
  return String(tokens);
}

/** About four characters to a token, the usual rule of thumb. */
export const tokensOf = (text: string) => text.length / 4;

/** Tokens the model sent in the turn in progress: real counts where the provider gives them, else an estimate. */
export class TurnTokens {
  private settled = 0;
  private reply = 0;
  private guess = 0;
  /** An estimate stayed in `settled`: a reply was cut before its real count. */
  private rough = false;

  /** Content arrived that no real count covers yet. */
  estimate(tokens: number): void {
    this.guess += tokens;
  }

  /** The real count of the reply being written so far. */
  replyCount(tokens: number): void {
    if (tokens <= 0) return;
    this.reply = tokens;
    this.guess = 0;
  }

  /** The next reply of the turn begins: what the last one came to stays. */
  nextReply(): void {
    this.rough ||= this.guess > 0;
    this.settled += this.reply + Math.ceil(this.guess);
    this.reply = 0;
    this.guess = 0;
  }

  /** The real count of the whole turn so far, for a provider that gives that. */
  turnCount(tokens: number): void {
    if (tokens <= 0) return;
    this.settled = tokens;
    this.reply = 0;
    this.guess = 0;
    this.rough = false;
  }

  reset(): void {
    this.settled = this.reply = this.guess = 0;
    this.rough = false;
  }

  get estimated(): boolean {
    return this.rough || this.guess > 0;
  }

  get count(): number {
    return this.settled + this.reply + Math.ceil(this.guess);
  }
}
