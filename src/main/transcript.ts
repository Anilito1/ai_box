import { IMAGE_TYPES, type ChatItem } from '../shared/types';
import { lang, t } from './i18n';
import { masterName } from './prompts';

// Converts Anthropic message content blocks (live SDK frames or stored transcripts) into chat items.

type Block = Record<string, unknown>;

const RESULT_MAX = 6000;
const DETAIL_MAX = 4000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);

export const blocksOf = (message: unknown): Block[] => {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
};

export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

export function toolSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return t('todos', { n: input.todos.length });
  if (name === 'SendMessage') return `→ ${str(input.to)}`;
  const keys = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'name', 'to', 'path', 'prompt'];
  const value = keys.map((k) => input[k]).find((v): v is string => typeof v === 'string' && v.length > 0) ?? '';
  return value.replace(/\s+/g, ' ').slice(0, 180);
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
const TAGGED = /^\[(Mission du maître[^\]\n]*|Message du maître|Mission from the master[^\]\n]*|Message from the master|Hub)\]\s*/;
/** Appended for each image saved to disk, so the model can hand its path to another session. */
export const capturedLine = (path: string) => (lang() === 'fr' ? `[Capture jointe : ${path}]` : `[Attached image: ${path}]`);
const CAPTURED = /^\[(?:Capture jointe :|Attached image:) [^\]\n]+\]\n?/gm;

/** Text as the user sees it: without the saved-image lines the model alone needs. */
export const visibleText = (text: string) => text.replace(CAPTURED, '').trim();

/** Sender of a hub-delivered message (the master, or "hub"), and its text without the tag; null for a user message. */
export function taggedSender(text: string): { from: string; text: string } | null {
  const m = TAGGED.exec(text);
  if (!m) return null;
  return { from: m[1] === 'Hub' ? 'hub' : masterName(), text: text.slice(m[0].length) };
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
