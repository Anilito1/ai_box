import type { Lang } from '../shared/i18n';
import { topicOf } from '../shared/parallel';
import { slugify } from '../shared/team';
import { isImplicit, isTopicId, parseTopicCall, TOPIC_LIMITS, workerName, type ReplayStep, type Topic, type TopicInput } from '../shared/topics';
import { lang } from './i18n';

// The master's side of the topics (shared/topics.ts): its tool, its prompt, and the block that tells it, and the
// transcript, which topic a message belongs to.

export const TOPIC_TOOL = 'mcp__hub__topic';

/**
 * Added to a message for the master: the topic the user wrote it in, or that a worker's message is about. The model
 * reads it; the user never sees it (visibleText() drops it); the hub reads it back from the transcript at each start.
 */
export function topicBlock(topic: Topic, from: 'user' | 'hub', l: Lang = lang()): string {
  const fr = l === 'fr';
  const title = topic.title.replace(/[<>]/g, '');
  const worker = isImplicit(topic.id) ? topic.id.slice(topic.id.indexOf(':') + 1) : '';
  const line = worker
    ? fr
      ? `[Hub] Ce message porte sur le chantier du worker ${worker}, qui n'a pas encore de sujet : déclare-en un avec \`topic\` (workers: ["${worker}"]).`
      : `[Hub] This message is about the job of worker ${worker}, which has no topic yet: declare one with \`topic\` (workers: ["${worker}"]).`
    : from === 'user'
      ? fr
        ? `[Hub] L'utilisateur écrit ce message dans le sujet « ${title} » (id ${topic.id}) : réponds dans ce sujet.`
        : `[Hub] The user writes this message in the topic "${title}" (id ${topic.id}): answer in that topic.`
      : fr
        ? `[Hub] Sujet : « ${title} » (id ${topic.id}).`
        : `[Hub] Topic: "${title}" (id ${topic.id}).`;
  return `<hub-topic id="${topic.id}">\n${line}\n</hub-topic>`;
}

const NOTE_BLOCK = /<hub-note>[\s\S]*?<\/hub-note>/g;
const TOPIC_BLOCK = /<hub-topic id="([^"\n]{1,80})">/g;

/**
 * The topic a stored message carries: the hub's own block, read outside the notes (a worker's words only ever travel
 * inside a note, which they cannot close), the last one when there are several.
 */
export function topicOfText(text: string): string | null {
  const ids = [...text.replace(NOTE_BLOCK, '').matchAll(TOPIC_BLOCK)].map((m) => m[1]);
  const id = ids.at(-1);
  return isTopicId(id) ? id : null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The session a spawn_worker call makes, named as spawnWorker() names it (a name taken twice gets "-2" there). */
export function spawnedName(input: Record<string, unknown>): string {
  const role = slugify(str(input.role), 40);
  const name = str(input.name);
  return role ? `hub-${slugify(`${role}-${topicOf(name, role) || 'work'}`, 48)}` : `hub-${slugify(name, 28) || 'worker'}`;
}

/**
 * One frame of the master's reply as the topics read it, live and from the transcript alike: its words and thinking
 * first (`items`, the frame's items but its tool calls), then its tool calls in order, a topic call switching the
 * topic of the calls after it, a call that writes to a worker filed under the topic that worker was named in.
 */
export function frameSteps(blocks: Record<string, unknown>[], items: { id: string; kind: string }[]): ReplayStep[] {
  const steps: ReplayStep[] = items.map((i) => ({ kind: 'item', id: i.id, text: i.kind === 'assistant' }));
  for (const b of blocks) {
    if (b.type !== 'tool_use') continue;
    const input = (b.input ?? {}) as Record<string, unknown>;
    if (b.name === TOPIC_TOOL) {
      const call = parseTopicCall(input);
      if (call) steps.push({ kind: 'topic', call });
      continue;
    }
    const spawn = b.name === 'mcp__hub__spawn_worker';
    const worker = spawn ? spawnedName(input) : b.name === 'mcp__hub__message_worker' ? workerName(str(input.name)) : '';
    if (worker) steps.push({ kind: 'wrote', worker, ...(spawn ? { spawn } : {}) });
    steps.push({ kind: 'item', id: str(b.id), tool: true, ...(worker ? { worker } : {}) });
  }
  return steps;
}

/**
 * Where a stored message of the master's conversation comes from: the user, a worker, or the hub. A worker's direct
 * message (SendMessage) is its own text from end to end: any block in it is the worker's, never the hub's.
 */
export function replayInput(kind: 'user' | 'peer', from: string, raw: string): TopicInput {
  const topic = /<cross-session-message\b/.test(raw) ? null : topicOfText(raw);
  if (kind === 'user') return { user: true, topic };
  return from === 'hub' ? { topic } : { worker: workerName(from) || null, topic };
}

/** The `topic` tool's words for the model; sessions.ts gives it its schema. */
export function topicToolSpec(l: Lang = lang()) {
  const fr = l === 'fr';
  return {
    description: fr
      ? "Range ta réponse dans un sujet (un chantier) : le hub classe ta conversation par sujet pour l'utilisateur et lui montre un badge tant que tu attends sa réponse. Appelle-le au début de chaque réponse qui porte sur un chantier, avant tout autre outil."
      : 'Files your reply under a topic (a job): the hub sorts your conversation by topic for the user and shows them a badge while you wait for their answer. Call it at the start of every reply about a job, before any other tool.',
    fields: {
      id: fr
        ? "Identifiant stable, en minuscules avec tirets (ex. paiements-niveau-a). Réutilise celui d'un sujet existant."
        : 'Stable id, lowercase with dashes (e.g. payments-level-a). Reuse the id of an existing topic.',
      title: fr
        ? `Titre court, 3 à 6 mots, ${TOPIC_LIMITS.title} caractères au plus (ex. « Paiements · niveau A »). Obligatoire pour un nouveau sujet.`
        : `Short title, 3 to 6 words, ${TOPIC_LIMITS.title} characters at most (e.g. "Payments · level A"). Required for a new topic.`,
      awaiting_user: fr
        ? "true quand ta réponse pose une question à l'utilisateur ou attend son go, son avis ou une validation ; sinon false."
        : 'true when your reply asks the user a question or waits for their go-ahead, opinion or approval; otherwise false.',
      question: fr ? 'Ce que tu attends de lui, en une phrase courte.' : 'What you wait for from them, in one short sentence.',
      workers: fr ? 'Les workers qui travaillent sur ce sujet.' : 'The workers working on this topic.',
    },
  };
}

export const topicErrors = (l: Lang = lang()) =>
  l === 'fr'
    ? { id: 'id invalide : des lettres et des chiffres, en minuscules avec tirets.', title: 'Nouveau sujet : donne aussi un `title` court.' }
    : { id: 'Invalid id: letters and digits, lowercase with dashes.', title: 'New topic: give a short `title` too.' };

/** The tool's answer: short, with the other topics when one is created (so the next replies reuse their ids). */
export function topicAnswer(topic: Topic, created: boolean, others: Topic[], l: Lang = lang()): string {
  const fr = l === 'fr';
  const head = fr ? `Sujet « ${topic.title} » (${topic.id})${created ? ' créé' : ''}.` : `Topic "${topic.title}" (${topic.id})${created ? ' created' : ''}.`;
  const badge = topic.awaiting ? (fr ? " Badge affiché jusqu'à la réponse de l'utilisateur." : ' Badge shown until the user answers.') : '';
  const named = others.filter((o) => !isImplicit(o.id)).slice(0, 12);
  const list = created && named.length > 0 ? `\n${fr ? 'Autres sujets' : 'Other topics'} : ${named.map((o) => `${o.id} « ${o.title} »`).join(' · ')}` : '';
  return `${head}${badge}${list}`;
}

/** The master's rules for topics, in its system prompt. */
export function topicsSection(l: Lang = lang()): string {
  if (l === 'fr') {
    return `## Sujets
L'utilisateur suit plusieurs chantiers à la fois dans ta conversation ; le hub la range par sujet avec l'outil \`topic\`.
- Un sujet = un chantier (une demande et ses suites), jamais plusieurs chantiers regroupés. Plusieurs workers peuvent partager un sujet s'ils travaillent au même chantier.
- Au début de chaque réponse qui porte sur un chantier, avant tout autre outil, appelle \`topic\` : \`id\` stable (réutilise celui du sujet existant), \`title\` court (« Paiements · niveau A »), \`workers\` de ce chantier seulement.
- Réponse qui touche plusieurs chantiers (tu en lances plusieurs, un retour en concerne un autre) : un appel \`topic\` par chantier, chacun juste avant les outils de ce chantier ; le hub range chaque outil et chaque worker sous le dernier sujet nommé.
- \`awaiting_user: true\`, avec \`question\`, sur le sujet où tu poses une question à l'utilisateur ou attends son go, son avis ou une validation ; sinon \`false\`. Si tu t'en aperçois en cours de réponse, rappelle \`topic\` pour ce sujet à la fin.
- Un message général (point sur tout, question sans chantier) : pas de \`topic\`, il reste dans « Tout ».
- Un bloc <hub-topic> dans un message de l'utilisateur ou du hub te dit à quel sujet il se rattache : réponds dans ce sujet.`;
  }
  return `## Topics
The user follows several jobs at once in your conversation; the hub sorts it by topic with the \`topic\` tool.
- A topic = one job (a request and its follow-ups), never several jobs together. Several workers may share a topic when they work on the same job.
- At the start of every reply about a job, before any other tool, call \`topic\`: a stable \`id\` (reuse the existing topic's), a short \`title\` ("Payments · level A"), the \`workers\` of that job only.
- A reply about several jobs (you start several, a report concerns another one): one \`topic\` call per job, each right before that job's tools; the hub files each tool and each worker under the topic named last.
- \`awaiting_user: true\`, with \`question\`, on the topic where you ask the user a question or wait for their go-ahead, opinion or approval; otherwise \`false\`. If you notice it during your reply, call \`topic\` again for that topic at the end.
- A general message (an overview, a question about no job): no \`topic\`, it stays in "All".
- A <hub-topic> block in a message of the user or the hub tells you which topic it belongs to: answer in that topic.`;
}
