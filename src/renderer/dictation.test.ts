import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright-core';

// The composer's real code in the built app, isolated as `npm run ui` is, with a fake engine and microphone. What leaves
// the window is read where it arrives, in the main process. Waits are on facts, never on a delay: this runs under load.

const root = resolve('.');
const load = createRequire(join(root, 'package.json'));
const TIMEOUT_MS = 15_000;

let app: ElectronApplication;
let page: Page;
let dataDir = '';

interface Spy {
  sent: string[];
  stops: number;
  starts: number;
  cancels: number;
  permissionMs: number;
}
const spy = () => app.evaluate(() => (globalThis as unknown as { spy: Spy }).spy);
const delayPermission = (ms: number) => app.evaluate((_e, v) => void ((globalThis as unknown as { spy: Spy }).spy.permissionMs = v), ms);
const fromEngine = (event: unknown) => app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.send('dictation:event', e), event);
/** What the window sent before this has arrived: its messages travel in order. */
const flush = () => page.evaluate(() => (window as unknown as { hub: { getSettings(): Promise<unknown> } }).hub.getSettings());

const field = () => page.locator('.composer-input:visible').first();
const mic = () => page.locator('.cbtn-mic:visible').first();
const hasText = (text: string) => page.waitForFunction((want) => [...document.querySelectorAll('textarea')].some((t) => t.value === want), text);
const recording = () => page.waitForSelector('.cbtn-mic.recording', { state: 'attached' });
const composer = () =>
  page.evaluate(() => {
    const input = [...document.querySelectorAll<HTMLTextAreaElement>('.composer-input')].find((i) => i.offsetParent !== null) as HTMLTextAreaElement;
    const send = input.closest('.composer-box')?.querySelector('.send') as HTMLButtonElement;
    return { value: input.value, readOnly: input.readOnly, sendOff: send.disabled };
  });
async function until(fact: (s: Spy) => boolean): Promise<Spy> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const s = await spy();
    if (fact(s)) return s;
    assert.ok(Date.now() < deadline, `still not there: ${JSON.stringify(s)}`);
    await new Promise((r) => setImmediate(r));
  }
}

async function reload(available: boolean): Promise<void> {
  await app.evaluate(({ ipcMain }, on) => {
    ipcMain.removeHandler('dictation:support');
    ipcMain.handle('dictation:support', () => ({ available: on, installed: on }));
  }, available);
  await page.reload();
  await page.waitForSelector('.composer-input');
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
    return new Promise<void>((resolved) => {
      const hub = (window as unknown as { hub: { onSnapshot(cb: () => void): void; ready(): void } }).hub;
      hub.onSnapshot(() => resolved());
      hub.ready();
    });
  });
  await page.waitForFunction(() => document.querySelector('.cbtn-mic')?.getAttribute('aria-pressed') === 'false');
}

/** A draft, and a dictation that has said `partial`. */
async function dictating(draft: string, partial: string): Promise<{ stops: number }> {
  const { stops } = await spy();
  await field().click();
  await field().fill(draft);
  await mic().click();
  await recording();
  await fromEngine({ type: 'partial', text: partial });
  await hasText(`${draft} ${partial}`);
  return { stops };
}

const reset = async () => {
  await app.evaluate(() => void ((globalThis as unknown as { spy: Spy }).spy.sent = []));
  await field().fill('');
};

before(async () => {
  const { _electron } = load('playwright-core') as typeof import('playwright-core');
  dataDir = mkdtempSync(join(tmpdir(), 'hub-test-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarded: true, language: 'fr' }));
  const env = { ...process.env, AI_BOX_REBUILT: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: load('electron') as unknown as string, args: ['.', `--user-data-dir=${dataDir}`], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(TIMEOUT_MS);
  await page.waitForSelector('.composer-input', { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setPosition(-4000, -4000);
    const state: Spy = { sent: [], stops: 0, starts: 0, cancels: 0, permissionMs: 0 };
    (globalThis as unknown as { spy: Spy }).spy = state;
    ipcMain.removeAllListeners('session:send');
    ipcMain.on('session:send', (_e, _id: string, text: string) => state.sent.push(text));
    ipcMain.on('dictation:stop', () => state.stops++);
    ipcMain.on('dictation:cancel', () => state.cancels++);
    ipcMain.removeHandler('dictation:permission');
    ipcMain.handle('dictation:permission', () => new Promise((r) => setTimeout(() => r({ ok: true, error: '' }), state.permissionMs)));
    ipcMain.removeHandler('dictation:start');
    ipcMain.handle('dictation:start', () => {
      state.starts++;
      return { ok: true, error: '' };
    });
  });
});

after(async () => {
  const child = app?.process();
  await Promise.race([app?.close().catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
  child?.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

test('a machine without dictation shows no microphone, and the buttons around it stay', async () => {
  await reload(false);
  const shown = await page.evaluate(() => {
    const display = (sel: string) => getComputedStyle(document.querySelector(sel) as Element).display;
    const hiddenYetShown = [...document.querySelectorAll('[hidden]')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.className);
    return { mic: display('.cbtn-mic'), model: display('.cbtn-model'), slash: display('.cbtn-slash'), hiddenYetShown };
  });
  assert.deepEqual(shown, { mic: 'none', model: 'flex', slash: 'flex', hiddenYetShown: [] });
  await reload(true);
});

test('Enter ends the speech and sends nothing; once the text has settled, Enter sends it, once', async () => {
  const { stops } = await dictating('Bonjour', 'lance les tes');
  await field().press('Enter');
  await until((s) => s.stops === stops + 1);
  assert.deepEqual((await spy()).sent, []);
  assert.deepEqual(await composer(), { value: 'Bonjour lance les tes', readOnly: true, sendOff: true });
  await fromEngine({ type: 'final', text: 'lance les tests' });
  await hasText('Bonjour lance les tests');
  assert.deepEqual(await composer(), { value: 'Bonjour lance les tests', readOnly: false, sendOff: false });
  assert.deepEqual((await spy()).sent, [], 'the text waits in the composer');
  await field().press('Enter');
  await until((s) => s.sent.length > 0);
  assert.deepEqual((await spy()).sent, ['Bonjour lance les tests']);
  await reset();
});

test('the send button is off during a dictation', async () => {
  const { stops } = await dictating('Salut', 'mot');
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.send')].forEach((b) => b.click()));
  await flush();
  assert.deepEqual((await spy()).sent, []);
  assert.equal((await composer()).sendOff, true);
  await field().press('Enter');
  await until((s) => s.stops === stops + 1);
  await fromEngine({ type: 'final', text: 'mot' });
  await hasText('Salut mot');
  await reset();
});

test('an Enter held down does not send what has just settled', async () => {
  const { stops } = await dictating('Salut', 'mot');
  await page.keyboard.down('Enter');
  await until((s) => s.stops === stops + 1);
  await fromEngine({ type: 'final', text: 'mot juste' });
  await hasText('Salut mot juste');
  await page.keyboard.down('Enter'); // A second down without an up: the key's repeat.
  await flush();
  await page.keyboard.up('Enter');
  assert.deepEqual((await spy()).sent, []);
  assert.equal((await composer()).value, 'Salut mot juste');
  await reset();
});

test('the "/" button leaves the words being dictated alone, and Escape gives the draft back', async () => {
  await dictating('Salut', 'mot');
  await page.locator('.cbtn-slash:visible').first().click();
  assert.equal((await composer()).value, 'Salut mot');
  await page.keyboard.press('Escape');
  await hasText('Salut');
  assert.deepEqual(await composer(), { value: 'Salut', readOnly: false, sendOff: false });
  await reset();
});

test('a cancel while the dictation starts gives the field back at once, and the end of that start leaves it alone', async () => {
  const { starts, cancels } = await spy();
  await delayPermission(300);
  await field().fill('Brouillon A');
  await mic().click();
  await recording();
  await page.keyboard.press('Escape');
  assert.deepEqual(await composer(), { value: 'Brouillon A', readOnly: false, sendOff: false });
  // What the field shows now may be another conversation's.
  await field().fill('Brouillon B');
  await until((s) => s.starts === starts + 1 && s.cancels === cancels + 2);
  assert.deepEqual(await composer(), { value: 'Brouillon B', readOnly: false, sendOff: false });
  await delayPermission(0);
  await page.waitForFunction(() => !document.querySelector('.cbtn-mic.recording'));
  await reset();
  await dictating('Encore', 'une fois');
  await page.keyboard.press('Escape');
  await hasText('Encore');
  await reset();
});
