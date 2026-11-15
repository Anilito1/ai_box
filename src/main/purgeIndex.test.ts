import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeReader, CodexReader, geminiFacts, geminiHash, patchPaths, placePath } from './purgeIndex';

const at = (s: number) => new Date(Date.UTC(2026, 10, 10, 10, 0, s)).toISOString();
const ms = (s: number) => Date.parse(at(s));

test('placePath places relative paths against the folder they were written in, on either system', () => {
  assert.equal(placePath('qc/a.png', 'C:\\Proj'), 'C:\\Proj\\qc\\a.png');
  assert.equal(placePath('C:/Proj/x.png', '/home/u'), 'C:\\Proj\\x.png');
  assert.equal(placePath('/c/Users/u/p/a.png', 'C:\\Users\\u'), 'c:\\Users\\u\\p\\a.png');
  assert.equal(placePath('shots/b.png', '/home/u/p'), '/home/u/p/shots/b.png');
  assert.equal(placePath('/tmp/x.png', '/home/u/p'), '/tmp/x.png');
  assert.equal(placePath('rel.png', ''), '');
});

test('Claude Code transcript: writes, commands with their run, background runs, citations and the hub name', () => {
  const r = new ClaudeReader();
  const lines = [
    { type: 'agent-name', agentName: 'title-of-tab', sessionId: 's' },
    { type: 'user', timestamp: at(0), cwd: 'C:\\Proj', message: { content: '[Mission du maître — tu es le worker "hub-qa"] Livre KIT-DEMO.zip et la planche `qc/sheets/planche.png`.' } },
    { type: 'assistant', timestamp: at(1), cwd: 'C:\\Proj', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'C:\\Proj\\notes\\essai.py', content: 'print(1)' } }] } },
    { type: 'user', timestamp: at(2), cwd: 'C:\\Proj', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, toolUseResult: { type: 'create' } },
    { type: 'assistant', timestamp: at(3), cwd: 'C:\\Proj', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ffmpeg -i in.mp4 qc/frames/f_%03d.png' } }] } },
    { type: 'user', timestamp: at(30), cwd: 'C:\\Proj', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'done' }] } },
    { type: 'assistant', timestamp: at(31), cwd: 'C:\\Proj', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'python render.py --out renders/', run_in_background: true } }] } },
    { type: 'user', timestamp: at(32), cwd: 'C:\\Proj', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'started' }] } },
    { type: 'assistant', timestamp: at(33), cwd: 'C:\\Proj', message: { content: [{ type: 'tool_use', id: 't4', name: 'mcp__hub__message_master', input: { message: 'Rendu livré : renders/final/hero.png' } }] } },
    { type: 'assistant', timestamp: at(200), cwd: 'C:\\Proj', message: { content: [{ type: 'text', text: 'Fini.' }] } },
  ];
  for (const l of lines) r.line(JSON.stringify(l));
  r.line('{"type":"api-request","params":{"messages":"C:\\\\Proj\\\\secret.png"}}');
  r.line('not json');
  // A line too large to parse: only which calls it ends.
  r.line(`{"type":"user","timestamp":"${at(201)}","message":{"content":[{"type":"tool_result","tool_use_id":"none","content":"${'x'.repeat(9 * 1024 * 1024)}"}]}}`);
  const f = r.facts('fallback');
  assert.equal(f.format, 'claude');
  assert.equal(f.session, 'hub-qa');
  assert.deepEqual(f.cwds, ['C:\\Proj']);
  const write = f.acts.find((a) => a.kind === 'write');
  assert.deepEqual(write && { paths: write.paths, start: write.start, end: write.end }, { paths: ['C:\\Proj\\notes\\essai.py'], start: ms(1), end: ms(2) });
  const cmds = f.acts.filter((a) => a.kind === 'cmd');
  assert.deepEqual(cmds[0].paths, ['C:\\Proj\\in.mp4', 'C:\\Proj\\qc\\frames\\f_%03d.png']);
  assert.equal(cmds[0].end, ms(30));
  // The background run lasts as long as the session kept working, not until its "started" answer.
  assert.ok(cmds[1].end >= ms(200), 'background command spans the rest of the stretch');
  for (const c of ['kit-demo.zip', 'qc/sheets/planche.png', 'renders/final/hero.png']) assert.ok(f.cites.includes(c), c);
  assert.ok(!f.cites.some((c) => c.includes('secret')), 'api requests are not read');
  assert.ok(f.acts.some((a) => a.kind === 'turn'));
});

test('Codex rollout: shell calls with their folder, apply_patch files and messages', () => {
  const r = new CodexReader();
  const lines = [
    { timestamp: at(0), type: 'session_meta', payload: { id: 'abcdef123456', cwd: '/home/u/p' } },
    { timestamp: at(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Garde final/hero.png' }] } },
    { timestamp: at(2), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'convert a.png shots/b.png'], workdir: '/home/u/p/web' }) } },
    { timestamp: at(9), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
    { timestamp: at(10), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Add File: notes/tmp.txt\n+hi\n*** End Patch' } },
    { timestamp: at(11), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'ok' } },
    { timestamp: at(12), type: 'event_msg', payload: { type: 'agent_message', message: 'Capture dans `shots/b.png`' } },
  ];
  for (const l of lines) r.line(JSON.stringify(l));
  const f = r.facts('x');
  assert.equal(f.format, 'codex');
  assert.equal(f.session, 'codex-abcdef12');
  const cmd = f.acts.find((a) => a.kind === 'cmd');
  assert.deepEqual(cmd?.paths, ['/home/u/p/web/a.png', '/home/u/p/web/shots/b.png']);
  assert.deepEqual([cmd?.start, cmd?.end], [ms(2), ms(9)]);
  assert.deepEqual(f.acts.find((a) => a.kind === 'write')?.paths, ['/home/u/p/notes/tmp.txt']);
  assert.ok(f.cites.includes('final/hero.png'));
  assert.ok(f.cites.includes('shots/b.png'));
  assert.deepEqual(patchPaths('*** Update File: a.ts\n*** Move to: b/c.ts'), ['a.ts', 'b/c.ts']);
});

test('Gemini CLI chat: its project from the hash, writes and shell commands', () => {
  const json = JSON.stringify({
    sessionId: '0123456789',
    projectHash: geminiHash('/home/u/g'),
    messages: [
      { type: 'user', timestamp: at(0), content: 'Fais une capture' },
      { type: 'gemini', timestamp: at(1), content: [{ text: 'Voir qc/home.png' }], toolCalls: [{ name: 'run_shell_command', args: { command: 'npx playwright screenshot http://x qc/home.png' } }, { name: 'write_file', args: { file_path: '/home/u/g/tmp/log.txt' } }] },
      { type: 'gemini', timestamp: at(20), content: 'ok' },
    ],
  });
  const f = geminiFacts(json, 'x', (h) => (h === geminiHash('/home/u/g') ? '/home/u/g' : ''));
  assert.ok(f);
  assert.equal(f.session, 'gemini-01234567');
  assert.deepEqual(f.cwds, ['/home/u/g']);
  assert.deepEqual(f.acts.find((a) => a.kind === 'cmd')?.paths, ['/home/u/g/qc/home.png']);
  assert.deepEqual(f.acts.find((a) => a.kind === 'cmd')?.end, ms(20));
  assert.deepEqual(f.acts.find((a) => a.kind === 'write')?.paths, ['/home/u/g/tmp/log.txt']);
  assert.ok(f.cites.includes('qc/home.png'));
  assert.equal(geminiFacts('{broken', 'x', () => ''), null);
});
