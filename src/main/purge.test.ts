import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import type { PurgeEntry, PurgeReport } from '../shared/purge';
import { PurgeService, type PurgeOptions } from './purge';
import type { Act, TranscriptFacts } from './purgeIndex';

const HOUR = 3_600_000;
const gitIn = (cwd: string, args: string[]) =>
  new Promise<string>((ok, ko) => execFile('git', ['-C', cwd, ...args], { windowsHide: true }, (err, out) => (err ? ko(err) : ok(out))));

interface Fixture {
  base: string;
  root: string;
  outside: string;
  data: string;
  bin: string;
  facts: TranscriptFacts[];
  trashed: string[];
  failTrash: boolean;
  busy: string[];
  svc: PurgeService;
}

async function file(path: string, text = 'synthetic fixture'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** A project with one of each case, the agent's runs around their files' birth, a clock one hour later. */
async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'purge-'));
  const root = join(base, 'projet démo #1');
  const outside = join(base, 'ailleurs');
  const data = join(base, 'data');
  const bin = join(base, 'bin');
  await mkdir(root, { recursive: true });
  await mkdir(bin);
  execFileSync('git', ['init', '-q', root]);
  await file(join(root, 'qc', 'tracked.png'));
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);

  const start = Date.now() - 2000;
  await file(join(root, '.aibox', '.gitignore'), '*\n');
  await file(join(root, '.aibox', 'scratch', 'hub-qa', 'capture.png'));
  await file(join(root, '.aibox', 'scratch', 'hub-qa', 'essai.py'));
  await file(join(root, 'qc', 'frames', 'f_001.png'));
  await file(join(root, 'qc', 'frames', 'f_002.png'));
  await file(join(root, 'qc', 'cited.png'));
  await file(join(root, 'qc', 'touched.png'));
  await file(join(root, 'renders', 'final', 'hero.png'));
  await file(join(root, 'KIT-DEMO.zip'));
  await file(join(root, 'tmp', 'Mes essais (été) [v2]', 'capture 100%.png'));
  await file(join(root, 'notes', 'idée.txt')); // Never named by an agent: nothing to say about it.
  await file(join(root, 'node_modules', 'pkg', 'screenshot.png'));
  await file(join(outside, 'capture.png'));
  const end = Date.now() + 2000;
  // Changed long after the agent made it, while no agent worked.
  await utimes(join(root, 'qc', 'touched.png'), new Date(end + 30 * 60_000), new Date(end + 30 * 60_000));
  // A link to a folder outside the project: never followed, never proposed.
  await symlink(outside, join(root, 'qc', 'link'), process.platform === 'win32' ? 'junction' : 'dir');

  const cmd = (paths: string[]): Act => ({ kind: 'cmd', start, end, cwd: root, paths });
  const facts: TranscriptFacts[] = [
    {
      format: 'claude',
      session: 'hub-qa',
      cwds: [root],
      acts: [
        { kind: 'turn', start, end, cwd: root, paths: [] },
        cmd([join(root, 'qc', 'frames'), join(root, 'qc', 'cited.png'), join(root, 'qc', 'touched.png'), join(root, 'renders', 'final', 'hero.png'), join(root, 'KIT-DEMO.zip')]),
        cmd([join(root, 'tmp', 'Mes essais (été) [v2]', 'capture 100%.png'), join(outside, 'capture.png'), join(root, 'qc', 'link', 'capture.png')]),
      ],
      cites: ['qc/cited.png'],
    },
  ];
  const fx = { base, root, outside, data, bin, facts, trashed: [] as string[], failTrash: false, busy: [] as string[] } as Fixture;
  const opts: PurgeOptions = {
    dataDir: data,
    index: { all: async () => fx.facts, counts: () => ({ claude: 1, codex: 0, gemini: 0, activity: 0 }) },
    trash: async (p) => {
      if (fx.failTrash) throw new Error('no trash here');
      fx.trashed.push(p);
      await rename(p, join(bin, `${fx.trashed.length}-${basename(p)}`));
    },
    known: () => [{ root, source: 'repo' }],
    broad: () => [base],
    busyScratch: () => fx.busy,
    git: gitIn,
    now: () => Date.now() + HOUR,
    systemDirs: [join(base, 'system')],
  };
  fx.svc = new PurgeService(opts);
  return fx;
}

const byRel = (r: PurgeReport) => new Map<string, PurgeEntry>(r.entries.map((e) => [e.rel, e]));

test('purge scan: nothing protected is ever offered, the scratch and agent outputs are', async () => {
  const fx = await fixture();
  try {
    fx.svc.projects();
    const r = await fx.svc.scan(fx.root);
    const e = byRel(r);
    // Never offered.
    assert.equal(e.get('qc/tracked.png')?.block, 'tracked');
    assert.equal(e.get('qc/cited.png')?.block, 'cited');
    assert.equal(e.get('qc/touched.png')?.block, 'userModified');
    assert.equal(e.get('renders/final/hero.png')?.block, 'deliverable');
    assert.equal(e.get('KIT-DEMO.zip')?.block, 'document');
    assert.equal(e.get('notes/idée.txt'), undefined);
    assert.ok(![...e.keys()].some((k) => k.includes('node_modules') || k.includes('link') || k.startsWith('.aibox/.git')), 'skipped folders and links');
    assert.ok(![...e.keys()].some((k) => k.includes('ailleurs')), 'nothing outside the root');
    // Offered.
    assert.equal(e.get('.aibox/scratch/hub-qa/capture.png')?.category, 'safe');
    assert.equal(e.get('.aibox/scratch/hub-qa/essai.py')?.category, 'safe');
    assert.equal(e.get('qc/frames/f_001.png')?.category, 'safe');
    assert.deepEqual(e.get('qc/frames/f_001.png')?.sessions, ['hub-qa']);
    assert.equal(e.get('tmp/Mes essais (été) [v2]/capture 100%.png')?.category, 'safe');
    for (const x of r.entries) if (x.category !== 'protected') assert.equal(x.block, null);
    assert.equal(r.totals.safe.count, 5);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('purge trash: only offered files move, a full folder goes whole, a scan is used once', async () => {
  const fx = await fixture();
  try {
    fx.svc.projects();
    const r = await fx.svc.scan(fx.root);
    // Everything ticked, the protected ones included: they must stay.
    const res = await fx.svc.trash(r.scanId, r.entries.map((x) => x.id));
    assert.equal(res.stale, undefined);
    assert.equal(res.trashed, 5);
    assert.equal(res.quarantined, 0);
    for (const rel of ['qc/cited.png', 'qc/touched.png', 'renders/final/hero.png', 'KIT-DEMO.zip', 'qc/tracked.png', 'notes/idée.txt']) assert.ok(existsSync(join(fx.root, rel)), rel);
    assert.ok(existsSync(join(fx.outside, 'capture.png')));
    // Folders whose every file was chosen went as one item; never the root, nor .aibox or .aibox/scratch.
    const names = fx.trashed.map((p) => p.slice(fx.root.length + 1).replace(/\\/g, '/'));
    assert.ok(names.includes('qc/frames'), names.join());
    assert.ok(names.includes('.aibox/scratch/hub-qa'), names.join());
    assert.ok(!names.some((n) => n === '' || n === '.aibox' || n === '.aibox/scratch'));
    assert.ok(existsSync(join(fx.root, '.aibox', '.gitignore')));
    // The same scan again: refused.
    assert.equal((await fx.svc.trash(r.scanId, [0])).stale, true);
    const log = fx.svc.history(fx.root);
    assert.equal(log.length, 1);
    assert.equal(log[0].items.find((i) => i.rel === 'qc/frames')?.files, 2);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('purge trash: a file changed since the scan stays; an unknown project cannot be scanned', async () => {
  const fx = await fixture();
  try {
    fx.svc.projects();
    const r = await fx.svc.scan(fx.root);
    const target = r.entries.find((x) => x.rel === 'tmp/Mes essais (été) [v2]/capture 100%.png') as PurgeEntry;
    await appendFile(join(fx.root, target.rel), ' changed');
    const res = await fx.svc.trash(r.scanId, [target.id]);
    assert.deepEqual(res.skipped, [{ rel: target.rel, why: 'changed' }]);
    assert.ok(existsSync(join(fx.root, target.rel)));
    await assert.rejects(fx.svc.scan(fx.outside));
    await assert.rejects(fx.svc.scan(homedir()));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('purge trash: without a system trash, the quarantine keeps the file and gives it back', async () => {
  const fx = await fixture();
  try {
    fx.failTrash = true;
    fx.svc.projects();
    const r = await fx.svc.scan(fx.root);
    const one = r.entries.find((x) => x.rel === '.aibox/scratch/hub-qa/capture.png') as PurgeEntry;
    const res = await fx.svc.trash(r.scanId, [one.id]);
    assert.equal(res.quarantined, 1);
    assert.ok(!existsSync(join(fx.root, one.rel)));
    const [entry] = fx.svc.history(fx.root);
    assert.equal(entry.items[0].how, 'quarantine');
    // Kept in the app's own folder, nowhere else.
    assert.ok(existsSync(join(fx.data, 'purge', 'quarantine')));
    const back = await fx.svc.restore(entry.id);
    assert.equal(back.restored, 1);
    assert.equal(await readFile(join(fx.root, one.rel), 'utf8'), 'synthetic fixture');
    assert.equal((await fx.svc.restore(entry.id)).restored, 0);
    assert.equal(fx.svc.history(fx.root)[0].items[0].restored, true);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('purge roots: too wide, system, network, the app\'s data and relative folders are refused', async () => {
  const fx = await fixture();
  try {
    const svc = fx.svc;
    assert.equal(svc.rootProblem(fx.root), null);
    assert.equal(svc.rootProblem(homedir()), 'wide');
    assert.equal(svc.rootProblem(dirname(homedir())), 'wide');
    assert.equal(svc.rootProblem(process.platform === 'win32' ? 'C:\\' : '/'), 'wide');
    assert.equal(svc.rootProblem(fx.base), 'wide');
    assert.equal(svc.rootProblem(join(fx.base, 'system', 'x')), 'system');
    assert.equal(svc.rootProblem(join(fx.data, 'scratch')), 'appData');
    assert.equal(svc.rootProblem('\\\\server\\share\\p'), 'network');
    assert.equal(svc.rootProblem('relative/p'), 'relative');
    assert.equal(svc.rootProblem(join(homedir(), '.claude', 'projects')), 'system');
    assert.equal(svc.addProject(join(fx.base, 'nope')), 'missing');
    assert.equal(svc.addProject(fx.outside), null);
    assert.ok(svc.projects().some((p) => p.root === fx.outside && p.source === 'added'));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('purge exclusions: a pattern of the project keeps its files out', async () => {
  const fx = await fixture();
  try {
    fx.svc.projects();
    fx.svc.saveProjectSettings(fx.root, ['qc/frames/', '  ', 42]);
    assert.deepEqual(fx.svc.projectSettings(fx.root).exclude, ['qc/frames/']);
    const e = byRel(await fx.svc.scan(fx.root));
    assert.equal(e.get('qc/frames/f_001.png')?.block, 'excluded');
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('purge: path keys follow the system\'s case rule', async () => {
  const data = await mkdtemp(join(tmpdir(), 'purge-keys-'));
  try {
    const base = { dataDir: data, index: { all: async () => [], counts: () => ({ claude: 0, codex: 0, gemini: 0, activity: 0 }) }, trash: async () => {}, known: () => [], broad: () => [], busyScratch: () => [], git: gitIn };
    const blind = new PurgeService({ ...base, platform: 'darwin' });
    const exact = new PurgeService({ ...base, platform: 'linux' });
    const p = join(data, 'Proj', 'A.PNG');
    assert.equal(blind.key(p), blind.key(p.toLowerCase()));
    assert.notEqual(exact.key(p), exact.key(p.toLowerCase()));
    assert.ok(!blind.key(p).includes('\\'));
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('purge trash: a folder swapped for a link after the scan, or a worker back at work, stops the move', async () => {
  const fx = await fixture();
  try {
    fx.svc.projects();
    const r = await fx.svc.scan(fx.root);
    const frames = r.entries.filter((x) => x.rel.startsWith('qc/frames/')).map((x) => x.id);
    const scratch = r.entries.filter((x) => x.rel.startsWith('.aibox/scratch/')).map((x) => x.id);
    // qc/frames becomes a link to a copy inside the project, same names, sizes and dates.
    await cp(join(fx.root, 'qc', 'frames'), join(fx.root, 'qc', 'copie'), { recursive: true, preserveTimestamps: true });
    await rename(join(fx.root, 'qc', 'frames'), join(fx.base, 'frames-moved'));
    await symlink(join(fx.root, 'qc', 'copie'), join(fx.root, 'qc', 'frames'), process.platform === 'win32' ? 'junction' : 'dir');
    fx.busy = [join(fx.root, '.aibox', 'scratch', 'hub-qa')];
    const res = await fx.svc.trash(r.scanId, [...frames, ...scratch]);
    assert.equal(res.trashed + res.quarantined, 0);
    // Through the link, the copy's dates may differ by a fraction: refused as a link or as changed, never moved.
    assert.ok(res.skipped.every((s) => (s.rel.startsWith('qc/') ? ['link', 'changed'].includes(s.why) : s.why === 'running')), JSON.stringify(res.skipped));
    assert.equal(res.skipped.length, frames.length + scratch.length);
    assert.ok(existsSync(join(fx.root, 'qc', 'copie', 'f_001.png')));
    assert.ok(existsSync(join(fx.root, '.aibox', 'scratch', 'hub-qa', 'capture.png')));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('purge trash: a folder that holds a scratch area never goes whole', async () => {
  const fx = await fixture();
  try {
    await file(join(fx.root, 'app', '.aibox', 'scratch', 's', 'a.png'));
    fx.svc.projects();
    const r = await fx.svc.scan(fx.root);
    const ids = r.entries.filter((x) => x.rel.startsWith('app/')).map((x) => x.id);
    assert.equal(ids.length, 1);
    await fx.svc.trash(r.scanId, ids);
    const names = fx.trashed.map((p) => p.slice(fx.root.length + 1).replace(/\\/g, '/'));
    assert.ok(!names.includes('app') && !names.includes('app/.aibox') && !names.includes('app/.aibox/scratch'), names.join());
    assert.ok(existsSync(join(fx.root, 'app', '.aibox', 'scratch')));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('purge scan: a file of before that an agent only edited is not taken for one it made', async () => {
  const fx = await fixture();
  try {
    const path = join(fx.root, 'qc', 'capture-ancienne.png');
    await file(path);
    const later = Date.now() + 60_000;
    await utimes(path, new Date(later + 500), new Date(later + 500));
    fx.facts.push({ format: 'claude', session: 'hub-edit', cwds: [fx.root], acts: [{ kind: 'write', start: later, end: later + 1000, cwd: fx.root, paths: [path] }], cites: [] });
    fx.svc.projects();
    const e = byRel(await fx.svc.scan(fx.root)).get('qc/capture-ancienne.png');
    assert.notEqual(e?.category, 'safe');
    assert.ok(!e?.signals.includes('agentWrite'));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('purge restore: a journal pointing outside the quarantine or the project moves nothing', async () => {
  const fx = await fixture();
  try {
    fx.failTrash = true;
    fx.svc.projects();
    const r = await fx.svc.scan(fx.root);
    const one = r.entries.find((x) => x.rel === '.aibox/scratch/hub-qa/capture.png') as PurgeEntry;
    const { logId } = await fx.svc.trash(r.scanId, [one.id]);
    // Someone edits the journal: the quarantined copy now "comes from" a folder outside the project.
    const logFile = join(fx.data, 'purge', 'log.json');
    const log = JSON.parse(await readFile(logFile, 'utf8'));
    log[0].items[0].abs = join(fx.outside, 'pris.png');
    await writeFile(logFile, JSON.stringify(log));
    const fresh = new PurgeService({ ...(fx.svc as unknown as { opts: PurgeOptions }).opts });
    assert.equal((await fresh.restore(logId)).restored, 0);
    assert.ok(!existsSync(join(fx.outside, 'pris.png')));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('purge: names in either Unicode form are the same key (git lists NFC, a Mac disk may hold NFD)', () => {
  const svc = new PurgeService({ dataDir: join(tmpdir(), 'purge-nfc-unused'), index: { all: async () => [], counts: () => ({ claude: 0, codex: 0, gemini: 0, activity: 0 }) }, trash: async () => {}, known: () => [], broad: () => [], busyScratch: () => [], git: gitIn, platform: 'darwin' });
  const nfd = '/p/e\u0301te\u0301.png';
  const nfc = '/p/\u00e9t\u00e9.png';
  assert.notEqual(nfd, nfc);
  assert.equal(svc.key(nfd), svc.key(nfc));
});
