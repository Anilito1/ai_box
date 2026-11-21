import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { conversationPrompt } from './prompts';
import { SessionManager } from './sessions';

// "New conversation": the user opens a worker conversation by spawn_worker's own way. It talks to the user, owes the
// master nothing, and falls asleep with its conversation and its worktree.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internal = any;
const VENICE = 'a-ven00001';
const never = () => new Promise<never>(() => undefined);
const processStub = () => ({ close: () => undefined, interrupt: async () => undefined, context: never, totals: never, rateLimits: never });

function repository(path: string) {
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  writeFileSync(join(path, 'fixture.txt'), 'SYNTHETIC_FIXTURE');
  git('add', '.');
  git('-c', 'user.name=FIXTURE', '-c', 'user.email=fixture@invalid.test', 'commit', '-m', 'Create fixture');
}

function hub() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-new-conversation-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  cfg.workerMaxEffort = 'medium';
  cfg.accounts = [{ id: VENICE, kind: 'openai', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', model: 'venice-uncensored', smallModel: '', slug: 'venice', models: ['venice-uncensored', 'llama-3.3-70b'], videoModels: ['my-video'], isolated: false }];
  const options = {
    cfg,
    dataDir: dir,
    executable: () => '',
    codexExecutable: () => '',
    geminiExecutable: () => '',
    mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }),
    persist: () => undefined,
    costLog: { today: () => 0, append: () => undefined } as unknown as CostLog,
    capabilities: async () => '',
  };
  const m = new SessionManager(options);
  m.setProviderStates({ venice: { connected: true, accountId: VENICE, method: 'apikey' } });
  m.setCatalog(VENICE, ['venice-uncensored', 'llama-3.3-70b', 'my-video'].map((value) => ({ value, displayName: value, description: '', efforts: [] })));
  const inner: Internal = m;
  // Nothing starts: each launch is noted, with its prompt.
  const launches: { id: string; resume: boolean; text: string | null }[] = [];
  inner.launch = async (s: Internal, resume: boolean, prompt?: { text: string }) => {
    launches.push({ id: s.id, resume, text: prompt?.text ?? null });
  };
  const master = inner.create('master', 'master', 'hub-master', '', work, '', null);
  return { cfg, dir, work, m, inner, master, launches, options, done: () => (m.killAll(), rmSync(dir, { recursive: true, force: true })) };
}

/** A session made to look started and idle, with a process that does nothing. */
function running(inner: Internal, s: Internal) {
  Object.assign(s, { started: true, status: 'idle', query: processStub(), inbox: inner.deliveryInbox(s) });
}

test('the window offers the models spawn_worker may run, by provider, and the known folders', () => {
  const { m, work, done } = hub();
  try {
    const choices = m.conversationChoices();
    const venice = choices.groups.find((g) => g.id === 'venice');
    // A video model is offered for no session, here neither.
    assert.deepEqual(venice?.entries.map((e) => e.target), [
      { kind: 'model', provider: 'venice', model: 'venice-uncensored' },
      { kind: 'model', provider: 'venice', model: 'llama-3.3-70b' },
    ]);
    assert.equal(new Set(choices.groups.flatMap((g) => g.entries.map((e) => e.id))).size, choices.groups.flatMap((g) => g.entries).length, 'ids are unique across groups');
    // Claude's: the models the user allows workers, named even before Claude Code listed its own.
    assert.deepEqual(choices.groups.find((g) => g.id === 'anthropic')?.entries.map((e) => [e.target.model, e.label]), [['opus', 'opus'], ['sonnet', 'sonnet']]);
    assert.ok(choices.folders.some((f) => f.path === work));
    assert.equal(choices.cwd, choices.folders[0].path);
  } finally {
    done();
  }
});

test('a conversation opened by the user runs with its choices, talks to the user and owes the master no report', async () => {
  const { m, inner, work, launches, done } = hub();
  try {
    const r = await m.newConversation({ target: { kind: 'model', provider: 'venice', model: 'llama-3.3-70b' }, effort: 'max', cwd: work, name: 'Notes de lecture', message: 'Bonjour, résume ce dossier.' });
    assert.ok(r.ok, JSON.stringify(r));
    const s = inner.sessions.get(r.id);
    assert.equal(s.name, 'hub-notes-de-lecture');
    assert.equal(s.cwd, work);
    assert.equal(s.accountId, VENICE);
    assert.equal(s.fixedModel, 'llama-3.3-70b');
    // The cap on effort holds the master's choices, not the user's.
    assert.equal(s.fixedEffort, 'max');
    assert.deepEqual([s.userOpened, s.owesReport, s.userModel, s.userEffort, s.userAccount], [true, false, true, true, true]);
    // The first message goes as the user's, not as a mission from the master.
    assert.equal(launches.length, 1);
    assert.equal(launches[0].id, s.id);
    assert.match(launches[0].text ?? '', /^Bonjour, résume ce dossier\./);
    assert.doesNotMatch(launches[0].text ?? '', /Mission|master/);
    assert.equal(m.snapshot().sessions.find((x) => x.id === s.id)?.userOpened, true);
    // Its instructions are a conversation's: its name, no report owed.
    const prompt = conversationPrompt(inner.opts.cfg, s.name);
    assert.match(prompt, /"hub-notes-de-lecture"/);
    assert.match(prompt, /owe it no report/);
    assert.doesNotMatch(prompt, /Every turn started by the master ends/);

    // Without a first message it starts and waits for one; the name defaults.
    const empty = await m.newConversation({ target: { kind: 'model', provider: 'venice', model: '' }, effort: null, cwd: work, name: '', message: '' });
    assert.ok(empty.ok);
    assert.equal(empty.name, 'hub-conversation');
    assert.deepEqual(launches.at(-1), { id: empty.id, resume: false, text: null });

    // A model the provider does not run is refused, as spawn_worker refuses it.
    const refused = await m.newConversation({ target: { kind: 'model', provider: 'venice', model: 'my-video' }, effort: null, cwd: work, name: '', message: '' });
    assert.equal(refused.ok, false);
  } finally {
    done();
  }
});

test('the master sees it in list_workers but gets no notice about it, and cannot close it', async () => {
  const { m, inner, master, work, launches, done } = hub();
  try {
    const r = await m.newConversation({ target: { kind: 'model', provider: 'venice', model: 'venice-uncensored' }, effort: null, cwd: work, name: 'mine', message: 'Hello' });
    assert.ok(r.ok);
    const s = inner.sessions.get(r.id);
    running(inner, s);
    const tools = inner.hubTools(master);
    const call = async (name: string, args: unknown) => (await tools.find((x: Internal) => x.name === name).handler(args, {})) as { content: { text: string }[]; isError?: boolean };
    assert.match((await call('list_workers', {})).content[0].text, /hub-mine · opened by the user · /);

    // The master may write to it; the hub chases no report from it.
    const sent = await call('message_worker', { name: 'mine', message: 'FYI' });
    assert.match(sent.content[0].text, /conversation the user opened/);
    assert.equal(s.owesReport, false);

    // Whatever ends its turns (silence, a crash), nothing about it reaches the master (closed here: a notice would
    // start it).
    const toMaster = () => launches.filter((l) => l.id === master.id).map((l) => l.text ?? '');
    s.owesReport = true;
    s.activeAt = 0;
    inner.chaseSilence(s, s.query);
    inner.notifyMaster('crashed', 'note', s);
    assert.deepEqual(toMaster(), []);
    // A worker of the master's is chased as before.
    const theirs = inner.create('w-theirs', 'worker', 'hub-theirs', 'TASK', work, '', null);
    running(inner, theirs);
    Object.assign(theirs, { owesReport: true, activeAt: 0 });
    inner.chaseSilence(theirs, theirs.query);
    assert.equal(toMaster().length, 1);
    assert.match(toMaster()[0], /^\[Hub\] .*theirs/);

    const close = await call('close_worker', { name: 'mine' });
    assert.equal(close.isError, true);
    assert.match(close.content[0].text, /only they close it/);
    assert.ok(s.inbox, 'still open');
  } finally {
    done();
  }
});

test('idle, it falls asleep with its worktree; the next message wakes it with its whole conversation', async () => {
  const { m, inner, work, launches, options, done } = hub();
  let restored: SessionManager | undefined;
  try {
    const repo = join(work, 'repo');
    repository(repo);
    // Another worker writes in the checkout: the conversation gets a worktree of its own, as from spawn_worker.
    const other = inner.create('w-other', 'worker', 'hub-other', 'TASK', repo, '', null);
    running(inner, other);
    const choices = m.conversationChoices();
    assert.deepEqual(choices.folders.find((f) => f.path === repo)?.writers, ['hub-other']);
    const r = await m.newConversation({ target: { kind: 'model', provider: 'venice', model: 'venice-uncensored' }, effort: 'low', cwd: repo, name: 'review', message: 'Look at it' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.branch, 'a worktree was made');
    assert.notEqual(r.cwd, repo);
    const s = inner.sessions.get(r.id);
    running(inner, s);
    let retired = 0;
    const retire = inner.retire.bind(inner);
    inner.retire = (x: Internal) => (retired++, retire(x));

    // Idle past the delay, with a well-filled context: asleep at once, no handoff note asked.
    Object.assign(s, { activeAt: Date.now() - 16 * 60_000, metrics: { contextTokens: 190_000, contextSize: 200_000, contextPct: 95, costUsd: 0 } });
    inner.closeIdle();
    assert.equal(s.inbox, null, 'its process is closed');
    assert.equal(s.deliveries.length, 0, 'no handoff note was asked');
    assert.equal(retired, 0, 'its worktree is kept');
    assert.equal(s.tree.state, 'active');
    assert.ok([...s.items.values()].some((i: Internal) => i.kind === 'notice' && /Asleep after 15 min/.test(i.text)));
    const view = m.snapshot().sessions.find((x) => x.id === s.id);
    assert.equal(view?.status, 'exited');
    assert.equal(view?.userOpened, true);
    // Asleep, it still holds its folder: a worker the master starts there gets its own worktree.
    assert.ok(inner.writersIn(s.tree.path).includes(s.name));

    const before = launches.length;
    m.send(s.id, 'And now?');
    assert.equal(launches.length, before + 1);
    assert.deepEqual({ ...launches.at(-1), text: launches.at(-1)?.text?.split('\n')[0] }, { id: s.id, resume: true, text: 'And now?' });

    // A restart keeps it as the user's, and keeps its worktree.
    m.killAll();
    restored = new SessionManager(options);
    const back: Internal = restored;
    assert.equal(back.sessions.get(s.id).userOpened, true);
    assert.equal(back.sessions.get(s.id).tree.state, 'active');
  } finally {
    restored?.killAll();
    done();
  }
});
