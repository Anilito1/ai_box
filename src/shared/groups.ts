import { slugify } from './team';
import type { TeamGroup, TeamRole } from './types';

// Groups of workers under a lead: the lead drives its members (message_worker, worker_report, list_workers limited
// to its groups), a member reports to the lead that wrote to it, the lead reports to the master. No Node and no DOM:
// the settings screen checks a group with the same rules as the main process.

export const GROUPS_MAX = 12;
export const GROUP_LIMITS = { name: 24, members: 12 } as const;
export const GROUP_ID = /^g-[a-z0-9]{8}$/;
const POST_REF = /^r-[a-z0-9]{8}$/;
/** An ad-hoc worker, by its session name. */
const WORKER_REF = /^hub-[a-z0-9][a-z0-9-]{0,59}$/;

/** A post's id, or an ad-hoc worker's session name. */
export const isGroupRef = (v: unknown): v is string => typeof v === 'string' && (POST_REF.test(v) || WORKER_REF.test(v));
export const isPostRef = (ref: string) => POST_REF.test(ref);

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A group as the user or the master typed it: its name as a slug, its members once each. Wrong types become empty values. */
export function normalizeGroup(raw: unknown): TeamGroup {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const members = Array.isArray(o.members) ? o.members.map(str).filter(Boolean) : [];
  return { id: str(o.id), name: slugify(str(o.name), GROUP_LIMITS.name), lead: str(o.lead), members: [...new Set(members)] };
}

export type GroupField = 'name' | 'lead' | 'members' | 'groups';
/** `leadIsMember`: the lead of a group is not one of its members; `elsewhere`: a worker is a member of one group only. */
export type GroupProblem = 'required' | 'taken' | 'tooMany' | 'format' | 'leadIsMember' | 'elsewhere' | 'loop';
export interface GroupError {
  field: GroupField;
  problem: GroupProblem;
}

/** First problem of a normalized group among the others, or null. Whether its posts and workers exist is the caller's. */
export function checkGroup(group: TeamGroup, others: TeamGroup[]): GroupError | null {
  const fail = (field: GroupField, problem: GroupProblem): GroupError => ({ field, problem });
  const rest = others.filter((o) => o.id !== group.id || !group.id);
  if (!group.id && rest.length >= GROUPS_MAX) return fail('groups', 'tooMany');
  if (!group.name) return fail('name', 'required');
  if (rest.some((o) => o.name === group.name)) return fail('name', 'taken');
  if (!group.lead) return fail('lead', 'required');
  if (!isGroupRef(group.lead)) return fail('lead', 'format');
  if (group.members.length === 0) return fail('members', 'required');
  if (group.members.length > GROUP_LIMITS.members) return fail('members', 'tooMany');
  if (!group.members.every(isGroupRef)) return fail('members', 'format');
  if (group.members.includes(group.lead)) return fail('members', 'leadIsMember');
  if (group.members.some((m) => rest.some((o) => o.members.includes(m)))) return fail('members', 'elsewhere');
  // A lead above itself, through other groups (a lead of b, b lead of a): nobody would report to the master.
  const all = [...rest, group];
  const leadOf = (ref: string) => all.find((g) => g.members.includes(ref))?.lead;
  for (let ref: string | undefined = group.lead, n = 0; ref && n <= all.length; ref = leadOf(ref), n++) if (n > 0 && ref === group.lead) return fail('lead', 'loop');
  return null;
}

/** Who a session is to a group: its post (an instance counts as its post), and its session name. */
export interface GroupSubject {
  roleId: string | null;
  instanceOf: string | null;
  name: string;
}

export const refsOf = (s: GroupSubject): string[] => [s.roleId ?? s.instanceOf ?? '', s.name].filter(Boolean);
export const isRefOf = (ref: string, s: GroupSubject) => refsOf(s).includes(ref);
/** The group a session is a member of, if any. */
export const memberOf = (groups: TeamGroup[], s: GroupSubject): TeamGroup | null => groups.find((g) => g.members.some((m) => isRefOf(m, s))) ?? null;
/** The groups a session leads. */
export const ledBy = (groups: TeamGroup[], s: GroupSubject): TeamGroup[] => groups.filter((g) => isRefOf(g.lead, s));
/** A session is one of the members of the groups a lead leads. */
export const leads = (groups: TeamGroup[], lead: GroupSubject, member: GroupSubject) => ledBy(groups, lead).some((g) => g.members.some((m) => isRefOf(m, member)));

/** A reference as people read it: the post's name, or the worker's name without "hub-". */
export function refName(team: Pick<TeamRole, 'id' | 'name'>[], ref: string): string {
  return team.find((r) => r.id === ref)?.name ?? ref.replace(/^hub-/, '');
}

/** The groups without a post that is gone (a group whose lead is gone, or that has no member left, goes too). */
export function withoutPosts(groups: TeamGroup[], team: Pick<TeamRole, 'id'>[]): TeamGroup[] {
  const known = (ref: string) => !isPostRef(ref) || team.some((r) => r.id === ref);
  return groups.map((g) => ({ ...g, members: g.members.filter(known) })).filter((g) => known(g.lead) && g.members.length > 0);
}
