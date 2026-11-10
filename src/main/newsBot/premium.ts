import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash, prefix, type Draft, type Platform } from './model';
import { checkMediaBudget, localRunner, type FontLicense, type Runner, type Probe } from './media';
export type Recipe = 'Flash' | 'Patch' | 'Dossier' | 'Radar';
export interface PremiumManifest {
  version: 2; recipe: Recipe; platform: Platform; width: number; height: number; fps: 30; duration: number;
  font: { hash: string; reference: string; expiresAt: number } | null; draftId: string; label: string; altText: string; aigc: false; audio: false; palette: string[];
  scenes: { start: number; end: number; role: string; text: string; claimIds: string[] }[];
  safe: { x: number; y: number; width: number; height: number }; sources: string[];
}
export function premiumManifest(draft: Draft, platform: Platform, recipe: Recipe): PremiumManifest {
  const [duration, count] = { Flash: [24, 6], Patch: [28, 7], Dossier: [40, 8], Radar: [20, 5] }[recipe];
  const facts = draft.text.split('\n')[0].replace(/^(CONFIRMÉ|CROISÉ|À CONFIRMER|RADAR) ·\s*/, '');
  const reserve = draft.label === 'C' ? 'Non confirmé par l’éditeur.' : draft.label === 'B' ? 'Sans confirmation officielle.' : recipe === 'Radar' ? 'Aperçu interne uniquement.' : prefix[draft.label];
  const texts = [facts, facts, reserve, facts, `Vérifié le ${new Date(draft.verifiedAt).toISOString().slice(5, 10).replace('-', '/')} à ${new Date(draft.verifiedAt).toISOString().slice(11, 16)} UTC`, reserve, facts, reserve];
  return { version: 2, recipe, platform, width: platform === 'tiktok' ? 1080 : 1600, height: platform === 'tiktok' ? 1920 : 900, fps: 30, duration, font: null, draftId: draft.id, label: recipe === 'Radar' ? prefix.D : prefix[draft.label], altText: draft.altText, aigc: false, audio: false, palette: ['#0B1426', '#FFB547', '#F3EFDF', '#A5B3C7', '#23344D'], safe: platform === 'tiktok' ? { x: 96, y: 216, width: 768, height: 1224 } : { x: 96, y: 96, width: 1408, height: 708 }, sources: draft.urls, scenes: Array.from({ length: count }, (_, i) => ({ start: duration * i / count, end: duration * (i + 1) / count, role: ['hook', 'fact', 'qualification', 'detail', 'verification', 'limit', 'recap', 'limit'][i], text: texts[i], claimIds: [0, 1, 3, 6].includes(i) ? draft.claimIds : [] })) };
}
export interface QaCheck { check: string; state: 'PASS' | 'BLOCKED' | 'NA'; code: string }
export interface PremiumReport { manifest: PremiumManifest; checks: QaCheck[]; state: 'BLOCKED' | 'QA_PASSED'; video: string | null }
const normalized = (s: string) => s.normalize('NFC').toLocaleLowerCase('fr').replace(/[^\p{L}\p{N}]/gu, '');
function lines(text: string, max: number): string {
  const result: string[] = []; let line = '';
  for (const word of text.split(/\s+/)) { if (word.length > max) throw new Error('BLOCKED_LAYOUT'); if ((line + ' ' + word).trim().length > max) { result.push(line); line = word; } else line = (line + ' ' + word).trim(); }
  result.push(line); if (result.length > 3) throw new Error('BLOCKED_LAYOUT'); return result.join('\n');
}
const pathArg = (s: string) => { const p = resolve(s); if (!/^[\p{L}\p{N}_/. -]+$/u.test(p)) throw new Error('BLOCKED_PATH'); return p; };
export async function renderPremium(draft: Draft, platform: Platform, recipe: Recipe, dir: string, font?: FontLicense, run: Runner = localRunner): Promise<PremiumReport> {
  checkMediaBudget(dir);
  const m = premiumManifest(draft, platform, recipe);
  if (font?.reference && font.expiresAt > Date.now()) { try { m.font = { hash: hash(readFileSync(font.path).toString('base64')), reference: font.reference, expiresAt: font.expiresAt }; } catch { /* rights check below remains blocked */ } }
  const checks: QaCheck[] = [];
  const folder = join(dir, hash(JSON.stringify(m))); mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(m, null, 2));
  writeFileSync(join(folder, 'alt.txt'), m.altText);
  const time = (s: number) => new Date(Math.round(s * 1000)).toISOString().slice(11, 23).replace('.', ',');
  writeFileSync(join(folder, 'captions.srt'), m.scenes.map((scene, i) => `${i + 1}\n${time(scene.start)} --> ${time(scene.end)}\n${scene.text}\n`).join('\n'));
  const report: PremiumReport = { manifest: m, checks, state: 'BLOCKED', video: null };
  const check = (name: string, ok: boolean, code: string) => checks.push({ check: name, state: ok ? 'PASS' : 'BLOCKED', code });
  const finish = () => { writeFileSync(join(folder, 'qa.json'), JSON.stringify(report, null, 2)); return report; };
  for (const tool of ['ffmpeg', 'ffprobe', 'tesseract']) {
    try { await run(tool, [tool === 'tesseract' ? '--version' : '-version']); check(tool, true, 'AVAILABLE'); }
    catch { check(tool, false, `BLOCKED_${tool.toUpperCase()}_UNAVAILABLE`); }
  }
  if (checks.some(c => ['ffmpeg', 'ffprobe'].includes(c.check) && c.state === 'BLOCKED')) checks.push({ check: 'renderer', state: 'BLOCKED', code: 'BLOCKED_RENDERER_UNAVAILABLE' });
  check('rights', !!m.font && !!font?.reference && !!font.glyphsVerified && font.expiresAt > Date.now(), 'BLOCKED_FONT_RIGHTS');
  check('alt-text', !!m.altText && m.sources.length > 0, 'BLOCKED_ALT_OR_SOURCE');
  checks.push({ check: 'ASR', state: 'NA', code: 'SILENT_ORIGINAL_CARDS' }, { check: 'LUFS', state: 'NA', code: 'NO_AUDIO_TRACK' }, { check: 'AIGC', state: 'PASS', code: 'NO_REALISTIC_SYNTHETIC_MEDIA' });
  if (checks.some(c => c.state === 'BLOCKED')) return finish();
  try {
    const f = pathArg(font!.path); readFileSync(f);
    const vertical = platform === 'tiktok'; const filters: string[] = [];
    for (const [i, scene] of m.scenes.entries()) {
      const path = pathArg(join(folder, `scene-${i}.txt`)); const text = lines(scene.text, vertical ? 16 : 27);
      if (/[^\u0020-\u024f·’\n]/u.test(text)) throw new Error('BLOCKED_GLYPHS');
      writeFileSync(path, text);
      filters.push(`drawtext=fontfile='${f}':textfile='${path}':expansion=none:fontcolor=0xF3EFDF:fontsize=${vertical ? 88 : 76}:x=96:y=${vertical ? 312 : 160}:line_spacing=8:enable='gte(t,${scene.start})*lt(t,${scene.end})'`);
      const captions = pathArg(join(folder, `caption-${i}.txt`));
      const captionText = lines(scene.text, 26); if (captionText.split('\n').length > 2) throw new Error('BLOCKED_CAPTIONS');
      writeFileSync(captions, captionText);
      filters.push(`drawtext=fontfile='${f}':textfile='${captions}':expansion=none:fontcolor=0xF3EFDF:fontsize=48:x=96:y=${vertical ? 1260 : 680}:line_spacing=8:enable='gte(t,${scene.start})*lt(t,${scene.end})'`);
    }
    const provenance = pathArg(join(folder, 'sources.txt')); const sourceText = lines(m.sources.map(url => new URL(url).hostname).join(' / '), 32);
    if (sourceText.split('\n').length > 2) throw new Error('BLOCKED_LAYOUT');
    writeFileSync(provenance, sourceText);
    filters.push(`drawtext=fontfile='${f}':textfile='${provenance}':expansion=none:fontcolor=0xA5B3C7:fontsize=32:x=96:y=${vertical ? 1164 : 560}`);
    const label = pathArg(join(folder, 'label.txt')); writeFileSync(label, m.label);
    filters.push(`drawtext=fontfile='${f}':textfile='${label}':expansion=none:fontcolor=0xA5B3C7:fontsize=32:x=96:y=${m.safe.y}`);
    filters.push(`drawbox=x=96:y=${vertical ? 696 : 480}:w=48:h=6:color=0xFFB547:t=fill`);
    // Opaque palette guarantees documented >=4.5:1 text contrast; no licensed imagery or soundtrack.
    const video = join(folder, 'video.mp4');
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', `color=c=0x0B1426:s=${m.width}x${m.height}:r=30:d=${m.duration}`, '-vf', filters.join(','), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-movflags', '+faststart', video]);
    const p = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video])) as Probe;
    const v = p.streams[0];
    check('format', p.streams.length === 1 && v.codec_type === 'video' && v.color_space === 'bt709' && Number(v.tags?.rotate ?? 0) === 0 && v.codec_name === 'h264' && v.width === m.width && v.height === m.height && v.pix_fmt === 'yuv420p' && v.avg_frame_rate === '30/1' && Math.abs(Number(p.format.duration) - m.duration) <= 1 / 30 && !v.side_data_list?.some(s => s.rotation), 'BLOCKED_MEDIA');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', video, '-f', 'null', '-']);
    for (const [i, scene] of m.scenes.entries()) {
      const png = join(folder, `qa-${i}.png`);
      await run('ffmpeg', ['-nostdin', '-y', '-ss', String((scene.start + scene.end) / 2), '-i', video, '-frames:v', '1', png]);
      const ocr = await run('tesseract', [png, 'stdout', '-l', 'fra', 'tsv']);
      const words = ocr.split('\n').slice(1).map(line => line.split('\t')).filter(row => row[0] === '5' && row[11]?.trim());
      check(`ocr-${i}`, normalized(words.map(row => row[11]).join(' ')).includes(normalized(scene.text)), 'BLOCKED_OCR_TEXT');
      check(`layout-${i}`, words.length > 0 && words.every(row => { const x = Number(row[6]); const y = Number(row[7]); const w = Number(row[8]); const h = Number(row[9]); return x >= m.safe.x && y >= m.safe.y && x + w <= m.safe.x + m.safe.width && y + h <= m.safe.y + m.safe.height; }), 'BLOCKED_LAYOUT');
    }
    checkMediaBudget(dir);
    report.video = video;
    check('contrast', true, 'OPAQUE_PALETTE_CONTRAST_VERIFIED');
    check('fixture', !draft.fixture && recipe !== 'Radar', 'BLOCKED_FIXTURE_OR_RADAR');
    // Sampled OCR is useful preparation QA; production certification still requires independent full-frame QA.
    check('production-certification', false, 'BLOCKED_PRODUCTION_QA_REQUIRED');
  } catch (e) { check('render', false, e instanceof Error && /^BLOCKED_[A-Z_]+$/.test(e.message) ? e.message : 'BLOCKED_RENDER_QA'); }
  return finish();
}
