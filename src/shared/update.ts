/** When an update installs by itself: as soon as nothing runs, when the hub closes, or only when the user says so. */
export type UpdateMode = 'auto' | 'next-start' | 'ask';
export const UPDATE_MODES: UpdateMode[] = ['auto', 'next-start', 'ask'];

/**
 * What the hub knows of its own updates.
 * - `off`: a built app (no source checkout): updates come from the README.
 * - `none`: not a git checkout, git missing, or nothing fetched yet: nothing to say.
 * - `unofficial`: the checkout follows another repository (a fork, a changed remote): updates are manual.
 * - `current`: same commit as the official main. `ahead`: local commits not pushed yet, nothing new upstream.
 * - `available`: a new version that installs by a fast-forward.
 * - `blocked`: a new version, but the checkout is on another branch, has local modifications, or commits of its own.
 * - `realign`: the official history was rewritten and the local commits hold nothing of their own.
 */
export type UpdateKind = 'off' | 'none' | 'unofficial' | 'current' | 'ahead' | 'available' | 'blocked' | 'realign';
export type UpdateBlock = 'branch' | 'changes' | 'commits';
/**
 * An install under way: getting the new version, moving the files, building, restarting; `ready`: built, the restart
 * waits for sessions that started meanwhile; `closing`: the hub closes so that a helper installs new dependencies
 * (Electron and Claude Code are locked while it runs), then opens again.
 */
export type UpdateStep = 'fetch' | 'install' | 'build' | 'ready' | 'restart' | 'closing';
/** The user's answer to "Update": ask first if sessions work, wait for them, interrupt them, or drop it. */
export type UpdateChoice = 'ask' | 'when-quiet' | 'now' | 'cancel';
export const UPDATE_CHOICES: UpdateChoice[] = ['ask', 'when-quiet', 'now', 'cancel'];

export interface UpdateResult {
  ok: boolean;
  /** Where a failure happened: a last check, git, the dependencies, the build. */
  step: '' | 'check' | 'git' | 'install' | 'build';
  at: number;
  /** After a failure: the previous version is back in place (or was never left). */
  restored: boolean;
  /** Output behind a failure, secrets removed. */
  detail: string;
  /** The commit it installed, or tried to. */
  to: string;
}

export interface UpdateState {
  kind: UpdateKind;
  mode: UpdateMode;
  checking: boolean;
  checkedAt: number | null;
  /** The last check could not reach the repository (offline, signed out): retried later. */
  offline: boolean;
  /** The official commit on offer (short), when there is one: a "later" holds until a newer one. */
  target: string;
  block: UpdateBlock | null;
  branch: string;
  /** A few of the files with local modifications. */
  files: string[];
  /** The install under way, else null. */
  progress: UpdateStep | null;
  /** Sessions at work when the user asked to update: the window asks to wait for them or interrupt them. */
  confirm: number;
  /** The install waits for the sessions to finish. */
  waiting: boolean;
  /** Time (ms) of an unattended restart the window counts down to, else null. */
  countdown: number | null;
  /** The last install: after the restart that followed it, or right away when it failed and was undone. */
  last: UpdateResult | null;
  /**
   * An install that could not start: `node` (no Node.js 22.12 or later with npm, to build it), `start` (the helper,
   * or the backup branch, could not be made).
   */
  problem: '' | 'node' | 'start';
  /** Raw words behind the last problem (a check or a start of install), for the "Details" fold. */
  detail: string;
}
