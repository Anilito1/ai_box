import { GRAPH_VERSION, type Graph } from '../../shared/graph/format';
import { t } from '../i18n';

// The graphs a new one can start from, on the simulated models: they run at once, with no key. Their words are the
// user's language at the time the example is taken.

const X = (column: number) => 36 + column * 234;
const Y = 70;
/** A node's values, typed as the format keeps them. */
const opts = (o: Record<string, string>) => o;

export interface Example {
  id: string;
  graph: () => Graph;
}

export const EXAMPLES: Example[] = [
  {
    id: 'image-video-review',
    graph: () => ({
      version: GRAPH_VERSION,
      name: t('graph.example.chain'),
      nodes: [
        { id: 'in', kind: 'chat-input', x: X(0), y: Y },
        { id: 'writer', kind: 'model', model: 'sim/llm', title: t('graph.example.writer'), instruction: t('graph.example.writerHow'), x: X(1), y: Y },
        { id: 'image', kind: 'model', model: 'sim/text-to-image', title: t('graph.example.image'), x: X(2), y: Y },
        { id: 'video', kind: 'model', model: 'sim/image-to-video', title: t('graph.example.video'), options: opts({ duration: '3s' }), x: X(3), y: Y },
        { id: 'critic', kind: 'model', model: 'sim/llm-video', title: t('graph.example.critic'), instruction: t('graph.example.criticHow'), x: X(4), y: Y },
        { id: 'out', kind: 'chat-output', x: X(5), y: Y },
      ],
      edges: [
        { from: 'in.text', to: 'writer.prompt' },
        { from: 'writer.text', to: 'image.prompt' },
        { from: 'image.image', to: 'video.image' },
        { from: 'writer.text', to: 'video.prompt' },
        { from: 'video.video', to: 'critic.video' },
        { from: 'critic.text', to: 'out.text' },
        { from: 'video.video', to: 'out.video' },
      ],
    }),
  },
  {
    id: 'video-frames',
    graph: () => ({
      version: GRAPH_VERSION,
      name: t('graph.example.frames'),
      nodes: [
        { id: 'in', kind: 'chat-input', x: X(0), y: Y },
        { id: 'video', kind: 'model', model: 'sim/text-to-video', title: t('graph.example.makeVideo'), options: opts({ duration: '3s' }), x: X(1), y: Y },
        { id: 'frames', kind: 'convert', convert: 'frames', options: opts({ count: '4' }), x: X(2), y: Y },
        { id: 'critic', kind: 'model', model: 'sim/llm-vision', title: t('graph.example.describe'), instruction: t('graph.example.describeHow'), x: X(3), y: Y },
        { id: 'out', kind: 'chat-output', x: X(4), y: Y },
      ],
      edges: [
        { from: 'in.text', to: 'video.prompt' },
        { from: 'video.video', to: 'frames.video' },
        { from: 'frames.images', to: 'critic.images' },
        { from: 'critic.text', to: 'out.text' },
        { from: 'video.video', to: 'out.video' },
      ],
    }),
  },
  {
    id: 'reference-image',
    graph: () => ({
      version: GRAPH_VERSION,
      name: t('graph.example.reference'),
      nodes: [
        { id: 'in', kind: 'chat-input', x: X(0), y: Y },
        { id: 'edit', kind: 'model', model: 'sim/reference-to-image', title: t('graph.example.edit'), x: X(1), y: Y },
        { id: 'out', kind: 'chat-output', x: X(2), y: Y },
      ],
      edges: [
        { from: 'in.text', to: 'edit.prompt' },
        { from: 'in.images', to: 'edit.images' },
        { from: 'edit.image', to: 'out.image' },
      ],
    }),
  },
];

/** A new graph with nothing but the chat's two ends. */
export const blankGraph = (): Graph => ({
  version: GRAPH_VERSION,
  name: t('graph.blank'),
  nodes: [
    { id: 'in', kind: 'chat-input', x: X(0), y: Y },
    { id: 'out', kind: 'chat-output', x: X(3), y: Y },
  ],
  edges: [],
});
