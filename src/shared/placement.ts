import type { TeamRole } from './types';

/** Programs of this PC a post may drive: named in what it does, it never runs elsewhere. */
const LOCAL_APPS = ['blender', 'unity', 'computer-use', 'claude in chrome'] as const;
/** MCP servers that reach this PC's programs, matched on a server's name or its command. */
const LOCAL_MCP = ['blender', 'unity', 'playwright', 'chrome', 'computer-use', 'desktop-commander', 'filesystem'] as const;

export type LocalReason = { kind: 'app' | 'mcp'; name: string } | { kind: 'folders' };

const mentions = (text: string, word: string) => new RegExp(`(^|[^a-z0-9])${word.replace(/[-\s]/g, '[-\\s]?')}($|[^a-z0-9])`, 'i').test(text);

/**
 * Why a post must run on this PC, or null when it may run on the remote server. `projectMcp` are the names and
 * commands of the MCP servers its folders declare (.mcp.json). Strict on purpose: a false "local" costs a launch here,
 * a false "remote" a worker without its tools, or one that reaches for this PC's files from the server.
 */
export function localReason(role: Pick<TeamRole, 'name' | 'description' | 'instructions' | 'folders'>, projectMcp: string[]): LocalReason | null {
  const text = [role.name, role.description, role.instructions].join('\n');
  const app = LOCAL_APPS.find((a) => mentions(text, a));
  if (app) return { kind: 'app', name: app };
  // Part of a word too: "unityMCP", "@playwright/mcp".
  const mcp = LOCAL_MCP.find((m) => projectMcp.some((s) => s.toLowerCase().includes(m)));
  if (mcp) return { kind: 'mcp', name: mcp };
  // Its other folders are paths of this PC: the server has no copy of them.
  if (role.folders.length > 1) return { kind: 'folders' };
  return null;
}

/** The names and commands of the servers an .mcp.json declares; nothing for a file that is not one. */
export function mcpServersOf(json: unknown): string[] {
  const servers = json && typeof json === 'object' ? (json as { mcpServers?: unknown }).mcpServers : null;
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers as Record<string, unknown>).flatMap(([name, def]) => {
    const d = (def && typeof def === 'object' ? def : {}) as { command?: unknown; args?: unknown; url?: unknown };
    const args = Array.isArray(d.args) ? d.args.filter((a): a is string => typeof a === 'string') : [];
    return [name, [d.command, ...args, d.url].filter((p): p is string => typeof p === 'string').join(' ')].filter(Boolean);
  });
}
