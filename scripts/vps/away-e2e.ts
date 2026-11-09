// "I'm stepping away" end to end, outside the app: the hub's own session manager runs a post's worker on this PC, moves
// it to the remote server, brings it back. Real Claude Code on both sides, real GitHub pushes, an isolated data folder.
//
//   npx esbuild scripts/vps/away-e2e.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.away-e2e.mjs
//   node node_modules/.away-e2e.mjs <config.json from vps:connect> <local checkout of a listed repo> <branch>
//
// Prints one line per step: what happened, how long it took, the server's memory. The master's messages are printed,
// not sent to a model.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../../src/main/config';
import type { CostLog } from '../../src/main/costLog';
import type { McpHub } from '../../src/main/mcpHub';
import { claudeExecutable } from '../../src/main/providers/claude/cli';
import { parseRemote, remoteLatency, remoteStatus } from '../../src/main/remote';
import { SessionManager } from '../../src/main/sessions';
import type { TeamRole } from '../../src/shared/types';
import { personalToken } from './token';

const [configFile, checkout, branch] = process.argv.slice(2);
if (!configFile || !checkout || !branch) throw new Error('usage: away-e2e <config.json> <checkout> <branch>');
const t0 = performance.now();
const at = () => `${Math.round((performance.now() - t0) / 1000)}s`;
const say = (what: string) => console.log(`[${at()}] ${what}`);

const token = personalToken();
const dir = mkdtempSync(join(tmpdir(), 'aibox-e2e-'));
const cfg = loadConfig(dir, 'fr');
cfg.onboarded = true;
cfg.workspaces = [resolve(checkout, '..')];
cfg.mainRepos = [resolve(checkout)];
cfg.remoteWorkers = parseRemote((JSON.parse(readFileSync(configFile, 'utf8')) as { remoteWorkers: unknown }).remoteWorkers);
if (!cfg.remoteWorkers.enabled) throw new Error('remote workers are not saved as on in this config');
const exe = await claudeExecutable(cfg);
const m = new SessionManager({
  cfg,
  dataDir: dir,
  executable: () => exe,
  codexExecutable: () => '',
  geminiExecutable: () => '',
  mcpHub: {} as McpHub,
  sessionEnv: () => ({ set: {}, unset: [] }),
  persist: () => undefined,
  costLog: { today: () => 0, append: () => undefined } as unknown as CostLog,
  capabilities: async () => '',
  // The user's fine-grained token, as the app takes it from its keychain (never this PC's GitHub CLI token).
  remoteServer: { wake: async () => null, idle: () => say('server may switch off'), state: () => '', secretsFor: async () => ({ GH_TOKEN: token }) },
});

interface Inner {
  sessions: Map<string, { id: string; status: string; inbox: unknown; remoteRun: unknown; away: unknown; lastMessage: string }>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  deliver(s: { id: string }, prompt: { text: string; from?: string; shown?: string }): void;
  notifyMaster(shown: string, note: string): void;
  messageMaster(s: { name: string }, message: string): string;
}
const inner = m as unknown as Inner;
// The master is this script: what it would get is printed, its model never runs.
inner.notifyMaster = (shown, note) => say(`MASTER <- ${shown} | ${note.replace(/\s+/g, ' ').slice(0, 600)}`);
// A worker's report, as the master would get it (same path for a live report and one read back from the server).
inner.messageMaster = (s, message) => (say(`REPORT from ${s.name}: ${message.replace(/\s+/g, ' ').slice(0, 400)}`), 'Delivered to the master.');
const deliver = inner.deliver.bind(m);
inner.deliver = (s, prompt) => {
  if (s.id === 'master') return say(`MASTER <- ${(prompt.shown ?? prompt.text).replace(/\s+/g, ' ').slice(0, 400)}`);
  deliver(s, prompt);
};

await inner.createRole({ name: 'remote-test', description: 'Test du serveur distant', folders: [resolve(checkout)] }, new AbortController().signal);
const post = cfg.team.find((r) => r.name === 'remote-test') as TeamRole;
post.mode = 'bypassPermissions';
const worker = () => inner.sessions.get(post.id)!;
const turnDone = () =>
  new Promise<void>((done) => {
    const on = (id: string, kind: string) => {
      if (id !== post.id || (kind !== 'turn_done' && kind !== 'crashed' && kind !== 'interrupted')) return;
      m.off('event', on);
      say(`worker: ${kind}`);
      done();
    };
    m.on('event', on);
  });
const memory = async () => {
  const st = await remoteStatus(cfg.remoteWorkers);
  return st ? `${st.memory.total - st.memory.available} MB used of ${st.memory.total}, ${st.running} remote run(s)` : 'server unreachable';
};

say(`server before: ${await memory()}; event round trip ${await remoteLatency(cfg.remoteWorkers)} ms`);
const file = 'VPS-TEST.md';
let done = turnDone();
m.send(post.id, `Mission de test du serveur distant, dans ce repo : crée la branche \`${branch}\` depuis origin/main (ou reprends-la si elle existe sur origin), ajoute au fichier ${file} une ligne « PC : <date et heure> », commite, pousse la branche sur origin. Réponds en une ligne.`);
await done;
say(`local turn 1 done: ${worker().lastMessage.slice(0, 200)}`);

done = turnDone();
m.send(post.id, `Suite : ajoute à ${file} une ligne « serveur : <date et heure> » et la sortie de \`hostname\`, commite, pousse. Puis fais ton rapport au maître avec message_master (une ligne, avec le dernier commit).`);
// Its turn under way: then the user steps away.
while (worker().status !== 'busy') await new Promise((r) => setTimeout(r, 500));
say('stepping away');
await m.stepAway(false);
say(`after step-away: away=${JSON.stringify(m.snapshot().sessions.find((s) => s.id === post.id)?.remote)}; ${await memory()}`);
const rss = () => {
  try {
    return execFileSync('ssh', ['-i', join(process.env.USERPROFILE ?? '', '.ssh', 'aibox_admin'), '-o', 'BatchMode=yes', `${cfg.remoteWorkers.admin}@${cfg.remoteWorkers.host}`, "ps -C claude -o rss= | awk '{s+=$1} END {print s/1024}'"], { encoding: 'utf8' }).trim();
  } catch {
    return '?';
  }
};
await new Promise((r) => setTimeout(r, 20_000));
say(`remote claude RSS while working: ${rss()} MB`);
await done.catch(() => undefined);
// The remote turn: wait for its end.
await new Promise<void>((r) => {
  const check = setInterval(() => {
    const s = worker();
    if (s.remoteRun && s.status === 'idle') {
      clearInterval(check);
      r();
    }
  }, 2000);
});
say(`remote turn done: ${worker().lastMessage.slice(0, 200)}`);
say('coming back');
await m.comeBack();
say(`after return: phase=${m.awayPhase()}, remote=${JSON.stringify(m.snapshot().sessions.find((s) => s.id === post.id)?.remote ?? null)}`);
await turnDone();
say(`local after return: ${worker().lastMessage.slice(0, 300)}`);
say(`local file:\n${readFileSync(join(checkout, file), 'utf8')}`);
say(`local log: ${execFileSync('git', ['-C', checkout, 'log', '--oneline', '-4'], { encoding: 'utf8' })}`);
m.killAll();
process.exit(0);
