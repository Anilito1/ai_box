import { IMAGE_TYPES, type ChatItem } from '../shared/types';
import { lang, t } from './i18n';
import { blocksOf, type Block } from './providers/blocks';
import { masterName } from './prompts';

// Converts Anthropic message content blocks (live SDK frames or stored transcripts) into chat items.


const RESULT_MAX = 6000;
const DETAIL_MAX = 4000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);

export { blocksOf };

/** Claude Code's tools and the hub's own, as a step names them in the user's language. */
const LABELS: Record<string, Parameters<typeof t>[0]> = {
  Read: 'label.read',
  Edit: 'label.edit',
  MultiEdit: 'label.edit',
  Write: 'label.write',
  NotebookEdit: 'label.notebook',
  Bash: 'label.command',
  PowerShell: 'label.command',
  BashOutput: 'label.output',
  TaskOutput: 'label.output',
  KillShell: 'label.stop',
  KillBash: 'label.stop',
  TaskStop: 'label.stop',
  Grep: 'label.grep',
  Glob: 'label.glob',
  WebFetch: 'label.webFetch',
  WebSearch: 'label.webSearch',
  TodoWrite: 'label.todos',
  Task: 'label.subagent',
  Agent: 'label.subagent',
  ToolSearch: 'label.toolSearch',
  SendMessage: 'label.message',
  ExitPlanMode: 'label.plan',
  Skill: 'label.skill',
  mcp__hub__list_workers: 'label.listWorkers',
  mcp__hub__list_repos: 'label.listRepos',
  mcp__hub__spawn_worker: 'label.spawnWorker',
  mcp__hub__message_worker: 'label.messageWorker',
  mcp__hub__message_master: 'label.messageMaster',
  mcp__hub__worker_report: 'label.workerReport',
  mcp__hub__close_worker: 'label.closeWorker',
  mcp__hub__list_roles: 'label.listRoles',
  mcp__hub__create_role: 'label.createRole',
  mcp__hub__update_role: 'label.updateRole',
  mcp__hub__delete_role: 'label.deleteRole',
  mcp__hub__topic: 'topics.label',
};

/** A tool's name for the user: ours in their language, another server's as "server · tool". */
export function toolLabel(name: string): string {
  if (LABELS[name]) return t(LABELS[name]);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/** A file as a step shows it: its folder and name, not the whole path (the step's detail keeps it). */
const shortPath = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join('/');

export function toolSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return t('todos', { n: input.todos.length });
  // A session's reference ("hub-maitre [f62b1e]") keeps its name only.
  if (name === 'SendMessage') return `→ ${str(input.to).replace(/\s*\[[0-9a-f]{4,}\]$/i, '')}`;
  // "select:mcp__hub__update_role,…": the tools it looks for, named as the steps name them.
  if (name === 'ToolSearch') {
    const query = str(input.query);
    const picked = /^select:(.+)$/.exec(query)?.[1].split(',').map((n) => toolLabel(n.trim()));
    return (picked ? picked.join(', ') : query).slice(0, 180);
  }
  // The hub's own tools are about a worker or a post: its name says it best.
  const keys = name.startsWith('mcp__hub__')
    ? ['name', 'to']
    : ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'name', 'to', 'path', 'prompt'];
  const key = keys.find((k) => typeof input[k] === 'string' && (input[k] as string).length > 0);
  if (!key) return '';
  const value = input[key] as string;
  return (['file_path', 'notebook_path', 'path'].includes(key) ? shortPath(value) : value).replace(/\s+/g, ' ').slice(0, 180);
}

/** Human-readable detail of a tool call; edits become +/- line diffs. */
export function toolDetail(name: string, input: Record<string, unknown>): { detail: string; diff: boolean } {
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const minus = input.old_string.split('\n').map((l) => `- ${l}`);
    const plus = input.new_string.split('\n').map((l) => `+ ${l}`);
    return { detail: clip([...minus, ...plus].join('\n'), DETAIL_MAX), diff: true };
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return { detail: clip(input.content.split('\n').map((l) => `+ ${l}`).join('\n'), DETAIL_MAX), diff: true };
  }
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    const marks: Record<string, string> = { completed: '✓', in_progress: '→', pending: '○' };
    const lines = (input.todos as Block[]).map((t) => `${marks[str(t.status)] ?? '○'} ${str(t.content)}`);
    return { detail: lines.join('\n'), diff: false };
  }
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') {
    return { detail: input.command, diff: false };
  }
  if (name === 'ExitPlanMode' && typeof input.plan === 'string') return { detail: input.plan, diff: false };
  return { detail: clip(JSON.stringify(input, null, 2), DETAIL_MAX), diff: false };
}

// Matched at the start of each command of a chain (`cd x && npm test`), never inside an argument or a message.
const TEST_CMD = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|vitest|jest|pytest|mocha|playwright\s+test|deno\s+test|cargo\s+test|go\s+test|node\s+--test)\b/;
const DEPLOY_CMD =
  /^(?:supabase\s+(?:functions\s+deploy|db\s+push)|wrangler\s+(?:pages\s+)?deploy|(?:npm|pnpm|yarn|bun)\s+run\s+deploy|netlify\s+deploy|firebase\s+deploy|vercel\b.*\s--prod)\b/;
const PUSH_CMD = /^git\s+(?:-C\s+\S+\s+)?push\b(?!.*--dry-run)/;
/** A test report with failures (jest, vitest, playwright, pytest, mocha, go, cargo, node --test). */
const TESTS_FAILED = /\b[1-9]\d*\s+(?:failed|failing)\b|^\s*FAIL\b|^# fail [1-9]/m;
const PUSH_REFUSED = /\[rejected\]|\berror:|\bfatal:|Everything up-to-date/i;

const commandsOf = (line: string) =>
  line
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim().replace(/^(?:npx|bunx|pnpm\s+dlx)\s+/, ''));

/** What a finished shell command shipped or broke (a push, a deploy, failing tests), for the mascots to react. */
export function commandOutcome(command: string, failed: boolean, output: string): 'pushed' | 'deployed' | 'tests_failed' | null {
  const commands = commandsOf(command);
  if (commands.some((c) => TEST_CMD.test(c)) && TESTS_FAILED.test(output)) return 'tests_failed';
  if (failed) return null;
  if (commands.some((c) => DEPLOY_CMD.test(c))) return 'deployed';
  return commands.some((c) => PUSH_CMD.test(c)) && !PUSH_REFUSED.test(output) ? 'pushed' : null;
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return clip(content, RESULT_MAX);
  if (!Array.isArray(content)) return '';
  const text = (content as Block[])
    .map((b) => (b.type === 'text' ? str(b.text) : b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
  return clip(text, RESULT_MAX);
}

/** Items for the blocks of one assistant frame. `textId` lets a streamed preview keep its id. */
export function assistantItems(blocks: Block[], baseId: string, textId?: string): ChatItem[] {
  const items: ChatItem[] = [];
  let previewId = textId;
  blocks.forEach((b, i) => {
    if (b.type === 'text' && str(b.text).trim()) {
      // Only the first text block takes over the streamed preview; later ones need their own ids.
      items.push({ kind: 'assistant', id: previewId ?? `${baseId}:${i}`, text: str(b.text), live: false });
      previewId = undefined;
    } else if (b.type === 'thinking' && str(b.thinking).trim()) {
      items.push({ kind: 'thinking', id: `${baseId}:${i}`, text: str(b.thinking) });
    } else if (b.type === 'tool_use') {
      const input = (b.input ?? {}) as Record<string, unknown>;
      const name = str(b.name);
      items.push({
        kind: 'tool',
        id: str(b.id),
        name: toolLabel(name),
        summary: toolSummary(name, input),
        ...toolDetail(name, input),
        result: null,
        isError: false,
      });
    }
  });
  return items;
}

const PEER = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/;
const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? '';

/** The tags of prompts.ts in either language: a transcript keeps the language it was written in. */
const TAGGED = /^\[(Mission du maître[^\]\n]*|Message du maître|Mission from the master[^\]\n]*|Message from the master|Hub|Message du worker "([^"\n]+)"|Message from worker "([^"\n]+)")\]\s*/;
/** Appended for each image saved to disk, so the model can hand its path to another session. */
export const capturedLine = (path: string) => (lang() === 'fr' ? `[Capture jointe : ${path}]` : `[Attached image: ${path}]`);
const CAPTURED = /^\[(?:Capture jointe :|Attached image:) [^\]\n]+\]\n?/gm;

/**
 * What the hub adds to a message for the model alone: a changed team or post, a handoff note, or the instructions
 * behind a short message the user reads (<hub-note>).
 */
const HUB_BLOCK = /\s*<hub-(roster|post|note|handoff|topic)\b[^>\n]*>[\s\S]*?<\/hub-\1>/g;
const HUB_NOTE = /<hub-note>([\s\S]*?)<\/hub-note>/;
/**
 * A worker's own words inside a hub note, between random tags nothing in them can close; the opening tag starts a line
 * (the note's prose may name the tag before).
 */
const WORKER_OUTPUT = /(?:^|\n)<(worker-output-[\w-]+)>\n?([\s\S]*?)\n?<\/\1>/;

/** Text as the user sees it: without the saved-image lines and the hub's blocks, which the model alone needs. */
export const visibleText = (text: string) => text.replace(CAPTURED, '').replace(HUB_BLOCK, '').trim();

const preview = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 280 ? `${line.slice(0, 280)}…` : line;
};

/**
 * Sender of a hub-delivered message (the master, a worker, or "hub") and the text the user reads: without the tag nor
 * what the model alone needs. A worker's words come from its note; a hub message keeps its short line, with a preview
 * of the worker's words it carries.
 */
export function taggedSender(text: string): { from: string; text: string } | null {
  const m = TAGGED.exec(text);
  if (!m) return null;
  const body = text.slice(m[0].length);
  const quoted = WORKER_OUTPUT.exec(HUB_NOTE.exec(body)?.[1] ?? '')?.[2]?.trim() ?? '';
  const worker = m[2] ?? m[3];
  if (worker) return { from: worker, text: quoted || visibleText(body) };
  if (m[1] !== 'Hub') return { from: masterName(), text: visibleText(body) };
  const line = visibleText(body);
  return { from: 'hub', text: quoted ? `${line}\n\n> ${preview(quoted)}` : line };
}

/** data: URLs of the base64 images of a user message. */
function imagesOf(blocks: Block[]): string[] {
  return blocks.flatMap((b) => {
    const source = (b.type === 'image' ? b.source : null) as Block | null;
    const type = str(source?.media_type);
    return source?.type === 'base64' && (IMAGE_TYPES as readonly string[]).includes(type) ? [`data:${type};base64,${str(source.data)}`] : [];
  });
}

/** Text and images the user, a peer session or the hub sent, from a stored transcript entry. */
export function userTextItem(blocks: Block[], id: string): Extract<ChatItem, { kind: 'user' | 'peer' }> | null {
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => str(b.text))
    .join('\n')
    .trim();
  const images = imagesOf(blocks);
  if ((!text && images.length === 0) || /^(<system-reminder>|<command-|<local-command|Caveat:)/.test(text)) return null;
  const peer = PEER.exec(text);
  if (peer) return { kind: 'peer', id, from: attr(peer[1], 'from-name') || attr(peer[1], 'from'), text: peer[2].trim() };
  const tagged = taggedSender(text);
  if (tagged) return { kind: 'peer', id, ...tagged };
  return { kind: 'user', id, text: visibleText(text), images };
}
