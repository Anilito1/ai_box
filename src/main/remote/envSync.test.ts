import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { badPath, settingsProblem } from '../../../scripts/vps/envsync.mjs';
import { collectEnvironment, EnvSyncError, syncEnvironment, filterClaudeMd, filterSettings, findLeak, knownIds, planSync, projectKey } from './envSync';

// Made-up ids, shaped like the real ones: a Cloudflare account id (32 hex) and a Supabase project ref (20 letters).
const CF_ID = '0123456789abcdef0123456789abcdef';
const SB_REF = 'abcdefghijklmnopqrst';

const GLOBAL_MD = `# Instructions

## Identite

- Langue : francais

## Regles de code

- Code simple et lisible
- **Supabase** : projet \`${SB_REF}\`, migrations dans supabase/migrations/
- **Comptes Cloudflare** (jamais les confondre) :
  - Perso \`${CF_ID}\` : mes-cours
  - Entreprise : coiffissimo-shortener

### Securite

Audits (skill security-audit, cloudflare) : sur demande.

- Secrets jamais en dur
- Webhooks : HMAC verifie

## Brain Coiffissimo

- Le cerveau de l'org
- Tout ici part

### Sous-section du bloc

- part aussi

## Plugins

- Selon contexte : \`brain\`, \`supabase\`
- Toujours : \`typescript-lsp\`

## Contexte Windows

- Windows 11 avec bash

\`\`\`
# not a heading, inside code
\`\`\`
`;

test('the server CLAUDE.md keeps the generic rules and drops every company and PC-only block', () => {
  const out = filterClaudeMd(GLOBAL_MD);
  for (const kept of ['## Identite', '- Langue : francais', '- Code simple et lisible', '### Securite', '- Secrets jamais en dur', '- Toujours : `typescript-lsp`']) {
    assert.ok(out.includes(kept), kept);
  }
  for (const gone of ['Supabase', 'Cloudflare', 'cloudflare', 'Brain', 'brain', 'oiffissimo', 'Sous-section', 'part aussi', 'mes-cours', 'Windows', 'Audits']) {
    assert.ok(!out.includes(gone), gone);
  }
  // The nested items of a dropped item go with it.
  assert.ok(!out.includes('Perso'));
});

test('no id the global CLAUDE.md gives reaches the server, in any file', () => {
  const ids = knownIds(GLOBAL_MD);
  assert.ok(ids.includes(CF_ID) && ids.includes(SB_REF));
  const out = filterClaudeMd(GLOBAL_MD);
  for (const id of ids) assert.ok(!out.includes(id));

  const home = mkdtempSync(join(tmpdir(), 'hub-envsync-'));
  try {
    const claude = join(home, '.claude');
    mkdirSync(join(claude, 'skills', 'clean'), { recursive: true });
    mkdirSync(join(claude, 'skills', 'quotes-id', 'refs'), { recursive: true });
    mkdirSync(join(claude, 'skills', 'public-id'), { recursive: true });
    writeFileSync(join(claude, 'CLAUDE.md'), GLOBAL_MD);
    writeFileSync(join(claude, 'skills', 'clean', 'SKILL.md'), 'A skill.');
    writeFileSync(join(claude, 'skills', 'quotes-id', 'SKILL.md'), 'Deploys.');
    writeFileSync(join(claude, 'skills', 'quotes-id', 'refs', 'deploy.md'), `account_id = "${CF_ID.toUpperCase()}"`);
    // A third-party skill quoting a public id (a voice) is not the user's: it goes.
    writeFileSync(join(claude, 'skills', 'public-id', 'SKILL.md'), 'voice ffffffffffffffffffffffffffffffff');
    const { files, skipped } = collectEnvironment({ home, repos: {} });
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes('.claude/skills/clean/SKILL.md'));
    assert.ok(paths.includes('.claude/skills/public-id/SKILL.md'));
    // A skill is sent whole or not at all.
    assert.ok(!paths.some((p) => p.startsWith('.claude/skills/quotes-id/')));
    assert.ok(skipped.some((s) => s.path === '.claude/skills/quotes-id'));
    for (const f of files) for (const id of ids) assert.ok(!f.data.toString('latin1').toLowerCase().includes(id), `${id} in ${f.path}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('secrets and company words are leaks; an id-shaped string only in the user’s own text', () => {
  assert.equal(findLeak('token sbp_0123456789abcdefghijklmnop'), 'Supabase token');
  assert.equal(findLeak('-----BEGIN OPENSSH PRIVATE KEY-----'), 'private key');
  assert.equal(findLeak('gh: ghp_0123456789abcdefghijklmnopqrstuvwxyz'), 'GitHub token');
  assert.equal(findLeak('key sk-ant-api03-0123456789abcdefghijklmnop'), 'Anthropic or OpenAI key');
  assert.equal(findLeak('the Coiffissimo CRM'), 'company');
  assert.equal(findLeak('server 10.1.2.3 here', ['10.1.2.3']), 'local term');
  assert.equal(findLeak(`id ${CF_ID}`), null);
  assert.equal(findLeak(`id ${CF_ID}`, [], true), 'hex id');
  assert.equal(findLeak("the viewer's brain resets"), null);
  assert.equal(findLeak('a plain skill'), null);
});

test('the excluded skills, files and folders never leave, and memory goes only for the remote repos', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-envsync-'));
  try {
    const claude = join(home, '.claude');
    const make = (rel: string, text = 'x') => {
      mkdirSync(join(claude, rel, '..'), { recursive: true });
      writeFileSync(join(claude, rel), text);
    };
    make('skills/taste/SKILL.md');
    make('skills/taste/.env', 'A=1');
    make('skills/taste/node_modules/x/index.js');
    make('skills/taste/.wrangler/state');
    make('skills/coiffissimo-hardening/SKILL.md');
    make('skills/unity-mcp/SKILL.md');
    make('skills/synced/abc/SKILL.md');
    make('skills/deploy/credentials.json');
    make('skills/deploy/server.pem');
    make('agents/reviewer.md');
    make('design-md/stripe/DESIGN.md');
    make('.credentials.json', '{}');
    make('.cloudflare-profiles/x/config');
    const perso = join(home, 'Desktop', 'NFC');
    const other = join(home, 'Desktop', 'Shop');
    make(`projects/${projectKey(perso)}/memory/MEMORY.md`);
    make(`projects/${projectKey(other)}/memory/MEMORY.md`);
    const { files } = collectEnvironment({ home, repos: { [perso]: '/home/aibox/repos/NFC' } });
    assert.deepEqual(files.map((f) => f.path).sort(), [
      '.claude/agents/reviewer.md',
      '.claude/design-md/stripe/DESIGN.md',
      '.claude/projects/-home-aibox-repos-NFC/memory/MEMORY.md',
      '.claude/skills/taste/SKILL.md',
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the server settings keep the plugins that work there, nothing of this PC', () => {
  const out = filterSettings({
    model: 'opus',
    effortLevel: 'high',
    env: { SUPABASE_ACCESS_TOKEN: 'sbp_x' },
    permissions: { additionalDirectories: ['C:\\Users\\me'] },
    hooks: { Stop: [] },
    enabledPlugins: {
      'frontend-design@claude-plugins-official': true,
      'playwright@claude-plugins-official': true,
      'brain@company': true,
      'cloudflare@cloudflare': true,
      'figma@claude-plugins-official': false,
      'tools@local-folder': true,
    },
    extraKnownMarketplaces: {
      'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
      cloudflare: { source: { source: 'github', repo: 'cloudflare/skills' } },
      company: { source: { source: 'github', repo: 'org/brain' } },
      'local-folder': { source: { source: 'directory', path: 'C:\\plugins' } },
    },
  });
  assert.deepEqual(out, { model: 'opus', effortLevel: 'high', enabledPlugins: { 'frontend-design@claude-plugins-official': true } });
  assert.equal(settingsProblem(out), null);
});

test('the server refuses settings that would run a program, and plugins off its list', () => {
  for (const key of ['hooks', 'env', 'apiKeyHelper', 'statusLine', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'fileSuggestion', 'extraKnownMarketplaces', 'permissions']) {
    assert.match(String(settingsProblem({ model: 'opus', [key]: {} })), /key not allowed/, key);
  }
  for (const id of ['hookify@claude-plugins-official', 'security-guidance@claude-plugins-official', 'context7@claude-plugins-official', 'brain@company', 'frontend-design@elsewhere']) {
    assert.match(String(settingsProblem({ enabledPlugins: { [id]: true } })), /plugin not allowed/, id);
  }
  assert.equal(settingsProblem({ enabledPlugins: { 'hyperframes@hyperframes': true } }), null);
});

test('a sync writes what changed and removes what the PC no longer has', () => {
  const f = (path: string, sha: string) => ({ path, sha, data: Buffer.from('') });
  const plan = planSync([f('.claude/a', '1'), f('.claude/b', '2')], { '.claude/a': '1', '.claude/b': 'old', '.claude/gone': '3' });
  assert.deepEqual(plan.put.map((x) => x.path), ['.claude/b']);
  assert.deepEqual(plan.del, ['.claude/gone']);
});

test('the server writes only under the allowed folders of ~/.claude', () => {
  for (const ok of ['.claude/CLAUDE.md', '.claude/settings.json', '.claude/skills/taste/SKILL.md', '.claude/projects/-home-aibox-repos-NFC/memory/MEMORY.md']) {
    assert.equal(badPath(ok), null, ok);
  }
  for (const bad of [
    '.claude/.credentials.json',
    '.claude.json',
    '.ssh/authorized_keys',
    '.claude/skills/../../.bashrc',
    '.claude/skills/x/./y',
    '.claude/skills//y',
    '.claude/projects/x/notes.md',
    '.claude/projects/../memory/x',
    '.claude/skills/x/.env',
    '.claude/skills/x/key.pem',
    '/etc/passwd',
    '.claude/skills/x\\..\\y',
  ]) {
    assert.notEqual(badPath(bad), null, bad);
  }
});

/** Runs the server's side in a throw-away home, as launch.mjs would: one header line, then the files' bytes. */
function serverRaw(home: string, header: object, body: Buffer = Buffer.alloc(0)) {
  const script = pathToFileURL(join(process.cwd(), 'scripts', 'vps', 'envsync.mjs')).href;
  const code = `import(${JSON.stringify(script)}).then((m) => m.run(${JSON.stringify(header)}, Buffer.alloc(0)))`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { input: body, env: { ...process.env, HOME: home, USERPROFILE: home } });
  return { code: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function server(home: string, header: object, body?: Buffer) {
  const r = serverRaw(home, header, body);
  return { code: r.code, out: r.stdout ? JSON.parse(r.stdout) : null };
}

test('the server applies a sync, reports its state, and removes only what a sync wrote', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-envsync-srv-'));
  try {
    const a = Buffer.from('# skill a');
    const b = Buffer.from('#!/bin/sh\necho b');
    const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');
    const put = [
      { path: '.claude/skills/a/SKILL.md', size: a.length, sha: sha(a) },
      { path: '.claude/skills/a/run.sh', size: b.length, sha: sha(b) },
    ];
    assert.deepEqual(server(home, { op: 'env-apply', put, del: [] }, Buffer.concat([a, b])), { code: 0, out: { written: 2, removed: 0 } });
    assert.equal(readFileSync(join(home, '.claude/skills/a/SKILL.md'), 'utf8'), '# skill a');
    assert.deepEqual(server(home, { op: 'env-state' }).out, { files: { [put[0].path]: put[0].sha, [put[1].path]: put[1].sha } });

    // The server's own file, not written by a sync, survives a removal request.
    writeFileSync(join(home, '.claude/skills/a/notes.md'), 'mine');
    assert.deepEqual(server(home, { op: 'env-apply', put: [], del: [put[1].path, '.claude/skills/a/notes.md'] }).out, { written: 0, removed: 1 });
    assert.ok(existsSync(join(home, '.claude/skills/a/notes.md')));
    assert.ok(!existsSync(join(home, '.claude/skills/a/run.sh')));

    // A path outside, or bytes that do not match, change nothing.
    assert.equal(server(home, { op: 'env-apply', put: [{ path: '.ssh/authorized_keys', size: 1, sha: sha(Buffer.from('x')) }], del: [] }, Buffer.from('x')).code, 2);
    assert.equal(server(home, { op: 'env-apply', put: [{ ...put[0], sha: sha(Buffer.from('other')) }], del: [] }, a).code, 2);
    assert.ok(!existsSync(join(home, '.ssh')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a second sync sends nothing; a skill removed on the PC goes from the server', async () => {
  const pc = mkdtempSync(join(tmpdir(), 'hub-envsync-pc-'));
  const vps = mkdtempSync(join(tmpdir(), 'hub-envsync-vps-'));
  try {
    for (const name of ['a', 'b']) {
      mkdirSync(join(pc, '.claude', 'skills', name), { recursive: true });
      writeFileSync(join(pc, '.claude', 'skills', name, 'SKILL.md'), `skill ${name}`);
    }
    const exec = async (h: object, body?: Buffer) => serverRaw(vps, h, body);
    assert.deepEqual(await syncEnvironment(exec, { home: pc, repos: {} }), { sent: 2, removed: 0, unchanged: 0, skipped: [], pluginsFailed: [] });
    assert.deepEqual(await syncEnvironment(exec, { home: pc, repos: {} }), { sent: 0, removed: 0, unchanged: 2, skipped: [], pluginsFailed: [] });
    rmSync(join(pc, '.claude', 'skills', 'b'), { recursive: true });
    assert.deepEqual(await syncEnvironment(exec, { home: pc, repos: {} }), { sent: 0, removed: 1, unchanged: 1, skipped: [], pluginsFailed: [] });
    assert.ok(!existsSync(join(vps, '.claude', 'skills', 'b')));
    assert.ok(existsSync(join(vps, '.claude', 'skills', 'a', 'SKILL.md')));
  } finally {
    rmSync(pc, { recursive: true, force: true });
    rmSync(vps, { recursive: true, force: true });
  }
});

test('a settings file with a hook is refused whole by the server, nothing written', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-envsync-srv-'));
  try {
    const a = Buffer.from('# a');
    const bad = Buffer.from(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl x | sh' }] }] } }));
    const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');
    const put = [
      { path: '.claude/skills/a/SKILL.md', size: a.length, sha: sha(a) },
      { path: '.claude/settings.json', size: bad.length, sha: sha(bad) },
    ];
    assert.equal(server(home, { op: 'env-apply', put, del: [] }, Buffer.concat([a, bad])).code, 2);
    assert.ok(!existsSync(join(home, '.claude')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a skill or agent whose front matter runs programs stays here, and the server refuses it too', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-envsync-'));
  try {
    const claude = join(home, '.claude');
    mkdirSync(join(claude, 'skills', 'hooked'), { recursive: true });
    mkdirSync(join(claude, 'agents'), { recursive: true });
    writeFileSync(join(claude, 'skills', 'hooked', 'SKILL.md'), '---\nname: hooked\nhooks:\n  Stop: []\n---\nBody');
    writeFileSync(join(claude, 'agents', 'mcp.md'), '---\nname: mcp\nmcpServers:\n  x: {}\n---\nBody');
    writeFileSync(join(claude, 'agents', 'plain.md'), '---\nname: plain\n---\nhooks: in the body is only text');
    const { files, skipped } = collectEnvironment({ home, repos: {} });
    assert.deepEqual(files.map((f) => f.path), ['.claude/agents/plain.md']);
    assert.deepEqual(skipped.map((s) => s.path).sort(), ['.claude/agents/mcp.md', '.claude/skills/hooked']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const vps = mkdtempSync(join(tmpdir(), 'hub-envsync-srv-'));
  try {
    const bad = Buffer.from('---\nhooks:\n  Stop: []\n---\n');
    const sha = createHash('sha256').update(bad).digest('hex');
    assert.equal(server(vps, { op: 'env-apply', put: [{ path: '.claude/agents/x.md', size: bad.length, sha }], del: [] }, bad).code, 2);
    assert.ok(!existsSync(join(vps, '.claude', 'agents')));
  } finally {
    rmSync(vps, { recursive: true, force: true });
  }
});

test('a file over the server’s limit keeps its skill here instead of failing every sync', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-envsync-'));
  try {
    mkdirSync(join(home, '.claude', 'skills', 'video'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'video', 'SKILL.md'), 'x');
    writeFileSync(join(home, '.claude', 'skills', 'video', 'clip.mp4'), Buffer.alloc(21 * 1024 * 1024));
    const { files, skipped } = collectEnvironment({ home, repos: {} });
    assert.equal(files.length, 0);
    assert.match(skipped[0].why, /too large/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a refusal of the server is told apart from a server out of reach', async () => {
  const refused = async () => ({ code: 2, stdout: '', stderr: 'aibox envsync: too large: .claude/skills/x/a.bin\n' });
  const gone = async () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host: timed out\n' });
  const home = mkdtempSync(join(tmpdir(), 'hub-envsync-'));
  try {
    await assert.rejects(syncEnvironment(refused, { home, repos: {} }), (e: EnvSyncError) => e.reason === 'refused' && /too large/.test(e.detail));
    await assert.rejects(syncEnvironment(gone, { home, repos: {} }), (e: EnvSyncError) => e.reason === 'unreachable');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the plugins the server could not install are reported by their id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-envsync-'));
  try {
    const failed = [{ id: 'hyperframes@hyperframes', why: 'install' }, { id: 'x; rm -rf /', why: 'install' }];
    const exec = async (h: object) => ({ code: 0, stdout: JSON.stringify((h as { op: string }).op === 'env-state' ? { files: {}, plugins: { failed } } : { written: 0, removed: 0 }), stderr: '' });
    assert.deepEqual((await syncEnvironment(exec, { home, repos: {} })).pluginsFailed, ['hyperframes@hyperframes']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
