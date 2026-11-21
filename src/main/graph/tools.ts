import { z } from 'zod';
import { t } from '../i18n';
import type { HubTool, HubToolResult } from '../providers/types';
import type { GraphService } from './service';

/**
 * The hub's graph tools, for the master and the workers alike, beside the video ones: list_graphs says which graphs
 * the user made, run_graph runs one on a message. A call that is cut (the agent interrupted) stops the run at once.
 */
export function graphTools(graphs: GraphService, cwd: () => string, run: (fn: () => Promise<string>) => Promise<HubToolResult>): HubTool[] {
  const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal;
  return [
    {
      name: 'list_graphs',
      description: t('graph.tool.desc.list'),
      shape: {},
      handler: () => run(async () => graphs.toolList()),
    },
    {
      name: 'run_graph',
      description: t('graph.tool.desc.run'),
      shape: {
        graph: z.string().max(120).describe(t('graph.tool.desc.graph')),
        message: z.string().max(32_000).describe(t('graph.tool.desc.message')),
        images: z.array(z.string().max(500)).max(8).nullish().describe(t('graph.tool.desc.images')),
        max_usd: z.number().positive().nullish().describe(t('graph.tool.desc.maxUsd')),
      },
      handler: (a: { graph: string; message: string; images?: string[] | null; max_usd?: number | null }, extra) => run(() => graphs.toolRun(a, { cwd: cwd(), signal: signalOf(extra) })),
    },
  ];
}
