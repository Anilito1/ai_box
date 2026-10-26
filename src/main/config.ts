import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ACCOUNT_ID, checkAccount, DEFAULT_ACCOUNT, isAccountRef, isBuiltinAccount, normalizeAccount, ACCOUNTS_MAX } from '../shared/accounts';
import { DICTATION_DEFAULTS, isDictationKey, isDictationLanguage } from '../shared/dictation';
import { isLang, type Lang } from '../shared/i18n';
import { FALLBACK_DEFAULTS, isFallback } from '../shared/fallback';
import { isParallel, PARALLEL_DEFAULTS } from '../shared/parallel';
import { isGroupPrefs } from '../shared/topicGroups';
import { checkRole, normalizeRole, TEAM_MAX, type RoleError } from '../shared/team';
import { EFFORTS, PROVIDERS, type Account, type Effort, type HubSettings, type Mode, type SettingsPatch, type TeamRole } from '../shared/types';
import { UPDATE_MODES, type UpdateMode } from '../shared/update';

export type HubConfig = HubSettings;

const VERSION = 2;
const MODES: Mode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
/** Usual homes of source checkouts, offered as working folders on a first run when they exist. */
const USUAL_ROOTS = ['code', 'dev', 'projects', 'Projects', 'src', 'repos', 'workspace', join('Documents', 'GitHub'), 'Desktop'];

export const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isStr = (v: unknown, max: number, re?: RegExp): v is string => typeof v === 'string' && v.length <= max && (!re || re.test(v));
const isPath = (v: unknown): v is string => isStr(v, 1000) && isAbsolute(v) && !v.includes('\0');
const isEffort = (v: unknown): v is Effort | '' => v === '' || EFFORTS.includes(v as Effort);
const MODEL = /^[\w.:[\]-]*$/;

function defaults(lang: Lang): HubConfig {
  const found = USUAL_ROOTS.map((r) => join(homedir(), r)).filter(isDir);
  return {
    language: lang,
    onboarded: false,
    claudePath: '',
    codexPath: '',
    provider: 'claude-code',
    workspaces: found.length > 0 ? found.slice(0, 1) : [homedir()],
    mainRepos: [],
    master: { model: '', effort: '' },
    worker: { model: '', effort: '' },
    workerModels: ['opus', 'sonnet'],
    workerMaxEffort: 'xhigh',
    team: [],
    accounts: [],
    masterAccount: DEFAULT_ACCOUNT,
    workerAccount: DEFAULT_ACCOUNT,
    anthropicActive: '',
    fallback: structuredClone(FALLBACK_DEFAULTS),
    parallel: { ...PARALLEL_DEFAULTS },
    permissionMode: '',
    masterInstructions: '',
    github: { clientId: '', source: 'none', login: '', shareWithSessions: false },
    updates: 'auto',
    topicGroups: { order: [], collapsed: [] },
    dictation: { ...DICTATION_DEFAULTS },
  };
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

/**
 * Each field of `raw` that passes its check replaces the one of `cfg`; the name of the first one that fails is
 * returned (and it is left out). Used for the file (tolerant: a bad field keeps its default) and for the renderer's
 * patches (strict: the caller rejects the whole patch).
 */
function merge(cfg: HubConfig, raw: Raw): string | null {
  let bad: string | null = null;
  const take = <T>(name: string, value: unknown, ok: (v: unknown) => v is T, set: (v: T) => void) => {
    if (value === undefined) return;
    if (ok(value)) set(value);
    else bad ??= name;
  };
  const paths = (max: number) => (v: unknown): v is string[] => Array.isArray(v) && v.length <= max && v.every(isPath);
  const modelEffort = (v: unknown): v is { model: string; effort: Effort | '' } => {
    const o = obj(v);
    return isStr(o.model, 80, MODEL) && isEffort(o.effort);
  };

  take('language', raw.language, isLang, (v) => (cfg.language = v));
  // An access no longer offered (Amazon Bedrock, Google Vertex AI) fails this check: the file keeps the default, Claude
  // Code's own sign-in, and the next save drops its old fields.
  take('provider', raw.provider, (v): v is HubConfig['provider'] => PROVIDERS.includes(v as HubConfig['provider']), (v) => (cfg.provider = v));
  take('workspaces', raw.workspaces, paths(20), (v) => (cfg.workspaces = v.length > 0 ? v.map((p) => resolve(p)) : cfg.workspaces));
  take('mainRepos', raw.mainRepos, paths(12), (v) => (cfg.mainRepos = v.map((p) => resolve(p))));
  take('master', raw.master, modelEffort, (v) => (cfg.master = { model: v.model, effort: v.effort }));
  take('worker', raw.worker, modelEffort, (v) => (cfg.worker = { model: v.model, effort: v.effort }));
  take(
    'workerModels',
    raw.workerModels,
    (v): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every((m) => isStr(m, 80, MODEL) && m !== ''),
    (v) => (cfg.workerModels = v),
  );
  take('workerMaxEffort', raw.workerMaxEffort, (v): v is Effort => EFFORTS.includes(v as Effort), (v) => (cfg.workerMaxEffort = v));
  // An account the list no longer has falls back to "default" (see knownAccounts).
  take('masterAccount', raw.masterAccount, isAccountRef, (v) => (cfg.masterAccount = v));
  take('workerAccount', raw.workerAccount, isAccountRef, (v) => (cfg.workerAccount = v));
  take('fallback', raw.fallback, isFallback, (v) => (cfg.fallback = v));
  take('parallel', raw.parallel, isParallel, (v) => (cfg.parallel = { perPost: v.perPost, maxWorkers: v.maxWorkers }));
  take('permissionMode', raw.permissionMode, (v): v is Mode | '' => v === '' || MODES.includes(v as Mode), (v) => (cfg.permissionMode = v));
  take('masterInstructions', raw.masterInstructions, (v): v is string => isStr(v, 20_000), (v) => (cfg.masterInstructions = v));
  take('updates', raw.updates, (v): v is UpdateMode => UPDATE_MODES.includes(v as UpdateMode), (v) => (cfg.updates = v));
  take('topicGroups', raw.topicGroups, isGroupPrefs, (v) => (cfg.topicGroups = { order: v.order, collapsed: v.collapsed }));
  if (raw.dictation !== undefined) {
    const d = obj(raw.dictation);
    take('dictation.enabled', d.enabled, (v): v is boolean => typeof v === 'boolean', (v) => (cfg.dictation.enabled = v));
    take('dictation.language', d.language, isDictationLanguage, (v) => (cfg.dictation.language = v));
    take('dictation.key', d.key, isDictationKey, (v) => (cfg.dictation.key = v));
  }
  if (raw.github !== undefined) {
    const g = obj(raw.github);
    take('github.clientId', g.clientId, (v): v is string => isStr(v, 64, /^[\w.-]*$/), (v) => (cfg.github.clientId = v));
    take('github.shareWithSessions', g.shareWithSessions, (v): v is boolean => typeof v === 'boolean', (v) => (cfg.github.shareWithSessions = v));
  }
  return bad;
}

export const ROLE_ID = /^r-[a-z0-9]{8}$/;

/** Fields only the main process sets: the executable sessions run, the setup state, the GitHub sign-in and the team. */
function mergeOwn(cfg: HubConfig, raw: Raw): void {
  if (typeof raw.onboarded === 'boolean') cfg.onboarded = raw.onboarded;
  // Read post by post: one that a hand edit broke is left out, the others stay.
  if (Array.isArray(raw.team)) {
    const team: TeamRole[] = [];
    for (const r of raw.team.slice(0, TEAM_MAX)) {
      const role = normalizeRole(r);
      if (ROLE_ID.test(role.id) && !team.some((o) => o.id === role.id) && !checkRole(role, team)) team.push(role);
    }
    cfg.team = team;
  }
  if (typeof raw.anthropicActive === 'string') cfg.anthropicActive = raw.anthropicActive;
  // Read account by account too.
  if (Array.isArray(raw.accounts)) {
    const accounts: Account[] = [];
    for (const a of raw.accounts.slice(0, ACCOUNTS_MAX)) {
      const account = normalizeAccount(a);
      if (ACCOUNT_ID.test(account.id) && !accounts.some((o) => o.id === account.id) && !checkAccount(account, accounts)) accounts.push(account);
    }
    cfg.accounts = accounts;
  }
  if (raw.claudePath === '' || isPath(raw.claudePath)) cfg.claudePath = raw.claudePath;
  if (raw.codexPath === '' || isPath(raw.codexPath)) cfg.codexPath = raw.codexPath;
  const g = obj(raw.github);
  if (['none', 'oauth', 'token', 'gh'].includes(g.source as string)) cfg.github.source = g.source as HubConfig['github']['source'];
  if (isStr(g.login, 39, /^[\w-]*$/)) cfg.github.login = g.login;
}

/**
 * Settings of the first versions (no `version`): one root folder, repo names under it, a French interface, and every
 * session in "bypass" when the mode was left empty. They load as the same behaviour, now explicit.
 */
function fromLegacy(raw: Raw): Raw {
  const root = isPath(raw.masterCwd) ? raw.masterCwd : join(homedir(), 'Desktop');
  const repos = Array.isArray(raw.mainRepos) ? raw.mainRepos.filter((r): r is string => isStr(r, 1000) && r !== '') : [];
  return {
    ...raw,
    language: 'fr',
    onboarded: true,
    workspaces: [root],
    mainRepos: repos.map((r) => resolve(root, r)),
    permissionMode: isStr(raw.permissionMode, 40) && raw.permissionMode ? raw.permissionMode : 'bypassPermissions',
  };
}

export function loadConfig(dataDir: string, systemLang: Lang): HubConfig {
  const cfg = defaults(systemLang);
  const file = join(dataDir, 'config.json');
  if (!existsSync(file)) return cfg;
  let raw: Raw;
  try {
    raw = obj(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // Unreadable settings: set them aside (never overwrite them) and run the first-run setup again.
    renameSync(file, `${file}.corrupt`);
    return cfg;
  }
  if (raw.version === undefined) {
    // Kept as it was: the first save writes the new format over config.json.
    const backup = join(dataDir, 'config.legacy.json');
    try {
      if (!existsSync(backup)) copyFileSync(file, backup);
    } catch {
      // Folder read-only or file locked: the settings load all the same, without the copy.
    }
    raw = fromLegacy(raw);
  }
  merge(cfg, raw);
  mergeOwn(cfg, raw);
  knownAccounts(cfg);
  return cfg;
}

/** Every account a setting or a post names exists, else it is "default" (or the workers' account) again. */
export function knownAccounts(cfg: HubConfig): void {
  const known = (id: string) => isBuiltinAccount(id) || cfg.accounts.some((a) => a.id === id);
  // The active Anthropic account is one of the Claude accounts, or empty (the user's own sign-in).
  if (cfg.anthropicActive && !cfg.accounts.some((a) => a.id === cfg.anthropicActive && a.kind === 'claude')) cfg.anthropicActive = '';
  if (!known(cfg.masterAccount)) cfg.masterAccount = DEFAULT_ACCOUNT;
  if (!known(cfg.workerAccount)) cfg.workerAccount = DEFAULT_ACCOUNT;
  for (const r of cfg.team) if (r.account && !known(r.account)) r.account = '';
  // A chain forgets an account that is gone.
  cfg.fallback.chain = cfg.fallback.chain.filter((s) => known(s.account));
  cfg.fallback.paidOk = cfg.fallback.paidOk.filter(known);
}

export function saveConfig(dataDir: string, cfg: HubConfig): void {
  const file = join(dataDir, 'config.json');
  // Write-then-rename: a crash mid-save never leaves a truncated file.
  writeFileSync(`${file}.tmp`, JSON.stringify({ version: VERSION, ...cfg }, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** Applies a patch from the renderer to `cfg` only if every field in it is valid; returns the first invalid field. */
export function applyPatch(cfg: HubConfig, patch: SettingsPatch): string | null {
  const next: HubConfig = structuredClone(cfg);
  const bad = merge(next, obj(patch));
  if (bad) return bad;
  // Only git checkouts can be added to the main repos (the git panel runs git in them), and only existing folders
  // to the working folders. Entries already there are kept even if their folder went away.
  const added = (list: string[], before: string[]) => list.filter((p) => !before.includes(p));
  if (added(next.mainRepos, cfg.mainRepos).some((p) => !existsSync(join(p, '.git')))) return 'mainRepos';
  if (added(next.workspaces, cfg.workspaces).some((p) => !isDir(p))) return 'workspaces';
  const known = (id: string) => isBuiltinAccount(id) || cfg.accounts.some((a) => a.id === id);
  if (!known(next.masterAccount)) return 'masterAccount';
  if (!known(next.workerAccount)) return 'workerAccount';
  if (next.fallback.chain.some((s) => !known(s.account)) || next.fallback.paidOk.some((id) => !known(id))) return 'fallback';
  Object.assign(cfg, next);
  return null;
}

export type RoleCheck = { role: TeamRole } | { error: RoleError };

/**
 * A post to save, normalized and checked against the rest of the team; a new one (no id, or one the team does not
 * know) gets a fresh id. Its folders must exist.
 */
export function prepareRole(cfg: HubConfig, raw: unknown): RoleCheck {
  const role = normalizeRole(raw);
  if (!cfg.team.some((r) => r.id === role.id)) role.id = '';
  // Resolved before the check, so the same folder written two ways counts as a duplicate; a relative one stays as
  // is and is refused.
  role.folders = role.folders.map((f) => (isAbsolute(f) ? resolve(f) : f));
  const error = checkRole(role, cfg.team);
  if (error) return { error };
  if (!role.folders.every(isDir)) return { error: { field: 'folders', problem: 'format' } };
  if (role.account && !isBuiltinAccount(role.account) && !cfg.accounts.some((a) => a.id === role.account)) return { error: { field: 'account', problem: 'format' } };
  if (!role.id) role.id = `r-${randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8)}`;
  return { role };
}

/** The master's folder: the first working folder. */
export const masterCwd = (cfg: HubConfig) => cfg.workspaces[0] ?? homedir();

/** Absolute folder of a main repo (a bare name resolves under the master's folder). */
export const mainRepoPath = (cfg: HubConfig, repo: string) => resolve(masterCwd(cfg), repo);
