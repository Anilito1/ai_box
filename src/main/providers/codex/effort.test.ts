import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LaunchSpec } from '../types';
import { codexAdapter, turnStartParams } from './adapter';

const base = { threadId: 't1', input: 'hi', cwd: '/w', model: 'gpt-6-luna', mode: null, readOnly: false, roots: ['/w'] };

test('the effort of the session goes with the turn, as the model lists it', () => {
  assert.equal(turnStartParams({ ...base, effort: 'xhigh', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }).effort, 'xhigh');
  assert.equal(turnStartParams({ ...base, effort: 'max', efforts: ['low', 'medium', 'high'] }).effort, 'high');
});

test('no effort held, or a model that lists none: the turn carries none', () => {
  assert.equal('effort' in turnStartParams({ ...base, effort: null, efforts: ['low', 'high'] }), false);
  assert.equal('effort' in turnStartParams({ ...base, effort: 'high', efforts: [] }), false);
});

// A stand-in for `codex app-server`: answers the handshake, lists one model, and writes the params of each turn it is given.
// Node plays the binary and this file, named `app-server` in the session's folder, is what `node app-server --listen …` runs:
// no shebang nor executable bit, which Windows would not honour.
const FAKE = (log: string) => `const fs = require('node:fs');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    let result = {};
    if (m.method === 'model/list') result = { data: [{ model: 'gpt-6-luna', displayName: 'GPT-6 Luna', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({ reasoningEffort: e })) }] };
    if (m.method === 'thread/start' || m.method === 'thread/resume') result = { thread: { id: 't1' }, model: 'gpt-6-luna', reasoningEffort: 'medium' };
    if (m.method === 'turn/start') {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m.params) + '\\n');
      result = { turn: { id: 'u' + m.id } };
      send({ id: m.id, result });
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u' + m.id, status: 'completed' } } }), 150);
      continue;
    }
    send({ id: m.id, result });
  }
});
`;

test('the effort a session is launched with, then the one picked by hand, reach the turns sent to Codex', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-codex-'));
  const log = join(dir, 'turns.jsonl');
  writeFileSync(join(dir, 'app-server'), FAKE(log));
  writeFileSync(log, '');
  let firstDone: () => void = () => undefined;
  const first = new Promise<void>((resolve) => (firstDone = resolve));
  let release: () => void = () => undefined;
  const second = new Promise<void>((resolve) => (release = resolve));
  const turns = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const waitFor = async (n: number) => {
    for (let i = 0; i < 200 && turns().length < n; i++) await new Promise((r) => setTimeout(r, 25));
  };
  const spec = {
    role: 'worker', name: 'w', cwd: dir, extraDirs: [], readOnly: false, model: 'gpt-6-luna', effort: 'xhigh', mode: null, instructions: '', stableInstructions: false,
    onSignal: () => undefined,
    tools: [], mcp: null, executable: process.execPath, env: { ...process.env } as Record<string, string>, conversation: { id: '', resume: false },
    input: (async function* () {
      yield { content: 'one' };
      await second;
      yield { content: 'two' };
    })(),
    onPermission: () => Promise.reject(new Error('unused')),
    onElicitation: () => Promise.reject(new Error('unused')),
  } as unknown as LaunchSpec;
  const proc = codexAdapter.start(spec);
  void (async () => {
    for await (const e of proc.events) if (e.type === 'turn') firstDone();
  })().catch(() => undefined);
  try {
    await proc.ready();
    await waitFor(1);
    assert.equal(turns()[0].effort, 'xhigh');
    assert.equal(turns()[0].model, 'gpt-6-luna');
    await first;
    await proc.setEffort('low');
    release();
    await waitFor(2);
    assert.equal(turns()[1].effort, 'low');
  } finally {
    proc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
