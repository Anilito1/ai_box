import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LineTail, parseTranscriptLine, projectDirName, SubagentTails, TranscriptFinder } from './subagentTail';
import { Subagents } from './subagents';

const SESSION = 'cdeb6554-b182-4bb9-80f3-55fcd9ae1785';
const CWD = '/Users/someone/dev/demo.app';
const CALL = 'toolu_01ABC';
const AGENT = 'a9b7a7c47278ee524';

const assistant = (content: unknown[], extra: Record<string, unknown> = {}, at = '2026-11-06T12:35:10.000Z') =>
  JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: at, message: { role: 'assistant', content, ...extra } }) + '\n';
const toolUse = (id: string, name: string, input: Record<string, unknown>) => assistant([{ type: 'tool_use', id, name, input }]);
const toolError = (id: string, text: string) =>
  JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } }) + '\n';

/** A projects folder with the session's subagents folder, and a hub-side tracker with a background subagent launched. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'subtail-'));
  const dir = join(root, projectDirName(CWD), SESSION, 'subagents');
  mkdirSync(dir, { recursive: true });
  let clock = Date.now();
  const subagents = new Subagents(() => clock);
  let changes = 0;
  const tails = new SubagentTails({ subagents, where: () => ({ sessionId: SESSION, cwd: CWD }), changed: () => changes++ }, root, () => clock, 10);
  const meta = (extra: Record<string, unknown> = {}) =>
    writeFileSync(join(dir, `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Recap', toolUseId: CALL, model: 'opus', requestShape: 'background', ...extra }));
  const launch = () => subagents.calls([{ type: 'tool_use', id: CALL, name: 'Agent', input: { description: 'Recap', run_in_background: true } }]);
  const file = join(dir, `agent-${AGENT}.jsonl`);
  return {
    root,
    dir,
    file,
    subagents,
    tails,
    meta,
    launch,
    tick: (ms = 0) => (clock += ms),
    changes: () => changes,
    log: () => subagents.views()[0]?.log.map((s) => `${s.kind}:${s.text}`) ?? [],
    done: () => {
      tails.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the project folder is the path with every character but letters and digits as a dash', () => {
  assert.equal(projectDirName('/Users/jeremy.bardet-neyrin/dev/calculette'), '-Users-jeremy-bardet-neyrin-dev-calculette');
});

test('a transcript line gives the tools, the text, the thinking and the errors of the subagent', () => {
  const l = parseTranscriptLine(
    assistant([
      { type: 'thinking', thinking: '', signature: 'x' },
      { type: 'thinking', thinking: 'Let me look at the layouts first.' },
      { type: 'text', text: 'Reading the files.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a/b.ts' } },
    ]),
  );
  assert.deepEqual(
    l?.items.map((i) => [i.kind, i.tool ?? false]),
    [
      ['thinking', false],
      ['text', false],
      ['tool', true],
    ],
  );
  assert.equal(l?.items[0].at, Date.parse('2026-11-06T12:35:10.000Z'));
  assert.equal(l?.end, undefined);
  assert.equal(parseTranscriptLine(toolError('toolu_1', 'boom'))?.items[0].kind, 'error');
});

test('a reply that ends the turn without a tool call is the end of the subagent, with its answer', () => {
  const l = parseTranscriptLine(assistant([{ type: 'text', text: 'All done.' }], { stop_reason: 'end_turn' }));
  assert.equal(l?.end, 'All done.');
  assert.equal(parseTranscriptLine(assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], { stop_reason: 'end_turn' }))?.end, undefined);
});

test('request blobs, attachments and broken lines are no steps', () => {
  assert.equal(parseTranscriptLine('{"type":"api-request-blob","message":{"content":[{"type":"text","text":"x"}]}}'), null);
  assert.equal(parseTranscriptLine('{"type":"attachment"}'), null);
  assert.equal(parseTranscriptLine('{"type":"assistant","mess'), null);
});

test('the tail reads what is appended, not what it already read', () => {
  const t = setup();
  writeFileSync(t.file, 'one\ntwo\n');
  const tail = new LineTail(t.file);
  assert.deepEqual(tail.poll().lines, ['one', 'two']);
  assert.deepEqual(tail.poll().lines, []);
  appendFileSync(t.file, 'three\n');
  assert.deepEqual(tail.poll().lines, ['three']);
  t.done();
});

test('a line still being written waits for its end, multi-byte characters included', () => {
  const t = setup();
  writeFileSync(t.file, 'a\nrécap en cou');
  const tail = new LineTail(t.file);
  assert.deepEqual(tail.poll().lines, ['a']);
  appendFileSync(t.file, 'rs');
  assert.deepEqual(tail.poll().lines, []);
  appendFileSync(t.file, '\nb\n');
  assert.deepEqual(tail.poll().lines, ['récap en cours', 'b']);
  // The byte of a character cut in two reads.
  const bytes = Buffer.from('é\n');
  writeFileSync(t.file, Buffer.concat([Buffer.from('x\n'), bytes.subarray(0, 1)]));
  const cut = new LineTail(t.file);
  assert.deepEqual(cut.poll().lines, ['x']);
  appendFileSync(t.file, bytes.subarray(1));
  assert.deepEqual(cut.poll().lines, ['é']);
  t.done();
});

test('a file that is not there yet is reported absent, then read from its start when it appears', () => {
  const t = setup();
  const tail = new LineTail(t.file);
  assert.equal(tail.poll().exists, false);
  writeFileSync(t.file, 'first\n');
  assert.deepEqual(tail.poll(), { lines: ['first'], exists: true, grew: false });
  t.done();
});

test('a file rewritten from the start is read again', () => {
  const t = setup();
  writeFileSync(t.file, 'aaaa\nbbbb\n');
  const tail = new LineTail(t.file);
  tail.poll();
  writeFileSync(t.file, 'c\n');
  assert.deepEqual(tail.poll().lines, ['c']);
  t.done();
});

test('the finder takes the file by the launching call named in its meta, in the folder of the session', () => {
  const t = setup();
  const finder = new TranscriptFinder(t.root, () => ({ sessionId: SESSION, cwd: CWD }));
  assert.equal(finder.find(CALL), null);
  t.meta();
  assert.equal(finder.find(CALL), null); // The meta is there, the transcript is not.
  writeFileSync(t.file, '');
  assert.equal(finder.find(CALL), t.file);
  assert.equal(finder.find('toolu_other', AGENT), t.file); // By agent id too.
  t.done();
});

test('the finder looks in every project when the folder name differs, and reads nothing outside the projects folder', () => {
  const t = setup();
  const finder = new TranscriptFinder(t.root, () => ({ sessionId: SESSION, cwd: '/elsewhere/odd path' }));
  t.meta();
  writeFileSync(t.file, '');
  assert.equal(finder.find(CALL), t.file);
  const bad = new TranscriptFinder(t.root, () => ({ sessionId: '../../etc', cwd: CWD }));
  assert.equal(bad.folder(), null);
  assert.equal(bad.find(CALL, '../../x'), null);
  t.done();
});

test('a background subagent follows its transcript as it grows, and the activity is the latest step', () => {
  const t = setup();
  t.meta();
  writeFileSync(t.file, toolUse('toolu_1', 'Bash', { command: 'npm test' }));
  t.launch();
  t.tails.sync();
  assert.equal(t.tails.size, 1);
  assert.deepEqual(t.log(), ['tool:Command npm test']);
  appendFileSync(t.file, assistant([{ type: 'text', text: 'Tests pass.' }]));
  t.tails.tick();
  assert.deepEqual(t.log(), ['tool:Command npm test', 'text:Tests pass.']);
  const v = t.subagents.views()[0];
  assert.equal(v.activity, 'Tests pass.');
  assert.equal(v.tools, 1);
  assert.ok(t.changes() >= 2);
  t.done();
});

test('a transcript that appears late is picked up on a later tick', () => {
  const t = setup();
  t.launch();
  t.tails.sync();
  assert.deepEqual(t.log(), []);
  t.meta();
  writeFileSync(t.file, toolUse('toolu_1', 'Read', { file_path: '/a/b.ts' }));
  t.tails.tick();
  assert.equal(t.log().length, 1);
  t.done();
});

test('a half-written line is kept for the next tick', () => {
  const t = setup();
  t.meta();
  writeFileSync(t.file, '');
  t.launch();
  t.tails.sync();
  const line = toolUse('toolu_1', 'Bash', { command: 'ls' });
  appendFileSync(t.file, line.slice(0, 40));
  t.tails.tick();
  assert.deepEqual(t.log(), []);
  appendFileSync(t.file, line.slice(40));
  t.tails.tick();
  assert.deepEqual(t.log(), ['tool:Command ls']);
  t.done();
});

test('only the latest 40 steps are kept', () => {
  const t = setup();
  t.meta();
  writeFileSync(t.file, '');
  t.launch();
  t.tails.sync();
  for (let i = 0; i < 55; i++) appendFileSync(t.file, toolUse(`toolu_${i}`, 'Bash', { command: `cmd ${i}` }));
  t.tails.tick();
  const log = t.log();
  assert.equal(log.length, 40);
  assert.equal(log.at(-1), 'tool:Command cmd 54');
  assert.equal(t.subagents.views()[0].tools, 55);
  t.done();
});

test('the tail is let go when the subagent ends, after one last read, and nothing keeps running', () => {
  const t = setup();
  t.meta();
  writeFileSync(t.file, '');
  t.launch();
  t.tails.sync();
  appendFileSync(t.file, toolUse('toolu_1', 'Bash', { command: 'last' }));
  t.subagents.task({ type: 'agentTask', id: AGENT, state: 'start', toolUseId: CALL });
  t.subagents.task({ type: 'agentTask', id: AGENT, state: 'done', toolUseId: CALL });
  t.tails.tick();
  assert.deepEqual(t.log(), ['tool:Command last']);
  assert.equal(t.tails.size, 0);
  appendFileSync(t.file, toolUse('toolu_2', 'Bash', { command: 'after' }));
  t.tails.tick();
  assert.deepEqual(t.log(), ['tool:Command last']);
  t.done();
});

test('a foreground subagent has no tail: its stream is its source', () => {
  const t = setup();
  t.meta({ requestShape: 'foreground' });
  writeFileSync(t.file, toolUse('toolu_1', 'Bash', { command: 'ls' }));
  t.subagents.calls([{ type: 'tool_use', id: CALL, name: 'Agent', input: { description: 'Recap' } }]);
  t.tails.sync();
  assert.equal(t.tails.size, 0);
  t.done();
});

test('the stream and the transcript tell the same steps once, whichever comes first', () => {
  const t = setup();
  t.meta();
  writeFileSync(t.file, '');
  t.launch();
  const blocks = [
    { type: 'text', text: 'Looking.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
  ];
  t.subagents.steps(CALL, blocks); // By the stream first...
  t.tails.sync();
  appendFileSync(t.file, assistant(blocks)); // ...then the same ones by the file.
  appendFileSync(t.file, toolError('toolu_1', 'denied'));
  t.tails.tick();
  assert.deepEqual(t.log(), ['text:Looking.', 'tool:Command ls', 'error:denied']);
  t.subagents.steps(CALL, [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'denied' }]);
  assert.equal(t.log().length, 3);
  assert.equal(t.subagents.views()[0].tools, 1);
  t.done();
});

test('subagents of before a restart come back running from fresh transcripts, and end with their answer', () => {
  const t = setup();
  t.meta();
  writeFileSync(t.file, toolUse('toolu_1', 'Bash', { command: 'ls' }));
  assert.equal(t.tails.adopt(), 1);
  const v = t.subagents.views()[0];
  assert.equal(v.status, 'running');
  assert.equal(v.description, 'Recap');
  assert.equal(v.background, true);
  assert.equal(t.tails.adopt(), 0); // Not twice.
  appendFileSync(t.file, assistant([{ type: 'text', text: 'Finished.' }], { stop_reason: 'end_turn' }));
  t.tails.tick();
  const ended = t.subagents.views()[0];
  assert.equal(ended.status, 'done');
  assert.equal(ended.result, 'Finished.');
  assert.equal(t.tails.size, 0);
  t.done();
});

test('old transcripts and foreground ones are not brought back, and an adopted subagent whose file went quiet is stopped', () => {
  const t = setup();
  t.meta();
  writeFileSync(t.file, toolUse('toolu_1', 'Bash', { command: 'ls' }));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(t.file, old, old);
  assert.equal(t.tails.adopt(), 0);
  t.meta({ requestShape: 'foreground' });
  utimesSync(t.file, new Date(), new Date());
  const fresh = setup();
  fresh.meta({ requestShape: 'foreground' });
  writeFileSync(fresh.file, toolUse('toolu_1', 'Bash', { command: 'ls' }));
  assert.equal(fresh.tails.adopt(), 0);
  fresh.done();

  const quiet = setup();
  quiet.meta();
  writeFileSync(quiet.file, toolUse('toolu_1', 'Bash', { command: 'ls' }));
  assert.equal(quiet.tails.adopt(), 1);
  quiet.tick(11 * 60_000);
  quiet.tails.tick();
  assert.equal(quiet.subagents.views()[0].status, 'stopped');
  assert.equal(quiet.tails.size, 0);
  quiet.done();
  t.done();
});

test('stop lets every tail go', () => {
  const t = setup();
  t.meta();
  writeFileSync(t.file, '');
  t.launch();
  t.tails.sync();
  assert.equal(t.tails.size, 1);
  t.tails.stop();
  assert.equal(t.tails.size, 0);
  t.done();
});
