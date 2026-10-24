import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isLang, type Lang } from '../shared/i18n';
import { EFFORTS, PROVIDERS, type Effort, type HubSettings, type Mode, type SettingsPatch } from '../shared/types';

export type HubConfig = HubSettings;

const VERSION = 2;
const MODES: Mode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
/** Usual homes of source checkouts, offered as working folders on a first run when they exist. */
const USUAL_ROOTS = ['code', 'dev', 'projects', 'Projects', 'src', 'repos', 'workspace', join('Documents', 'GitHub'), 'Desktop'];

const isDir = (p: string) => {
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
const REGION = /^[a-z0-9-]*$/;

function defaults(lang: Lang): HubConfig {
  const found = USUAL_ROOTS.map((r) => join(homedir(), r)).filter(isDir);
  return {
    language: lang,
    onboarded: false,
    claudePath: '',
    provider: 'claude-code',
    bedrock: { region: '', profile: '' },
    vertex: { region: '', projectId: '' },
    workspaces: found.length > 0 ? found.slice(0, 1) : [homedir()],
    mainRepos: [],
    master: { model: '', effort: '' },
    worker: { model: '', effort: '' },
    workerModels: ['opus', 'sonnet'],
    permissionMode: '',
    masterInstructions: '',
    github: { clientId: '', source: 'none', login: '', shareWithSessions: false },
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
  take('provider', raw.provider, (v): v is HubConfig['provider'] => PROVIDERS.includes(v as HubConfig['provider']), (v) => (cfg.provider = v));
  take(
    'bedrock',
    raw.bedrock,
    (v): v is HubConfig['bedrock'] => isStr(obj(v).region, 40, REGION) && isStr(obj(v).profile, 64, /^[\w.@-]*$/),
    (v) => (cfg.bedrock = { region: v.region, profile: v.profile }),
  );
  take(
    'vertex',
    raw.vertex,
    (v): v is HubConfig['vertex'] => isStr(obj(v).region, 40, REGION) && isStr(obj(v).projectId, 64, REGION),
    (v) => (cfg.vertex = { region: v.region, projectId: v.projectId }),
  );
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
  take('permissionMode', raw.permissionMode, (v): v is Mode | '' => v === '' || MODES.includes(v as Mode), (v) => (cfg.permissionMode = v));
  take('masterInstructions', raw.masterInstructions, (v): v is string => isStr(v, 20_000), (v) => (cfg.masterInstructions = v));
  if (raw.github !== undefined) {
    const g = obj(raw.github);
    take('github.clientId', g.clientId, (v): v is string => isStr(v, 64, /^[\w.-]*$/), (v) => (cfg.github.clientId = v));
    take('github.shareWithSessions', g.shareWithSessions, (v): v is boolean => typeof v === 'boolean', (v) => (cfg.github.shareWithSessions = v));
  }
  return bad;
}

/** Fields only the main process sets: the executable sessions run, the setup state and the GitHub sign-in. */
function mergeOwn(cfg: HubConfig, raw: Raw): void {
  if (typeof raw.onboarded === 'boolean') cfg.onboarded = raw.onboarded;
  if (raw.claudePath === '' || isPath(raw.claudePath)) cfg.claudePath = raw.claudePath;
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
  if (raw.version === undefined) raw = fromLegacy(raw);
  merge(cfg, raw);
  mergeOwn(cfg, raw);
  return cfg;
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
  // Only folders that are git checkouts can be pinned: the git panel runs git in them.
  const notRepo = next.mainRepos.find((p) => !existsSync(join(p, '.git')));
  if (notRepo) return 'mainRepos';
  if (next.workspaces.some((p) => !isDir(p))) return 'workspaces';
  Object.assign(cfg, next);
  return null;
}

/** The master's folder: the first working folder. */
export const masterCwd = (cfg: HubConfig) => cfg.workspaces[0] ?? homedir();

/** Absolute folder of a main repo (a bare name resolves under the master's folder). */
export const mainRepoPath = (cfg: HubConfig, repo: string) => resolve(masterCwd(cfg), repo);
