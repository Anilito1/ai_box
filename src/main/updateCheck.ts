import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateBlock, UpdateKind } from '../shared/update';
import { git, GitError } from './git';
import { samePath } from './repos';
import {
  cherryEquivalents,
  decide,
  FULL_FORMAT,
  MAIN,
  normalizeRemote,
  ownCommits,
  parseFull,
  parseStatus,
  redact,
  repositoryOf,
  TARGET_REF,
  type Facts,
} from './updateLogic';

// What the hub's own checkout can do with its official repository, read with git (no Electron: tested on throwaway
// clones).

export interface Inspection {
  kind: UpdateKind;
  block: UpdateBlock | null;
  branch: string;
  ahead: number;
  behind: number;
  /** A few of the files with local modifications. */
  files: string[];
  /** What an install would do, when there is a new version. */
  pending: { from: string; to: string; lockChanged: boolean } | null;
  /** The official repository, normalized; empty when the checkout declares none. */
  remote: string;
  /** With `fetch`: whether the repository answered, and git's words when not. */
  fetched: { ok: boolean; detail: string } | null;
}

/** The official repository the checkout's package.json declares (`repository`), normalized. */
export function officialRepo(root: string): string {
  try {
    return repositoryOf(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  } catch {
    return '';
  }
}

export async function inspect(root: string, fetch: boolean): Promise<Inspection> {
  const none: Inspection = { kind: 'none', block: null, branch: '', ahead: 0, behind: 0, files: [], pending: null, remote: '', fetched: null };
  const value = async (args: string[]) => (await git(root, args).catch(() => '')).trim();
  if (!existsSync(join(root, '.git')) || !samePath(await value(['rev-parse', '--show-toplevel']), root)) return none;
  const remote = officialRepo(root);
  // The URL git really contacts (insteadOf applied): a remote pointed elsewhere is not the official one.
  const url = await value(['remote', 'get-url', 'origin']);
  const official = remote !== '' && normalizeRemote(url) === remote;
  if (!official) return { ...none, kind: 'unofficial', remote };
  let fetched: Inspection['fetched'] = null;
  if (fetch) {
    try {
      // Only main, forced: a rewritten official history replaces the old one, as a plain fetch does.
      await git(root, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${MAIN}:${TARGET_REF}`], { timeout: 60_000, auth: url, hooks: false });
      fetched = { ok: true, detail: '' };
    } catch (err) {
      // Offline, signed out, git missing: shown only in Settings › About, tried again later.
      fetched = { ok: false, detail: redact(err instanceof GitError ? err.stderr || err.message : String(err)) };
    }
  }
  const branch = await value(['symbolic-ref', '-q', '--short', 'HEAD']);
  const head = await value(['rev-parse', '--verify', '-q', 'HEAD']);
  const target = await value(['rev-parse', '--verify', '-q', TARGET_REF]);
  // An unreadable status counts as modified: nothing is touched.
  const dirty = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).then(parseStatus, () => ['?']);
  const counts = target && head ? (await value(['rev-list', '--left-right', '--count', `HEAD...${TARGET_REF}`])).split(/\s+/).map(Number) : [];
  const facts: Facts = { official, branch, head, target, dirty, ahead: counts[0] || 0, behind: counts[1] || 0, realignSafe: false };
  if (facts.ahead > 0 && facts.behind > 0 && branch === MAIN && dirty.length === 0) facts.realignSafe = await nothingOwn(root);
  const { kind, block } = decide(facts);
  const result: Inspection = { kind, block, branch, ahead: facts.ahead, behind: facts.behind, files: dirty.slice(0, 8), pending: null, remote, fetched };
  if (facts.behind > 0 && (kind === 'available' || kind === 'blocked' || kind === 'realign')) {
    const lockChanged = (await value(['diff', '--name-only', 'HEAD', TARGET_REF, '--', 'package-lock.json'])) !== '';
    result.pending = { from: head, to: target, lockChanged };
  }
  return result;
}

/** Diverged from the official main: true when no local commit holds work of its own (updateLogic.ownCommits). */
async function nothingOwn(root: string): Promise<boolean> {
  try {
    const [local, upstream, cherry, tree] = await Promise.all([
      git(root, ['log', FULL_FORMAT, '--date=raw', '-n', '500', `${TARGET_REF}..HEAD`]),
      git(root, ['log', FULL_FORMAT, '--date=raw', '-n', '5000', TARGET_REF]),
      git(root, ['cherry', TARGET_REF, 'HEAD'], { timeout: 60_000 }),
      git(root, ['rev-parse', 'HEAD^{tree}']),
    ]);
    const mine = parseFull(local);
    // More local commits than read: some may be the user's own.
    if (mine.length >= 500) return false;
    return ownCommits(mine, parseFull(upstream), cherryEquivalents(cherry), tree.trim()).length === 0;
  } catch {
    return false;
  }
}
