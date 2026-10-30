// UI checks for the hub, driven by Playwright's Electron support: one isolated instance per run, a few steps, short text out.
//   npm run ui -- shot /tmp/a.png --width 700 + click .model-btn + shot /tmp/b.png
//   npm run ui -- steps.json            (a JSON array of steps, each an array of arguments)
// The instance never touches the installed app nor its data: its own user-data-dir in /tmp, removed at the end.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { builtStamp, sourceStamp } from './sourceStamp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');

const HELP = `Usage: npm run ui -- [options] <step> [+ <step> ...]   or   npm run ui -- [options] steps.json
Options: --config <json|@file>  settings merged over {"onboarded":true,"language":"fr"}
         --keep                 keep the temporary data folder (its path is printed)
         --show                 leave the window where it opens (default: moved off screen)
Steps (separated by "+"; the app starts once, whatever the number of steps):
  shot <file> [--width W --height H] [--selector S] [--scale device]   capture at CSS size (a resize stays)
  size <W> <H>                                         resize the window content (the sidebar takes ~380px of it)
  fit <sel> <W>                                        resize the window so that <sel> is W px wide (ex: fit .composer 360)
  click <sel> | hover <sel> | type <sel> <text> | press <key>
  text <sel> [--max N]                                 visible text of the first match
  count <sel>                                          number of matches
  eval <js>                                            JS expression in the page, result printed (short)
  check-overflow <sel> [--tolerance PX]                descendants outside the box of <sel>, and its own scroll overflow
  wait <sel|ms>                                        wait for an element, or sleep
  snapshot <json|@file>                                merge keys into the hub snapshot (sessions, topics, providers, models...)
  mock <channel> <json|@file>                          answer an invoke channel (providers:state, settings:get...) with this value
  send <channel> <json-array|@file>                    send an IPC event to the page (hub:items, hub:event...)
  reload                                               reload the page (after "mock")
Steps file: [["click",".model-btn"],["shot","/tmp/a.png","--width","360"]]`;

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
const say = (s) => console.log(s);
const fail = (s) => {
  console.error(s);
  process.exit(2);
};
const clip = (s, n = 1500) => (s.length > n ? `${s.slice(0, n)}…(+${s.length - n} chars)` : s);
const jsonArg = (v) => JSON.parse(v.startsWith('@') ? readFileSync(v.slice(1), 'utf8') : v);

// ---------- arguments ----------
const argv = process.argv.slice(2);
const opts = { config: {}, keep: false, show: false };
while (argv[0]?.startsWith('--') && ['--config', '--keep', '--show'].includes(argv[0])) {
  const o = argv.shift();
  if (o === '--config') Object.assign(opts.config, jsonArg(argv.shift() ?? '{}'));
  else opts[o.slice(2)] = true;
}
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  say(HELP);
  process.exit(argv.length === 0 ? 1 : 0);
}
let steps;
if (argv.length === 1 && argv[0].endsWith('.json') && existsSync(argv[0])) steps = JSON.parse(readFileSync(argv[0], 'utf8'));
else {
  steps = [[]];
  for (const a of argv) a === '+' ? steps.push([]) : steps.at(-1).push(a);
}
steps = steps.map((s) => (Array.isArray(s) ? s.map(String) : String(s).split(/\s+/)));

/** { _: positional, flag: value } of one step. */
function parse(step) {
  const out = { cmd: step[0], _: [] };
  for (let i = 1; i < step.length; i++) {
    if (step[i].startsWith('--') && step[i].length > 2 && i + 1 < step.length) out[step[i].slice(2)] = step[++i];
    else out._.push(step[i]);
  }
  return out;
}

// ---------- the build: made here, so the app never rebuilds and restarts itself under Playwright's feet ----------
if (builtStamp(root) !== sourceStamp(root)) {
  const b = spawnSync(process.execPath, ['build.mjs'], { cwd: root, encoding: 'utf8' });
  if (b.status !== 0) fail(`build failed:\n${clip(`${b.stdout}${b.stderr}`, 2000)}`);
  say(`build ${secs()}s`);
}

// ---------- the isolated instance ----------
const dataDir = mkdtempSync(join(tmpdir(), 'hub-ui-'));
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarded: true, language: 'fr', ...opts.config }));
const electronPath = require('electron');
const env = { ...process.env, AI_BOX_REBUILT: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: electronPath, args: ['.', `--user-data-dir=${dataDir}`], cwd: root, env, timeout: 60_000 });
const child = app.process();
let exitCode = 0;
const cleanup = async () => {
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  child.kill('SIGKILL');
  if (opts.keep) say(`data kept: ${dataDir}`);
  else rmSync(dataDir, { recursive: true, force: true });
};

try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  await page.waitForSelector('.composer-input', { timeout: 20_000 }).catch(() => say('warn: composer not shown after 20s'));
  // Without min size the window can go as narrow as a test asks; off screen so the check does not take over the desktop.
  await app.evaluate(({ BrowserWindow, app: a }, show) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setMinimumSize(1, 1);
    if (!show) {
      w.setPosition(-4000, -4000);
      a.dock?.hide();
    }
  }, opts.show);
  // The real snapshot, kept by the page to merge a fake state into it.
  await page.evaluate(() => {
    window.__uiSnap = null;
    window.hub.onSnapshot((s) => (window.__uiSnap = s));
    window.hub.ready();
  });
  say(`ready ${secs()}s`);

  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const resize = async (w, h) => {
    const [cw, ch] = await app.evaluate(({ BrowserWindow }, [W, H]) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [cw0, ch0] = win.getContentSize();
      win.setContentSize(W || cw0, H || ch0);
      return win.getContentSize();
    }, [Number(w) || 0, Number(h) || 0]);
    await settle();
    return `${cw}x${ch}`;
  };
  const sendToPage = (channel, args) => app.evaluate(({ BrowserWindow }, [c, a]) => BrowserWindow.getAllWindows()[0].webContents.send(c, ...a), [channel, args]);

  const actions = {
    async shot(a) {
      const file = resolve(a._[0] ?? (() => { throw new Error('shot: file needed'); })());
      if (a.width || a.height) await resize(a.width, a.height);
      if (a.selector) await page.locator(a.selector).first().screenshot({ path: file, scale: a.scale === 'device' ? 'device' : 'css' });
      else await page.screenshot({ path: file, scale: a.scale === 'device' ? 'device' : 'css' });
      const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
      return `${file} (${a.selector ? `element ${a.selector}` : `${w}x${h}`}, ${Math.round(statSync(file).size / 1024)} KB)`;
    },
    async fit(a) {
      const cur = await page.locator(a._[0]).first().evaluate((e) => e.getBoundingClientRect().width);
      const [w0] = await page.evaluate(() => [innerWidth]);
      const got = await resize(Math.round(w0 + Number(a._[1]) - cur), 0);
      const now = await page.locator(a._[0]).first().evaluate((e) => Math.round(e.getBoundingClientRect().width));
      return `window ${got}, ${a._[0]} ${now}px`;
    },
    size: async (a) => `content ${await resize(a._[0], a._[1])}`,
    async click(a) {
      await page.locator(a._[0]).first().click();
      await settle();
      return 'ok';
    },
    async hover(a) {
      await page.locator(a._[0]).first().hover();
      return 'ok';
    },
    async type(a) {
      await page.locator(a._[0]).first().fill(a._.slice(1).join(' '));
      return 'ok';
    },
    async press(a) {
      await page.keyboard.press(a._[0]);
      await settle();
      return 'ok';
    },
    async text(a) {
      const loc = page.locator(a._[0]).first();
      if ((await loc.count()) === 0) return 'not found';
      return clip((await loc.innerText()).replace(/\n+/g, ' | '), Number(a.max) || 600);
    },
    count: async (a) => String(await page.locator(a._[0]).count()),
    async eval(a) {
      const v = await page.evaluate(a._.join(' '));
      return v === undefined ? 'undefined' : clip(typeof v === 'string' ? v : JSON.stringify(v));
    },
    async wait(a) {
      if (/^\d+$/.test(a._[0])) await page.waitForTimeout(Number(a._[0]));
      else await page.waitForSelector(a._[0], { timeout: 10_000 });
      return 'ok';
    },
    async 'check-overflow'(a) {
      const res = await page.evaluate(
        ([sel, tol]) => {
          const box = document.querySelector(sel);
          if (!box) return { missing: true };
          const r = box.getBoundingClientRect();
          const name = (e) => {
            const cls = [...e.classList].slice(0, 2).join('.');
            const txt = (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 18);
            return `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${cls ? `.${cls}` : ''}${txt ? ` "${txt}"` : ''}`;
          };
          const over = new Map();
          for (const e of box.querySelectorAll('*')) {
            const b = e.getBoundingClientRect();
            if (!b.width && !b.height) continue;
            const cs = getComputedStyle(e);
            if (cs.visibility === 'hidden' || cs.position === 'fixed') continue;
            const d = [];
            if (r.left - b.left > tol) d.push(`left ${Math.round(r.left - b.left)}px`);
            if (b.right - r.right > tol) d.push(`right ${Math.round(b.right - r.right)}px`);
            if (r.top - b.top > tol) d.push(`top ${Math.round(r.top - b.top)}px`);
            if (b.bottom - r.bottom > tol) d.push(`bottom ${Math.round(b.bottom - r.bottom)}px`);
            if (d.length) over.set(e, `${name(e)}: ${d.join(', ')}`);
          }
          // Only the outermost offender of a branch: its children overflow with it.
          const lines = [...over].filter(([e]) => !over.has(e.parentElement)).map(([, l]) => l);
          const own = [];
          if (box.scrollWidth > box.clientWidth + tol) own.push(`scrollWidth ${box.scrollWidth} > ${box.clientWidth}`);
          if (box.scrollHeight > box.clientHeight + tol) own.push(`scrollHeight ${box.scrollHeight} > ${box.clientHeight}`);
          return { box: `${Math.round(r.width)}x${Math.round(r.height)}`, lines, own };
        },
        [a._[0], Number(a.tolerance ?? 0.5)],
      );
      if (res.missing) return 'not found';
      if (!res.lines.length && !res.own.length) return `OK (${res.box}, nothing outside)`;
      exitCode = 1;
      const shown = res.lines.slice(0, 10).map((l) => `\n  - ${l}`).join('');
      return `OVERFLOW in ${a._[0]} (${res.box}): ${res.lines.length} element(s)${shown}${res.lines.length > 10 ? '\n  - …' : ''}${res.own.length ? `\n  - box scrolls: ${res.own.join(', ')}` : ''}`;
    },
    async snapshot(a) {
      const base = await page.evaluate(() => window.__uiSnap);
      if (!base) return 'no snapshot received yet';
      const patch = jsonArg(a._.join(' '));
      // What the app reads of any session, for a fake that only says what it is about.
      const blank = { background: [], limit: null, tool: null, approvedAt: null, pulse: { signalAt: null, tokens: 0, estimated: false } };
      if (patch.sessions) patch.sessions = patch.sessions.map((s) => ({ ...blank, ...s }));
      await sendToPage('hub:snapshot', [{ ...base, ...patch }]);
      await settle();
      return `merged ${Object.keys(patch).join(', ')}`;
    },
    async mock(a) {
      const value = jsonArg(a._.slice(1).join(' '));
      await app.evaluate(({ ipcMain }, [c, v]) => {
        ipcMain.removeHandler(c);
        ipcMain.handle(c, () => v);
      }, [a._[0], value]);
      return `${a._[0]} answered (reload to apply)`;
    },
    async send(a) {
      await sendToPage(a._[0], jsonArg(a._.slice(1).join(' ')));
      await settle();
      return 'ok';
    },
    async reload() {
      await page.reload();
      await page.waitForSelector('.composer-input', { timeout: 20_000 }).catch(() => {});
      await page.evaluate(() => {
        window.__uiSnap = null;
        window.hub.onSnapshot((s) => (window.__uiSnap = s));
      });
      return 'ok';
    },
  };

  for (const [i, step] of steps.entries()) {
    const a = parse(step);
    const label = `[${i + 1}] ${a.cmd}`;
    try {
      const run = actions[a.cmd] ?? (() => { throw new Error(`unknown step "${a.cmd}" (see npm run ui -- --help)`); })();
      say(`${label}: ${await run(a)}`);
    } catch (e) {
      exitCode = 1;
      say(`${label}: ERROR ${clip(String(e.message).split('\n')[0], 200)}`);
    }
  }
  say(`done ${secs()}s`);
} catch (e) {
  exitCode = 1;
  console.error(`ui: ${clip(String(e.stack || e), 1500)}`);
} finally {
  await cleanup();
}
process.exit(exitCode);
