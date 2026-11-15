import assert from 'node:assert/strict';
import { test } from 'node:test';
import { citationKeys, classify, commandPaths, formatBytes, globTest, inScratch, nameSignals, outputPattern, pathTokens, scratchName, type FileFacts } from './purge';

const facts = (rel: string, over: Partial<FileFacts> = {}): FileFacts => ({
  rel,
  tracked: false,
  cited: false,
  provenance: 'command',
  touchedOutside: false,
  excluded: false,
  recent: false,
  running: false,
  ...over,
});
const cat = (rel: string, over: Partial<FileFacts> = {}) => classify(facts(rel, over))?.category ?? null;
const block = (rel: string, over: Partial<FileFacts> = {}) => classify(facts(rel, over))?.block ?? null;

// ---------- what must never go ----------

test('a file git tracks is protected, wherever it is, scratch included', () => {
  assert.equal(block('qc/capture-1.png', { tracked: true }), 'tracked');
  assert.equal(block('.aibox/scratch/w/a.png', { tracked: true }), 'tracked');
  assert.equal(block('tmp/run.log', { tracked: null }), 'gitUnknown');
});

test('a file cited in a conversation is protected outside the scratch, and waits for a tick inside it', () => {
  assert.equal(block('qc/planche-finale.png', { cited: true }), 'cited');
  assert.equal(block('tmp/frame_0001.png', { cited: true }), 'cited');
  assert.equal(cat('.aibox/scratch/w/planche.png', { cited: true }), 'check');
});

test('a file changed outside the agents after it was made is protected', () => {
  assert.equal(block('qc/capture.png', { touchedOutside: true }), 'userModified');
  assert.equal(block('debug/out.log', { provenance: 'write', touchedOutside: true }), 'userModified');
  assert.equal(cat('.aibox/scratch/w/x.png', { touchedOutside: true }), 'check');
});

test('deliverables, documents, archives and creative working files are protected outside the scratch', () => {
  for (const rel of ['renders/final/hero.png', 'final/a.mp4', 'tmp/rendu-final.png', 'livrables/planche.png', 'export/qc.png', 'dist/screenshot.png', 'tmp/version-validée.jpg']) {
    assert.equal(block(rel), 'deliverable', rel);
  }
  for (const rel of ['KIT-LIZ-BLEPS.zip', 'tmp/MISE-EN-PROD.md', 'qc/rapport.pdf', 'tmp/scene.blend', 'tmp/data.tar.gz', 'debug/table.csv', 'captures/logo.svg']) {
    assert.equal(block(rel), 'document', rel);
  }
});

test('secrets, exclusions, recent files and a working worker\'s scratch are protected everywhere', () => {
  assert.equal(block('tmp/.env.local'), 'secret');
  assert.equal(block('.aibox/scratch/w/id_rsa'), 'secret');
  assert.equal(block('debug/server.pem'), 'secret');
  assert.equal(block('qc/a.png', { excluded: true }), 'excluded');
  assert.equal(block('.aibox/scratch/w/a.png', { excluded: true }), 'excluded');
  assert.equal(block('qc/a.png', { recent: true }), 'recent');
  assert.equal(block('.aibox/scratch/w/a.png', { running: true }), 'running');
});

test('names alone never make a file safe', () => {
  assert.equal(cat('tmp/capture.png', { provenance: null }), 'check');
  assert.equal(cat('qc/frame_0001.png', { provenance: null }), 'check');
  assert.equal(cat('photos/IMG_2041.jpg', { provenance: null }), null);
  assert.equal(cat('src/app.ts', { provenance: null }), null);
  // Born while an agent worked, but nothing names it: at most "likely".
  assert.equal(cat('tmp/frame.png', { provenance: 'session' }), 'likely');
  assert.equal(cat('renders/hero.png', { provenance: 'session' }), 'check');
  assert.equal(cat('notes/idea.txt', { provenance: 'session' }), null);
});

test('what an agent made without a throwaway sign is only suggested', () => {
  assert.equal(cat('renders/hero.png'), 'check'); // Maybe the render that was asked for.
  assert.equal(cat('gen/model.onnx', { provenance: 'command' }), 'check');
  assert.equal(cat('tmp/model.onnx'), 'likely');
  assert.equal(cat('tmp/essai.py', { provenance: 'write' }), 'check');
  assert.equal(cat('page.html', { provenance: 'write' }), 'check');
});

test('safe: the scratch, or an agent\'s look-once output in a throwaway place', () => {
  assert.equal(cat('.aibox/scratch/w/anything.bin', { provenance: null }), 'safe');
  assert.equal(cat('sub/.aibox/scratch/w/a.png', { provenance: null }), 'safe');
  assert.equal(cat('qc/frames-all/f_0001.png'), 'safe');
  assert.equal(cat('test-results/trace.zip'), 'protected'); // An archive, even there.
  assert.equal(cat('test-results/run.log'), 'safe');
  assert.equal(cat('screenshot-home.png'), 'safe');
  assert.equal(cat('x.png', { appScratch: true, provenance: null }), 'safe');
});

test('paths with spaces, accents and odd characters are classed like the others', () => {
  assert.equal(cat('Mes rendus/aperçus #2/capture (1) [v3].png'), 'safe');
  assert.equal(block('Livraison client/été 2026/rendu 100%.png'), 'deliverable');
  assert.equal(block('dossier ünïcode/🎬 tmp/clip.mp4', { tracked: true }), 'tracked');
  assert.equal(nameSignals('C:/x/y.png').media, true);
});

test('the scratch folder is recognised at any depth, and only there', () => {
  assert.equal(inScratch('.aibox/scratch/w/a.png'), true);
  assert.equal(inScratch('app/.aibox/scratch/w/a.png'), true);
  assert.equal(inScratch('.aibox/a.png'), false);
  assert.equal(inScratch('my.aibox/scratch/a.png'), false);
  assert.equal(inScratch('.aibox/scratch'), false);
});

// ---------- citations ----------

test('citations: a full path, a tail, a name, or the file\'s own folder of two levels at least', () => {
  const tokens = new Set(pathTokens('Planches dans `renders/qc/sheets/`, rendu C:\\Proj\\out\\hero.png et "capture-01.png". Voir gen/ et https://x.y/a.png'));
  const has = (abs: string, rel: string) => citationKeys(abs.toLowerCase(), rel.toLowerCase()).some((k) => tokens.has(k));
  assert.equal(has('c:/proj/out/hero.png', 'out/hero.png'), true);
  assert.equal(has('c:/proj/x/capture-01.png', 'x/capture-01.png'), true);
  assert.equal(has('c:/proj/renders/qc/sheets/s1.png', 'renders/qc/sheets/s1.png'), true);
  // Not its parent's sub-folders, not a single folder name, not the project itself, not a URL.
  assert.equal(has('c:/proj/renders/qc/sheets/deep/s1.png', 'renders/qc/sheets/deep/s1.png'), false);
  assert.equal(has('c:/proj/gen/img.png', 'gen/img.png'), false);
  assert.equal(has('c:/proj/a.png', 'a.png'), true === tokens.has('a.png'));
  assert.equal([...tokens].some((t) => t.startsWith('https')), false);
});

test('pathTokens normalises separators, case, quotes, ./ and line suffixes', () => {
  const tokens = pathTokens('see ./Src/Main.ts:12 and (docs\\Guide.MD), `mon rapport.pdf`; [lien](<a b/c.png>)');
  assert.ok(tokens.includes('src/main.ts'));
  assert.ok(tokens.includes('docs/guide.md'));
  assert.ok(tokens.includes('mon rapport.pdf'));
  assert.ok(tokens.includes('a b/c.png'));
  assert.ok(!tokens.includes('and'));
});

// ---------- commands ----------

test('commandPaths finds the outputs a command names', () => {
  const paths = commandPaths('ffmpeg -y -i "in put.mp4" -vf fps=2 qc/frames/f_%04d.png && npx playwright screenshot --full-page http://localhost:3000 shots/home.png > debug/run.log --output=out/x.webm');
  for (const p of ['in put.mp4', 'qc/frames/f_%04d.png', 'shots/home.png', 'debug/run.log', 'out/x.webm']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => p.startsWith('http')));
  assert.ok(!paths.includes('-y'));
  assert.deepEqual(commandPaths("Out-File -FilePath 'C:\\tmp\\a b.txt'"), ['C:\\tmp\\a b.txt']);
});

test('outputPattern matches frame numbers and globs, and nothing for a plain path', () => {
  const rx = outputPattern('c:/p/qc/f_%04d.png') as RegExp;
  assert.ok(rx.test('c:/p/qc/f_0001.png'));
  assert.ok(!rx.test('c:/p/qc/f_final.png'));
  assert.ok(!rx.test('c:/p/qc/sub/f_0001.png'));
  assert.ok((outputPattern('/p/shots/*.png') as RegExp).test('/p/shots/a b.png'));
  assert.equal(outputPattern('/p/a.png'), null);
});

// ---------- settings and names ----------

test('exclusion patterns read like .gitignore', () => {
  const t = (p: string, rel: string, blind = true) => (globTest(p, blind) as (r: string) => boolean)(rel);
  assert.equal(t('renders/final/**', 'renders/final/a/b.png'), true);
  assert.equal(t('*.blend', 'deep/scene.blend'), true);
  assert.equal(t('livraison/', 'livraison/a.png'), true);
  assert.equal(t('/tmp', 'a/tmp/x.png'), false);
  assert.equal(t('tmp', 'a/tmp/x.png'), true);
  assert.equal(t('QC/*.PNG', 'qc/a.png', true), true);
  assert.equal(t('QC/*.PNG', 'qc/a.png', false), false);
  assert.equal(globTest('  # a comment', true), null);
  assert.equal(globTest('', true), null);
});

test('scratchName makes a safe folder name of any session name', () => {
  assert.equal(scratchName('hub-aibox-purge'), 'hub-aibox-purge');
  assert.equal(scratchName('../../etc'), 'etc');
  assert.equal(scratchName('Équipe QA / 2'), 'Equipe-QA-2');
  assert.equal(scratchName('..'), 'session');
  assert.equal(scratchName('a'.repeat(200)).length, 64);
});

test('formatBytes in both languages', () => {
  assert.equal(formatBytes(512, 'fr'), '512 o');
  assert.equal(formatBytes(1536, 'fr'), '1,5 Ko');
  assert.equal(formatBytes(1536, 'en'), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 3, 'en'), '5.0 GB');
});
