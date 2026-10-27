import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatItem, TeamRole } from '../shared/types';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { rosterBlock, workerPrompt, groupInfo } from './prompts';
import { Inbox } from './providers/inbox';
import { SessionManager } from './sessions';

// A lead drives the members of its group, with the master's tools limited to them; a member reports to its lead.

const CODEX = 'a-cdx00001';

interface Fake {
  id: string;
  name: string;
  roleId: string | null;
  instanceOf: string | null;
  inbox: Inbox<unknown> | null;
  status: string;
  owesReport: boolean;
  reportTo: string | null;
  items: Map<string, ChatItem>;
}
interface Inner {
  sessions: Map<string, Fake>;
  hubTools(s: Fake, harness?: string): { name: string }[];
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  groupAsked(before: unknown, args: { name?: string; lead?: string; members?: string[] }): string;
  findGroup(name: string): unknown;
  listGroups(): string;
  listWorkers(lead?: Fake): string;
  messageWorker(args: { name: string; message: string }, by?: Fake): Promise<string>;
  workerReport(name: string, lead?: Fake): Promise<string>;
  messageLead(s: Fake, message: string): string;
  deleteRole(id: string): boolean;
}

async function hub() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-groups-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  cfg.accounts = [{ id: CODEX, kind: 'codex', name: 'OpenAI (ChatGPT)', baseUrl: '', model: '', smallModel: '', slug: '', models: [], isolated: true }];
  const m = new SessionManager({
    cfg,
    dataDir: dir,
    executable: () => '',
    codexExecutable: () => '',
    geminiExecutable: () => '',
    mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }),
    persist: () => undefined,
    costLog: {} as CostLog,
    capabilities: async () => '',
  });
  m.setProviderStates({ openai: { connected: true, accountId: CODEX, method: 'chatgpt' } });
  m.setCatalog(CODEX, [{ value: 'gpt-6-luna', displayName: 'GPT-6 Luna', description: '', efforts: ['low', 'high'] }]);
  const inner = m as unknown as Inner;
  const signal = new AbortController().signal;
  for (const [name, more] of [
    ['sous-chef-lbc', { model: 'opus' }],
    ['openai-lbc1', { provider: 'openai', model: 'gpt-6-luna' }],
    ['other', {}],
  ] as const) {
    await inner.createRole({ name, description: name, folders: [work], ...more }, signal);
  }
  const post = (name: string) => cfg.team.find((r) => r.name === name) as TeamRole;
  // Running without a program: what is delivered lands in its inbox.
  const session = (name: string) => {
    const s = inner.sessions.get(post(name).id) as Fake;
    s.inbox ??= new Inbox();
    s.status = 'idle';
    return s;
  };
  return {
    cfg,
    inner,
    post,
    session,
    done: () => {
      m.killAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const lastPeer = (s: Fake) => [...s.items.values()].filter((i) => i.kind === 'peer').at(-1) as (ChatItem & { from: string; text: string }) | undefined;

test('the master makes a group: the lead gets its tools, the member message_lead, the roster says it', async () => {
  const { cfg, inner, post, session, done } = await hub();
  try {
    const text = inner.groupAsked(null, { name: 'lbc', lead: 'sous-chef-lbc', members: ['hub-openai-lbc1'] });
    assert.deepEqual(cfg.groups.map((g) => [g.name, g.lead, g.members]), [['lbc', post('sous-chef-lbc').id, [post('openai-lbc1').id]]]);
    assert.match(text, /lbc · lead hub-sous-chef-lbc · members hub-openai-lbc1/);
    assert.match(inner.listGroups(), /lbc/);
    assert.match(rosterBlock(cfg, 'en'), /Groups \(lead → members\):\n- lbc : hub-sous-chef-lbc → hub-openai-lbc1/);

    const names = (s: Fake) => inner.hubTools(s).map((x) => x.name).sort();
    assert.deepEqual(names(session('sous-chef-lbc')), ['list_capabilities', 'list_repos', 'list_workers', 'message_master', 'message_worker', 'worker_report']);
    assert.deepEqual(names(session('openai-lbc1')), ['list_capabilities', 'list_repos', 'list_workers', 'message_lead', 'message_master']);
    assert.deepEqual(names(session('other')), ['list_capabilities', 'list_repos', 'list_workers', 'message_master']);

    const lead = workerPrompt(cfg, post('sous-chef-lbc'), undefined, groupInfo(cfg, cfg.groups, null));
    assert.match(lead, /You lead the group "lbc" \(hub-openai-lbc1\)/);
    const member = workerPrompt(cfg, post('openai-lbc1'), undefined, groupInfo(cfg, [], cfg.groups[0]));
    assert.match(member, /led by "hub-sous-chef-lbc"/);
    assert.match(member, /message_lead/);
  } finally {
    done();
  }
});

test('a lead reaches its members only; their report comes back to it, a later master message takes it back', async () => {
  const { cfg, inner, post, session, done } = await hub();
  try {
    inner.groupAsked(null, { name: 'lbc', lead: 'sous-chef-lbc', members: ['openai-lbc1'] });
    const lead = session('sous-chef-lbc');
    const member = session('openai-lbc1');
    await assert.rejects(inner.messageWorker({ name: 'hub-other', message: 'go' }, lead), /not a member of your group/);
    await assert.rejects(inner.workerReport('hub-other', lead), /not a member of your group/);
    const listed = inner.listWorkers(lead);
    assert.match(listed, /hub-openai-lbc1/);
    assert.doesNotMatch(listed, /hub-other ·/);
    assert.match(listed, /1 other worker\(s\) outside your group/);

    await inner.messageWorker({ name: 'openai-lbc1', message: 'Search the LBC ads' }, lead);
    assert.equal(member.reportTo, lead.id);
    assert.equal(member.owesReport, true);
    assert.equal(lastPeer(member)?.from, 'hub-sous-chef-lbc');

    assert.match(inner.messageLead(member, 'Found 3 ads'), /Delivered to your lead hub-sous-chef-lbc/);
    assert.equal(member.owesReport, false);
    assert.deepEqual([lastPeer(lead)?.from, lastPeer(lead)?.text], ['hub-openai-lbc1', 'Found 3 ads']);

    // The master keeps the hand on everyone: its own message makes the report its own again.
    await inner.messageWorker({ name: 'openai-lbc1', message: 'Stop' });
    assert.equal(member.reportTo, null);
    assert.match(inner.listWorkers(), /group lbc · lead hub-sous-chef-lbc/);

    // The lead's post deleted: the group goes, the member reports to the master.
    lead.status = 'exited';
    lead.inbox = null;
    assert.ok(inner.deleteRole(post('sous-chef-lbc').id));
    assert.deepEqual(cfg.groups, []);
    assert.throws(() => inner.messageLead(member, 'hello?'), /not in a group/);
  } finally {
    done();
  }
});

test('a group refuses a worker that does not exist, a lead among its members, a member of another group', async () => {
  const { inner, done } = await hub();
  try {
    assert.throws(() => inner.groupAsked(null, { name: 'x', lead: 'nobody', members: ['other'] }), /No post nor ad-hoc worker named "nobody"/);
    assert.throws(() => inner.groupAsked(null, { name: 'x', lead: 'other', members: ['other'] }), /cannot hold the lead itself/);
    inner.groupAsked(null, { name: 'lbc', lead: 'sous-chef-lbc', members: ['openai-lbc1'] });
    assert.throws(() => inner.groupAsked(null, { name: 'y', lead: 'other', members: ['openai-lbc1'] }), /already in another group/);
  } finally {
    done();
  }
});
