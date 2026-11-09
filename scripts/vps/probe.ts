// Phase 1 check of remote workers, outside the app: Claude Code on the server through the hub's own SSH spawner
// (src/main/remote.ts), with an in-process MCP tool and a permission prompt answered here, as the hub does.
//
//   npx esbuild scripts/vps/probe.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.probe.mjs
//   node node_modules/.probe.mjs <remote.json> <server folder> [cut]
//
// remote.json holds the `remoteWorkers` settings. Prints one line per measure; `cut` also kills the SSH connection
// in the middle of a turn, to see what the session does.
import { readFileSync } from 'node:fs';
import { createSdkMcpServer, query, tool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { parseRemote, remoteSpawner, remoteTranscript } from '../../src/main/remote';

const [file, cwd, mode] = process.argv.slice(2);
if (!file || !cwd) throw new Error('usage: probe <remote.json> <server folder> [cut]');
const r = parseRemote({ ...JSON.parse(readFileSync(file, 'utf8')), enabled: true });
const ms = (t: number) => Math.round(performance.now() - t);
const say = (what: string, value: unknown) => console.log(`${what}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

// 1. The round trip of a request that does nothing: connection, key, launcher.
const trips: number[] = [];
for (let i = 0; i < 5; i++) {
  const t = performance.now();
  await remoteTranscript(r, '00000000-0000-0000-0000-000000000000');
  trips.push(ms(t));
}
say('ssh round trip ms (5 runs)', trips);

// 2. A turn: a hub tool, a permission prompt, the reply streamed.
let sshPid = 0;
const marks: Record<string, number> = {};
const t0 = performance.now();
const mark = (k: string) => (marks[k] ??= ms(t0));
const ping = tool('ping', 'Answers pong with the time it was called.', { value: z.string() }, async ({ value }) => {
  mark('hub tool called');
  return { content: [{ type: 'text', text: `pong ${value}` }] };
});
const options: Options = {
  cwd,
  spawnClaudeCodeProcess: remoteSpawner(r, cwd, (pid) => (sshPid = pid), (text) => process.stderr.write(`[ssh] ${text}`)),
  mcpServers: { hub: createSdkMcpServer({ name: 'hub', version: '0', tools: [ping] }) },
  allowedTools: ['mcp__hub__ping'],
  permissionMode: 'default',
  includePartialMessages: true,
  canUseTool: async (name, input) => {
    mark(`permission asked (${name})`);
    return { behavior: 'allow', updatedInput: input };
  },
};
const prompt =
  mode === 'cut'
    ? 'Run this exact Bash command and wait for it: sleep 45 && echo slept. Then reply DONE.'
    : 'Call the ping tool with value "a". Then run `git log -1 --oneline` with Bash. Reply with the pong text and the commit line, nothing else.';
let id = '';
let cut = false;
try {
  for await (const m of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
    if (m.type === 'system' && m.subtype === 'init') {
      id = m.session_id;
      mark('init');
    }
    if (m.type === 'stream_event') mark('first streamed event');
    if (m.type === 'assistant' && JSON.stringify(m.message.content).includes('"tool_use"')) {
      mark('first tool use');
      if (mode === 'cut' && !cut && JSON.stringify(m.message.content).includes('sleep')) {
        cut = true;
        setTimeout(() => {
          mark('ssh killed');
          if (sshPid > 0) process.kill(sshPid);
        }, 5000);
      }
    }
    if (m.type === 'result') {
      mark('result');
      say('result', `${m.subtype} ${'result' in m ? String(m.result).slice(0, 200) : ''}`);
    }
  }
} catch (err) {
  mark('stream error');
  say('error', err instanceof Error ? err.message.slice(0, 300) : String(err));
}
say('timeline ms', marks);
say('conversation', id);

// 3. The transcript as the hub reads it back after a restart.
if (id) {
  const t = performance.now();
  const entries = await remoteTranscript(r, id);
  say('transcript', `${entries?.length ?? 'none'} entries in ${ms(t)} ms`);
}
