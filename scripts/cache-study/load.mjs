// Reads the Claude Code transcripts of a time window and writes numbers only: one record per API request
// (prefix shape, parameters, breakpoints, usage), the request shapes (block sizes and tool names), and the size of the
// blocks that open each conversation. No text of a conversation leaves this script.
//
//   node scripts/cache-study/load.mjs [--since 2026-11-03] [--until 2026-11-18] [--out <file>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
// Local days (Paris, UTC+1 in November).
const since = Date.parse(`${arg('since', '2026-11-03')}T00:00:00+01:00`);
const until = Date.parse(`${arg('until', '2026-11-18')}T00:00:00+01:00`);
const out = arg('out', path.join(process.env.AIBOX_SCRATCH_DIR ?? os.tmpdir(), 'cache-study', 'requests.json'));
const root = path.join(os.homedir(), '.claude', 'projects');

const files = [];
for (const dir of fs.readdirSync(root)) {
  const p = path.join(root, dir);
  if (!fs.statSync(p).isDirectory()) continue;
  for (const f of fs.readdirSync(p)) {
    const fp = path.join(p, f);
    if (f.endsWith('.jsonl')) files.push({ fp, parent: null });
    else if (fs.existsSync(path.join(fp, 'subagents')) && fs.statSync(fp).isDirectory()) {
      for (const g of fs.readdirSync(path.join(fp, 'subagents'))) {
        if (g.endsWith('.jsonl')) files.push({ fp: path.join(fp, 'subagents', g), parent: f });
      }
    }
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const repoCache = new Map();
/** The main checkout a folder belongs to (a worktree counts as its repo), else the folder's own name. */
function repoOf(cwd) {
  if (!cwd) return '?';
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let name = path.basename(cwd);
  const r = fs.existsSync(cwd) ? spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }) : null;
  if (r && r.status === 0) {
    const common = r.stdout.trim();
    name = path.basename(common.endsWith('.git') ? path.dirname(common) : common);
  } else if (/AppData[\\/]Local[\\/]Temp/i.test(cwd)) name = '(temp)';
  repoCache.set(cwd, name);
  return name;
}

// Block of the first user message -> what injected it. Matched on a few fixed headers, never stored.
const KINDS = [
  ['claudeMd', /^<system-reminder>\s*As you answer the user's questions/],
  ['skills', /The following skills are available/],
  ['deferredTools', /deferred tools are now available/],
  ['mcpInstructions', /# MCP Server Instructions/],
  ['agentTypes', /Available agent types for the Agent tool/],
  ['sessionStartHook', /SessionStart hook additional context/],
  ['mcpAuth', /require authentication before their tools/],
  ['mcpConnecting', /still connecting/],
  ['context', /^<system-reminder>/],
];
const kindOf = (text) => (KINDS.find(([, re]) => re.test(text.slice(0, 600))) ?? ['prompt'])[0];
// Sections of the claudeMd reminder, by their header.
const MD_PARTS = [
  ['globalClaudeMd', /^Contents of .*[\\/]\.claude[\\/]CLAUDE\.md/],
  ['memoryIndex', /^Contents of .*MEMORY\.md/],
  ['repoClaudeMd', /^Contents of .*CLAUDE\.md/],
  ['rules', /^Contents of .*\.claude[\\/]rules/],
  ['gitStatus', /^# gitStatus/],
  ['userEmail', /^# userEmail/],
  ['currentDate', /^# currentDate/],
];
function claudeMdParts(text) {
  const parts = {};
  for (const sec of text.split(/\n(?=Contents of |# [a-zA-Z]+\n)/)) {
    const k = (MD_PARTS.find(([, re]) => re.test(sec)) ?? ['other'])[0];
    parts[k] = (parts[k] ?? 0) + sec.length;
  }
  return parts;
}
function blocksOf(message) {
  const c = message?.content;
  const list = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  return list.map((b) => {
    if (b.type !== 'text') return { kind: b.type, len: JSON.stringify(b).length };
    const kind = kindOf(b.text);
    return { kind, len: b.text.length, ...(kind === 'claudeMd' ? { parts: claudeMdParts(b.text) } : {}) };
  });
}

const shapes = new Map();
const outFiles = [];
const requests = [];
const openers = [];
for (const { fp, parent } of files) {
  if (fs.statSync(fp).mtimeMs < since) continue;
  const lines = fs.readFileSync(fp, 'utf8').split('\n');
  const reqs = [];
  const answers = new Map();
  const blobs = new Map();
  const info = { file: path.relative(root, fp), sid: '', sub: !!parent, parent, agentName: '', agentType: '', cwd: '', entry: '', version: '', compacts: [], errors: 0, title: false };
  for (const line of lines) {
    if (!line) continue;
    // Cheap skip of the bulk (attachments, hook errors, user turns): parse only what is used.
    if (!line.startsWith('{"type":"api-request') && !line.startsWith('{"type":"agent-name') && !line.includes('"type":"assistant"') && !line.includes('"subtype":"compact_boundary"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'agent-name') info.agentName = o.agentName;
    else if (o.type === 'api-request-blob') blobs.set(o.hash, o.message);
    else if (o.type === 'api-request-shape') {
      if (!shapes.has(o.shapeHash)) {
        const sys = (o.shape.system ?? []).map((b) => ({ len: (b.text ?? '').length, h: sha(b.text ?? '') }));
        const tools = (o.shape.tools ?? []).map((t) => ({ name: t.name ?? t.type ?? '?', len: JSON.stringify(t).length, h: sha(JSON.stringify(t)), defer: !!t.defer_loading }));
        shapes.set(o.shapeHash, { sys, tools });
      }
    } else if (o.type === 'api-request') {
      const t = Date.parse(o.timestamp);
      if (t < since || t >= until) continue;
      const ttls = [...new Set((o.cacheControl ?? []).map((c) => c.value?.ttl ?? '5m'))].sort().join('+');
      reqs.push({
        id: o.id, t, src: o.querySource, shape: o.shapeHash, model: o.params?.model, effort: o.params?.output_config?.effort ?? '',
        think: o.params?.thinking ? `${o.params.thinking.type}/${o.params.thinking.display ?? ''}` : '', betas: sha((o.params?.betas ?? []).join(',')),
        cm: sha(JSON.stringify(o.params?.context_management ?? null)), maxTok: o.params?.max_tokens,
        base: o.base ?? null, keep: o.keep ?? 0, n: (o.keep ?? 0) + (o.tail?.length ?? 0), tail: o.tail ?? [], ttl: ttls,
        bp: (o.cacheControl ?? []).map((c) => c.path.join('.')), global: (o.cacheControl ?? []).some((c) => c.value?.scope === 'global'),
      });
    } else if (o.type === 'assistant') {
      info.sid ||= o.sessionId;
      info.cwd ||= o.cwd ?? '';
      info.entry ||= o.entrypoint ?? '';
      info.version ||= o.version ?? '';
      if (o.isApiErrorMessage) info.errors++;
      const u = o.message?.usage;
      if (!o.requestRef || !u) continue;
      const prev = answers.get(o.requestRef);
      const out = Math.max(u.output_tokens ?? 0, prev?.u[4] ?? 0);
      const cw = u.cache_creation_input_tokens ?? 0;
      const cw1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const cw5 = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : cw - cw1;
      answers.set(o.requestRef, { msgId: o.message.id, model: o.message.model, u: [u.input_tokens ?? 0, cw5, cw1, u.cache_read_input_tokens ?? 0, out], think: u.output_tokens_details?.thinking_tokens ?? 0, stop: o.message.stop_reason });
    } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const t = Date.parse(o.timestamp);
      if (t >= since && t < until) info.compacts.push({ t, trigger: o.compactMetadata?.trigger ?? '', pre: o.compactMetadata?.preTokens ?? 0 });
    }
  }
  if (reqs.length === 0) continue;
  if (parent) {
    const meta = fp.replace(/\.jsonl$/, '.meta.json');
    if (fs.existsSync(meta)) {
      try {
        info.agentType = JSON.parse(fs.readFileSync(meta, 'utf8')).agentType ?? '';
      } catch { /* unreadable meta: type unknown */ }
    }
  }
  info.repo = repoOf(info.cwd);
  const fi = outFiles.length;
  outFiles.push(info);
  reqs.sort((a, b) => a.t - b.t);
  let opened = false;
  for (const r of reqs) {
    const a = answers.get(r.id);
    // The blocks that open the conversation: the first request that starts from nothing.
    if (!opened && !r.base) {
      opened = true;
      openers.push({ f: fi, shape: r.shape, msgs: r.tail.map((h) => (blobs.has(h) ? { role: blobs.get(h).role, blocks: blocksOf(blobs.get(h)) } : null)) });
    }
    delete r.tail;
    requests.push({ f: fi, ...r, u: a?.u ?? null, rmodel: a?.model ?? '', thinkTok: a?.think ?? 0, stop: a?.stop ?? '' });
  }
}

// Parent agent name for subagents.
const bySid = new Map(outFiles.filter((f) => !f.sub).map((f) => [f.sid, f]));
for (const f of outFiles) {
  if (f.sub) {
    const p = bySid.get(f.parent);
    f.agentName = p?.agentName ?? '';
    f.parentRepo = p?.repo;
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ since, until, files: outFiles, requests, shapes: Object.fromEntries(shapes), openers }));
console.log(`${outFiles.length} transcripts, ${requests.length} requests, ${shapes.size} shapes -> ${out}`);
