import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NewsBotRuntime, runtimeDefaults, registerNewsBotIpc, type Timer } from './runtime';
import { premiumManifest, renderPremium } from './premium';
import { dryRun } from './dryRun';
import { LocalStore } from './store';
import type { Draft } from './model';
const now = Date.now();
const draft: Draft = { id: 'synthetic', storyId: 'fixture-story', revision: 1, label: 'A', text: 'CONFIRMÉ · Patch annoncé.', claimIds: ['c'], urls: ['https://games.example/news'], altText: 'Carte du patch annoncé.', verifiedAt: now, expiresAt: now + 60_000, fixture: false, state: 'DRAFTED' };
function temp(t: { after(fn: () => void): void }) { const dir = mkdtempSync(join(tmpdir(), 'newsbot-phase2-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

import { writeFileSync } from 'node:fs';

test('IPC config strict defaults, persistence, start/stop and no token-bearing keys', async t => {
  const dir = temp(t); const r = new NewsBotRuntime(dir); t.after(() => r.dispose());
  const handlers = new Map<string, (...args: unknown[]) => unknown>(); registerNewsBotIpc((key, fn) => handlers.set(key, fn), r);
  assert.equal(r.state().config.enabled, false); assert.equal(r.start().running, false);
  assert.throws(() => handlers.get('newsbot:configure')!({ ...runtimeDefaults, network: true }));
  assert.throws(() => handlers.get('newsbot:configure')!({ ...runtimeDefaults, accessToken: 'never-save' }));
  handlers.get('newsbot:configure')!({ ...runtimeDefaults, enabled: true });
  assert.equal(handlers.get('newsbot:start')!() && r.state().running, true); handlers.get('newsbot:stop')!(); assert.equal(r.state().running, false);
  const restarted = new NewsBotRuntime(dir); assert.equal(restarted.state().config.enabled, true); assert.equal(restarted.state().running, false); restarted.dispose();
  assert.ok(!readFileSync(join(dir, 'config.json'), 'utf8').includes('never-save'));
});

test('scheduler runs no overlapping cycle, stops rearming and expurgates thrown secrets', async t => {
  const callbacks = new Map<number, () => void>(); let seq = 0; const timers: Timer = { schedule: fn => { callbacks.set(++seq, fn); return seq; }, cancel: id => { callbacks.delete(id as number); } };
  let release!: () => void; let calls = 0;
  const r = new NewsBotRuntime(temp(t), async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); throw new Error('synthetic-token-must-not-leak'); }, timers);
  t.after(() => r.dispose()); r.configure({ ...runtimeDefaults, enabled: true, scheduler: true }); r.start();
  const cb = callbacks.values().next().value!; callbacks.clear(); cb(); assert.equal(r.state().busy, true);
  await r.run(); assert.equal(calls, 1); r.stop(); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks.size, 0); assert.equal(r.state().busy, false); assert.match(JSON.stringify(r.state().logs), /BLOCKED_CYCLE/); assert.ok(!JSON.stringify(r.state()).includes('must-not-leak'));
});

test('premium manifests respect all four recipe durations, continuous scenes and two platforms', () => {
  for (const [recipe, duration, count] of [['Flash',24,6],['Patch',28,7],['Dossier',40,8],['Radar',20,5]] as const) for (const platform of ['x','tiktok'] as const) {
    const m = premiumManifest(draft, platform, recipe); assert.equal(m.duration, duration); assert.equal(m.scenes.length, count); assert.equal(m.scenes[0].start, 0); assert.equal(m.scenes.at(-1)!.end, duration); assert.equal(m.width, platform === 'x' ? 1600 : 1080);
    for (let i = 1; i < count; i++) assert.equal(m.scenes[i].start, m.scenes[i-1].end);
  }
});

test('complete fixture dry-run saves drafts, manifests, QA and never enqueues publication', async t => {
  const dir = temp(t); const report = await dryRun(dir, { ...runtimeDefaults, sources: ['steam'] }, async () => { throw new Error('fixture tool absent'); });
  assert.equal(report.drafts, 1); assert.equal(report.manifests, 8); assert.equal(report.publication, 'BLOCKED_DRY_RUN'); assert.ok(report.qa.includes('BLOCKED_FFMPEG_UNAVAILABLE'));
  assert.equal(JSON.parse(readFileSync(join(dir, 'dry-run', 'steam-draft.json'), 'utf8')).draft.fixture, true);
  const store = new LocalStore(join(dir, 'dry-run', 'news.sqlite')); assert.equal(store.publications().length, 0); store.close();
});

test('missing tools leave premium blocked but persist manifest and actionable report', async t => {
  const result = await renderPremium(draft, 'tiktok', 'Flash', temp(t), undefined, async () => { throw new Error('absent'); }); assert.equal(result.state, 'BLOCKED'); assert.equal(result.video, null); assert.equal(result.manifest.scenes.length, 6);
});

test('premium renderer builds continuous scene/caption filters and verifies sampled OCR boxes', async t => {
  const dir = temp(t); const font = join(dir, 'fixture-font'); writeFileSync(font, 'not a real font, simulated runner only');
  const m = premiumManifest(draft, 'tiktok', 'Flash'); const calls: string[][] = [];
  const report = await renderPremium(draft, 'tiktok', 'Flash', dir, { path: font, reference: 'synthetic-only', expiresAt: Date.now() + 86_400_000, glyphsVerified: true }, async (command, args) => {
    calls.push(args);
    if (command === 'ffprobe' && args.includes('-show_streams')) return JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, pix_fmt: 'yuv420p', avg_frame_rate: '30/1', color_space: 'bt709' }], format: { duration: '24' } });
    if (command === 'tesseract' && args.includes('tsv')) { const i = Number(/qa-(\d+)\.png/.exec(args[0])![1]); return 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t96\t312\t700\t100\t99\t' + m.scenes[i].text; }
    return 'simulated';
  });
  assert.ok(report.video); assert.equal(report.manifest.font?.reference, 'synthetic-only'); assert.equal(report.checks.filter(c => c.check.startsWith('ocr-') && c.state === 'PASS').length, 6);
  assert.equal(report.checks.find(c => c.check === 'production-certification')?.state, 'BLOCKED'); assert.ok(calls.some(args => args.some(a => a.includes('caption-5.txt'))));
});
