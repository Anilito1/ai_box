import { slugify } from './team';

// Parallel work: extra instances of a post and the worktrees the hub makes for them. No Node and no DOM: the
// settings screen checks the limits with the same rules as the main process.

/** Instances of a post at the same time, its own worker included; and workers running at the same time. */
export const PARALLEL_DEFAULTS = { perPost: 3, maxWorkers: 8 } as const;
export const PARALLEL_LIMITS = { perPost: { min: 1, max: 5 }, maxWorkers: { min: 1, max: 20 } } as const;
const TOPIC_MAX = 20;

const inRange = (v: unknown, r: { min: number; max: number }): v is number => Number.isInteger(v) && (v as number) >= r.min && (v as number) <= r.max;
export const isParallel = (v: unknown): v is { perPost: number; maxWorkers: number } => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return inRange(o.perPost, PARALLEL_LIMITS.perPost) && inRange(o.maxWorkers, PARALLEL_LIMITS.maxWorkers);
};

/** What a new worker may not exceed: the workers running, then the instances of its post. */
export function capReached(i: { maxWorkers: number; running: number; perPost?: number; instances?: number }): 'workers' | 'post' | null {
  if (i.running >= i.maxWorkers) return 'workers';
  if (i.perPost !== undefined && (i.instances ?? 0) >= i.perPost) return 'post';
  return null;
}

/** Subject of a worktree as a slug, without the post's own name in front ("brain-agenda" → "agenda" for brain). */
export function topicOf(raw: string, post = ''): string {
  const slug = slugify(raw, 40);
  const bare = post && slug.startsWith(`${post}-`) ? slug.slice(post.length + 1) : slug === post ? '' : slug;
  return bare.slice(0, TOPIC_MAX).replace(/-+$/, '');
}

/** `base`, else `base-2`, `base-3`…: the first one `taken` refuses not. */
export function firstFree(base: string, taken: (candidate: string) => boolean): string {
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`no free name for ${base}`);
}

/** Lowercase slug segments joined by "/": never a leading dash, "..", a space or anything git or a shell reads. */
const SAFE_BRANCH = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
export const isSafeBranch = (name: string) => name.length <= 120 && SAFE_BRANCH.test(name);

/**
 * Branch and folder name of a worktree: "<post>/<topic>" and "<repo>-<post>-<topic>" for an instance of a post,
 * "hub/<topic>" and "<repo>-<topic>" for an ad-hoc worker. The folder sits next to the repo's main folder; a repo
 * already named after the post does not get the name twice.
 */
export function treeNames(repoFolder: string, post: string, topic: string): { branch: string; folder: string } {
  const subject = topic || 'work';
  const repo = repoFolder.toLowerCase();
  const withPost = post && repo !== post && !repo.endsWith(`-${post}`);
  return { branch: post ? `${post}/${subject}` : `hub/${subject}`, folder: `${repoFolder}-${withPost ? `${post}-` : ''}${subject}` };
}

/** What git says of a worktree when its worker closes. */
export interface TreeFacts {
  /** Its folder is still there. */
  exists: boolean;
  /** Files changed and not committed (new files included; ignored ones such as node_modules aside). */
  changes: number;
  /** A merge, rebase, cherry-pick or revert left in progress. */
  operation: boolean;
  /** Locked with `git worktree lock`. */
  locked: boolean;
  /** Commits of HEAD and of its branch found on no remote branch and not in the base it was made from. */
  unpushed: number;
  /** Its branch still exists, and no other checkout has it. */
  branchExists: boolean;
  branchElsewhere: boolean;
}

/** `inUse`: git could not delete it (a file still open); `unknown`: git could not tell, so it stays. */
export type KeepReason = 'changes' | 'unpushed' | 'operation' | 'locked' | 'inUse' | 'unknown';

/**
 * Removes a worktree only when nothing would be lost: nothing uncommitted, nothing left in progress, every commit on
 * a remote (pushed, or merged upstream) or still the base. Its branch goes with it, unless another checkout uses it.
 * A folder deleted by hand is only forgotten by git; a branch with unpushed commits always stays.
 */
export function cleanupVerdict(f: TreeFacts): { removeTree: boolean; deleteBranch: boolean; why: KeepReason[] } {
  const why: KeepReason[] = [];
  if (f.exists) {
    if (f.changes > 0) why.push('changes');
    if (f.operation) why.push('operation');
    if (f.locked) why.push('locked');
  }
  if (f.unpushed > 0) why.push('unpushed');
  const removeTree = !f.exists || why.length === 0;
  return { removeTree, deleteBranch: removeTree && f.unpushed === 0 && f.branchExists && !f.branchElsewhere, why };
}
