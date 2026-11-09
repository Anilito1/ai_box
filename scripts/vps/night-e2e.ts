// "I'm stepping away", the AI Box closed, then "I'm back", end to end: the hub's own session manager, a real worker
// started on this PC, real Claude Code on both sides, real GitHub pushes, an isolated data folder kept between the two
// runs (the app's own data folder is never touched).
//
//   npx esbuild scripts/vps/night-e2e.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.night-e2e.mjs
//   node node_modules/.night-e2e.mjs leave <config.json from vps:connect> <data folder> <local checkout of a listed repo, on its branch>
//   ... the AI Box "closed" (this process ends), as long as you want ...
//   node node_modules/.night-e2e.mjs back <config.json> <data folder>
//
// The master is this script: what it would get is printed, its model never runs. One line per step, with its time.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, saveConfig } from '../../src/main/config';
import type { CostLog } from '../../src/main/costLog';
import type { McpHub } from '../../src/main/mcpHub';
import { claudeExecutable } from '../../src/main/providers/claude/cli';
import { parseRemote, remoteStatus } from '../../src/main/remote';
import { SessionManager } from '../../src/main/sessions';
import type { TeamRole } from '../../src/shared/types';
import { personalToken } from './token';

const [phase, configFile, dataArg, checkout] = process.argv.slice(2);
if ((phase !== 'leave' && phase !== 'back') || !configFile || !dataArg || (phase === 'leave' && !checkout)) {
  throw new Error('usage: night-e2e leave <config.json> <data folder> <checkout> | back <config.json> <data folder>');
}
const dir = resolve(dataArg);
mkdirSync(dir, { recursive: true });
const t0 = performance.now();
const say = (what: string) => console.log(`[${new Date().toISOString().slice(11, 19)}Z +${Math.round((performance.now() - t0) / 1000)}s] ${what}`);
const token = personalToken();
const cfg = loadConfig(dir, 'fr');
cfg.onboarded = true;
if (checkout) {
  cfg.workspaces = [resolve(checkout, '..')];
  cfg.mainRepos = [resolve(checkout)];
}
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
  persist: () => saveConfig(dir, cfg),
  costLog: { today: () => 0, append: () => undefined } as unknown as CostLog,
  capabilities: async () => '',
  remoteServer: { wake: async () => null, idle: () => say('server may switch off'), state: () => '', secretsFor: async () => ({ GH_TOKEN: token }) },
});

interface Inner {
  sessions: Map<string, { id: string; name: string; status: string; inbox: unknown; remoteRun: { state: string; seq: number } | null; away: { branch: string; base: string } | null; lastMessage: string; cwd: string }>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  deliver(s: { id: string }, prompt: { text: string; from?: string; shown?: string }): void;
  notifyMaster(shown: string, note: string): void;
  messageMaster(s: { name: string }, message: string): string;
}
const inner = m as unknown as Inner;
const reports: string[] = [];
inner.notifyMaster = (shown, note) => say(`MASTER <- ${shown} | ${note.replace(/\s+/g, ' ').slice(0, 700)}`);
inner.messageMaster = (s, message) => {
  reports.push(message);
  say(`REPORT from ${s.name}: ${message.replace(/\s+/g, ' ').slice(0, 900)}`);
  return 'Delivered to the master.';
};
const deliver = inner.deliver.bind(m);
inner.deliver = (s, prompt) => {
  if (s.id === 'master') return say(`MASTER <- ${(prompt.shown ?? prompt.text).replace(/\s+/g, ' ').slice(0, 400)}`);
  deliver(s, prompt);
};

const runner = async () => {
  const st = await remoteStatus(cfg.remoteWorkers);
  const r = st?.runner;
  return st ? `server ${st.memory.total - st.memory.available}/${st.memory.total} MB used; runner ${r?.rssMb ?? '?'} MB, ${r?.live ?? 0} live; ${JSON.stringify(r?.sessions.filter((x) => x.live || x.outbox > 0).map((x) => ({ id: x.id.slice(0, 8), state: x.state, outbox: x.outbox, attached: x.attached })))}` : 'server unreachable';
};
const claudeRss = () => {
  try {
    return execFileSync('ssh', ['-i', join(process.env.USERPROFILE ?? '', '.ssh', 'aibox_admin'), '-o', 'BatchMode=yes', `${cfg.remoteWorkers.admin}@${cfg.remoteWorkers.host}`, "ps -C claude -o rss= | awk '{s+=$1} END {print s/1024}'"], { encoding: 'utf8' }).trim();
  } catch {
    return '?';
  }
};
const until = async (what: string, ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const state = join(dir, 'night-e2e.json');

if (phase === 'leave') {
  await inner.createRole({ name: 'night-proof', description: 'Preuve du runner du serveur distant', folders: [resolve(checkout)] }, new AbortController().signal);
  const post = cfg.team.find((r) => r.name === 'night-proof') as TeamRole;
  post.mode = 'bypassPermissions';
  saveConfig(dir, cfg);
  const branch = execFileSync('git', ['-C', checkout, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(state, JSON.stringify({ post: post.id, checkout: resolve(checkout), branch }));
  const worker = () => inner.sessions.get(post.id)!;
  say(`${await runner()}`);
  m.send(
    post.id,
    [
      `Mission de preuve, dans ce repo, sur la branche courante \`${branch}\` (déjà poussée sur origin) :`,
      '1. Crée le fichier NIGHT-PROOF.md s’il n’existe pas.',
      '2. Six fois de suite : ajoute à NIGHT-PROOF.md une ligne `<date -u +%FT%TZ> <hostname>` (sortie réelle des deux commandes), commite (« proof: step N »), pousse sur origin ; puis lance `sleep 200` en arrière-plan (run_in_background) et attends la notification de sa fin avant l’étape suivante (c’est l’attente voulue par le test, pas un contournement).',
      '3. Une fois les six commits poussés, fais ton rapport au maître avec message_master : la liste des six commits (hash court et heure).',
      'Ne fais rien d’autre.',
    ].join('\n'),
  );
  await until('the first local commit', () => worker().status === 'busy' && execFileSync('git', ['-C', checkout, 'log', '--oneline', `origin/${branch}`, '-1'], { encoding: 'utf8' }).includes('proof: step'), 10 * 60_000).catch(() => undefined);
  say(`local worker at work: ${execFileSync('git', ['-C', checkout, 'log', '--format=%h %cI %s', '-2'], { encoding: 'utf8' }).replace(/\n/g, ' | ')}`);
  const away0 = performance.now();
  say('I’m stepping away');
  await m.stepAway(false);
  const snap = m.snapshot();
  say(`stepped away in ${Math.round((performance.now() - away0) / 1000)}s: phase=${snap.away?.phase} safe=${snap.away?.safe} card=${JSON.stringify(snap.sessions.find((s) => s.id === post.id)?.remote)}`);
  await new Promise((r) => setTimeout(r, 20_000));
  say(`${await runner()}; claude RSS ${claudeRss()} MB`);
  say('closing the AI Box (as the app does on quit)');
  m.killAll();
  await new Promise((r) => setTimeout(r, 3000));
  say(`after close: ${await runner()}`);
  process.exit(0);
}

// ---------- back ----------
const saved = JSON.parse(readFileSync(state, 'utf8')) as { post: string; checkout: string; branch: string };
const worker = () => inner.sessions.get(saved.post)!;
say(`reopened: ${await runner()}`);
say(`the worker as saved: remoteRun=${JSON.stringify(worker().remoteRun)} away=${worker().away?.branch}`);
const log = () => execFileSync('git', ['-C', saved.checkout, 'log', '--format=%h %cI %s', `origin/${saved.branch}`, '-8'], { encoding: 'utf8' });
execFileSync('git', ['-C', saved.checkout, 'fetch', '-q', 'origin', saved.branch]);
say(`pushed meanwhile (GitHub):\n${log()}`);
const back0 = performance.now();
// What the app does when it starts: the sessions it is not connected to are looked at, and taken up again.
await m.checkDetached();
await until('reports handed over', () => reports.length > 0 || worker().status === 'idle', 3 * 60_000).catch(() => undefined);
say(`reconnected in ${Math.round((performance.now() - back0) / 1000)}s; reports so far: ${reports.length}`);
say('I’m back (bring them back)');
await m.comeBack('bring');
say(`back in ${Math.round((performance.now() - back0) / 1000)}s: phase=${m.awayPhase()} remote=${JSON.stringify(m.snapshot().sessions.find((s) => s.id === saved.post)?.remote ?? null)}`);
await until('the local turn after the return', () => worker().status === 'idle', 15 * 60_000).catch(() => undefined);
say(`local after return: ${worker().lastMessage.replace(/\s+/g, ' ').slice(0, 400)}`);
say(`local log:\n${execFileSync('git', ['-C', saved.checkout, 'log', '--format=%h %cI %s', '-8'], { encoding: 'utf8' })}`);
if (existsSync(join(saved.checkout, 'NIGHT-PROOF.md'))) say(`NIGHT-PROOF.md:\n${readFileSync(join(saved.checkout, 'NIGHT-PROOF.md'), 'utf8')}`);
say(`${await runner()}`);
m.killAll();
process.exit(reports.length > 0 ? 0 : 1);
