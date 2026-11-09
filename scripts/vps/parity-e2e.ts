// Parity of a remote worker with a local one, outside the app: the environment sync of Settings › Remote server
// (src/main/remote/envSync.ts), then the hub's own session manager runs a post placed on the server, with real Claude
// Code there and real GitHub pushes, in an isolated data folder.
//
//   npx esbuild scripts/vps/parity-e2e.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.parity-e2e.mjs
//   AIBOX_GH_TOKEN=… node node_modules/.parity-e2e.mjs <config.json from vps:connect> <local checkout of a listed repo> <branch> <page url>
//
// The worker reads the synced CLAUDE.md, uses the taste skill, captures the page with playwright-cli, commits a proof
// file on <branch> and reports to the master. Prints one line per step: what happened, how long, the server's memory.
// The master's messages are printed, not sent to a model.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../../src/main/config';
import type { CostLog } from '../../src/main/costLog';
import type { McpHub } from '../../src/main/mcpHub';
import { claudeExecutable } from '../../src/main/providers/claude/cli';
import { parseRemote, remoteStatus, sshOptions, sshProgram } from '../../src/main/remote';
import { personalRepos, sshEnvExec, syncEnvironment } from '../../src/main/remote/envSync';
import { remoteOf as originOf } from '../../src/main/repos';
import { SessionManager } from '../../src/main/sessions';

const [configFile, checkout, branch, page] = process.argv.slice(2);
if (!configFile || !checkout || !branch || !page) throw new Error('usage: parity-e2e <config.json> <checkout> <branch> <page url>');
const t0 = performance.now();
const at = () => `${Math.round((performance.now() - t0) / 1000)}s`;
const say = (what: string) => console.log(`[${at()}] ${what}`);

const dir = mkdtempSync(join(tmpdir(), 'aibox-parity-'));
const cfg = loadConfig(dir, 'fr');
cfg.onboarded = true;
cfg.workspaces = [resolve(checkout, '..')];
cfg.mainRepos = [resolve(checkout)];
cfg.remoteWorkers = parseRemote((JSON.parse(readFileSync(configFile, 'utf8')) as { remoteWorkers: unknown }).remoteWorkers);
const r = cfg.remoteWorkers;
if (!r.enabled) throw new Error('remote workers are not saved as on in this config');

// 1. The environment, as the Settings button sends it.
const repos = personalRepos(r, originOf);
const env = await syncEnvironment(sshEnvExec(r), { repos, forbid: [r.host, ...r.orgs, ...r.denied] });
say(`env sync: ${env.sent} sent, ${env.removed} removed, ${env.unchanged} unchanged, ${env.skipped.length} held on the PC; plugins failed: ${env.pluginsFailed.join(', ') || 'none'}; memory of ${Object.keys(repos).length} repo(s)`);
for (const s of env.skipped) say(`  held: ${s.path} (${s.why})`);

// 2. A post placed on the server.
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
  // The user's token comes from this terminal's environment (never a file of the repo), as the app takes it from its keychain.
  remoteServer: { wake: async () => null, idle: () => undefined, state: () => '', secretsFor: async (): Promise<Record<string, string>> => (process.env.AIBOX_GH_TOKEN ? { GH_TOKEN: process.env.AIBOX_GH_TOKEN } : {}) },
});
interface Inner {
  sessions: Map<string, { status: string; remoteRun: unknown; lastMessage: string }>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  deliver(s: { id: string }, prompt: { text: string; shown?: string }): void;
  notifyMaster(shown: string, note: string): void;
  messageMaster(s: { name: string }, message: string): string;
}
const inner = m as unknown as Inner;
let report = '';
inner.notifyMaster = (shown, note) => say(`MASTER <- ${shown} | ${note.replace(/\s+/g, ' ').slice(0, 300)}`);
inner.messageMaster = (s, message) => ((report = message), say(`REPORT from ${s.name}: ${message.replace(/\s+/g, ' ').slice(0, 900)}`), 'Delivered to the master.');
const deliver = inner.deliver.bind(m);
inner.deliver = (s, prompt) => (s.id === 'master' ? say(`MASTER <- ${(prompt.shown ?? prompt.text).replace(/\s+/g, ' ').slice(0, 300)}`) : deliver(s, prompt));

const created = await inner.createRole({ name: 'parity-test', description: 'Test de parité du serveur distant', folders: [resolve(checkout)] }, new AbortController().signal);
const post = cfg.team.find((p) => p.name === 'parity-test');
if (!post) throw new Error(`post not created: ${created.slice(0, 200)}`);
post.mode = 'bypassPermissions';
post.placement = 'remote';
const worker = () => inner.sessions.get(post.id);

// While the worker runs, every 5 s, one sample at a time: the server's memory (the peak is what a second worker would
// have to share) and the resident memory of aibox's processes (Claude Code, its browser), read by the admin user.
const admin = [...sshOptions(r.knownHosts, r.port), '-o', 'ConnectTimeout=10', '-i', join(homedir(), '.ssh', 'aibox_admin'), `${r.admin}@${r.host}`];
const rssOf = () =>
  new Promise<number>((ok) =>
    execFile(sshProgram('ssh'), [...admin, "ps -u aibox -o rss= | awk '{s+=$1} END {print int(s/1024)}'"], { timeout: 20_000, windowsHide: true }, (err, out) => ok(err ? 0 : Number(out.trim()) || 0)),
  );
const used = async () => {
  const st = await remoteStatus(r);
  return st ? st.memory.total - st.memory.available : 0;
};
const mem = { base: await used(), peak: 0, rssPeak: 0 };
if (!mem.base) throw new Error('server unreachable');
say(`server before: ${mem.base} MB used, aibox processes ${await rssOf()} MB`);
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const [u, rss] = await Promise.all([used(), rssOf()]);
    mem.peak = Math.max(mem.peak, u);
    mem.rssPeak = Math.max(mem.rssPeak, rss);
    await new Promise((ok) => setTimeout(ok, 5000));
  }
})();

const file = 'VPS-PARITY.md';
const shot = 'vps-parity.png';
const LIMIT_MS = 30 * 60_000;
const done = new Promise<string>((ok) => {
  const timer = setTimeout(() => ok('timeout'), LIMIT_MS);
  const on = (id: string, kind: string) => {
    if (id !== post.id || (kind !== 'turn_done' && kind !== 'crashed' && kind !== 'interrupted')) return;
    clearTimeout(timer);
    m.off('event', on);
    ok(kind);
  };
  m.on('event', on);
});
const started = performance.now();
m.send(
  post.id,
  [
    `Test de parité du serveur distant, dans ce repo. Note chaque résultat dans ${file} (une section par point), en français, court.`,
    `1. Mets-toi sur la branche \`${branch}\` : reprends-la si elle existe sur origin, sinon crée-la depuis origin/main.`,
    `2. Lis ~/.claude/CLAUDE.md et cite mot pour mot une règle de la section « Regles de code ».`,
    `3. Invoque le skill taste (outil Skill) et cite une de ses règles.`,
    `4. Avec playwright-cli (sans écran), ouvre ${page} et fais une capture dans ${shot} ; note le titre de la page et la taille du fichier.`,
    `5. Note la sortie de \`hostname\`, \`whoami\` et \`playwright-cli --version\`.`,
    `6. Commite ${file} et ${shot}, pousse la branche sur origin.`,
    `7. Fais ton rapport au maître avec message_master : une ligne par point (2 à 6), avec le dernier commit.`,
  ].join('\n'),
);
const kind = await done;
const secs = Math.round((performance.now() - started) / 1000);
sampling = false;
await sampler;
const w = worker();
say(`worker: ${kind} after ${secs}s, remote=${String(!!w?.remoteRun)}; server memory ${mem.base} MB before, peak ${mem.peak} MB; aibox processes peak ${mem.rssPeak} MB`);
say(`last message: ${(w?.lastMessage ?? '').replace(/\s+/g, ' ').slice(0, 400)}`);
if (!report) say('no report to the master');
// A turn cut short (timeout, crash) may still run on the server: stopped there too, not only here.
if (kind !== 'turn_done') m.stop(post.id);
m.killAll();
rmSync(dir, { recursive: true, force: true });
process.exit(kind === 'turn_done' && report ? 0 : 1);
