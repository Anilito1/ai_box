import { readFileSync, statSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';

// Sees the computer change network (a Wi-Fi that drops, a phone's hotspot, back from sleep) while work is under way:
// a reply cut by the switch is then taken up at once instead of after a wait. Nothing runs while no session works.

export interface NetworkWatchDeps {
  /** os.networkInterfaces(). */
  interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Electron's net.isOnline(): false when no connection is up at all. */
  online(): boolean;
  /** When the network last switched by another program's account (Power Box), else 0. Optional: never required. */
  switchedAt?(): number;
}

/** Each look costs a system call (well under a millisecond), and only while a session works. */
export const NETWORK_POLL_MS = 3_000;

/** The addresses the computer is reachable at: one changes when the connection does. IPv6 rotates its temporary addresses, so only IPv4 counts. */
export function networkSignature(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string {
  const out: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list ?? []) {
      if (i.internal || i.family !== 'IPv4' || i.address.startsWith('169.254.')) continue;
      out.push(`${name}=${i.address}`);
    }
  }
  return out.sort().join(',');
}

export class NetworkWatch {
  private timer: NodeJS.Timeout | null = null;
  private signature = '';
  private switched = 0;

  /** `active`: whether a session still works (else the watch stops); `onChange`: the network changed. */
  constructor(
    private readonly deps: NetworkWatchDeps,
    private readonly active: () => boolean,
    private readonly onChange: () => void,
    private readonly periodMs = NETWORK_POLL_MS,
  ) {}

  /** Work started or waits on the network: watch until none does. Cheap to call often. */
  wake(): void {
    if (this.timer) return;
    this.signature = this.read();
    this.switched = this.switchedAt();
    this.timer = setInterval(() => this.tick(), this.periodMs);
    this.timer.unref?.();
  }

  get watching(): boolean {
    return this.timer !== null;
  }

  online(): boolean {
    try {
      return this.deps.online();
    } catch {
      return true;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.active()) return this.stop();
    const signature = this.read();
    const switched = this.switchedAt();
    if (signature === this.signature && switched <= this.switched) return;
    this.signature = signature;
    this.switched = Math.max(this.switched, switched);
    this.onChange();
  }

  private read(): string {
    try {
      return networkSignature(this.deps.interfaces());
    } catch {
      return this.signature;
    }
  }

  private switchedAt(): number {
    try {
      return this.deps.switchedAt?.() ?? 0;
    } catch {
      return 0;
    }
  }
}

/** Keys Power Box may give its last switch under; the file's own time otherwise. */
const SWITCH_KEYS = ['lastSwitchAt', 'lastSwitch', 'switchedAt', 'lastChangeAt', 'lastChange', 'changedAt', 'timestamp', 'at'];

const timeOf = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
};

/**
 * Power Box (a separate utility) writes the time of the last network switch to a file. Read only when it changed;
 * missing, unreadable or of another shape: 0 or the file's time, never an error.
 */
export function powerBoxSwitch(file: string): () => number {
  let mtime = -1;
  let at = 0;
  return () => {
    let m: number;
    try {
      m = statSync(file).mtimeMs;
    } catch {
      return 0;
    }
    if (m === mtime) return at;
    mtime = m;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const key = SWITCH_KEYS.find((k) => timeOf(data?.[k]) > 0);
      at = key ? timeOf(data[key]) : m;
    } catch {
      at = m;
    }
    return at;
  };
}
