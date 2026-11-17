// Reads Claude Code's local transcripts (~/.claude/projects) into API requests and tool results, to measure what
// exploring costs. Only numbers leave this module: no text of a transcript is kept beyond the line being read.
// Shared with the prompt-cache study: the same window, deduplication and session classes for both.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export const PROJECTS = join(homedir(), '.claude', 'projects');

/** Every transcript written since `from` (ms): sessions, and the sub-agents each one launched. */
export function listTranscripts(root = PROJECTS, from = 0) {
  const out = [];
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.endsWith('.jsonl')) {
        if (statSync(path).mtimeMs >= from) out.push({ file: path, session: name.slice(0, -6), parent: null, agentType: null });
        continue;
      }
      const subs = join(path, 'subagents');
      if (!existsSync(subs)) continue;
      for (const sub of readdirSync(subs)) {
        if (!sub.endsWith('.jsonl') || statSync(join(subs, sub)).mtimeMs < from) continue;
        let meta = {};
        try {
          meta = JSON.parse(readFileSync(join(subs, sub.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
        } catch {}
        out.push({ file: join(subs, sub), session: sub.slice(0, -6), parent: name, agentType: meta.agentType ?? null });
      }
    }
  }
  return out;
}

/** Parsed lines of a transcript, one at a time (the largest are near 100 MB). Torn lines are skipped. */
export async function* lines(file) {
  for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

const repoCache = new Map();
/** The main folder of the repo a cwd belongs to (a worktree counts with its repo), or null outside any repo. */
export function repoOf(cwd, known = []) {
  if (!cwd) return null;
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let root = null;
  if (existsSync(cwd)) {
    try {
      const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      root = resolve(basename(common) === '.git' ? dirname(common) : common);
    } catch {}
  } else {
    // A worktree removed since: the hub names them `<repo>-<post>-<slug>` beside the repo.
    const parent = dirname(resolve(cwd));
    const name = basename(cwd);
    root = known.filter((r) => dirname(r) === parent && name.startsWith(`${basename(r)}-`)).sort((a, b) => b.length - a.length)[0] ?? null;
  }
  repoCache.set(cwd, root);
  return root;
}

/**
 * The kind of session, from the name the hub gave it: the master, a permanent post, an instance of a post (its name
 * starts with the post's), a one-off worker; `cli` for a session run by hand, `bench` for the A/B runner's.
 */
export function sessionClass({ name, cwd, entrypoint, posts, master = 'hub-maitre' }) {
  if (/[\\/]bench-repos[\\/]/.test(cwd ?? '') || entrypoint === 'sdk-cli' || entrypoint === 'cli-bench') return 'bench';
  if (name === master) return 'master';
  if (!name) return entrypoint === 'cli' ? 'cli' : entrypoint === 'sdk-ts' ? 'master' : 'other';
  if (posts.includes(name)) return 'post';
  if (posts.some((p) => name.startsWith(`${p}-`))) return 'instance';
  return 'oneoff';
}

/** Splits a shell command into its simple commands (`&&`, `||`, `;`, `|`), quotes respected. */
export function shellSegments(command) {
  const segs = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"') cur += command[i++] ?? '';
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && command[i + 1] === '&')) {
      if (command[i + 1] === c) i++;
      segs.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  segs.push(cur.trim());
  return segs.filter(Boolean);
}

const LOCATE = new Set(['grep', 'rg', 'egrep', 'fgrep', 'find', 'ls', 'tree', 'fd', 'dir', 'get-childitem', 'gci', 'select-string', 'sls', 'which', 'where', 'du', 'stat', 'file']);
const READ = new Set(['cat', 'head', 'tail', 'sed', 'awk', 'less', 'more', 'type', 'nl', 'get-content', 'gc', 'jq', 'strings', 'od', 'xxd']);
// Commands that only shape the output of a lookup: they do not change what the command is.
const FILTER = new Set(['sort', 'uniq', 'wc', 'cut', 'tr', 'head', 'tail', 'grep', 'rg', 'sed', 'awk', 'xargs', 'echo', 'cd', 'pwd', 'column', 'jq', 'select-object', 'format-table', 'measure-object', 'out-string', 'true']);
const GIT_READ = new Set(['log', 'show', 'diff', 'status', 'blame', 'branch', 'rev-parse', 'ls-tree', 'cat-file', 'reflog', 'describe', 'shortlog']);

function firstWord(seg) {
  const words = seg.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return [(words[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase(), words];
}

/** What a shell command does, for this study: `locate`, `read`, `git` (history, status), or `other`. */
export function shellKind(command) {
  const segs = shellSegments(String(command ?? '')).filter((s) => !/^cd(\s|$)/.test(s));
  if (!segs.length) return 'other';
  const [word, words] = firstWord(segs[0]);
  let kind;
  if (word === 'git') {
    const sub = words.slice(1).find((w) => !w.startsWith('-')) ?? '';
    kind = sub === 'grep' || sub === 'ls-files' ? 'locate' : GIT_READ.has(sub) ? 'git' : 'other';
  } else if (LOCATE.has(word)) kind = 'locate';
  else if (READ.has(word)) kind = word === 'sed' && /\s-i/.test(segs[0]) ? 'other' : 'read';
  else return 'other';
  for (const seg of segs.slice(1)) {
    const [w, ws] = firstWord(seg);
    if (FILTER.has(w) || LOCATE.has(w) || (w === 'git' && GIT_READ.has(ws[1] ?? ''))) continue;
    return 'other';
  }
  return kind;
}

/** The file a read-type shell command shows, when it names one (`cat f`, `head -n 50 f`, `sed -n 1,80p f`). */
export function shellReadPath(command) {
  const seg = shellSegments(String(command ?? '')).filter((s) => !/^cd(\s|$)/.test(s))[0] ?? '';
  const words = seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const args = words.slice(1).filter((w) => !w.startsWith('-') && !/^\d+(,\d+)?p?$/.test(w.replace(/['"]/g, '')));
  const last = args[args.length - 1];
  return last ? last.replace(/^['"]|['"]$/g, '') : null;
}

const MEMORY_PATH = /([\\/]memory[\\/]|MEMORY\.md$|CLAUDE\.md$|AGENTS\.md$|[\\/]\.claude[\\/]rules[\\/]|notes?-de-passation|handoff)/i;

/**
 * The class of a tool call: exploration (`locate`, `read`, `memory`, `git`), the search tools (`search`), or what the
 * session does with what it found (`edit`, `run`, `delegate`, `web`, `hub`, `meta`, `other`).
 */
export function toolClass(name, input = {}) {
  switch (name) {
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'locate';
    case 'Read':
    case 'NotebookRead': {
      const path = String(input.file_path ?? input.notebook_path ?? '');
      // Looking at a capture or a render checks a result; no search stands in for it.
      if (/\.(png|jpe?g|gif|webp|bmp|pdf)$/i.test(path)) return 'view';
      return MEMORY_PATH.test(path) ? 'memory' : 'read';
    }
    case 'Bash':
    case 'PowerShell': {
      const kind = shellKind(input.command);
      return kind === 'read' && MEMORY_PATH.test(shellReadPath(input.command) ?? '') ? 'memory' : kind === 'other' ? 'run' : kind;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'Agent':
    case 'Task':
      return input.subagent_type === 'Explore' ? 'explore-agent' : 'delegate';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'ToolSearch':
    case 'Skill':
      return 'meta';
    case 'SendMessage':
    case 'ListAgents':
      return 'hub';
  }
  if (/(^|__)(search_code|where_is|search_memory)$/.test(name)) return 'search';
  if (/^mcp__hub__topic_memory$/.test(name)) return input.action === 'read' ? 'memory' : 'hub';
  if (name.startsWith('mcp__hub__')) return 'hub';
  return name.startsWith('mcp__') ? 'mcp' : 'other';
}

export const EXPLORE = new Set(['locate', 'read', 'memory', 'explore-agent']);

/** Characters of what a tool answered, and how many images it held. */
export function resultSize(content) {
  if (typeof content === 'string') return { chars: content.length, images: 0 };
  let chars = 0;
  let images = 0;
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === 'text') chars += String(b.text ?? '').length;
    else if (b?.type === 'image') images++;
  }
  return { chars, images };
}

/** Price of a request in input-token equivalents: cache writes 1.25x (5 min) or 2x (1 h), reads 0.1x, output 5x. */
export function weigh(u) {
  const input = u.input + 1.25 * u.cacheWrite5m + 2 * u.cacheWrite1h + 0.1 * u.cacheRead;
  return { input, output: 5 * u.output, total: input + 5 * u.output };
}

function usageOf(message) {
  const u = message?.usage;
  if (!u) return null;
  const cw = u.cache_creation_input_tokens ?? 0;
  const h1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return { input: u.input_tokens ?? 0, cacheWrite5m: Math.max(0, cw - h1), cacheWrite1h: h1, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 };
}

/**
 * One transcript as API requests (deduplicated by message id: a request is written one content block per line, the
 * usage repeated, its output complete on the last line) and the tool results each request's context carried.
 * Sizes stay in characters (and images): the caller turns them into tokens once it has measured the ratio
 * (`fresh` and `prevOutput` serve that). Requests outside [from, to] are dropped, not the context they build.
 */
export async function readSession(entry, { from = 0, to = Infinity } = {}) {
  // The files the session changes at some point: reading those is needed; the other reads only inform.
  const changed = new Set();
  for await (const o of lines(entry.file)) {
    if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue;
    for (const b of o.message.content) if (b?.type === 'tool_use' && toolClass(b.name, b.input ?? {}) === 'edit' && b.input?.file_path) changed.add(resolve(String(b.input.file_path)).toLowerCase());
  }
  const meta = { name: '', cwd: '', entrypoint: '' };
  /** The paths the session's tools named, and how often: where it worked when its cwd is not a repo. */
  const dirs = new Map();
  const requests = [];
  const byId = new Map();
  /** Tool calls by id: their class and request, until their result comes. */
  const calls = new Map();
  /** Per context (the session, or a sub-agent written in the same file): the results it still carries. */
  const contexts = new Map();
  const ctxOf = (key) => {
    if (!contexts.has(key)) contexts.set(key, { carry: [], reads: new Map(), edited: new Map(), last: null, fresh: { n: 0, chars: 0, images: 0, text: false } });
    return contexts.get(key);
  };
  for await (const o of lines(entry.file)) {
    if (o.type === 'agent-name' && o.agentName) meta.name = o.agentName;
    if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
    if (o.entrypoint && !meta.entrypoint) meta.entrypoint = o.entrypoint;
    const ctx = ctxOf(o.isSidechain && o.agentId ? o.agentId : 'main');
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      ctx.carry = [];
      ctx.reads.clear();
      continue;
    }
    if (o.type === 'assistant') {
      const msg = o.message ?? {};
      if (msg.model === '<synthetic>') continue;
      const id = msg.id ?? o.requestId;
      const usage = usageOf(msg);
      if (!id || !usage) continue;
      let req = byId.get(id);
      if (!req) {
        const at = Date.parse(o.timestamp);
        // The context this request sent: every result still carried, by tag.
        const carried = {};
        for (const r of ctx.carry) {
          const c = (carried[r.tag] ??= { chars: 0, images: 0 });
          c.chars += r.chars;
          c.images += r.images;
        }
        req = { id, at, model: msg.model, usage, emits: {}, carried, fresh: ctx.fresh, prevOutput: ctx.last?.usage.output ?? null, keep: at >= from && at <= to };
        ctx.fresh = { n: 0, chars: 0, images: 0, text: false };
        byId.set(id, req);
        requests.push(req);
        ctx.last = req;
      } else {
        // The last line holds the complete output; the input side is the same on every line.
        req.usage.output = Math.max(req.usage.output, usage.output);
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type !== 'tool_use') continue;
        const cls = toolClass(b.name, b.input ?? {});
        const path = b.name === 'Read' ? b.input?.file_path : cls === 'read' || cls === 'memory' ? shellReadPath(b.input?.command) : null;
        const key = cls === 'read' && path && changed.has(resolve(meta.cwd || '.', String(path)).toLowerCase()) ? 'read:edited' : cls;
        req.emits[key] = (req.emits[key] ?? 0) + 1;
        const range = b.name === 'Read' ? [b.input?.offset ?? 1, b.input?.limit ? (b.input.offset ?? 1) + b.input.limit : Infinity] : [1, Infinity];
        const where = b.input?.file_path ?? b.input?.path;
        if (typeof where === 'string' && where) {
          const dir = resolve(meta.cwd || '.', where);
          dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
        }
        calls.set(b.id, { cls, name: b.name, path: path ? resolve(meta.cwd || '.', String(path)).toLowerCase() : null, range, bounded: b.name === 'Read' && !!b.input?.limit });
        if (cls === 'edit' && b.input?.file_path) ctx.edited.set(resolve(String(b.input.file_path)).toLowerCase(), requests.length);
      }
      continue;
    }
    if (o.type !== 'user') continue;
    if (!Array.isArray(o.message?.content)) {
      ctx.fresh.text = true;
      continue;
    }
    for (const b of o.message.content) {
      if (b?.type === 'text') ctx.fresh.text = true;
      if (b?.type !== 'tool_result') continue;
      const call = calls.get(b.tool_use_id);
      if (!call) continue;
      calls.delete(b.tool_use_id);
      const { chars, images } = resultSize(b.content);
      ctx.fresh.n++;
      ctx.fresh.chars += chars;
      ctx.fresh.images += images;
      const flags = [];
      if (call.path && (call.cls === 'read' || call.cls === 'memory')) {
        const seen = ctx.reads.get(call.path);
        if (seen?.some(([a, z]) => a < call.range[1] && call.range[0] < z)) {
          // A file edited since it was last read may need reading again; the rest is a plain re-read.
          flags.push((ctx.edited.get(call.path) ?? -1) > seen.lastAt ? 'reread-after-edit' : 'reread');
        }
        const total = o.toolUseResult?.file?.totalLines;
        if (call.name === 'Read' && !call.bounded && total > 200) flags.push('full-big');
        if (changed.has(call.path)) flags.push('edited');
        const ranges = seen ?? [];
        ranges.push(call.range);
        ranges.lastAt = requests.length;
        ctx.reads.set(call.path, ranges);
      }
      const tag = [call.cls, ...flags].join(':');
      ctx.carry.push({ tag, chars, images });
      const req = ctx.last;
      if (req) {
        req.results ??= {};
        const r = (req.results[tag] ??= { n: 0, chars: 0, images: 0, lines: 0, total: 0 });
        r.n++;
        r.chars += chars;
        r.images += images;
        r.lines += o.toolUseResult?.file?.numLines ?? 0;
        r.total += o.toolUseResult?.file?.totalLines ?? 0;
      }
    }
  }
  return { ...meta, ...entry, dirs, requests: requests.filter((r) => r.keep) };
}
