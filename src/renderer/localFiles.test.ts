import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication } from 'playwright-core';
import type { HubApi } from '../shared/types';

test('final-message local links use the real preload/IPC with workspace validation', { timeout: 60_000 }, async () => {
  const root = resolve('.');
  const load = createRequire(join(root, 'package.json'));
  const data = mkdtempSync(join(tmpdir(), 'hub-files-ui-'));
  const workspace = join(data, 'workspace');
  mkdirSync(workspace);
  for (const name of ['read me.md', 'image.png', 'paper.pdf', 'video.mp4']) writeFileSync(join(workspace, name), 'synthetic fixture');
  mkdirSync(join(workspace, 'samples'));
  mkdirSync(join(workspace, 'Desktop'));
  const correction = join(workspace, 'Desktop', 'TD01-correction.md');
  writeFileSync(correction, 'synthetic correction fixture');
  writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 2, onboarded: true, language: 'fr', workspaces: [workspace], claudePath: '/usr/bin/false' }));
  const env = { ...process.env, HOME: data, CODEX_HOME: join(data, 'codex'), CLAUDE_CONFIG_DIR: join(data, 'claude'), AI_BOX_REBUILT: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await (load('playwright-core') as typeof import('playwright-core'))._electron.launch({ executablePath: load('electron') as unknown as string, args: ['scripts/ui-entry.cjs', `--user-data-dir=${data}`], cwd: root, env, timeout: 30_000 });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    await page.waitForSelector('.composer-input');
    await app.evaluate(({ BrowserWindow, shell }) => {
      BrowserWindow.getAllWindows()[0].setPosition(-4000, -4000);
      const calls: string[][] = [];
      (globalThis as unknown as { fileCalls: string[][] }).fileCalls = calls;
      shell.openPath = async (path) => { calls.push(['open', path]); return ''; };
      shell.showItemInFolder = (path) => { calls.push(['reveal', path]); };
    });
    await page.keyboard.press('Escape');
    const text = '[Texte](<read%20me.md>) [Image](image.png) [PDF](paper.pdf) [Vidéo](video.mp4) [Samples](samples)\n\n`./read me.md`\n\n' + workspace + '/paper.pdf\n\n[Correction](<' + correction + '>)';
    await app.evaluate(({ BrowserWindow }, text) => {
      BrowserWindow.getAllWindows()[0].webContents.send('hub:items', 'master', [{ id: 'files-final', kind: 'assistant', live: false, text }], true);
    }, text);
    const links = page.locator('.msg-assistant a[href^="#ai-box-file="]');
    await links.first().waitFor();
    assert.equal(await links.count(), 8);
    for (let i = 0; i < 5; i++) await links.nth(i).click();
    await links.first().click({ modifiers: ['Alt'] });
    await links.nth(7).click();
    await links.nth(7).click({ modifiers: ['Alt'] });
    // An invoke on the same ordered IPC connection flushes the earlier clicks.
    const result = await page.evaluate(async () => {
      const hub = (window as unknown as { hub: HubApi }).hub;
      return [
        await hub.openLocalFile('master', '../outside.txt', 'open'),
        await hub.openLocalFile('master', 'https://example.invalid', 'open'),
        await hub.openLocalFile('unknown-session', 'paper.pdf', 'open'),
        await hub.openLocalFile('master', 'gone.pdf', 'open'),
      ];
    });
    assert.deepEqual(result, [{ ok: false, error: 'outside' }, { ok: false, error: 'invalid' }, { ok: false, error: 'invalid' }, { ok: false, error: 'missing' }]);
    const calls = await app.evaluate(() => (globalThis as unknown as { fileCalls: string[][] }).fileCalls);
    assert.equal(calls.length, 8);
    assert.deepEqual(calls.map((c) => c[0]), ['open', 'open', 'open', 'open', 'open', 'reveal', 'open', 'reveal']);
    assert.deepEqual(calls.slice(-2).map((c) => c[1]), [realpathSync(correction), realpathSync(correction)]);
    assert.ok(calls.every((c) => c[1].startsWith(realpathSync(workspace) + '/')));
    // A foreign sender frame cannot invoke the registered secure handler, even with a valid workspace path.
    const untrusted = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, ...args: unknown[]) => unknown> })._invokeHandlers.get('session:open-file')!;
      for (const sender of [{}, BrowserWindow.getAllWindows()[0].webContents]) {
        try { await handler({ sender, senderFrame: { url: 'https://example.invalid' } }, 'master', 'paper.pdf', 'open'); return false; }
        catch { /* Both a foreign webContents and a foreign frame must be refused. */ }
      }
      return true;
    });
    assert.equal(untrusted, true);
    // The UI gives a fixed, useful error after the same missing-path IPC result.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('hub:items', 'master', [{ id: 'missing-final', kind: 'assistant', live: false, text: '[Supprimé](gone.pdf)' }], true));
    await page.locator('.msg-assistant a').click();
    await page.getByText('Ce fichier ou dossier n’existe plus.', { exact: true }).waitFor();
  } finally {
    await app?.close();
    rmSync(data, { recursive: true, force: true });
  }
});
