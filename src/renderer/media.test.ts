import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import type { ElectronApplication } from 'playwright-core';

/** Its own Electron, always ended: closed if it answers within 5 s, else its process tree killed by the PID it got. */
async function end(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  const proc = app.process();
  await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 5_000))]);
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  } catch {
    // Already gone between the check and the kill.
  }
}

const within = <T>(ms: number, work: Promise<T>) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`UI test stuck for ${ms / 1000} s`)), ms).unref())]);

/** A real 2×2 grey PNG: the page decodes it, so its card proves the scheme, its handler and the CSP together. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([head, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0; // no filter
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(2, 2);

test('media in messages: shown through main, by range, saved through main; broken and outside links stay links', { timeout: 120_000 }, async () => {
  const root = resolve('.');
  const load = createRequire(join(root, 'package.json'));
  const data = mkdtempSync(join(tmpdir(), 'hub-media-ui-'));
  const workspace = join(data, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'shot.png'), PNG);
  const clip = Buffer.alloc(64 * 1024, 7);
  writeFileSync(join(workspace, 'clip.mp4'), clip);
  writeFileSync(join(data, 'outside.png'), PNG);
  const saved = join(data, 'saved.png');
  writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 2, onboarded: true, language: 'fr', workspaces: [workspace], claudePath: '/usr/bin/false' }));
  const env = { ...process.env, HOME: data, CODEX_HOME: join(data, 'codex'), CLAUDE_CONFIG_DIR: join(data, 'claude'), AI_BOX_REBUILT: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  let launching: Promise<ElectronApplication> | undefined;
  try {
    await within(90_000, (async () => {
      launching = (load('playwright-core') as typeof import('playwright-core'))._electron.launch({ executablePath: load('electron') as unknown as string, args: ['scripts/ui-entry.cjs', `--user-data-dir=${data}`], cwd: root, env, timeout: 30_000 });
      app = await launching;
      const page = await app.firstWindow();
      page.setDefaultTimeout(10_000);
      await page.waitForSelector('.composer-input');
      await app.evaluate(({ BrowserWindow, dialog, shell }, saved) => {
        BrowserWindow.getAllWindows()[0].setPosition(-4000, -4000);
        const calls: string[] = [];
        (globalThis as unknown as { mediaCalls: string[] }).mediaCalls = calls;
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: saved })) as typeof dialog.showSaveDialog;
        shell.showItemInFolder = (path) => { calls.push(path); };
      }, saved);
      await page.keyboard.press('Escape');
      const text = [
        '![Capture](shot.png)',
        '[clip.mp4](clip.mp4)',
        'Un ancien rendu : [gone.mp4](gone.mp4)',
        '[Hors du dossier](../outside.png)',
        'https://example.com/a/photo.png',
      ].join('\n\n');
      await app.evaluate(({ BrowserWindow }, text) => {
        BrowserWindow.getAllWindows()[0].webContents.send('hub:items', 'master', [{ id: 'media-final', kind: 'assistant', live: false, text }], true);
      }, text);
      const msg = page.locator('.msg-assistant');
      await msg.locator('figure.media-image img').waitFor();
      // Decoded: the scheme, its handler and the page's CSP let the image through.
      await page.waitForFunction(() => (document.querySelector('figure.media-image img') as HTMLImageElement | null)?.naturalWidth === 2);
      // Bytes that are no video: the card stays, says so, and keeps its buttons.
      await msg.locator('figure.media-video .media-broken').waitFor();
      assert.equal(await msg.locator('figure.media-video .media-bar button').count(), 2);
      // A missing file and a file outside the allowed folders stay plain links; the web image waits for a click.
      assert.deepEqual(await msg.locator('a').allTextContents(), ['gone.mp4', 'Hors du dossier']);
      assert.equal(await msg.locator('.media-remote').count(), 1);
      assert.equal(await msg.locator('.media').count(), 3);
      // The video's URL is served by range by the main process.
      const url = await page.evaluate(async () => {
        const r = await (window as unknown as { hub: import('../shared/types').HubApi }).hub.resolveMedia('master', 'clip.mp4');
        return r.ok ? r.url : '';
      });
      assert.match(url, /^aibox-media:\/\/m\/[0-9a-f]{32}$/);
      const ranged = await app.evaluate(async ({ net }, url) => {
        const res = await net.fetch(url, { headers: { Range: 'bytes=10-19' } });
        return [res.status, res.headers.get('content-range'), (await res.arrayBuffer()).byteLength];
      }, url);
      assert.deepEqual(ranged, [206, `bytes 10-19/${clip.length}`, 10]);
      // "Download" copies the file where the save dialog says; "Open folder" reveals the checked file.
      await msg.locator('figure.media-image .media-bar button').first().click();
      await page.waitForFunction(() => document.querySelector('figure.media-image .media-bar button')?.textContent === 'Enregistré');
      assert.ok(existsSync(saved) && readFileSync(saved).equals(PNG));
      await msg.locator('figure.media-video .media-bar button').nth(1).click();
      let calls: string[] = [];
      for (let i = 0; i < 50 && calls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        calls = await app.evaluate(() => (globalThis as unknown as { mediaCalls: string[] }).mediaCalls);
      }
      assert.deepEqual(calls, [realpathSync(join(workspace, 'clip.mp4'))]);
      // The renderer cannot name a file itself: an outside path, a "..", an unknown session are refused by main.
      const refused = await page.evaluate(async () => {
        const hub = (window as unknown as { hub: import('../shared/types').HubApi }).hub;
        return [await hub.resolveMedia('master', '../outside.png'), await hub.resolveMedia('unknown', 'shot.png'), await hub.saveMedia('aibox-media://m/0123')];
      });
      assert.deepEqual(refused, [{ ok: false, error: 'outside' }, { ok: false, error: 'invalid' }, { ok: false, error: 'missing' }]);
    })());
  } finally {
    await end(app ?? (await launching?.catch(() => undefined)));
    rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
