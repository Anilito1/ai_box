import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { agentToRole, parseAgentFile } from '../shared/team';
import type { AgentFile } from '../shared/types';
import { masterCwd, type HubConfig } from './config';

const FILES_MAX = 50;
const FILE_BYTES_MAX = 64 * 1024;

/**
 * Claude Code subagent files a post can start from: the user's (~/.claude/agents) and those of the followed repos.
 * A repo's subagent works in that repo; a user subagent in the master's folder, until the user picks another one.
 */
export function agentFiles(cfg: HubConfig): AgentFile[] {
  const places = [
    { scope: 'user', dir: join(homedir(), '.claude', 'agents'), folder: masterCwd(cfg) },
    ...cfg.mainRepos.map((repo) => ({ scope: basename(repo), dir: join(repo, '.claude', 'agents'), folder: repo })),
  ];
  const found: AgentFile[] = [];
  for (const { scope, dir, folder } of places) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md'));
    } catch {
      continue; // No agents folder there.
    }
    for (const name of names.slice(0, FILES_MAX)) {
      const path = join(dir, name);
      try {
        // A plain file only: a link in a cloned repo could point anywhere on this computer.
        const info = lstatSync(path);
        if (!info.isFile() || info.size > FILE_BYTES_MAX) continue;
        const parsed = parseAgentFile(readFileSync(path, 'utf8'));
        if (!parsed) continue;
        const { role, ignored } = agentToRole(parsed, folder);
        if (role.name) found.push({ scope, path, role, ignored });
      } catch {
        // Unreadable file: left out.
      }
    }
  }
  return found;
}
