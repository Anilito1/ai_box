// Ephemeral files: how a file found in a project is classed for the purge (docs/purge-ephemeres.md). Pure string
// logic, shared by the main process (which decides) and the renderer (which shows): paths here are relative to the
// project, "/"-separated. Every rule errs on the side of keeping a file.

/** Where a worker's scratch folders live inside the folder it works in. */
export const SCRATCH_PARENT = '.aibox';
export const SCRATCH_DIR = `${SCRATCH_PARENT}/scratch`;
/** The environment variable that carries a worker's scratch folder. */
export const SCRATCH_ENV = 'AIBOX_SCRATCH_DIR';
/** Days a file stays in the app's quarantine (when the system trash refused it) before it goes to that trash. */
export const QUARANTINE_DAYS = 30;

/** A session name as a folder name: letters, digits, dot, dash and underscore, never empty, never "." or "..". */
export function scratchName(name: string): string {
  const safe = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  return safe || 'session';
}

export type PurgeCategory = 'safe' | 'likely' | 'check' | 'protected';
export const PURGE_CATEGORIES: PurgeCategory[] = ['safe', 'likely', 'check', 'protected'];

/** Why a file looks disposable. */
export type PurgeSignal = 'scratch' | 'agentWrite' | 'agentCommand' | 'agentSession' | 'tmpDir' | 'toolCache' | 'captureName' | 'script' | 'media' | 'log';
/** Why a file may never go. */
export type PurgeBlock =
  | 'tracked'
  | 'gitUnknown'
  | 'cited'
  | 'userModified'
  | 'deliverable'
  | 'document'
  | 'secret'
  | 'excluded'
  | 'recent'
  | 'running';

export interface PurgeEntry {
  /** Index in the scan's own list: the renderer only ever sends these back, never a path. */
  id: number;
  rel: string;
  size: number;
  mtime: number;
  category: PurgeCategory;
  signals: PurgeSignal[];
  block: PurgeBlock | null;
  /** Sessions the file comes from (their names or titles), most recent first. */
  sessions: string[];
}

export interface PurgeTotals {
  count: number;
  bytes: number;
}

export interface PurgeReport {
  root: string;
  name: string;
  scanId: string;
  scannedAt: number;
  durationMs: number;
  /** Every file seen, kept or not. */
  files: number;
  bytes: number;
  entries: PurgeEntry[];
  totals: Record<PurgeCategory, PurgeTotals>;
  /** Too many files (the rest was not seen), or a part of the folder could not be read. */
  partial: '' | 'tooMany' | 'unreadable';
  /** Transcripts read for provenance, by format. */
  sources: { claude: number; codex: number; gemini: number; activity: number };
}

export type PurgeProjectSource = 'repo' | 'session' | 'added' | 'suggested' | 'appScratch';

export interface PurgeProject {
  root: string;
  name: string;
  source: PurgeProjectSource;
}

export interface PurgeLogItem {
  rel: string;
  size: number;
  /** A folder sent whole: its file count. */
  files?: number;
  how: 'trash' | 'quarantine';
  restored?: boolean;
}

export interface PurgeLogEntry {
  id: string;
  at: number;
  root: string;
  bytes: number;
  items: PurgeLogItem[];
}

export type PurgeSkip = 'changed' | 'missing' | 'outside' | 'tracked' | 'link' | 'failed' | 'unknown' | 'running';

export interface PurgeTrashResult {
  /** The scan this answers no longer exists (another scan replaced it): nothing was moved. */
  stale?: boolean;
  trashed: number;
  quarantined: number;
  bytes: number;
  skipped: { rel: string; why: PurgeSkip }[];
  logId: string;
}

export interface PurgeRestoreResult {
  restored: number;
  /** Already back, or something else now sits at the original place. */
  kept: { rel: string; why: 'occupied' | 'missing' | 'failed' }[];
}

export interface PurgeSettingsView {
  exclude: string[];
}

// ---------- what a name says ----------

const segments = (rel: string) => rel.split('/').filter(Boolean);
const lower = (s: string) => s.toLowerCase();
/** The name without its last extension, and the extension (lowercase, without the dot). */
function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), lower(name.slice(dot + 1))] : [name, ''];
}

// A folder whose name says it holds throwaway work.
const TMP_DIR =
  /^\.?_?(?:tmp|temp|scratch|qc|debug|dbg|travail|brouillons?|drafts?|essais?|captures?|screenshots?|screens|frames?|planches?|contact-?sheets?|previews?|apercus?|aperçus?|snapshots?|shots|wip|sandbox|trash|test-?outputs?|sortie-?test)(?:[-_ .].*)?$/i;
const TMP_DIR_AFFIX = /^(?:tmp|temp|debug|dbg|qc|test|essai)[-_ .]|[-_ .](?:tmp|temp|debug|dbg|qc|test|essai|wip)$/i;
// Outputs of known tools, rebuilt at every run.
const TOOL_CACHE = new Set(['test-results', 'playwright-report', 'blob-report', 'coverage', '.nyc_output', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
// A file whose name says it was made to look at once.
const CAPTURE_NAME =
  /(?:^|[-_ .])(?:capture|screenshot|screen|shot|snap(?:shot)?|planche|contact-?sheet|frame|dbg|debug|test|tmp|temp|essai|apercu|aperçu|preview|qc|check|verif|vérif|diff|thumb)s?(?:[-_ .\d]|$)/i;
const MEDIA = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'exr', 'hdr', 'mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'wav']);
const LOG = new Set(['log', 'trace', 'har', 'dmp', 'prof', 'heapsnapshot', 'cpuprofile']);
const SCRIPT = new Set(['py', 'js', 'mjs', 'cjs', 'ts', 'ps1', 'sh', 'bash', 'bat', 'cmd', 'rb', 'html', 'htm', 'json', 'txt']);
// Documents, archives and the working files of creative tools: what a person keeps.
const DOCUMENT = new Set([
  'md', 'markdown', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'csv', 'tsv', 'key', 'pages', 'numbers', 'epub',
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst',
  'blend', 'psd', 'ai', 'indd', 'fig', 'sketch', 'aep', 'prproj', 'drp', 'kra', 'xcf', 'c4d', 'max', 'ma', 'mb', 'fbx', 'glb', 'gltf', 'obj', 'usd', 'usdz', 'svg',
]);
const DELIVERABLE_DIR =
  /^(?:finals?|finales?|d[ée]finitifs?|livrables?|deliverables?|livraisons?|delivery|delivered|exports?|releases?|dist|publish|public|prod|production|rendus?[-_ ]?finals?)$/i;
const DELIVERABLE_NAME = /final|livrable|deliverable|livraison|d[ée]finitif|valid[ée]|approved/i;
const SECRET_NAME = /^\.env|^id_(?:rsa|ed25519|ecdsa|dsa)|credential|secret|password|passwd|token/i;
const SECRET_EXT = new Set(['pem', 'key', 'p12', 'pfx', 'kdbx', 'keystore', 'jks', 'asc', 'gpg', 'ovpn']);

export interface NameSignals {
  tmpDir: boolean;
  toolCache: boolean;
  captureName: boolean;
  script: boolean;
  media: boolean;
  log: boolean;
  deliverable: boolean;
  document: boolean;
  secret: boolean;
}

/** What the path alone says about a file (its folders inside the project, then its name). */
export function nameSignals(rel: string): NameSignals {
  const parts = segments(rel);
  const name = parts.pop() ?? '';
  const [stem, ext] = splitName(name);
  // ".tar.gz" and the like: the inner extension says it is an archive too.
  const inner = splitName(stem)[1];
  return {
    tmpDir: parts.some((p) => TMP_DIR.test(p) || TMP_DIR_AFFIX.test(p)),
    toolCache: parts.some((p) => TOOL_CACHE.has(lower(p))),
    captureName: CAPTURE_NAME.test(stem),
    script: SCRIPT.has(ext),
    media: MEDIA.has(ext),
    log: LOG.has(ext),
    deliverable: parts.some((p) => DELIVERABLE_DIR.test(p) || DELIVERABLE_NAME.test(p)) || DELIVERABLE_NAME.test(stem),
    document: DOCUMENT.has(ext) || (inner === 'tar' && ext !== ''),
    secret: SECRET_NAME.test(name) || SECRET_EXT.has(ext),
  };
}

/** True when the file is inside a scratch folder of the hub (`.aibox/scratch/…`, at any depth: a worker in a subfolder). */
export const inScratch = (rel: string) => /(?:^|\/)\.aibox\/scratch\/./i.test(rel);

// ---------- classing ----------

/** What the scan knows of a file. */
export interface FileFacts {
  rel: string;
  /** Inside the app's own scratch area (sessions without a project): the whole folder is scratch. */
  appScratch?: boolean;
  /** True: git tracks it; null: git could not be read for its repo. */
  tracked: boolean | null;
  cited: boolean;
  /** How an agent made it: a write tool, a command that names it, or only born while a session worked. */
  provenance: 'write' | 'command' | 'session' | null;
  /** Changed after it was made, outside every agent's activity: someone else touched it. */
  touchedOutside: boolean;
  excluded: boolean;
  recent: boolean;
  running: boolean;
}

export interface Classed {
  category: PurgeCategory;
  signals: PurgeSignal[];
  block: PurgeBlock | null;
}

/**
 * The category of a file, or null when nothing points to it being disposable (it is then not listed at all). A
 * blocked file that would have been listed comes back as "protected" with its first block.
 */
export function classify(f: FileFacts): Classed | null {
  const n = nameSignals(f.rel);
  const scratch = f.appScratch || inScratch(f.rel);
  const signals: PurgeSignal[] = [];
  if (scratch) signals.push('scratch');
  if (f.provenance === 'write') signals.push('agentWrite');
  else if (f.provenance === 'command') signals.push('agentCommand');
  else if (f.provenance === 'session') signals.push('agentSession');
  if (n.tmpDir) signals.push('tmpDir');
  if (n.toolCache) signals.push('toolCache');
  if (n.captureName) signals.push('captureName');
  if (n.script) signals.push('script');
  if (n.media) signals.push('media');
  if (n.log) signals.push('log');

  const category = scratch ? scratchCategory(f) : outsideCategory(f, n);
  if (!category) return null;
  const block = blockOf(f, n, scratch);
  return block ? { category: 'protected', signals, block } : { category, signals, block: null };
}

function scratchCategory(f: FileFacts): PurgeCategory {
  // Disposable by contract; a file someone cited or changed since still waits for an explicit tick.
  return f.cited || f.touchedOutside ? 'check' : 'safe';
}

function outsideCategory(f: FileFacts, n: NameSignals): PurgeCategory | null {
  const strong = n.tmpDir || n.toolCache || n.captureName || n.log;
  const explicit = f.provenance === 'write' || f.provenance === 'command';
  if (explicit) {
    if (n.script) return 'check';
    // Ticked in advance: a look-once kind of file (picture, video, log, a tool's output) in a throwaway place or
    // name. Anything else there (a downloaded model, a data file) may be needed again: suggested only.
    if (strong) return n.media || n.log || n.toolCache ? 'safe' : 'likely';
    // A picture or a video an agent made, with nothing else to go by, is as often the render that was asked for.
    return 'check';
  }
  if (f.provenance === 'session') {
    if (n.script) return n.captureName || n.tmpDir ? 'check' : null;
    if (strong || n.media) return strong ? 'likely' : 'check';
    return null;
  }
  // No agent behind it: names alone never get further than a suggestion.
  if (n.toolCache) return 'likely';
  if (n.tmpDir || n.captureName) return 'check';
  return null;
}

function blockOf(f: FileFacts, n: NameSignals, scratch: boolean): PurgeBlock | null {
  if (f.tracked === true) return 'tracked';
  if (f.tracked === null) return 'gitUnknown';
  if (f.excluded) return 'excluded';
  if (n.secret) return 'secret';
  if (f.running) return 'running';
  if (f.recent) return 'recent';
  if (scratch) return null;
  if (f.cited) return 'cited';
  if (f.touchedOutside) return 'userModified';
  if (n.deliverable) return 'deliverable';
  if (n.document) return 'document';
  return null;
}

// ---------- exclusion patterns ----------

/** A pattern of the settings ("renders/final/**", "*.blend", "docs/") as a test on a project-relative path. */
export function globTest(pattern: string, caseBlind: boolean): ((rel: string) => boolean) | null {
  let p = pattern.trim().replace(/\\/g, '/');
  if (!p || p.startsWith('#')) return null;
  const anchored = p.startsWith('/');
  p = p.replace(/^\/+/, '');
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      // "**/" spans any number of folders, a final "**" anything below.
      re += p[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += p[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A pattern without "/" matches a name at any depth, like .gitignore.
  const prefix = anchored || p.includes('/') ? '^' : '^(?:.*/)?';
  const rx = new RegExp(`${prefix}${re}(?:/.*)?$`, caseBlind ? 'i' : '');
  return (rel) => rx.test(rel);
}

// ---------- citations ----------

const TRAIL = /[)\]}>.,;:!?»"'`*]+$/;
const LEAD = /^[([{<«"'`*]+/;
/** A ":12", ":12:3" or "#L12" source suffix. */
const LINE_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;

/**
 * Path-like tokens of a message, normalised for matching: "/" separators, lowercase, no "./" in front, no quotes or
 * trailing punctuation. A folder written with a final "/" keeps it ("renders/"). Text between backticks or <> is
 * also taken whole, for names with spaces.
 */
export function pathTokens(text: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    let s = raw.trim().replace(LEAD, '').replace(TRAIL, '').replace(LINE_SUFFIX, '').replace(/\\/g, '/');
    if (!s || s.length > 400 || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return; // URLs are not files here.
    const dir = s.endsWith('/');
    s = s.replace(/\/+$/, '').replace(/\/{2,}/g, '/');
    while (s.startsWith('./')) s = s.slice(2);
    if (!s || s === '.' || s === '..') return;
    const hasSlash = s.includes('/');
    const hasExt = /\.[a-z0-9]{1,8}$/i.test(s);
    if (!hasSlash && !hasExt && !dir) return; // A plain word.
    out.add(lower(s) + (dir ? '/' : ''));
  };
  for (const m of text.matchAll(/`([^`\n]{1,400})`|<([^<>\n]{1,400})>|\]\(([^)\s]{1,400})\)/g)) add(m[1] ?? m[2] ?? m[3]);
  for (const word of text.split(/[\s|]+/)) if (word) add(word);
  return [...out];
}

/**
 * Every way a message could name this file: its full path, its name, its path tails; and its own folder, by full
 * path or by a tail of two folders at least ("audit/qc/"). A folder only covers the files right in it: "the sheets
 * are in qc/sheets/" names those sheets, not everything under qc. A single folder name ("gen/") names nothing: too
 * many folders share it. The project's own folder names nothing either.
 */
export function citationKeys(absKey: string, relKey: string): string[] {
  const keys = [absKey];
  const parts = segments(relKey);
  for (let i = 0; i < parts.length; i++) keys.push(parts.slice(i).join('/'));
  const dirParts = parts.slice(0, -1);
  if (dirParts.length > 0) {
    const absDir = absKey.slice(0, absKey.lastIndexOf('/'));
    keys.push(absDir, `${absDir}/`);
    for (let i = 0; i + 1 < dirParts.length; i++) {
      const dir = dirParts.slice(i).join('/');
      keys.push(dir, `${dir}/`);
    }
  }
  return keys;
}

// ---------- outputs of a command ----------

/** Split a shell command into words, honouring simple quotes; good enough to find the paths it names. */
export function commandWords(command: string): string[] {
  const words: string[] = [];
  for (const m of command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'`|;&<>()]+)/g)) {
    const w = m[1] ?? m[2] ?? m[3];
    if (w) words.push(w);
  }
  return words;
}

/**
 * The paths a command names, as it wrote them (relative or absolute): what may be its outputs. Options with an
 * attached value ("--output=x", "-o=x") give their value. A path ends up here whether it is read or written; the
 * file's birth inside the command's run is what tells an output.
 */
export function commandPaths(command: string): string[] {
  const out = new Set<string>();
  for (let w of commandWords(command)) {
    const eq = /^-{1,2}[\w-]+=(.+)$/.exec(w);
    if (eq) w = eq[1];
    if (/^-/.test(w) || /^[a-z][a-z0-9+.-]*:\/\//i.test(w) || /^\$/.test(w)) continue;
    w = w.replace(/^>+/, '').replace(TRAIL, '');
    if (!w || w === '.' || w === '..' || w === '~') continue;
    const pathLike = /[\\/]/.test(w) || /\.[a-z0-9]{1,8}$/i.test(w) || /%0?\d*d/.test(w);
    if (pathLike) out.add(w);
  }
  return [...out];
}

/** A printf frame pattern ("f_%04d.png") or a glob ("*.png") as a test on a lowercase "/" path; null for a plain path. */
export function outputPattern(key: string): RegExp | null {
  if (!/%0?\d*d|[*?]/.test(key)) return null;
  let re = '';
  for (let i = 0; i < key.length; i++) {
    const m = /^%0?\d*d/.exec(key.slice(i));
    if (m) {
      re += '\\d+';
      i += m[0].length - 1;
    } else if (key[i] === '*') re += '[^/]*';
    else if (key[i] === '?') re += '[^/]';
    else re += key[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// ---------- sizes ----------

export function formatBytes(bytes: number, lang: 'fr' | 'en'): string {
  const units = lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const text = u === 0 ? String(v) : v >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `${lang === 'fr' ? text.replace('.', ',') : text} ${units[u]}`;
}
