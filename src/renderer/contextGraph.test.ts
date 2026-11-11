import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright-core';
import type { ContextGraphStatus } from '../shared/contextGraph';
import type { HubApi, HubSnapshot, SessionView } from '../shared/types';

// Real settings and preload in an isolated app. Only graph IPC replies and synthetic sessions are replaced.
const root = resolve('.');
const load = createRequire(join(root, 'package.json'));
let app: ElectronApplication;
let page: Page;
let dataDir = '';
interface GraphSpy {
  status: ContextGraphStatus;
  calls: { action: string; id: string; enabled?: boolean }[];
  hold: string;
  fail: string;
  release: (() => void)[];
  downloads: string[];
}
declare global {
  interface Window {
    contextTestSnapshot: HubSnapshot;
    contextDownloads: unknown[];
  }
}
const fixture: SessionView = {
  id: 'fixture-master', role: 'master', post: null, instance: null, group: null, leads: [], tree: null,
  name: 'fixture-master', mission: '', cwd: '/tmp/context-fixture', model: '', modelLabel: '', effort: null,
  mode: null, status: 'idle', lastMessage: '', metrics: null, createdAt: 0, busySince: null, background: [],
  idleSince: null, agents: 0, compacting: false, retrying: false, limit: null, tool: null, approvedAt: null,
  pulse: { signalAt: null, tokens: 0, estimated: false }, modelStreams: true, error: '', account: 'default',
  fallbackFrom: '', accountPending: false, userAccount: false, ultracode: false, ultracodeAccess: 'hidden',
};
const initial: ContextGraphStatus = {
  state: 'disabled', enabled: false, workspaceId: 'PRIVATE_WORKSPACE', sessionId: 'PRIVATE_SESSION',
  countsAvailable: false, counts: { nodes: 9261, edges: 9262, archivedNodes: 9263, archivedEdges: 9264 },
  limits: { nodes: 10000, edges: 20000, bytes: 1000000, retrievalNodes: 20, retrievalEdges: 40 },
  lastProvenance: { origin: 'worker', reference: 'PRIVATE_REFERENCE', at: 1_700_000_000_000 }, error: null,
};
const action = (id: string) => page.locator(`[data-context-action="${id}"]`);
const panel = () => page.locator('.context-graph');
const state = () => page.locator('.context-state .setup-label');
const spy = () => app.evaluate(() => {
  const { calls, hold, fail, status, downloads } = (globalThis as unknown as { graphSpy: GraphSpy }).graphSpy;
  return { calls, hold, fail, status, downloads };
});
async function configure(status: ContextGraphStatus = initial, options: { hold?: string; fail?: string } = {}): Promise<void> {
  await app.evaluate((_e, value) => {
    const s = (globalThis as unknown as { graphSpy: GraphSpy }).graphSpy;
    s.status = value.status;
    s.hold = value.hold;
    s.fail = value.fail;
    s.calls = [];
  }, { status, hold: options.hold ?? '', fail: options.fail ?? '' });
}
async function sessions(ids: string[]): Promise<void> {
  const base = await page.evaluate(() => window.contextTestSnapshot);
  await app.evaluate(({ BrowserWindow }, snapshot) => {
    (globalThis as unknown as { contextFixtureSnapshot: HubSnapshot }).contextFixtureSnapshot = snapshot;
    BrowserWindow.getAllWindows()[0].webContents.send('hub:snapshot', snapshot);
  }, { ...base, sessions: ids.map((id) => ({ ...fixture, id })) });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
async function open(ids = ['fixture-master']): Promise<void> {
  if (await page.locator('#setup').isVisible()) await page.keyboard.press('Escape');
  await sessions(ids);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('hub:open-settings', { detail: 'general' })));
  await page.locator('.setup-nav-item', { hasText: 'Contexte du projet' }).click();
  await panel().waitFor();
  await page.waitForFunction(() => document.querySelector('.context-graph')?.getAttribute('aria-busy') === 'false');
}
async function release(): Promise<void> {
  await app.evaluate(() => {
    const s = (globalThis as unknown as { graphSpy: GraphSpy }).graphSpy;
    s.hold = '';
    s.release.splice(0).forEach((resolve) => resolve());
  });
}
async function waitCalls(n: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await spy()).calls.length >= n) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Expected ${n} IPC calls`);
}

before(async () => {
  const { _electron } = load('playwright-core') as typeof import('playwright-core');
  dataDir = mkdtempSync(join(tmpdir(), 'hub-context-test-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarded: true, language: 'fr' }));
  const env = { ...process.env, AI_BOX_REBUILT: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: load('electron') as unknown as string, args: ['scripts/ui-entry.cjs', `--user-data-dir=${dataDir}`], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForSelector('.composer-input', { timeout: 30_000 });
  await page.locator('.notes-foot button').click();
  await page.locator('.notes-overlay').waitFor({ state: 'detached' });
  await page.evaluate(() => new Promise<void>((done) => {
    const hub = (window as unknown as { hub: HubApi }).hub;
    hub.onSnapshot((s) => { window.contextTestSnapshot = s; done(); });
    hub.ready();
  }));
  await page.evaluate(() => {
    window.contextDownloads = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob instanceof Blob && blob.type === 'application/json') {
        void blob.text().then((text) => window.contextDownloads.push(JSON.parse(text)));
      }
      return create(blob);
    };
  });
  await app.evaluate(({ BrowserWindow, ipcMain }, { status, snapshot }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setPosition(-4000, -4000);
    // Main can still emit startup snapshots; keep every test on its explicit synthetic sessions.
    const globals = globalThis as unknown as { contextFixtureSnapshot: HubSnapshot };
    globals.contextFixtureSnapshot = snapshot;
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => send(channel, ...(channel === 'hub:snapshot' ? [globals.contextFixtureSnapshot] : args));
    const s: GraphSpy = { status, calls: [], hold: '', fail: '', release: [], downloads: [] };
    // Exercise the real download event, but never create a file in the user's Downloads folder.
    BrowserWindow.getAllWindows()[0].webContents.session.on('will-download', (event, item) => {
      s.downloads.push(item.getFilename());
      event.preventDefault();
    });
    (globalThis as unknown as { graphSpy: GraphSpy }).graphSpy = s;
    for (const action of ['status', 'set-enabled', 'export-snapshot', 'purge']) {
      ipcMain.removeHandler(`context-graph:${action}`);
      ipcMain.handle(`context-graph:${action}`, async (_event, id: string, enabled?: boolean) => {
        s.calls.push({ action, id, ...(enabled === undefined ? {} : { enabled }) });
        // Capture the reply at request time to exercise genuinely obsolete responses.
        let result = structuredClone(s.status);
        if (action === 'set-enabled') result = { ...result, enabled: enabled!, state: enabled ? 'enabled' : 'disabled' };
        if (action === 'purge') result.counts = { nodes: 0, edges: 0, archivedNodes: 0, archivedEdges: 0 };
        const fail = s.fail === action;
        if (s.hold === action) await new Promise<void>((resolve) => s.release.push(resolve));
        if (fail) throw new Error('PRIVATE_PATH /tmp/private-conversation SECRET_TOKEN');
        return action === 'export-snapshot' ? { status: result, snapshot: { schemaVersion: 1, nodes: [], edges: [] } } : result;
      });
    }
  }, { status: initial, snapshot: await page.evaluate(() => window.contextTestSnapshot) });
});

after(async () => {
  const child = app?.process();
  await Promise.race([app?.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5000))]);
  child?.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

test('missing session sends no IPC; disabled state hides unavailable counts and all opaque references', async () => {
  await configure();
  await open([]);
  assert.equal(await state().textContent(), 'Aucune session actuelle');
  assert.equal((await spy()).calls.length, 0);
  await sessions(['fixture-master']);
  await action('toggle').waitFor();
  assert.equal(await state().textContent(), 'Désactivé');
  assert.equal(await action('toggle').isChecked(), false);
  const text = await panel().textContent();
  assert.match(text!, /Non disponibles/);
  assert.doesNotMatch(text!, /PRIVATE_|926[1-4]|\/tmp/);
  assert.match(text!, /10\s?000/);
  assert.deepEqual((await spy()).calls, [{ action: 'status', id: 'fixture-master' }]);
});

test('opt-in is explicit and every graph control is disabled during IPC; duplicate clicks invoke once', async () => {
  await configure(initial, { hold: 'set-enabled' });
  await open();
  await action('toggle').evaluate((el) => {
    (el as HTMLInputElement).click();
    (el as HTMLInputElement).click();
  });
  await waitCalls(2);
  assert.equal(await panel().getAttribute('aria-busy'), 'true');
  assert.equal(await panel().locator('button:enabled, input:enabled').count(), 0);
  assert.deepEqual((await spy()).calls.filter((c) => c.action === 'set-enabled'), [{ action: 'set-enabled', id: 'fixture-master', enabled: true }]);
  await release();
  await page.waitForFunction(() => document.querySelector('.context-state .setup-label')?.textContent === 'Activé');
  assert.equal(await action('toggle').isChecked(), true);
});

test('export downloads only the snapshot with a fixed filename and leaves graph activation unchanged', async () => {
  await configure();
  await open();
  await action('export').click();
  await page.waitForFunction(() => window.contextDownloads.length === 1);
  assert.deepEqual(await page.evaluate(() => window.contextDownloads[0]), { schemaVersion: 1, nodes: [], edges: [] });
  const deadline = Date.now() + 15_000;
  while ((await spy()).downloads.length === 0 && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await spy()).downloads, ['context-graph-snapshot.json']);
  assert.equal(await action('toggle').isChecked(), false);
  assert.deepEqual((await spy()).calls.map((c) => c.action), ['status', 'export-snapshot']);
  assert.match((await panel().textContent())!, /Téléchargement/);
});

test('purge requires a separate confirmation, cancellation restores focus, and double confirmation invokes once', async () => {
  await configure({ ...initial, countsAvailable: true }, { hold: 'purge' });
  await open();
  await action('purge').click();
  assert.equal((await spy()).calls.filter((c) => c.action === 'purge').length, 0);
  assert.equal(await action('cancel').evaluate((el) => el === document.activeElement), true);
  await action('cancel').click();
  assert.equal(await action('confirm').count(), 0);
  assert.equal(await action('purge').evaluate((el) => el === document.activeElement), true);
  await action('purge').click();
  await action('confirm').evaluate((el) => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
  await waitCalls(2);
  assert.equal((await spy()).calls.filter((c) => c.action === 'purge').length, 1);
  await release();
  await page.waitForFunction(() => document.querySelector('.context-note')?.textContent?.includes('a été effacé'));
  assert.equal(await action('toggle').isChecked(), false);
  assert.doesNotMatch((await panel().textContent())!, /926[1-4]/);
});

test('unavailable storage offers a safe French error and no export or enable, while quota failure allows confirmed purge', async () => {
  await configure({ ...initial, state: 'unavailable', error: 'sqlite-unavailable' });
  await open();
  assert.equal(await state().textContent(), 'Indisponible');
  assert.equal(await action('toggle').isDisabled(), true);
  assert.equal(await action('export').isDisabled(), true);
  assert.equal(await action('purge').isDisabled(), true);
  assert.match((await panel().textContent())!, /Mets l’app à jour/);
  await configure({ ...initial, enabled: true, state: 'unavailable', error: 'quota-exceeded' });
  await action('refresh').click();
  await page.waitForFunction(() => document.querySelector('.context-note')?.textContent?.includes('atteint sa limite'));
  assert.equal(await action('toggle').isDisabled(), false);
  assert.equal(await action('purge').isDisabled(), false);
});

test('an IPC rejection never exposes its message and requires a fresh status before another mutation', async () => {
  await configure(initial, { fail: 'export-snapshot' });
  await open();
  await action('export').click();
  await page.waitForSelector('.context-note[role="alert"]');
  assert.doesNotMatch((await panel().textContent())!, /PRIVATE_|SECRET|\/tmp/);
  assert.match((await panel().textContent())!, /Actualise l’état/);
  assert.equal(await action('export').isDisabled(), true);
  await configure(initial);
  await action('refresh').click();
  await action('toggle').waitFor();
  assert.equal(await action('export').isDisabled(), false);
});

test('replacing or removing the master invalidates in-flight replies and purge confirmations', async () => {
  await configure();
  await open();
  await action('purge').click();
  await configure({ ...initial, countsAvailable: true, counts: { ...initial.counts, nodes: 71 } }, { hold: 'status' });
  await action('refresh').click();
  await waitCalls(1);
  await configure({ ...initial, countsAvailable: true, counts: { ...initial.counts, nodes: 42 } });
  await sessions(['replacement-master']);
  await page.waitForFunction(() => document.querySelector('.context-details')?.textContent?.includes('42'));
  await release();
  assert.equal(await action('confirm').count(), 0);
  assert.doesNotMatch((await panel().textContent())!, /71/);
  assert.deepEqual((await spy()).calls, [{ action: 'status', id: 'replacement-master' }]);
  await configure(initial, { hold: 'set-enabled' });
  await action('toggle').click();
  await waitCalls(1);
  await sessions([]);
  await release();
  assert.equal(await state().textContent(), 'Aucune session actuelle');
  assert.equal(await action('toggle').count(), 0);
});

test('leaving settings drops an in-flight export and the panel works with English labels and keyboard focus', async () => {
  await configure(initial, { hold: 'export-snapshot' });
  await open();
  const downloadsBefore = await page.evaluate(() => window.contextDownloads.length);
  await action('export').click();
  await waitCalls(2);
  await page.keyboard.press('Escape');
  await release();
  assert.equal(await page.evaluate(() => window.contextDownloads.length), downloadsBefore);
  // Language is selected when the renderer is loaded; no real preferences are changed.
  const url = new URL(page.url());
  url.searchParams.set('lang', 'en');
  await page.goto(url.toString());
  await page.waitForSelector('.composer-input');
  await page.evaluate(() => new Promise<void>((done) => {
    const hub = (window as unknown as { hub: HubApi }).hub;
    hub.onSnapshot((s) => { window.contextTestSnapshot = s; done(); });
    hub.ready();
  }));
  await configure({ ...initial, state: 'unavailable', error: 'storage-error' });
  await sessions(['english-master']);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('hub:open-settings', { detail: 'general' })));
  await page.locator('.setup-nav-item', { hasText: 'Project context' }).click();
  await page.waitForSelector('.context-note[role="alert"]');
  assert.equal(await state().textContent(), 'Unavailable');
  assert.match((await panel().textContent())!, /Check available disk space/);
  await action('refresh').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#setup').evaluate((el) => el.contains(document.activeElement)), true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(780, 620));
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const overflow = await panel().evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>('*')].filter((child) => {
      if (child.offsetParent === null) return false;
      const box = child.getBoundingClientRect();
      return box.left < bounds.left - 1 || box.right > bounds.right + 1;
    }).map((child) => child.tagName);
  });
  assert.deepEqual(overflow, []);
  await panel().screenshot({ path: '/tmp/context-graph-settings-narrow.png', scale: 'css' });
});
