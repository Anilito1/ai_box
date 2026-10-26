import type { Topic } from './topics';

/**
 * The topics of the master's conversation, grouped by repo in the column that lists them. A topic belongs to the repo
 * (main folder of the git repository, a worktree counting as its origin repo) of its last worker, remembered once
 * known; one the user drags to another group stays there. No repo: the "General" group, key "".
 */

export const GENERAL = '';
export const GROUP_LIMITS = { keys: 200, key: 1000 } as const;

/** What the user arranged in the column: the groups' order (keys, first to last) and the folded ones. */
export interface TopicGroupPrefs {
  order: string[];
  collapsed: string[];
}

const isKeys = (v: unknown): v is string[] => Array.isArray(v) && v.length <= GROUP_LIMITS.keys && v.every((k) => typeof k === 'string' && k.length <= GROUP_LIMITS.key);

export const isGroupPrefs = (v: unknown): v is TopicGroupPrefs => !!v && typeof v === 'object' && isKeys((v as TopicGroupPrefs).order) && isKeys((v as TopicGroupPrefs).collapsed);

/**
 * The repo of a topic: that of its last worker; when the last one is unknown (its folder is gone, it was closed) the one
 * remembered, else that of the latest worker before it that has one. `repoOf` gives the main folder of a worker's
 * repo, or null; "" when nothing is known.
 */
export function resolveTopicRepo(workers: string[], repoOf: (worker: string) => string | null, remembered = ''): string {
  const last = workers.at(-1);
  const now = last === undefined ? null : repoOf(last);
  if (now) return now;
  if (remembered) return remembered;
  for (let i = workers.length - 2; i >= 0; i--) {
    const repo = repoOf(workers[i] as string);
    if (repo) return repo;
  }
  return GENERAL;
}

/** The group a topic is shown in: where the user put it, else its repo. */
export const groupKeyOf = (topic: Pick<Topic, 'repo' | 'moved'>): string => topic.moved ?? topic.repo ?? GENERAL;

/** A group's header: the repo's folder name ("" for General, which the view names). */
export function groupName(key: string): string {
  return key.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

export interface TopicGroup {
  key: string;
  topics: Topic[];
  /** Latest activity of its topics. */
  at: number;
}

/**
 * The groups of a list of topics (kept in their order), arranged: first the groups the user has not placed yet (most
 * recent first), then the ones in `order`, then General when it was not placed.
 */
export function groupTopics(topics: Topic[], order: string[]): TopicGroup[] {
  const groups = new Map<string, TopicGroup>();
  for (const topic of topics) {
    const key = groupKeyOf(topic);
    const group = groups.get(key) ?? { key, topics: [], at: 0 };
    group.topics.push(topic);
    group.at = Math.max(group.at, topic.at);
    groups.set(key, group);
  }
  const placed = (g: TopicGroup) => order.indexOf(g.key);
  const all = [...groups.values()];
  const fresh = all.filter((g) => placed(g) < 0 && g.key !== GENERAL).sort((a, b) => b.at - a.at);
  const known = all.filter((g) => placed(g) >= 0).sort((a, b) => placed(a) - placed(b));
  const general = all.filter((g) => placed(g) < 0 && g.key === GENERAL);
  return [...fresh, ...known, ...general];
}

/**
 * The saved order once `key` is moved to the place of `target` (the groups shown, in order): it takes that place,
 * the others shift. Keys of groups not shown now keep their place after the ones shown.
 */
export function reorderGroups(shown: string[], saved: string[], key: string, target: string): string[] {
  const from = shown.indexOf(key);
  const to = shown.indexOf(target);
  if (from < 0 || to < 0 || from === to) return saved;
  const next = shown.filter((k) => k !== key);
  next.splice(to, 0, key);
  return [...next, ...saved.filter((k) => !shown.includes(k))].slice(0, GROUP_LIMITS.keys);
}

/** The keys with `key` shown (folded: false) or hidden (true). */
export function toggled(keys: string[], key: string, on: boolean): string[] {
  const rest = keys.filter((k) => k !== key);
  return on ? [...rest, key].slice(-GROUP_LIMITS.keys) : rest;
}
