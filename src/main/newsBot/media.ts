import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash, prefix, type Asset, type Draft, type Platform } from './model';
const exec = promisify(execFile);
export type Runner = (command: string, args: string[]) => Promise<string>;
export const localRunner: Runner = async (command, args) => (await exec(command, args, { timeout: 120_000, maxBuffer: 1_000_000, windowsHide: true })).stdout;
export interface FontLicense { path: string; reference: string; expiresAt: number; glyphsVerified: boolean }
export interface Manifest {
  version: 1; draftId: string; platform: Platform; width: number; height: number; fps: 30; seconds: 24;
  palette: { night: string; signal: string; paper: string; mist: string; slate: string };
  safe: { x: number; y: number; width: number; height: number }; title: string[]; captions: { start: number; end: number; text: string }[];
  altText: string; claimIds: string[]; sources: string[]; fontHash: string; rightsReference: string; aigc: false;
}
function wrap(text: string, width: number): string[] {
  const lines: string[] = []; let line = '';
  for (const word of text.split(/\s+/)) { if (word.length > width) throw new Error('BLOCKED_LAYOUT'); if ((line + ' ' + word).trim().length > width) { lines.push(line); line = word; } else line = (line + ' ' + word).trim(); }
  if (line) lines.push(line); return lines;
}
export function manifest(draft: Draft, platform: Platform, font: FontLicense, now: number): Manifest {
  if (!font.reference || font.expiresAt <= now || !font.glyphsVerified || !existsSync(font.path)) throw new Error('BLOCKED_FONT_RIGHTS');
  if (!draft.altText || !draft.claimIds.length) throw new Error('BLOCKED_QA');
  const titleText = draft.text.split('\n')[0];
  // Reviewed glyph subset only; no silent missing emoji or font fallback.
  if (/[^\u0020-\u024f·’]/u.test(titleText)) throw new Error('BLOCKED_GLYPHS');
  const title = wrap(titleText, platform === 'tiktok' ? 16 : 27);
  if (title.length > 3) throw new Error('BLOCKED_LAYOUT');
  const captionLines = wrap(titleText, 26); const captions = [];
  for (let i = 0; i < captionLines.length; i += 2) captions.push({ start: 24 * i / captionLines.length, end: Math.min(24, 24 * (i + 2) / captionLines.length), text: captionLines.slice(i, i + 2).join('\n') });
  return { version: 1, draftId: draft.id, platform, width: platform === 'tiktok' ? 1080 : 1600, height: platform === 'tiktok' ? 1920 : 900, fps: 30, seconds: 24, palette: { night: '#0B1426', signal: '#FFB547', paper: '#F3EFDF', mist: '#A5B3C7', slate: '#23344D' }, safe: platform === 'tiktok' ? { x: 96, y: 216, width: 768, height: 1224 } : { x: 96, y: 96, width: 1408, height: 708 }, title, captions, altText: draft.altText, claimIds: draft.claimIds, sources: draft.urls, fontHash: hash(readFileSync(font.path).toString('base64')), rightsReference: font.reference, aigc: false };
}
export function checkMediaBudget(dir: string, limit = 128_000_000): void {
  let bytes = 0;
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    const s = lstatSync(path);
    if (s.isSymbolicLink()) throw new Error('BLOCKED_MEDIA_PATH');
    if (s.isDirectory()) { for (const name of readdirSync(path)) visit(join(path, name)); } else bytes += s.size;
    if (bytes > limit) throw new Error('BLOCKED_MEDIA_BUDGET');
  };
  visit(dir);
}
const srtTime = (s: number) => new Date(Math.round(s * 1000)).toISOString().slice(11, 23).replace('.', ',');
export async function render(draft: Draft, platform: Platform, font: FontLicense, dir: string, now: number, run: Runner = localRunner): Promise<Asset> {
  const id = hash(`${draft.id}:${platform}:cards-1`); const folder = resolve(dir, id); mkdirSync(folder, { recursive: true, mode: 0o700 });
  const asset: Asset = { id, draftId: draft.id, path: join(folder, 'video.mp4'), manifestPath: join(folder, 'manifest.json'), state: 'BLOCKED', reason: null };
  try { checkMediaBudget(dir); } catch (e) { return { ...asset, reason: (e as Error).message }; }
  try { await run('ffmpeg', ['-version']); await run('ffprobe', ['-version']); } catch { return { ...asset, reason: 'BLOCKED_RENDERER_UNAVAILABLE' }; }
  try {
    const m = manifest(draft, platform, font, now); writeFileSync(asset.manifestPath, JSON.stringify(m, null, 2));
    writeFileSync(join(folder, 'title.txt'), m.title.join('\n')); writeFileSync(join(folder, 'label.txt'), prefix[draft.label]);
    writeFileSync(join(folder, 'source.txt'), `Sources : ${m.sources.map(u => new URL(u).hostname).join(', ')}\n${new Date(draft.verifiedAt).toISOString()}`);
    writeFileSync(join(folder, 'captions.srt'), m.captions.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n'));
    writeFileSync(join(folder, 'alt.txt'), m.altText);
    // Text files + expansion=none prevent FFmpeg expression injection. Paths are strictly filtered.
    const safePath = (p: string) => { const absolute = resolve(p); if (!/^[\p{L}\p{N}_/. -]+$/u.test(absolute)) throw new Error('BLOCKED_PATH'); return absolute; };
    const f = safePath(font.path); const title = safePath(join(folder, 'title.txt')); const src = safePath(join(folder, 'source.txt'));
    const vertical = platform === 'tiktok';
    const filters = [`drawtext=fontfile='${f}':textfile='${title}':expansion=none:fontcolor=0xF3EFDF:fontsize=${vertical ? 88 : 76}:x=96:y=${vertical ? 312 : 160}:line_spacing=8`, `drawbox=x=96:y=${vertical ? 696 : 480}:w=48:h=6:color=0xFFB547:t=fill`, `drawtext=fontfile='${f}':textfile='${src}':expansion=none:fontcolor=0xA5B3C7:fontsize=32:x=96:y=${vertical ? 1164 : 560}`];
    for (const [i, caption] of m.captions.entries()) {
      const cp = safePath(join(folder, `caption-${i}.txt`)); writeFileSync(cp, caption.text);
      filters.push(`drawtext=fontfile='${f}':textfile='${cp}':expansion=none:fontcolor=0xF3EFDF:fontsize=48:x=96:y=${vertical ? 1260 : 680}:line_spacing=8:enable='between(t,${caption.start},${caption.end - 1 / 30})'`);
    }
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', `color=c=0x0B1426:s=${m.width}x${m.height}:r=30:d=24`, '-vf', filters.join(','), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', asset.path]);
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', asset.path])) as Probe;
    checkMediaBudget(dir);
    const reason = qa(m, probe);
    if (!reason) await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', asset.path, '-f', 'null', '-']);
    // Full art-direction OCR/ASR QA is deliberately not claimed by this preview renderer.
    return { ...asset, state: reason ? 'BLOCKED' : 'RENDERED', reason: reason ?? 'BLOCKED_ADVANCED_QA_REQUIRED' };
  } catch (e) { return { ...asset, reason: e instanceof Error && e.message.startsWith('BLOCKED_') ? e.message : 'BLOCKED_RENDER_QA' }; }
}
export interface Probe { streams: { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string; color_space?: string; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[]; format: { duration: string } }
export function qa(m: Manifest, p: Probe): string | null {
  const video = p.streams.filter(s => s.codec_type === 'video'); const v = video[0];
  if (video.length !== 1 || p.streams.length !== 1 || v.codec_name !== 'h264' || v.width !== m.width || v.height !== m.height || v.pix_fmt !== 'yuv420p' || v.avg_frame_rate !== '30/1' || v.color_space !== 'bt709' || Number(v.tags?.rotate ?? 0) !== 0 || v.side_data_list?.some(s => s.rotation) || !Number.isFinite(Number(p.format.duration)) || Math.abs(Number(p.format.duration) - m.seconds) > 1 / 30) return 'BLOCKED_MEDIA';
  if (!m.altText || !m.rightsReference) return 'BLOCKED_RIGHTS';
  if (m.captions.some(c => c.text.split('\n').length > 2 || c.end <= c.start || c.text.length / (c.end - c.start) > 20)) return 'BLOCKED_CAPTIONS';
  return null;
}
export interface VoiceConfig { enabled: boolean; executable: string; args: string[]; license: string; modelHash: string; cloning: boolean }
/** Trusted local executable only; caller supplies a Piper wrapper accepting input/output file paths. */
export async function localVoice(script: string, config: VoiceConfig, dir: string, run: Runner = localRunner): Promise<string | null> {
  if (!config.enabled) return null;
  if (config.cloning || !config.license || !config.modelHash || !config.executable.startsWith('/')) throw new Error('BLOCKED_VOICE_RIGHTS');
  checkMediaBudget(dir);
  const key = hash(JSON.stringify([script, config.executable, config.args, config.modelHash, config.license])); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const output = join(resolve(dir), `${key}.wav`); if (existsSync(output)) return output;
  const input = join(resolve(dir), `${key}.txt`); writeFileSync(input, script);
  await run(config.executable, [...config.args, input, output]);
  if (!existsSync(output)) throw new Error('BLOCKED_VOICE_OUTPUT'); return output;
}
