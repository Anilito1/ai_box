import { z } from 'zod';
import { t } from '../i18n';
import type { HubTool, HubToolResult } from '../providers/types';
import type { GenerateArgs, VideoService } from './service';

/**
 * The hub's video tools, for the master and the workers alike: list_video_models says what there is,
 * generate_video makes one video and answers with its file. A call that is cut (the agent interrupted) stops waiting
 * at once; the job stays at the provider, and its id resumes it.
 */
export function videoTools(video: VideoService, cwd: () => string, run: (fn: () => Promise<string>) => Promise<HubToolResult>): HubTool[] {
  const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal;
  return [
    {
      name: 'list_video_models',
      description: t('tool.listVideoModels'),
      shape: {
        provider: z.string().nullish().describe(t('tool.video.provider')),
        search: z.string().max(120).nullish().describe(t('tool.listVideoModels.search')),
      },
      handler: (a: { provider?: string | null; search?: string | null }, extra) => run(() => video.list(a, signalOf(extra))),
    },
    {
      name: 'generate_video',
      description: t('tool.generateVideo'),
      shape: {
        prompt: z.string().max(32_000).nullish().describe(t('tool.generateVideo.prompt')),
        model: z.string().max(120).nullish().describe(t('tool.generateVideo.model')),
        provider: z.string().nullish().describe(t('tool.video.provider')),
        duration: z.string().max(20).nullish().describe(t('tool.generateVideo.duration')),
        aspect_ratio: z.string().max(20).nullish().describe(t('tool.generateVideo.aspectRatio')),
        resolution: z.string().max(20).nullish().describe(t('tool.generateVideo.resolution')),
        image: z.string().nullish().describe(t('tool.generateVideo.image')),
        negative_prompt: z.string().max(32_000).nullish().describe(t('tool.generateVideo.negativePrompt')),
        audio: z.boolean().nullish().describe(t('tool.generateVideo.audio')),
        max_usd: z.number().positive().nullish().describe(t('tool.generateVideo.maxUsd')),
        quote_only: z.boolean().nullish().describe(t('tool.generateVideo.quoteOnly')),
        job_id: z.string().max(200).nullish().describe(t('tool.generateVideo.jobId')),
        wait_minutes: z.number().min(1).max(30).nullish().describe(t('tool.generateVideo.wait')),
        output_dir: z.string().max(500).nullish().describe(t('tool.generateVideo.outputDir')),
      },
      handler: (a: GenerateArgs, extra) => run(() => video.generate(a, { cwd: cwd(), signal: signalOf(extra) })),
    },
  ];
}
