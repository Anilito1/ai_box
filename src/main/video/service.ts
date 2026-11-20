import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { isCustomAccount } from '../../shared/providers';
import type { Account, ProviderVideoView } from '../../shared/types';
import { mergeVideoModels, videoApiOf, type VideoModel } from '../../shared/video';
import { t } from '../i18n';
import { runVideo, videoRequest, VideoRunError } from './generate';
import type { VideoAdapter, VideoJob } from './types';
import { venice } from './venice';

// The video models of the providers the user added, and the videos made with them: what the settings show and what
// the hub's tools (tools.ts) call. A provider counts when the hub has an adapter for its address.

const ADAPTERS: Record<string, VideoAdapter> = { venice };

/** The adapter for a provider's address, null when the hub speaks no video API there. */
export function videoAdapter(baseUrl: string): VideoAdapter | null {
  const api = videoApiOf(baseUrl);
  return api ? ADAPTERS[api] : null;
}

/** A provider's list is asked again once this old. */
const LIST_AGE = 10 * 60_000;
const LIST_TIMEOUT = 20_000;
const WAIT_DEFAULT = 10;
const WAIT_MAX = 30;
/** Lines one answer of list_video_models holds. */
const LINES_MAX = 200;
/** Jobs remembered for a later call; the oldest go first. */
const JOBS_MAX = 50;

export interface VideoServiceOptions {
  accounts(): Account[];
  /** An account's stored key, else empty. */
  key(accountId: string): string;
  /** Where videos go when the caller names no folder. */
  outDir(): string;
  adapterOf?(baseUrl: string): VideoAdapter | null;
  fetch?: typeof fetch;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

/** What generate_video takes, as the tool's schema names it. */
export interface GenerateArgs {
  prompt?: string | null;
  model?: string | null;
  provider?: string | null;
  duration?: string | null;
  aspect_ratio?: string | null;
  resolution?: string | null;
  image?: string | null;
  negative_prompt?: string | null;
  audio?: boolean | null;
  max_usd?: number | null;
  quote_only?: boolean | null;
  job_id?: string | null;
  wait_minutes?: number | null;
  output_dir?: string | null;
}

const usdText = (usd: number | null) => (usd === null ? t('video.priceUnknown') : t('video.price', { usd: `$${usd < 1 ? usd.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : usd.toFixed(2)}` }));
const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`);
const timeText = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

/** One line of list_video_models: the id first, what generate_video is given. */
function modelLine(m: VideoModel): string {
  const kind = m.input === 'text' ? 'text→video' : m.input === 'image' ? 'image→video' : m.input === 'video' ? 'video→video' : '';
  return [m.id, m.name, kind, m.durations.join(' '), m.aspectRatios.join(' '), m.resolutions.join(' '), m.manual ? t('video.list.manual') : ''].filter(Boolean).join(' · ');
}

export class VideoService {
  /** Each provider's own list, by account, as last read from the address it then had. */
  private readonly lists = new Map<string, { at: number; baseUrl: string; models: VideoModel[] }>();
  /** The jobs queued and not saved yet, by id: what a later call resumes. */
  private readonly jobs = new Map<string, { account: string; job: VideoJob; at: number }>();

  constructor(private readonly o: VideoServiceOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  adapterOf(a: Pick<Account, 'baseUrl'>): VideoAdapter | null {
    return (this.o.adapterOf ?? videoAdapter)(a.baseUrl);
  }

  /** The providers the user added that have a video API. */
  private providers(): Account[] {
    return this.o.accounts().filter((a) => isCustomAccount(a) && this.adapterOf(a) !== null);
  }

  /** The video models an address lists now. Throws what the provider answered instead. */
  async detect(baseUrl: string, key: string, signal?: AbortSignal): Promise<VideoModel[]> {
    const adapter = this.adapterOf({ baseUrl });
    if (!adapter) return [];
    const timeout = AbortSignal.timeout(LIST_TIMEOUT);
    return adapter.models({ baseUrl, key, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, fetch: this.o.fetch ?? fetch });
  }

  /** A provider's list read again. One that cannot be read leaves the last one, as long as the address is the same. */
  async refresh(a: Account, signal?: AbortSignal): Promise<VideoModel[]> {
    const kept = this.lists.get(a.id);
    if (!this.adapterOf(a)) {
      this.lists.delete(a.id);
      return [];
    }
    try {
      const models = await this.detect(a.baseUrl, this.o.key(a.id), signal);
      this.lists.set(a.id, { at: this.now(), baseUrl: a.baseUrl, models });
      return models;
    } catch {
      if (kept && kept.baseUrl !== a.baseUrl) this.lists.delete(a.id);
      return kept && kept.baseUrl === a.baseUrl ? kept.models : [];
    }
  }

  /** The video models the provider last listed, without asking it. */
  listed(a: Account): VideoModel[] {
    const kept = this.lists.get(a.id);
    return kept && kept.baseUrl === a.baseUrl && this.adapterOf(a) ? kept.models : [];
  }

  /** Every video model known for an account, listed or named by hand: none of them may run a session. */
  ids(a: Account): string[] {
    return [...this.listed(a).map((m) => m.id), ...(a.videoModels ?? [])];
  }

  view(a: Account): ProviderVideoView {
    return { listed: this.listed(a).map((m) => m.id), manual: a.videoModels ?? [] };
  }

  forget(accountId: string): void {
    this.lists.delete(accountId);
  }

  private remember(account: string, job: VideoJob): void {
    if (!this.jobs.has(job.id)) this.jobs.set(job.id, { account, job, at: this.now() });
    for (const id of [...this.jobs.keys()].slice(0, Math.max(0, this.jobs.size - JOBS_MAX))) this.jobs.delete(id);
  }

  /** A provider's video models for a tool call: its list when fresh, asked again otherwise, then the ones named by hand. */
  private async modelsOf(a: Account, signal: AbortSignal, again = false): Promise<VideoModel[]> {
    const kept = this.lists.get(a.id);
    const fresh = !again && kept && kept.baseUrl === a.baseUrl && this.now() - kept.at < LIST_AGE;
    return mergeVideoModels(fresh ? kept.models : await this.refresh(a, signal), a.videoModels ?? []);
  }

  private named(ref: string): Account[] {
    const all = this.providers();
    if (all.length === 0) throw new Error(t('video.none'));
    const r = ref.trim().toLowerCase();
    if (!r) return all;
    const hit = all.filter((a) => a.slug === r || a.name.toLowerCase() === r);
    if (hit.length === 0) throw new Error(t('video.noProvider', { name: ref, list: all.map((a) => a.slug).join(', ') }));
    return hit;
  }

  /** list_video_models: each provider's video models, one line each, with the values each takes. */
  async list(args: { provider?: string | null; search?: string | null }, signal: AbortSignal): Promise<string> {
    const words = (args.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let room = LINES_MAX;
    for (const a of this.named(args.provider ?? '')) {
      const all = await this.modelsOf(a, signal);
      const lines = all.map(modelLine).filter((line) => words.every((w) => line.toLowerCase().includes(w)));
      out.push(t(words.length > 0 ? 'video.list.headFound' : 'video.list.head', { provider: a.slug, name: a.name, count: all.length, found: lines.length }));
      out.push(...lines.slice(0, room));
      if (lines.length > room) out.push(t('video.list.more', { count: lines.length - room }));
      room = Math.max(0, room - lines.length);
    }
    const waiting = [...this.jobs.values()];
    if (waiting.length > 0) out.push('', t('video.list.jobs'), ...waiting.map((j) => `${j.job.id} · ${j.job.model} · ${timeText(this.now() - j.at)}`));
    return out.join('\n');
  }

  /** The model asked for, at the provider that has it; the only one there is when none is named. */
  private async pick(provider: string, model: string, signal: AbortSignal): Promise<{ account: Account; model: VideoModel }> {
    const accounts = this.named(provider);
    const wanted = model.trim().toLowerCase();
    for (const again of [false, true]) {
      const all: { account: Account; model: VideoModel }[] = [];
      for (const account of accounts) for (const m of await this.modelsOf(account, signal, again)) all.push({ account, model: m });
      if (!wanted) {
        if (all.length === 1) return all[0];
        throw new Error(t(all.length === 0 ? 'video.noModels' : 'video.pickModel', { count: all.length }));
      }
      const hit = all.find((x) => x.model.id.toLowerCase() === wanted);
      if (hit) return hit;
      // Not in the list read a moment ago: the provider may have added it since.
      if (again) {
        const near = all.filter((x) => x.model.id.toLowerCase().includes(wanted) || wanted.includes(x.model.id.toLowerCase())).slice(0, 8);
        throw new Error(t('video.unknownModel', { model }) + (near.length > 0 ? ` ${t('video.near', { list: near.map((x) => x.model.id).join(', ') })}` : ''));
      }
    }
    throw new Error(t('video.unknownModel', { model }));
  }

  /** generate_video: the price, or the video made and saved, said in a few lines for the agent that asked. */
  async generate(args: GenerateArgs, ctx: { cwd: string; signal: AbortSignal }): Promise<string> {
    const jobId = args.job_id?.trim() ?? '';
    const known = jobId ? this.jobs.get(jobId) : undefined;
    let account: Account;
    let model: VideoModel | null = null;
    let resume: VideoJob | undefined;
    if (known) {
      const a = this.o.accounts().find((x) => x.id === known.account);
      if (!a) throw new Error(t('video.none'));
      account = a;
      resume = known.job;
    } else {
      if (jobId && !args.model?.trim()) throw new Error(t('video.resumeModel'));
      const picked = await this.pick(args.provider ?? '', args.model ?? '', ctx.signal);
      account = picked.account;
      model = picked.model;
      if (jobId) resume = { id: jobId, model: model.id };
    }
    const adapter = this.adapterOf(account);
    if (!adapter) throw new Error(t('video.none'));
    const key = this.o.key(account.id);
    if (!key) throw new Error(t('video.noKey', { provider: account.slug }));
    let outDir = this.o.outDir();
    if (args.output_dir?.trim()) {
      outDir = resolve(ctx.cwd, args.output_dir.trim());
      if (!ctx.cwd || !inside(resolve(ctx.cwd), outDir)) throw new Error(t('video.outside', { cwd: ctx.cwd }));
    }
    const request = resume || !model ? undefined : await videoRequest(model, { prompt: args.prompt ?? '', negativePrompt: args.negative_prompt, duration: args.duration, aspectRatio: args.aspect_ratio, resolution: args.resolution, audio: args.audio, image: args.image }, ctx.cwd);
    const wait = Math.min(WAIT_MAX, Math.max(1, args.wait_minutes ?? WAIT_DEFAULT));
    let queued = resume;
    try {
      const r = await runVideo({
        adapter,
        baseUrl: account.baseUrl,
        key,
        request,
        resume,
        quoteOnly: args.quote_only === true && !resume,
        maxUsd: args.max_usd,
        outDir,
        waitMs: wait * 60_000,
        signal: ctx.signal,
        onJob: (job) => {
          queued = job;
          this.remember(account.id, job);
        },
        fetch: this.o.fetch,
        sleep: this.o.sleep,
        now: this.o.now,
      });
      const asked = request ? [request.duration, request.aspectRatio, request.resolution].filter(Boolean).join(' · ') : '';
      if (r.kind === 'quote') return t('video.quoted', { provider: account.slug, model: request?.model ?? '', asked, price: usdText(r.usd) });
      this.jobs.delete(r.job.id);
      return [
        t('video.saved', { path: r.path, size: sizeText(r.bytes) }),
        t('video.savedWith', { provider: account.slug, model: r.job.model, asked: asked || '-' }),
        ...(resume ? [] : [usdText(r.usd)]),
        t('video.savedIn', { time: timeText(r.elapsedMs), job: r.job.id }),
        // A link the conversation opens: forward slashes, a Markdown target takes them on every system.
        t('video.savedLink', { link: `[${basename(r.path)}](<${r.path.replace(/\\/g, '/')}>)` }),
      ].join('\n');
    } catch (err) {
      // Still at the provider: kept for a later call. A refusal ends the job here.
      if (err instanceof VideoRunError && err.job) this.remember(account.id, err.job);
      else if (queued) this.jobs.delete(queued.id);
      throw err;
    }
  }
}
