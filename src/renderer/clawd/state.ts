import type { ChatItem, HubEventKind, Mode, Role, SessionView, Status } from '../../shared/types';

// What a worker's Clawd plays, decided from its session alone: no DOM, no three.js, the clock and dice passed in.

export interface ClipInfo {
  /** Seconds at speed 1. */
  duration: number;
  loop: boolean;
  /** Keys the eyes' scale (an expression): no blink on top of it. */
  expr: boolean;
}

/** The clips baked in assets/clawd.glb (asset.extras.clawd.clips); the stage warns when one is missing. */
export const CLIPS = {
  attention_wave: { duration: 1, loop: true, expr: true },
  checklist: { duration: 1.5, loop: true, expr: false },
  compact_squish: { duration: 2, loop: false, expr: true },
  crash_ko: { duration: 1.5, loop: false, expr: true },
  dance: { duration: 2, loop: true, expr: false },
  delegate_juggle: { duration: 1, loop: true, expr: false },
  done_celebrate: { duration: 1.5, loop: false, expr: true },
  eyes_blink: { duration: 0.25, loop: false, expr: false },
  fall_asleep: { duration: 3, loop: false, expr: true },
  flag_wave: { duration: 1, loop: true, expr: false },
  idle_breathe: { duration: 3, loop: true, expr: false },
  idle_drowsy: { duration: 3, loop: true, expr: true },
  idle_hop: { duration: 1, loop: false, expr: false },
  idle_look_around: { duration: 2.5, loop: false, expr: false },
  idle_stretch: { duration: 2, loop: false, expr: true },
  interrupted: { duration: 0.8333, loop: false, expr: true },
  ko_loop: { duration: 1, loop: true, expr: true },
  master_conduct: { duration: 1.3333, loop: true, expr: false },
  money_coin: { duration: 1, loop: false, expr: false },
  oops_flinch: { duration: 0.75, loop: false, expr: true },
  poke: { duration: 0.6667, loop: false, expr: true },
  receive_message: { duration: 1, loop: false, expr: true },
  retry_dizzy: { duration: 1.3333, loop: true, expr: false },
  rocket_jump: { duration: 1.5, loop: false, expr: false },
  search_read: { duration: 2, loop: true, expr: true },
  send_message: { duration: 1.25, loop: false, expr: false },
  sleep_loop: { duration: 4, loop: true, expr: true },
  spawn_pop: { duration: 1, loop: false, expr: false },
  sweat_overlay: { duration: 1.5, loop: true, expr: false },
  test_fail_slump: { duration: 1.25, loop: false, expr: true },
  think: { duration: 2, loop: true, expr: false },
  wait_coffee: { duration: 3, loop: true, expr: true },
  wake_up: { duration: 1.25, loop: false, expr: true },
  web_search: { duration: 2, loop: true, expr: false },
  work_hammer: { duration: 0.75, loop: true, expr: false },
  work_type: { duration: 0.5, loop: true, expr: false },
} as const satisfies Record<string, ClipInfo>;

export type Clip = keyof typeof CLIPS;
export type Hat = 'crown' | 'pumpkin' | 'santa' | 'party' | 'nightcap';
/** Hub events, plus what happens in the UI itself: a click on the mascot, every worker done at once. */
export type MindEvent = HubEventKind | 'poke' | 'party';

/** Resting loops: held as a still pose, only blinks and fidgets move it. */
export const REST = new Set<Clip>(['idle_breathe', 'idle_drowsy', 'sleep_loop', 'ko_loop']);
/** Slow loops that keep moving at half pace: waiting on a background task, the master conducting. */
export const CALM = new Set<Clip>(['wait_coffee', 'master_conduct']);
/** Everyday fidgets of a resting Clawd, drawn at the slow pace too. */
export const FIDGETS = new Set<Clip>(['idle_look_around', 'idle_hop', 'idle_stretch']);
/** Lying down: entered through fall_asleep / crash_ko, left through wake_up. */
const DOWN = new Set<Clip>(['sleep_loop', 'ko_loop']);
/** Poses that leave the left arm free for the blueprint of a session in plan mode. */
const BLUEPRINT_CLIPS = new Set<Clip>(['idle_breathe', 'idle_drowsy', 'idle_look_around', 'search_read']);

const DROWSY_MS = 5 * 60_000;
const ASLEEP_MS = 10 * 60_000;
const SWEAT_TURN_MS = 10 * 60_000;
const SWEAT_CONTEXT_PCT = 80;
/** A base clip shows at least this long: a Read, an Edit, a Read in a row must not flicker. */
const MIN_DWELL_MS = 800;
/** Shorter turns end without fanfare. */
const CELEBRATE_MIN_MS = 8_000;
/** The same reaction again within this delay is noise (a burst of failing tool calls). */
const COOLDOWN_MS = 4_000;
/** A new session shown this soon after its creation is being born, not resumed. */
const NEWBORN_MS = 15_000;
// Every frame drawn costs CPU and GPU: a resting Clawd fidgets every 20-45 s and blinks every 4-9 s.
const FIDGET_MS = [20_000, 45_000] as const;
const BLINK_MS = [4_000, 9_000] as const;
const DOUBLE_BLINK_MS = 350;
const FRENZY_POKES = 4;
const FRENZY_MS = 2_000;

/** The one-shot each event plays, its priority (a lower one never cuts a higher one) and repetitions. */
const REACTIONS: Partial<Record<MindEvent, { clip: Clip; prio: number; reps?: number }>> = {
  turn_done: { clip: 'done_celebrate', prio: 4 },
  pushed: { clip: 'flag_wave', prio: 4, reps: 2 },
  deployed: { clip: 'rocket_jump', prio: 4 },
  tests_failed: { clip: 'test_fail_slump', prio: 3 },
  tool_error: { clip: 'oops_flinch', prio: 3 },
  interrupted: { clip: 'interrupted', prio: 3 },
  compacting: { clip: 'compact_squish', prio: 3 },
  retry: { clip: 'retry_dizzy', prio: 2 },
  message_in: { clip: 'receive_message', prio: 2 },
  message_out: { clip: 'send_message', prio: 2 },
  cost_milestone: { clip: 'money_coin', prio: 2 },
  poke: { clip: 'poke', prio: 2 },
  party: { clip: 'dance', prio: 2, reps: 2 },
  // Starts dozing off as the hub closes it; the closed status then keeps it asleep.
  idle_closed: { clip: 'fall_asleep', prio: 4 },
};
const CRASH_PRIO = 5;
const TRANSITION_PRIO = 4;
const FIDGET_PRIO = 1;

/** What the mascot needs to know about its session. */
export interface Signals {
  role: Role;
  status: Status;
  /** Display name of the tool running now (the latest chat item), else null. */
  tool: string | null;
  /** Reply text streaming in. */
  writing: boolean;
  background: number;
  agents: number;
  compacting: boolean;
  retrying: boolean;
  contextPct: number | null;
  busySince: number | null;
  idleSince: number | null;
  mode: Mode | null;
  createdAt: number;
  /** Master only: workers at work right now. */
  workersBusy: number;
}

export function signalsOf(s: SessionView, last: ChatItem | undefined, workersBusy = 0): Signals {
  return {
    role: s.role,
    status: s.status,
    tool: last?.kind === 'tool' && last.result === null ? last.name : null,
    writing: last?.kind === 'assistant' && last.live,
    background: s.background.length,
    agents: s.agents,
    compacting: s.compacting,
    retrying: s.retrying,
    contextPct: s.metrics?.contextPct ?? null,
    busySince: s.busySince,
    idleSince: s.idleSince,
    mode: s.mode,
    createdAt: s.createdAt,
    workersBusy,
  };
}

// Tools by display name (MCP tools read "server · tool"). The throw of a message is its own one-shot (message_out).
const TOOL_CLIPS: [RegExp, Clip][] = [
  [/^(Edit|MultiEdit|Write|NotebookEdit)$/, 'work_type'],
  [/^(Read|Grep|Glob|LS|LSP|NotebookRead|ToolSearch|BashOutput|TaskOutput)$|^hub · (list_workers|list_repos|worker_report)$/, 'search_read'],
  [/^(WebSearch|WebFetch)$|^playwright · /, 'web_search'],
  [/^(Agent|Task)$/, 'delegate_juggle'],
  [/^(TodoWrite|TaskCreate|TaskUpdate|TaskList|ExitPlanMode)$/, 'checklist'],
  [/^(SendMessage|Skill)$|^hub · /, 'think'],
];

/** Commands, scripts and every other tool hammer away. */
export function toolClip(tool: string): Clip {
  return TOOL_CLIPS.find(([pattern]) => pattern.test(tool))?.[1] ?? 'work_hammer';
}

/** The loop a session's state calls for, before transitions and one-shots. */
export function baseClip(sig: Signals, now: number, crashed: boolean): Clip {
  if (sig.status === 'exited') return crashed ? 'ko_loop' : 'sleep_loop';
  if (sig.status === 'attention') return 'attention_wave';
  if (sig.status === 'starting') return 'idle_breathe';
  if (sig.retrying) return 'retry_dizzy';
  if (sig.compacting) return 'compact_squish';
  if (sig.status === 'busy') return sig.tool ? toolClip(sig.tool) : sig.writing ? 'work_type' : 'think';
  if (sig.background > 0) return sig.agents > 0 ? 'delegate_juggle' : 'wait_coffee';
  if (sig.role === 'master' && sig.workersBusy > 0) return 'master_conduct';
  const idleFor = sig.idleSince === null ? 0 : now - sig.idleSince;
  if (idleFor >= ASLEEP_MS) return 'sleep_loop';
  return idleFor >= DROWSY_MS ? 'idle_drowsy' : 'idle_breathe';
}

/** Pumpkin around Halloween, Santa's hat in December, a party hat at New Year. */
export function seasonalHat(date: Date): Hat | null {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if ((month === 10 && day >= 17) || (month === 11 && day <= 2)) return 'pumpkin';
  if (month === 12 && day <= 26) return 'santa';
  if ((month === 12 && day === 31) || (month === 1 && day <= 2)) return 'party';
  return null;
}

/** The master wears the crown; a Clawd asleep at night swaps its hat for a nightcap. */
export function hatFor(role: Role, asleep: boolean, date: Date): Hat | null {
  if (role === 'master') return 'crown';
  const hour = date.getHours();
  if (asleep && (hour >= 22 || hour < 7)) return 'nightcap';
  return seasonalHat(date);
}

/** FNV-1a: stable across launches, so a worker keeps its look. */
export function hash(seed: string): number {
  let n = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) n = Math.imul(n ^ seed.charCodeAt(i), 0x01000193);
  return n >>> 0;
}

export interface Pose {
  /** Clip to show now: the one-shot playing, else the base loop. */
  clip: Clip;
  base: Clip;
  /** Times to play `clip`: Infinity for the base loop. */
  reps: number;
  /** Changes at every new playback, so the stage restarts even the same clip. */
  serial: number;
  sweat: boolean;
  hat: Hat | null;
  blueprint: boolean;
  /** Closed and settled: one frame is enough. */
  still: boolean;
}

interface Shot {
  clip: Clip;
  prio: number;
  reps: number;
  until: number;
}

/** A session's mascot over time: base loop, one-shots by priority, fidgets, blinks, falling asleep. */
export class Mind {
  /** Own pace and loop phase, so a column of Clawds never moves in lockstep. */
  readonly speed: number;
  readonly phase: number;
  private sig: Signals | null = null;
  private base: Clip = 'idle_breathe';
  private baseSince = 0;
  private shot: Shot | null = null;
  private serial = 0;
  private crashed = false;
  private busyFrom = 0;
  private nextFidget = 0;
  private nextBlink = 0;
  private blinkCount = 0;
  private pokes: number[] = [];
  private readonly lastPlayed = new Map<Clip, number>();

  constructor(
    seed: string,
    private readonly random: () => number = Math.random,
  ) {
    const n = hash(seed);
    this.speed = 0.9 + ((n >>> 3) % 21) / 100;
    this.phase = ((n >>> 11) % 1000) / 1000;
  }

  update(sig: Signals, now: number): void {
    const prev = this.sig;
    this.sig = sig;
    if (sig.busySince !== null) this.busyFrom = sig.busySince;
    // Cleared only once it is back up: a stale view still showing it busy must not undo the crash.
    if (prev?.status === 'exited' && sig.status !== 'exited') this.crashed = false;
    if (prev) return;
    // First sight: the current state as is, no transition, except a worker being born or a session starting up.
    this.base = baseClip(sig, now, false);
    this.baseSince = now;
    this.nextFidget = now + this.between(FIDGET_MS);
    this.serial++;
    if (sig.status === 'starting') this.play(now - sig.createdAt < NEWBORN_MS ? 'spawn_pop' : 'wake_up', TRANSITION_PRIO, 1, now);
  }

  event(kind: MindEvent, now: number): void {
    const sig = this.sig;
    if (!sig) return;
    if (kind === 'crashed') {
      this.crashed = true;
      this.play('crash_ko', CRASH_PRIO, 1, now);
      return;
    }
    // Asleep, knocked out or closed, only a poke stirs it; the rest wakes it through its status.
    if (kind !== 'poke' && (sig.status === 'exited' || DOWN.has(this.base))) return;
    if (kind === 'turn_done' && now - this.busyFrom < CELEBRATE_MIN_MS) return;
    if (kind === 'poke' && this.frenzy(now)) {
      this.play('retry_dizzy', 2, 2, now);
      return;
    }
    const reaction = REACTIONS[kind];
    if (!reaction || reaction.clip === this.base) return;
    if (kind !== 'poke' && now - (this.lastPlayed.get(reaction.clip) ?? -Infinity) < COOLDOWN_MS) return;
    if (this.play(reaction.clip, reaction.prio, reaction.reps ?? 1, now)) this.lastPlayed.set(reaction.clip, now);
  }

  /** `quiet`: the hub is in the background, the Clawd does not fidget. */
  pose(now: number, quiet = false): Pose {
    const sig = this.sig;
    if (!sig) throw new Error('Mind.pose before update');
    if (this.shot && now >= this.shot.until) {
      this.shot = null;
      this.serial++; // Back to the base loop: a new playback.
    }
    const want = baseClip(sig, now, this.crashed);
    // Lying down and getting up go through at once; anything else waits for the dwell.
    if (want !== this.base && (now - this.baseSince >= MIN_DWELL_MS || DOWN.has(want) !== DOWN.has(this.base))) this.rebase(want, now);
    if (!this.shot && this.base === 'idle_breathe' && now >= this.nextFidget) {
      if (quiet) this.nextFidget = now + this.between(FIDGET_MS);
      else this.fidget(now);
    }
    const clip = this.shot?.clip ?? this.base;
    const busyFor = sig.status === 'busy' && sig.busySince !== null ? now - sig.busySince : 0;
    const strained = (sig.contextPct ?? 0) >= SWEAT_CONTEXT_PCT || busyFor > SWEAT_TURN_MS;
    return {
      clip,
      base: this.base,
      reps: this.shot?.reps ?? Infinity,
      serial: this.serial,
      // oops_flinch keys the same drop.
      sweat: strained && sig.status !== 'exited' && !DOWN.has(this.base) && clip !== 'oops_flinch',
      hat: hatFor(sig.role, this.base === 'sleep_loop', new Date(now)),
      blueprint: sig.mode === 'plan' && BLUEPRINT_CLIPS.has(clip),
      still: sig.status === 'exited' && !this.shot,
    };
  }

  /**
   * Blinks so far: every 2-6 s, sometimes twice, never over an expression nor while `quiet`. A view blinks when
   * the count moves, so every view of the session blinks together.
   */
  blinks(now: number, quiet = false): number {
    if (now < this.nextBlink) return this.blinkCount;
    this.nextBlink = now + (this.random() < 0.2 ? DOUBLE_BLINK_MS : this.between(BLINK_MS));
    if (!quiet && !CLIPS[this.shot?.clip ?? this.base].expr) this.blinkCount++;
    return this.blinkCount;
  }

  /** Earliest time the pose may change by itself (blink, fidget, end of a one-shot): a still view sleeps until then. */
  nextChange(now: number): number {
    const fidget = !this.shot && this.base === 'idle_breathe' ? this.nextFidget : Infinity;
    return Math.max(now, Math.min(this.nextBlink, fidget, this.shot?.until ?? Infinity));
  }

  private rebase(want: Clip, now: number): void {
    const was = this.base;
    this.base = want;
    this.baseSince = now;
    if (this.shot?.prio === FIDGET_PRIO) this.shot = null; // A fidget gives way to real activity.
    if (DOWN.has(want) && !DOWN.has(was)) this.play(want === 'ko_loop' ? 'crash_ko' : 'fall_asleep', TRANSITION_PRIO, 1, now);
    else if (DOWN.has(was) && !DOWN.has(want)) this.play('wake_up', TRANSITION_PRIO, 1, now);
    if (!this.shot) this.serial++; // Otherwise the one-shot hands over to the new base when it ends.
    this.nextFidget = now + this.between(FIDGET_MS);
  }

  private fidget(now: number): void {
    const roll = this.random();
    if (roll < 1 / 40) this.play('dance', FIDGET_PRIO, 2, now);
    else this.play(roll < 0.5 ? 'idle_look_around' : roll < 0.75 ? 'idle_hop' : 'idle_stretch', FIDGET_PRIO, 1, now);
    this.nextFidget = (this.shot?.until ?? now) + this.between(FIDGET_MS);
  }

  /** Four pokes in a row make it dizzy. */
  private frenzy(now: number): boolean {
    this.pokes = [...this.pokes.filter((at) => now - at < FRENZY_MS), now];
    if (this.pokes.length < FRENZY_POKES) return false;
    this.pokes = [];
    return true;
  }

  private play(clip: Clip, prio: number, reps: number, now: number): boolean {
    if (this.shot && (this.shot.prio > prio || this.shot.clip === clip)) return false;
    this.shot = { clip, prio, reps, until: now + (CLIPS[clip].duration * reps * 1000) / this.speed };
    this.serial++;
    return true;
  }

  private between([min, max]: readonly [number, number]): number {
    return min + this.random() * (max - min);
  }
}
