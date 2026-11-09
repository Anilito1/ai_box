// The runner's protocol end to end, with a real Claude Code on the server and the Agent SDK here, as the hub uses them:
// a turn starts, the hub leaves in the middle of it (as when the PC is switched off), the worker writes to the master
// meanwhile, then the hub comes back with the number of the last line it got.
//
//   npx esbuild scripts/vps/runner-e2e.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.runner-e2e.mjs
//   node node_modules/.runner-e2e.mjs <config.json from vps:connect> [away seconds, default 60]
//
// Checked: the second connection's `initialize` is answered (from the first one), the lines missed are given once, in
// order, the message written while away reaches the hub's tool once, the runner keeps nothing afterwards. One line per
// step, with its time.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSdkMcpServer, query, tool, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { notifyOf, parseRemote, remoteSpawner, remoteStatus, remoteStop } from '../../src/main/remote';

// `restart`: the runner is restarted while the hub is away (as a server reboot would): the cut turn is said, then taken up.
const [configFile, awayArg, mode] = process.argv.slice(2);
const restart = mode === 'restart';
if (!configFile) throw new Error('usage: runner-e2e <config.json> [away seconds]');
const r = parseRemote((JSON.parse(readFileSync(configFile, 'utf8')) as { remoteWorkers: unknown }).remoteWorkers);
const cwd = Object.values(r.repos)[0];
if (!r.enabled || !cwd) throw new Error('remote workers are not saved as on, with a clone, in this config');
const awayMs = Number(awayArg ?? 60) * 1000;
const t0 = performance.now();
const say = (what: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${what}`);
const id = randomUUID();
let seq = 0;
const seqs: number[] = [];
const reports: string[] = [];
const texts = { queued: 'Saved for the master (hub offline).', offline: 'The hub is offline.', late: '[written while offline, at {time}]', full: 'Too many kept.' };
const phone = { done: 'e2e: done', report: 'e2e: report', blocked: 'e2e: blocked', cut: 'e2e: cut', timeout: 'e2e: timeout', interrupted: 'e2e: interrupted' };

function session(resume: boolean, prompt: string | null) {
  const input = (async function* (): AsyncGenerator<SDKUserMessage> {
    if (prompt) yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: id };
    await new Promise(() => {});
  })();
  const hub = createSdkMcpServer({
    name: 'hub',
    version: '0.6.0',
    tools: [
      tool('message_master', 'Writes to the master.', { message: z.string() }, async ({ message }) => {
        reports.push(message);
        say(`hub tool message_master: ${JSON.stringify(message.slice(0, 120))}`);
        return { content: [{ type: 'text', text: 'Delivered.' }] };
      }),
    ],
  });
  return query({
    prompt: input,
    options: {
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      mcpServers: { hub },
      allowedTools: ['mcp__hub__message_master'],
      settingSources: [],
      ...(resume ? { resume: id } : { sessionId: id }),
      spawnClaudeCodeProcess: remoteSpawner(r, cwd, {
        texts,
        notify: notifyOf(r, phone),
        since: () => seq,
        onSeq: (n) => {
          seqs.push(n);
          seq = n;
        },
        onGap: () => say('GAP'),
        onStderr: (t) => process.stderr.write(t),
      }),
    },
  });
}

const kinds = (m: SDKMessage) => `${m.type}${'subtype' in m ? `/${m.subtype}` : ''}`;

// 1. A turn that outlives the hub: a pause, then a report, then the end.
const first = session(
  false,
  restart
    ? 'Run this Bash command with run_in_background: sleep 120. Wait for its completion notification (this wait is the test), then call the tool mcp__hub__message_master with the message "runner-e2e: report written while the hub was away". Then answer with one word: DONE.'
    : 'Run this Bash command in the foreground, not in the background: sleep 40. Then call the tool mcp__hub__message_master with the message "runner-e2e: report written while the hub was away". Then answer with one word: DONE.',
);
say(`started ${id.slice(0, 8)} in ${cwd}`);
for await (const m of first) {
  if (m.type === 'assistant' && JSON.stringify(m.message.content).includes('"tool_use"')) {
    say(`tool use seen at seq ${seq}: the hub leaves now`);
    break;
  }
}
first.close();
const left = performance.now();
say(`hub gone; away for ${awayMs / 1000}s`);
if (restart) {
  await new Promise((done) => setTimeout(done, 10_000));
  say('restarting the runner (as a reboot of the server would)');
  execFileSync('ssh', ['-i', join(process.env.USERPROFILE ?? '', '.ssh', 'aibox_admin'), '-o', 'BatchMode=yes', `${r.admin}@${r.host}`, 'sudo systemctl restart aibox-runner']);
}
await new Promise((done) => setTimeout(done, awayMs));
const st = await remoteStatus(r);
const mine = st?.runner?.sessions.find((x) => x.id === id);
say(`runner: ${JSON.stringify(mine)} rss=${st?.runner?.rssMb}MB live=${st?.runner?.live}`);

// 2. Back: the same conversation, from the last line got.
const before = seq;
const second = session(true, restart ? 'The server restarted during your turn, which was cut. Call the tool mcp__hub__message_master with the message "runner-e2e: taken up after the restart". Then answer with one word: DONE.' : null);
const init = await second.initializationResult();
say(`second initialize answered (${init.models.length} models), since=${before}`);
const replayed: string[] = [];
let done = false;
// The turn may still run (or a background task wake it again): until the report reached the hub and a turn ended after.
const limit = setTimeout(() => second.close(), 180_000);
for await (const m of second) {
  replayed.push(kinds(m));
  if (m.type === 'result') say(`result: ${m.subtype} ${JSON.stringify('result' in m ? m.result.slice(0, 40) : '')}`);
  if (m.type === 'result' && reports.length > 0) {
    done = true;
    break;
  }
}
clearTimeout(limit);
say(`replayed ${replayed.length} messages: ${replayed.join(' ')}; back in ${((performance.now() - left) / 1000).toFixed(1)}s after leaving`);
const ordered = seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1);
const after = (await remoteStatus(r))?.runner?.sessions.find((x) => x.id === id);
second.close();
await remoteStop(r, id);
const ok = restart
  ? done && mine?.interrupted === true && after?.interrupted === false && reports.length === 1 && reports[0].includes('taken up')
  : done && ordered && reports.length === 1 && reports[0].startsWith('[written while offline') && after?.outbox === 0;
say(`${ok ? 'OK' : 'FAILED'}: reports=${reports.length} ordered=${ordered} seqs=${seqs[0]}..${seqs.at(-1)} outbox after=${after?.outbox}`);
process.exit(ok ? 0 : 1);
