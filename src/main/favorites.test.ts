import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { modelsText } from '../shared/favorites';
import type { ProviderBadge } from '../shared/types';
import { applyPatch, loadConfig } from './config';
import type { CostLog } from './costLog';
import type { McpHub } from './mcpHub';
import { rosterBlock } from './prompts';
import { SessionManager } from './sessions';

// Favourite models: the stars of Settings › Providers reach the composer's Favourites tab (the snapshot's providers),
// the master (its roster, list_capabilities, the models it may run a worker on), and a pick there moves the
// conversation to the provider with its conversation, the way the provider tabs already do.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internal = any;
const VENICE = 'a-ven00001';
const never = () => new Promise<never>(() => undefined);
const processStub = () => ({ close: () => undefined, interrupt: async () => undefined, setModel: async () => undefined, context: never, totals: never, rateLimits: never });
const claudeModel = (value: string, displayName: string) => ({ value, displayName, description: '', efforts: [] });

function hub() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-favorites-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  cfg.workerModels = ['opus', 'sonnet'];
  cfg.favoriteModels = { anthropic: ['haiku'] };
  cfg.accounts = [{ id: VENICE, kind: 'openai', name: 'Venice', baseUrl: 'https://api.venice.ai/api/v1', model: 'venice-uncensored', smallModel: '', slug: 'venice', models: ['venice-uncensored', 'llama-3.3-70b'], isolated: false }];
  const m = new SessionManager({
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
  });
  const inner: Internal = m;
  inner.modelInfos = [claudeModel('default', 'Default'), claudeModel('opus', 'Opus'), claudeModel('sonnet', 'Sonnet'), claudeModel('haiku', 'Haiku')];
  m.setProviderStates({ anthropic: { connected: true, accountId: 'default', method: 'cli' }, venice: { connected: true, accountId: VENICE, method: 'apikey' } });
  m.setCatalog(VENICE, ['venice-uncensored', 'llama-3.3-70b'].map((value) => ({ value, displayName: value, description: '', efforts: [] })));
  const launches: { id: string; resume: boolean }[] = [];
  inner.launch = async (s: Internal, resume: boolean) => {
    launches.push({ id: s.id, resume });
  };
  return { cfg, dir, work, m, inner, launches, done: () => (m.killAll(), rmSync(dir, { recursive: true, force: true })) };
}

const provider = (m: SessionManager, id: string) => m.snapshot().providers.find((p: ProviderBadge) => p.id === id);

test("the snapshot's providers carry the favourites: a built-in one's from the settings, the chosen models of one the user added", () => {
  const { m, done } = hub();
  try {
    assert.deepEqual(provider(m, 'anthropic')?.favorites, ['haiku']);
    assert.deepEqual(provider(m, 'venice')?.favorites, ['venice-uncensored', 'llama-3.3-70b']);
    assert.deepEqual(provider(m, 'gemini')?.favorites, []);
  } finally {
    done();
  }
});

test('the master knows the favourites: starred in its roster and list_capabilities, and it may run a worker on one', () => {
  const { cfg, m, inner, done } = hub();
  try {
    m.favoritesChanged();
    const roster = rosterBlock(cfg, 'en');
    assert.match(roster, /Providers \(★: the user's favourite\)/);
    assert.match(roster, /anthropic \(Anthropic · connected · models: opus, sonnet, haiku★\)/, 'a Claude favourite is one the master may pick, beside the allowed ones');
    assert.match(roster, /venice \(Venice · connected · models: venice-uncensored, llama-3\.3-70b\)/, 'the models chosen for a provider the user added: all favourites, none starred');
    assert.match(modelsText(inner.providerLines()), /- anthropic \(Anthropic\): opus, sonnet, haiku★/);
    assert.deepEqual(inner.modelsFor('default', 'haiku'), { allowed: ['opus', 'sonnet', 'haiku'], model: 'haiku', listed: true });
    // Its star taken off: the master is told again, and may no longer pick it.
    cfg.favoriteModels = {};
    m.favoritesChanged();
    assert.doesNotMatch(rosterBlock(cfg, 'en'), /haiku|★/);
    assert.equal(inner.modelsFor('default', 'haiku').listed, false);
  } finally {
    done();
  }
});

test('a favourite of another provider picked in a conversation moves it there with its conversation: now when idle, after the turn when busy, at the next start when asleep', () => {
  const { work, m, inner, launches, done } = hub();
  try {
    const idle = inner.create('w-idle', 'worker', 'hub-idle', 'TASK', work, '', null);
    Object.assign(idle, { started: true, status: 'idle', query: processStub(), runAccount: 'default', inbox: inner.deliveryInbox(idle) });
    m.setProviderModel('w-idle', 'venice', 'llama-3.3-70b');
    assert.equal(idle.accountId, VENICE);
    assert.equal(idle.model, 'llama-3.3-70b');
    assert.equal(idle.userModel, true, "the user's pick: the master's later choices leave it alone");
    assert.deepEqual(launches, [{ id: 'w-idle', resume: true }], 'started again on the same conversation');

    const busy = inner.create('w-busy', 'worker', 'hub-busy', 'TASK', work, '', null);
    Object.assign(busy, { started: true, status: 'busy', query: processStub(), runAccount: 'default', inbox: inner.deliveryInbox(busy) });
    m.setProviderModel('w-busy', 'venice', 'venice-uncensored');
    assert.equal(busy.switchPending, true, 'its turn is never cut');
    assert.equal(launches.length, 1);

    const asleep = inner.create('w-asleep', 'worker', 'hub-asleep', 'TASK', work, '', null);
    m.setProviderModel('w-asleep', 'venice', 'llama-3.3-70b');
    assert.equal(asleep.accountId, VENICE);
    assert.equal(launches.length, 1, 'nothing starts: the account is the one its next start runs on');

    // A favourite of the provider it is on: the model changes in place, no restart.
    m.setProviderModel('w-idle', 'venice', 'venice-uncensored');
    assert.equal(idle.model, 'venice-uncensored');
    assert.equal(launches.length, 1);

    // One of a provider no longer connected (a menu drawn before it was disconnected): nothing moves, the user is told.
    m.setProviderModel('w-idle', 'gemini', 'gemini-3-pro');
    assert.equal(idle.accountId, VENICE);
    const notice = [...idle.items.values()].at(-1);
    assert.equal(notice.kind, 'notice');
    assert.equal(notice.action, 'accounts-settings');
    assert.match(notice.text, /^Gemini is not connected: connect it in Settings › Providers/);
  } finally {
    done();
  }
});

test('favourites are read provider by provider from the settings file, and no settings patch changes them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-favorites-cfg-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 2, favoriteModels: { anthropic: ['haiku', 'opus[1m]'], venice: ['llama'], gemini: ['two words'] } }));
    const cfg = loadConfig(dir, 'en');
    assert.deepEqual(cfg.favoriteModels, { anthropic: ['haiku', 'opus[1m]'] });
    assert.equal(applyPatch(cfg, { favoriteModels: { anthropic: [] } } as never), null);
    assert.deepEqual(cfg.favoriteModels, { anthropic: ['haiku', 'opus[1m]'] }, 'only the star (setFavorite) changes them');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pick back on the provider it runs on cancels a move still waiting for the turn to end', () => {
  const { work, m, inner, launches, done } = hub();
  try {
    const busy = inner.create('w-busy', 'worker', 'hub-busy', 'TASK', work, '', null);
    Object.assign(busy, { started: true, status: 'busy', query: processStub(), runAccount: 'default', inbox: inner.deliveryInbox(busy) });
    m.setProviderModel('w-busy', 'venice', 'llama-3.3-70b');
    assert.equal(busy.switchPending, true);
    m.setProviderModel('w-busy', 'anthropic', 'haiku');
    assert.equal(busy.switchPending, false, 'no move to Venice once the turn ends');
    assert.equal(busy.accountId, 'default');
    assert.equal(busy.model, 'haiku');
    assert.deepEqual(launches, []);
  } finally {
    done();
  }
});

test("the master's star copied into a model name is no part of it", () => {
  const { inner, done } = hub();
  try {
    assert.equal(inner.modelsFor('default', 'haiku★').model, 'haiku');
    assert.equal(inner.modelsFor('default', 'haiku★').listed, true);
  } finally {
    done();
  }
});
