import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DirectRunner, Value } from '../../../shared/graph/engine';
import { t } from '../../i18n';
import { paint } from '../media/paint';
import { png } from '../media/png';
import { IMAGE } from './sim';

// The "frames" conversion: a few pictures spread over a video, for a model that reads images but no video.
// A simulated video is drawn again at those moments; a real one goes through ffmpeg, when it is installed.

const run = (file: string, args: string[], signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, { signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

async function withFfmpeg(video: Exclude<Value, { type: 'text' }>, count: number, signal: AbortSignal): Promise<Value[]> {
  const dir = await mkdtemp(join(tmpdir(), 'hub-graph-frames-'));
  try {
    const source = join(dir, 'video');
    await writeFile(source, video.bytes);
    let seconds: number;
    try {
      seconds = Number.parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source], signal));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(t('graph.err.noFfmpeg'));
      throw new Error(t('graph.err.badVideo'));
    }
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(t('graph.err.badVideo'));
    const frames: Value[] = [];
    for (let i = 0; i < count; i++) {
      const at = (seconds * (i + 0.5)) / count;
      const target = join(dir, `frame-${i}.jpg`);
      await run('ffmpeg', ['-v', 'error', '-ss', at.toFixed(3), '-i', source, '-frames:v', '1', '-vf', 'scale=min(1024\\,iw):-2', '-q:v', '3', '-y', target], signal);
      frames.push({ type: 'image', mime: 'image/jpeg', bytes: new Uint8Array(await readFile(target)), label: `${at.toFixed(1)} s` });
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const framesRunner: DirectRunner = {
  // Made here: free.
  estimate: async () => 0,
  async run(call, ctx) {
    const video = call.inputs.video?.find((v): v is Exclude<Value, { type: 'text' }> => v.type === 'video');
    if (!video) throw new Error(t('graph.err.noVideo'));
    const count = Math.min(8, Math.max(1, Number.parseInt(call.node.options?.count ?? '4', 10) || 4));
    if (!video.sim) return { outputs: { images: await withFfmpeg(video, count, ctx.signal) } };
    const { seed, about } = video.sim;
    const images = Array.from({ length: count }, (_, i): Value => {
      const at = count === 1 ? 0.5 : i / (count - 1);
      return { type: 'image', mime: 'image/png', bytes: png(paint(seed, IMAGE.width, IMAGE.height, at), IMAGE.width, IMAGE.height), label: `${i + 1}/${count}`, sim: { seed, about } };
    });
    return { outputs: { images } };
  },
};
