// What fills the conversations, and what each source costs to carry: a block that enters a conversation is read again
// by every later request, so its weight is its size times the requests that follow it. Walks each transcript in order
// (messages, replies, the request log); keeps sizes and tool names only, never a text.
// --caps adds, for the sources a limit could bound where they are produced, what a limit of N characters would have
// left out of the later reads (the part of each block beyond N, times the requests after it).
//   node scripts/cache-study/sources.mjs [--since 2026-11-03] [--until 2026-11-19] [--class master] [--top 25] [--caps]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classOf, table } from './common.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const since = Date.parse(`${arg('since', '2026-11-03')}T00:00:00+01:00`);
const until = Date.parse(`${arg('until', '2026-11-19')}T00:00:00+01:00`);
const only = arg('class', '');
const top = Number(arg('top', 25));
const root = path.join(os.homedir(), '.claude', 'projects');
const IMAGE_CHARS = 4500; // An image is about 1.5K tokens whatever its base64 length.
const BINARY_CHARS = 8; // Base64 of a PDF: far more characters than the tokens its pages cost. A rough scale.
const THINK_CHARS = 3; // Thinking is stored encrypted: its tokens come from the usage, here as characters.

// Where a text block comes from, by its first characters.
const TEXT_KINDS = [
  ['reminder: skills list', /^<system-reminder>[\s\S]{0,80}skills are available/],
  ['reminder: CLAUDE.md, memory, git', /^<system-reminder>\s*(As you answer|Codebase and user instructions)/],
  ['reminder: other', /^<system-reminder>/],
  ['hub: mission from the master', /^\[Mission (du|from)/],
  ['hub: message from the master', /^\[(Message du maître|Message from the master|Message du chef)/],
  ['hub: worker message or report', /^\[(Message du worker|Message from worker|Message du membre)/],
  ['hub: note', /^\[Hub\]/],
  ['peer message (SendMessage)', /^<cross-session-message|^Another Claude session sent/],
  ['background task notice', /^<task-notification|^\[SYSTEM NOTIFICATION/],
  ['skill body', /^Base directory for this skill/],
  ['local command output', /^<(local-command|command-name|bash-)/],
];
const textKind = (t, dflt) => (TEXT_KINDS.find(([, re]) => re.test(t.slice(0, 400))) ?? [dflt])[0];
const toolLabel = (name) => (name.startsWith('mcp__') ? (name.startsWith('mcp__hub__') ? name.slice(5) : `mcp:${name.split('__')[1]}`) : name);
const listOf = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []);

/** [kind, chars] of each block of a user message. `names` maps a tool call's id to its tool. */
function userBlocks(content, names) {
  const out = [];
  for (const b of listOf(content)) {
    if (b.type === 'text') out.push([textKind(b.text ?? '', 'user prompt'), (b.text ?? '').length]);
    else if (b.type === 'image') out.push(['image: user', IMAGE_CHARS]);
    else if (b.type === 'document') out.push(['document: user', Math.round(JSON.stringify(b).length / BINARY_CHARS)]);
    else if (b.type === 'tool_result') {
      const tool = toolLabel(names.get(b.tool_use_id) ?? '?');
      let chars = 0, images = 0, other = 0;
      for (const p of listOf(b.content)) {
        if (p.type === 'image') images++;
        else if (p.type === 'text') chars += (p.text ?? '').length;
        else other += Math.round(JSON.stringify(p).length / BINARY_CHARS); // A document in base64, a tool reference.
      }
      if (chars || (!images && !other)) out.push([`result: ${tool}`, chars]);
      if (images) out.push([`image: ${tool}`, images * IMAGE_CHARS]);
      if (other) out.push([`result (not text): ${tool}`, other]);
    }
  }
  return out;
}

const files = [];
for (const dir of fs.readdirSync(root)) {
  const p = path.join(root, dir);
  if (!fs.statSync(p).isDirectory()) continue;
  for (const f of fs.readdirSync(p)) if (f.endsWith('.jsonl') && fs.statSync(path.join(p, f)).mtimeMs >= since) files.push(path.join(p, f));
}

const stats = new Map(); // class -> kind -> { n, chars, carry (chars x later requests), sizes }
const totals = new Map(); // class -> { conversations, requests, read, fixed }
const bump = (cls, kind, chars, later) => {
  const m = stats.get(cls) ?? stats.set(cls, new Map()).get(cls);
  const e = m.get(kind) ?? m.set(kind, { n: 0, chars: 0, carry: 0, sizes: [], laters: [] }).get(kind);
  e.n++;
  e.chars += chars;
  e.carry += chars * later;
  e.sizes.push(chars);
  e.laters.push(later);
};

for (const fp of files) {
  // One event per thing sent or received, in the order of the file: a request, or blocks that enter the conversation.
  const events = [];
  const usage = new Map();
  const names = new Map();
  const replied = new Set();
  let agentName = '';
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line.startsWith('{"type":"api-request') && !line.startsWith('{"type":"agent-name') && !line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !line.includes('"subtype":"compact_boundary"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain) continue;
    if (o.type === 'agent-name') agentName = o.agentName;
    else if (o.type === 'system' && o.subtype === 'compact_boundary') events.push({ cut: true });
    else if (o.type === 'api-request') events.push({ req: o.id, t: Date.parse(o.timestamp) });
    else if (o.type === 'api-request-blob') {
      // Messages the CLI builds itself. Tool results and prompts are counted from their own lines.
      const m = o.message;
      const blocks = [];
      for (const b of listOf(m?.content)) {
        if (m.role === 'system' && b.type === 'text') blocks.push([textKind(b.text ?? '', 'system message'), (b.text ?? '').length]);
        else if (m.role === 'system') blocks.push([`system: ${b.type}`, JSON.stringify(b).length]);
        else if (m.role === 'user' && b.type === 'text' && /^<system-reminder>/.test(b.text ?? '')) blocks.push([textKind(b.text, 'reminder: other'), b.text.length]);
      }
      if (blocks.length) events.push({ blocks });
    } else if (o.type === 'user' && o.message) {
      const blocks = userBlocks(o.message.content, names).map(([k, c]) => [o.isCompactSummary ? 'compaction summary' : k, c]);
      if (blocks.length) events.push({ blocks });
    } else if (o.type === 'assistant' && o.message) {
      const u = o.message.usage;
      if (o.requestRef && u) usage.set(o.requestRef, { prompt: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), read: u.cache_read_input_tokens ?? 0, think: u.output_tokens_details?.thinking_tokens ?? 0 });
      const blocks = [];
      listOf(o.message.content).forEach((b, k) => {
        const key = `${o.requestRef ?? o.message.id}:${b.id ?? `${o.apiBlockIndex ?? ''}:${k}:${b.type}`}`;
        if (replied.has(key)) return;
        replied.add(key);
        if (b.type === 'tool_use') {
          names.set(b.id, b.name);
          blocks.push([`call: ${toolLabel(b.name)}`, JSON.stringify(b.input ?? {}).length]);
        } else if (b.type === 'text') blocks.push(['assistant text', (b.text ?? '').length]);
      });
      if (blocks.length) events.push({ blocks });
      if (o.requestRef) events.push({ thinkOf: o.requestRef });
    }
  }
  const inWindow = (e) => e.req && usage.has(e.req) && e.t >= since && e.t < until;
  if (!events.some(inWindow)) continue;
  const cls = classOf(agentName);
  if (only && cls !== only) continue;
  const tot = totals.get(cls) ?? totals.set(cls, { conversations: 0, requests: 0, read: 0, fixed: 0 }).get(cls);
  // Blocks that precede the first request of a conversation are inside its first prompt: find those requests first.
  // A compaction starts another conversation.
  const firstReq = new Set();
  let open = true;
  for (const e of events) {
    if (e.cut) open = true;
    else if (e.req && usage.has(e.req) && open) {
      firstReq.add(e.req);
      open = false;
    }
  }
  // Walk back from the end: `after` is the number of answered requests of the window that follow, inside the same
  // conversation. A block is sent new by the next request and read by those after it.
  let after = 0;
  let opening = false; // Walking back: true between a conversation's first request and its start.
  const thought = new Set();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.cut) {
      after = 0;
      opening = false;
    } else if (e.req) {
      if (!usage.has(e.req)) continue;
      if (firstReq.has(e.req)) {
        // The first prompt (system, tools, opening context, first message) is read by every later request.
        tot.conversations++;
        tot.fixed += usage.get(e.req).prompt * after;
        opening = true;
      }
      if (inWindow(e)) {
        tot.requests++;
        tot.read += usage.get(e.req).read;
        after++;
      }
    } else if (opening) continue;
    else if (e.blocks) {
      if (after > 1) for (const [kind, chars] of e.blocks) bump(cls, kind, chars, after - 1);
    } else if (e.thinkOf && !thought.has(e.thinkOf)) {
      thought.add(e.thinkOf);
      const think = usage.get(e.thinkOf)?.think ?? 0;
      if (think && after > 1) bump(cls, 'thinking (kept in context)', think * THINK_CHARS, after - 1);
    }
  }
}

const pctl = (a, f) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))] ?? 0;
const CAPS = [2000, 4000, 8000, 16000];
const CAPPED = /^(result: (Bash|PowerShell|Read|Grep|Glob|WebFetch|WebSearch|Agent|mcp:|hub__)|hub: worker message|hub: message from the master|skill body|background task notice|peer message)/;
const K = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
for (const [cls, kinds] of [...stats].sort()) {
  const tot = totals.get(cls);
  const carry = [...kinds.values()].reduce((s, e) => s + e.carry, 0);
  const fixed = Math.min(tot.fixed, tot.read);
  const conv = tot.read - fixed;
  console.log(`\n${cls}: ${tot.conversations} conversations, ${tot.requests} requests, ${(tot.read / 1e6).toFixed(0)} M tokens read: ${(fixed / 1e6).toFixed(0)} M the first prompt carried along (${Math.round((100 * fixed) / tot.read)} %), ${(conv / 1e6).toFixed(0)} M what the conversation added.`);
  console.log(`Sources of what was added, by carry (size x later requests); read M = their share of those ${(conv / 1e6).toFixed(0)} M. ${(carry / Math.max(1, conv)).toFixed(2)} characters per token read.`);
  const rows = [...kinds].sort((a, b) => b[1].carry - a[1].carry).slice(0, top)
    .map(([kind, e]) => [kind, e.n, K(e.chars), K(pctl(e.sizes, 0.5)), K(pctl(e.sizes, 0.9)), K(pctl(e.sizes, 1)), `${((100 * e.carry) / carry).toFixed(1)} %`, ((conv * e.carry) / carry / 1e6).toFixed(1), Math.round(e.carry / Math.max(1, e.chars))]);
  console.log(table(rows, ['source', 'blocks', 'chars', 'median', 'p90', 'max', 'carry', 'read M', 'requests after']));
  if (!process.argv.includes('--caps')) continue;
  const capRows = [...kinds].filter(([kind]) => CAPPED.test(kind)).sort((a, b) => b[1].carry - a[1].carry).slice(0, 12).map(([kind, e]) => [
    kind,
    ...CAPS.map((cap) => {
      const beyond = e.sizes.reduce((sum, size, i) => sum + Math.max(0, size - cap) * e.laters[i], 0);
      return `${((conv * beyond) / carry / 1e6).toFixed(1)} (${e.sizes.filter((x) => x > cap).length})`;
    }),
  ]);
  console.log('Read M a limit would have left out, and the blocks over it:');
  console.log(table(capRows, ['source', ...CAPS.map((c) => `${c / 1000}K chars`)]));
}
