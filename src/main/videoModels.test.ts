import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Account } from '../shared/types';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { SessionManager } from './sessions';
import { VideoService } from './video/service';

// A provider's video models make videos through the hub's tools. They are never among the models a session runs:
// not in the menus, not for a post, whatever list they got into.

const VENICE = 'a-ven00001';
const LISTED = { data: [{ id: 'wan-2.5-preview-text-to-video', type: 'video', model_spec: { name: 'Wan 2.5', constraints: { model_type: 'text-to-video', durations: ['5s'] } } }] };

interface Inner {
  sessions: Map<string, { name: string }>;
  providerBadges(): { id: string; models: { value: string }[] }[];
  modelsFor(account: string, asked: string): { allowed: string[]; model: string; listed: boolean };
  hubTools(s: unknown): { name: string; handler(args: unknown, extra?: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> }[];
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  listRoles(): string;
}

async function hub(withVideo = true) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-video-models-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  const venice: Account = { id: VENICE, kind: 'openai', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', model: 'venice-uncensored', smallModel: '', slug: 'venice', models: ['venice-uncensored', 'llama-3.3-70b'], videoModels: ['my-video'], isolated: false };
  cfg.accounts = [venice];
  const asked: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(JSON.stringify(LISTED), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const video = new VideoService({ accounts: () => cfg.accounts, key: () => 'fake-video-key-0123456789', outDir: () => join(dir, 'videos'), fetch });
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
    ...(withVideo ? { video } : {}),
  });
  await video.refresh(venice);
  m.setProviderStates({ venice: { connected: true, accountId: VENICE, method: 'apikey' } });
  // The worst case: a list of session models that video models got into (an older save, a provider that mixes them).
  m.setCatalog(VENICE, ['venice-uncensored', 'wan-2.5-preview-text-to-video', 'llama-3.3-70b', 'My-Video'].map((value) => ({ value, displayName: value, description: '', efforts: [] })));
  return { cfg, work, inner: m as unknown as Inner, asked, done: () => (m.killAll(), rmSync(dir, { recursive: true, force: true })) };
}

const signal = new AbortController().signal;

test('a video model is offered for no session: not in the provider’s models, not for a post', async () => {
  const { inner, work, done } = await hub();
  try {
    // What the composer's menu and the post editor show of the provider, and what spawn_worker may be given.
    assert.deepEqual(inner.providerBadges().find((p) => p.id === 'venice')?.models.map((x) => x.value), ['venice-uncensored', 'llama-3.3-70b']);
    assert.deepEqual(inner.modelsFor(VENICE, 'wan-2.5-preview-text-to-video'), { allowed: ['venice-uncensored', 'llama-3.3-70b'], model: 'wan-2.5-preview-text-to-video', listed: false });
    // Listed by the provider, or named by hand: a post cannot run on either.
    for (const model of ['wan-2.5-preview-text-to-video', 'my-video']) {
      await assert.rejects(inner.createRole({ name: `clip-${model.length}`, description: 'x', folders: [work], provider: 'venice', model }, signal), (err: Error) => err.message.includes(model) && !/Allowed models:.*video/i.test(err.message));
    }
    assert.match(await inner.createRole({ name: 'writer', description: 'Writes', folders: [work], provider: 'venice', model: 'llama-3.3-70b' }, signal), /provider venice · model llama-3\.3-70b/);
  } finally {
    done();
  }
});

test('the master and the workers get the video tools; they answer from the provider’s video models', async () => {
  const { inner, work, done } = await hub();
  try {
    await inner.createRole({ name: 'writer', description: 'Writes', folders: [work], provider: 'venice', model: 'llama-3.3-70b' }, signal);
    const worker = [...inner.sessions.values()].find((s) => s.name === 'hub-writer');
    assert.ok(worker);
    const tools = inner.hubTools(worker);
    const names = tools.map((x) => x.name);
    assert.ok(names.includes('generate_video') && names.includes('list_video_models'), names.join(' '));
    const list = await (tools.find((x) => x.name === 'list_video_models') as (typeof tools)[number]).handler({});
    assert.deepEqual(list.content[0].text.split('\n'), ['venice (Venice) · 2 video models', 'wan-2.5-preview-text-to-video · Wan 2.5 · text→video · 5s', 'my-video · named by hand']);
    // A session model is no video model: the tool refuses it the other way round.
    const refused = await (tools.find((x) => x.name === 'generate_video') as (typeof tools)[number]).handler({ prompt: 'a fox', model: 'llama-3.3-70b' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Unknown video model "llama-3\.3-70b"/);
  } finally {
    done();
  }
});

test('without the video service, nothing changes: the tools are not there, the lists are as before', async () => {
  const { inner, work, done } = await hub(false);
  try {
    await inner.createRole({ name: 'writer', description: 'Writes', folders: [work], provider: 'venice', model: 'llama-3.3-70b' }, signal);
    const worker = [...inner.sessions.values()].find((s) => s.name === 'hub-writer');
    assert.ok(!inner.hubTools(worker).some((x) => /video/.test(x.name)));
    // The ones named by hand are kept out even then: the account itself says they are video models.
    assert.deepEqual(inner.providerBadges().find((p) => p.id === 'venice')?.models.map((x) => x.value), ['venice-uncensored', 'wan-2.5-preview-text-to-video', 'llama-3.3-70b']);
  } finally {
    done();
  }
});
