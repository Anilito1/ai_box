/** Commands the hub runs itself, in every session (master, worker or post), in the order the menu lists them. */
export const HUB_COMMANDS = ['compact', 'clear', 'model', 'effort', 'mode', 'cost', 'help'] as const;
export type HubCommand = (typeof HUB_COMMANDS)[number];

/** A command or skill of Claude Code, as the session lists it. */
export interface CliCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
}

/**
 * Claude Code commands the menu never offers: the hub has its own version (clear, compact, model, effort, cost), or
 * they would break the hub's session (its name is how the sessions reach each other) or only make sense in a terminal.
 */
const HIDDEN = new Set(['clear', 'compact', 'model', 'effort', 'cost', 'rename', 'color', 'focus', 'heapdump', 'exit', 'quit', 'resume', 'login', 'logout', 'config']);

export const visibleCli = (c: CliCommand) => !HIDDEN.has(c.name.toLowerCase()) && !c.name.startsWith('_');

export interface SlashInput {
  name: string;
  arg: string;
}

/** "/name args" at the start of a message, or null for plain text: a path such as /usr/bin is text, not a command. */
export function parseSlash(text: string): SlashInput | null {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], arg: (m[2] ?? '').trim() } : null;
}

export type SlashTarget = { kind: 'hub'; command: HubCommand; arg: string } | { kind: 'cli'; command: CliCommand; arg: string } | { kind: 'unknown'; name: string };

/** The hub's own commands first, then Claude Code's by name or alias; case does not matter. */
export function resolveSlash(input: SlashInput, cli: CliCommand[]): SlashTarget {
  const name = input.name.toLowerCase();
  const hub = HUB_COMMANDS.find((c) => c === name);
  if (hub) return { kind: 'hub', command: hub, arg: input.arg };
  const command = cli.filter(visibleCli).find((c) => c.name.toLowerCase() === name || c.aliases.some((a) => a.toLowerCase() === name));
  return command ? { kind: 'cli', command, arg: input.arg } : { kind: 'unknown', name: input.name };
}

/**
 * Commands for what is typed after "/": names starting with it first, then names containing it, then (from three
 * letters on, so two letters do not match half the list) descriptions.
 */
export function filterCommands<T extends { name: string; description: string }>(list: T[], query: string): T[] {
  const q = query.toLowerCase();
  if (!q) return list;
  const rank = (c: T) => {
    const name = c.name.toLowerCase();
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : q.length >= 3 && c.description.toLowerCase().includes(q) ? 2 : 3;
  };
  return list
    .map((c, i) => ({ c, i, r: rank(c) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/** Lowercase, without accents, spaces or punctuation: "Accept Edits", "acceptEdits" and "accept-edits" read the same. */
export const foldWord = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * The option an argument names, by any of its names: an exact name first, then the first one starting with it, then
 * the first one containing it. Null when none matches.
 */
export function pickOption<T>(options: { value: T; names: string[] }[], arg: string): T | null {
  const a = foldWord(arg);
  if (!a) return null;
  const names = (o: { names: string[] }) => o.names.map(foldWord).filter(Boolean);
  return (
    options.find((o) => names(o).includes(a))?.value ??
    options.find((o) => names(o).some((n) => n.startsWith(a)))?.value ??
    options.find((o) => names(o).some((n) => n.includes(a)))?.value ??
    null
  );
}

/** A required argument ("<instruction>"): picking the command completes it rather than running it bare. */
export const needsArgument = (hint: string) => hint.trim().startsWith('<');
