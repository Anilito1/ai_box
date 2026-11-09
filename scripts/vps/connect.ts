// The setup of Settings › Remote server, from a terminal: the same steps (src/main/vps.ts), for a check outside the app.
//
//   npm run vps:connect -- <host> [--admin ubuntu] [--port 22] --config <file.json> [--trust SHA256:…] [--code-file <file>]
//
// --repo: the local checkout to link to the server's clone (its origin must be a listed repo).
// --config: where the `remoteWorkers` settings are written (never the app's own data folder).
// --trust: the fingerprint you checked (provider's console); the server is trusted only if it shows that one.
// --code-file: the Claude sign-in code, read from this file once it appears (the sign-in address is printed first).
// Exit: 0 saved, 3 waits for you (fingerprint, admin key, deploy keys), 1 failed.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { VPS_STEPS, type VpsState } from '../../src/shared/vps';
import { parseRemote, remoteLatency, remoteStatus } from '../../src/main/remote';
import { remoteOf as originOfRemote } from '../../src/main/repos';
import { realExec, realTty, VpsWizard } from '../../src/main/vps';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const host = argv[0];
const config = opt('config');
if (!host || host.startsWith('--') || !config) {
  console.error('usage: vps:connect <host> [--admin ubuntu] [--port 22] --config <file.json> [--trust SHA256:…] [--code-file <file>]');
  process.exit(1);
}
const file = resolve(config);
const read = () => parseRemote(existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { remoteWorkers?: unknown }).remoteWorkers : {});
let printed = '';
const show = (s: VpsState) => {
  const line = VPS_STEPS.map((id) => `${id}:${s.steps[id].state}${s.steps[id].detail ? `(${s.steps[id].detail})` : ''}`).join(' ');
  if (line !== printed) console.log(line);
  printed = line;
};
const w = new VpsWizard({
  exec: realExec,
  tty: realTty,
  home: homedir(),
  scripts: resolve('scripts/vps'),
  platform: process.platform,
  user: userInfo().username,
  current: read,
  save: (r) => writeFileSync(file, JSON.stringify({ remoteWorkers: r }, null, 2)),
  mainRepos: () => (opt('repo') ? [resolve(opt('repo') as string)] : []),
  originOf: originOfRemote,
  // Outside the app: the token comes from the environment of this terminal, never from a file of the repo.
  token: () => process.env.AIBOX_GH_TOKEN ?? '',
  status: remoteStatus,
  latency: remoteLatency,
  onChange: (s) => {
    show(s);
    if (s.loginUrl && s.steps.login.state === 'wait') console.log(`LOGIN ${s.loginUrl}`);
  },
});

const codeFile = opt('code-file');
// The sign-in code, typed into the server's Claude Code as soon as it is written to the file.
const watch = codeFile
  ? setInterval(() => {
      if (!existsSync(codeFile)) return;
      const code = readFileSync(codeFile, 'utf8').trim();
      unlinkSync(codeFile);
      w.code(code);
    }, 2000)
  : null;
let s = await w.run({ host, admin: opt('admin') ?? 'ubuntu', port: Number(opt('port') ?? 22) });
if (s.steps.hostkey.state === 'wait') {
  console.log(`FINGERPRINT ${s.fingerprint}`);
  if (opt('trust') !== s.fingerprint) process.exit(3);
  s = await w.trust(s.fingerprint);
}
if (watch) clearInterval(watch);
show(s);
for (const k of s.repos) console.log(`REPO ${k.slug} ${k.ready ? 'ready' : 'refused'}`);
if (VPS_STEPS.some((id) => s.steps[id].state === 'fail')) console.log(s.log.slice(-15).join('\n'));
if (s.latencyMs) console.log(`LATENCY ${s.latencyMs} ms; MEMORY ${s.memoryMb.available}/${s.memoryMb.total} MB; CLAUDE ${s.claude}`);
process.exit(s.steps.save.state === 'ok' ? 0 : VPS_STEPS.some((id) => s.steps[id].state === 'fail') ? 1 : 3);
