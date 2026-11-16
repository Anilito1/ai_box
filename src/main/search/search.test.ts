import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SEARCH_DEFAULTS } from '../../shared/search';
import { applyPatch, loadConfig } from '../config';
import { chunkFile, MAX_LINES } from './chunker';
import { pickDevice } from './engine';
import { looksWritten, redact, skipReason } from './files';
import { syncDocs, syncFiles, syncVectors, usesOf } from './indexer';
import { formatHits, ftsQuery, nearest, rrf, search } from './search';
import { shorten } from './service';
import { identifierParts, SearchStore } from './store';

const lines = (n: number, of: (i: number) => string): string => Array.from({ length: n }, (_, i) => of(i)).join('\n');

/** A stand-in for the model: a text's vector says which of these words it holds. */
const WORDS = ['invoice', 'refund', 'login', 'webhook'];
const fakeEmbed = async (texts: string[]): Promise<Float32Array[]> => texts.map((t) => Float32Array.from(WORDS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0))));

test('files: what is never read, and what is read without its keys', () => {
  for (const path of ['node_modules/a/index.js', 'dist/main.mjs', 'packages/x/build/out.js', 'a/.git/config']) assert.equal(skipReason(path), 'dir', path);
  for (const path of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml']) assert.equal(skipReason(path), 'lock', path);
  for (const path of ['.env', '.env.local', 'api/prod.env', 'certs/server.pem', 'id_rsa', 'deploy/app.key', 'credentials.json', 'src/credentials.ts', 'secrets.yaml', '.npmrc']) assert.equal(skipReason(path), 'secret-name', path);
  for (const path of ['logo.png', 'model.glb', 'font.woff2', 'a.exe']) assert.equal(skipReason(path), 'type', path);
  assert.equal(skipReason('app.min.js'), 'minified');
  assert.equal(skipReason('data.json', 500_000), 'size');
  for (const path of ['src/main/secrets.ts', 'src/environment.ts', 'supabase/migrations/001_init.sql', 'README.md']) assert.equal(skipReason(path, 1000), '', path);

  const jwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJyb2xlIjoiYW5vbiIsImlhdCI6MTYwMDAwMDAwMH0', 'c2lnbmF0dXJlLXNpZ25hdHVyZQ'].join('.');
  const source = `const KEY = '${jwt}';\nconst a = 'sk-${'a'.repeat(30)}';\nconst b = "sbp_${'0'.repeat(40)}";\nfetch(url);`;
  const clean = redact(source);
  assert.equal(clean.count, 3);
  assert.equal(clean.text, `const KEY = '[secret]';\nconst a = '[secret]';\nconst b = "[secret]";\nfetch(url);`);
  assert.deepEqual(redact('const task = "sk-ip this"; // eyJ is how a JWT starts'), { text: 'const task = "sk-ip this"; // eyJ is how a JWT starts', count: 0 });
  assert.ok(looksWritten('function a() {\n  return 1;\n}\n'));
  assert.ok(!looksWritten(`var a=${'x'.repeat(3000)};`));
  assert.ok(!looksWritten('ab\u0000cd'));
});

/** Fake secrets, assembled here so that no scanner takes this file for a leak. Each has the shape of a real one. */
const FAKE = {
  openai: `sk-${'proj'}-${'A1b2C3d4'.repeat(5)}`,
  stripeLive: `sk_${'live'}_${'4eC39HqLyjWDarjt'.repeat(2)}`,
  stripeRestricted: `rk_${'live'}_${'9aB8cD7eF6gH5iJ4'.repeat(2)}`,
  stripeWebhook: `whsec_${'Zx9Yw8Vu7Ts6'.repeat(3)}`,
  supabase: `sbp_${'0a1b2c3d4e'.repeat(4)}`,
  jwt: [`eyJ${'hbGciOiJIUzI1NiJ9'}`, `eyJ${'yb2xlIjoic2VydmljZV9yb2xlIn0'}`, 'c2lnbmF0dXJlX3NpZ25hdHVyZQ'].join('.'),
  github: `ghp_${'Ab12Cd34Ef56Gh78Ij90'.repeat(2)}`,
  githubPat: `github_pat_${'11ABCDEFG0'.repeat(4)}`,
  slackBot: `xoxb-${'123456789012'}-${'abcdefABCDEF'}`,
  slackUser: `xoxp-${'210987654321'}-${'FEDCBAfedcba'}`,
  aws: `AKIA${'IOSFODNN7EXAMPLE'}`,
  shopify: `shpat_${'0123456789abcdef'.repeat(2)}`,
  shopifyShared: `shpss_${'fedcba9876543210'.repeat(2)}`,
  mailchimp: `${'0123456789abcdef'.repeat(2)}-us21`,
  pemBody: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
  ringover: 'a8f3k2m9x7q1w5e4r6t0',
  password: 'Tr0ub4dor&3xyz',
  serviceRole: 'srv-role-value-7781',
  bareToken: 'abcDEF1234567890xyzQ',
  clientSecret: 'cs_55aa66bb77cc',
};

test('secrets: masked in what is indexed, in what the model reads and in every answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-search-secrets-'));
  const store = new SearchStore(':memory:');
  try {
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    mkdirSync(join(root, 'billing'));
    mkdirSync(join(root, 'deploy'));
    writeFileSync(
      join(root, 'billing/config.js'),
      [
        `const OPENAI = '${FAKE.openai}';`,
        `const stripe = new Stripe('${FAKE.stripeLive}');`,
        `const restricted = "${FAKE.stripeRestricted}";`,
        `const endpointSigning = '${FAKE.stripeWebhook}';`,
        `const SUPABASE_ACCESS = '${FAKE.supabase}';`,
        `const anon = '${FAKE.jwt}';`,
        `const GH = '${FAKE.github}'; const PAT = '${FAKE.githubPat}';`,
        `const slack = ['${FAKE.slackBot}', '${FAKE.slackUser}'];`,
        `const aws = { id: '${FAKE.aws}' };`,
        `const shop = '${FAKE.shopify}'; const shared = '${FAKE.shopifyShared}';`,
        `const newsletter = '${FAKE.mailchimp}';`,
        `const RINGOVER_API_KEY = '${FAKE.ringover}';`,
        `const dbPassword = "${FAKE.password}";`,
        `const headers = { service_role: '${FAKE.serviceRole}' };`,
        `const signing = \`-----BEGIN RSA PRIVATE KEY-----\n${FAKE.pemBody}\n-----END RSA PRIVATE KEY-----\`;`,
        `const tokens = 1500;`,
        `const apiKey = process.env.OPENAI_API_KEY;`,
        `const labels = { 'account.token.hint': 'Paste your token here' };`,
        `export function chargeCustomer(order) {`,
        ...Array.from({ length: 22 }, (_, i) => `  step${i}(order, headers);`),
        `  return stripe.charges.create({ amount: order.total });`,
        `}`,
      ].join('\n'),
    );
    writeFileSync(join(root, 'deploy/settings.yml'), `name: billing\nauth_token: ${FAKE.bareToken}\nclient_secret: "${FAKE.clientSecret}"\nregion: eu-west-3\n`);

    const seenByModel: string[] = [];
    await syncFiles(store, root, root, 'fake');
    await syncVectors(store, root, 'fake', async (texts) => (seenByModel.push(...texts), fakeEmbed(texts)), { root });
    const indexed = [...store.vectors(root, 'fake').ids].map((id) => store.chunk(id)!);
    assert.ok(indexed.length >= 3);
    const hits = indexed.map((c) => ({ ...c, score: 1 }));
    const answers = [formatHits(hits, 'stripe api key password token', 8000, true), formatHits(hits, 'RINGOVER_API_KEY service_role', 600), formatHits(hits, 'x', 40)];
    const everything = [...indexed.map((c) => `${c.symbol}\n${c.text}`), ...seenByModel, ...answers].join('\n');
    for (const [name, value] of Object.entries(FAKE)) assert.ok(!everything.includes(value), `${name} leaked`);

    // What is not a secret stays, and so does the code around the secrets.
    const config = indexed.map((c) => c.text).join('\n');
    assert.ok(config.includes("const RINGOVER_API_KEY = '[secret]';"));
    assert.ok(config.includes('const dbPassword = "[secret]";'));
    assert.ok(config.includes("service_role: '[secret]'"));
    assert.ok(config.includes('auth_token: [secret]') && config.includes('client_secret: "[secret]"') && config.includes('region: eu-west-3'));
    assert.ok(config.includes('const tokens = 1500;'));
    assert.ok(config.includes('const apiKey = process.env.OPENAI_API_KEY;'));
    assert.ok(config.includes("'account.token.hint': 'Paste your token here'"));
    assert.equal((await search(store, root, 'fake', 'chargeCustomer', 3, { lexical: true, vectors: false, rerank: 0 }, {}))[0].symbol, 'chargeCustomer');

    // An answer is checked again on its way out, whatever the index holds (one built before a rule existed).
    const old = { id: 1, path: 'old.js', start: 1, end: 2, symbol: 'legacy', kind: 'code' as const, hash: 'x', score: 1, text: `const a = '${FAKE.stripeLive}';\nconst webhookSecret = "${FAKE.clientSecret}";` };
    const out = formatHits([old], 'legacy', 500, true);
    assert.ok(!out.includes(FAKE.stripeLive) && !out.includes(FAKE.clientSecret) && out.includes("const a = '[secret]';"), out);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('chunker: a long class is cut at its methods, each with its comment and its name', async () => {
  const method = (name: string) => `  /** Does ${name}. */\n  ${name}(): number {\n${lines(26, (i) => `    const v${i} = ${i};`)}\n    return 1;\n  }`;
  const source = `import { helper } from './helper';\nimport type { T } from './types';\n\n/** Keeps the orders. */\nexport class Orders {\n  private count = 0;\n\n${['load', 'save', 'refund', 'close'].map(method).join('\n\n')}\n}\n\nexport function tiny(): void {}\nexport const other = 1;\n`;
  const chunks = await chunkFile('src/orders.ts', source);
  const refund = chunks.find((c) => c.symbol === 'Orders.refund');
  assert.ok(refund, chunks.map((c) => c.symbol).join(' | '));
  assert.equal(refund.kind, 'method');
  assert.ok(refund.text.startsWith('  /** Does refund. */'));
  assert.ok(refund.text.trimEnd().endsWith('}'));
  assert.equal(source.split('\n').slice(refund.start - 1, refund.end).join('\n'), refund.text);
  // The imports are not a piece of their own; the class's first lines keep its documentation.
  assert.ok(chunks.every((c) => !c.text.startsWith('import ')));
  assert.ok(chunks.some((c) => c.text.includes('/** Keeps the orders. */') && c.text.includes('export class Orders {')));
  // Short neighbours go together.
  assert.ok(chunks.some((c) => c.symbol === 'tiny, other'));
  assert.ok(chunks.every((c) => c.kind === 'outline' || c.end - c.start + 1 <= MAX_LINES));
});

test('chunker: nested code, an outline for a long file, windows for a block with no structure', async () => {
  const fn = (name: string, n: number) => `  function ${name}() {\n${lines(n, (i) => `    step${i}();`)}\n  }`;
  const iife = `(function () {\n${fn('openPanel', 50)}\n\n${fn('dialNumber', 50)}\n\n${fn('hangUp', 50)}\n})();\n`;
  const chunks = await chunkFile('panel.js', iife);
  assert.deepEqual(chunks.filter((c) => c.kind === 'function').map((c) => c.symbol), ['openPanel', 'dialNumber', 'hangUp']);
  const top = chunks.find((c) => c.kind === 'outline');
  assert.ok(top && top.start === 1 && /dialNumber L\d+-\d+/.test(top.text), top?.text);

  const flat = await chunkFile('notes.txt', lines(200, (i) => `line ${i}`));
  assert.ok(flat.length >= 4);
  assert.ok(flat[1].start < flat[0].end, 'windows overlap');
  assert.equal(flat.at(-1)?.end, 200);
});

test('chunker: SQL by statement, Markdown by section, Python by definition', async () => {
  const sql = `-- Orders of a shop\ncreate table if not exists public.orders (\n  id bigint primary key,\n${lines(22, (i) => `  c${i} text,`)}\n  note text -- a ; in a comment\n);\n\ncreate or replace function public.count_orders(shop text) returns int language plpgsql as $$\nbegin\n${lines(22, (i) => `  perform ${i};`)}\n  return 1; -- body; with; semicolons\nend;\n$$;\n\ncreate policy "read own" on public.orders for select using (true);\n`;
  const statements = await chunkFile('supabase/migrations/1_orders.sql', sql);
  assert.deepEqual(statements.map((c) => c.symbol), ['table public.orders', 'function public.count_orders', 'policy read own']);
  assert.ok(statements[1].text.trimEnd().endsWith('$$;'));

  const md = await chunkFile('docs/guide.md', `# Guide\n${lines(25, (i) => `intro ${i}`)}\n## Install\n${lines(25, (i) => `step ${i}`)}\n\`\`\`\n# not a heading\n\`\`\`\n## Use\n${lines(25, (i) => `use ${i}`)}\n`);
  assert.deepEqual(md.map((c) => c.symbol), ['Guide', 'Install', 'Use']);

  const py = await chunkFile('app/jobs.py', `import os\n\nclass Jobs:\n    """Runs the jobs."""\n${['start', 'stop', 'retry'].map((n) => `    def ${n}(self):\n${lines(34, (i) => `        x${i} = ${i}`)}\n        return 1\n`).join('\n')}`);
  assert.ok(py.some((c) => c.symbol === 'Jobs.retry'), py.map((c) => c.symbol).join(' | '));
});

test('words and fusion: identifiers are found by their parts, lists are merged by rank', () => {
  assert.equal(identifierParts('hubTools list_repos HTTPServer id'), 'hub tools list repos http server');
  assert.equal(ftsQuery('Où est géré hubTools ?'), '"hubtools" OR "hub" OR "tools"');
  assert.equal(ftsQuery('a "quoted" AND (weird) NEAR/2 thing*'), '"quoted" OR "weird" OR "near" OR "thing"');
  assert.equal(ftsQuery('où est le'), '');
  assert.deepEqual(rrf([[1, 2, 3], [3, 4], [3, 1]]), [3, 1, 2, 4]);
  const index = { ids: Int32Array.of(10, 11, 12), data: Float32Array.of(1, 0, 0, 1, 0.6, 0.8), dims: 2 };
  assert.deepEqual(nearest(index, Float32Array.of(0, 1), 2), [11, 12]);
  assert.deepEqual(nearest(index, Float32Array.of(0, 1), 2, (id) => id !== 11), [12, 10]);
  const short = shorten(Float32Array.of(3, 4, 12), 2);
  assert.deepEqual([...short].map((x) => Number(x.toFixed(2))), [0.6, 0.8]);
  assert.equal(pickDevice(['Intel(R) UHD Graphics', 'NVIDIA GeForce RTX 4060 Laptop GPU']), 1);
  assert.equal(pickDevice(['AMD Radeon RX 7600', 'Intel(R) Iris Xe']), 0);
  assert.equal(pickDevice(['Intel(R) UHD Graphics']), -1);
  assert.equal(pickDevice([]), -1);
});

test('uses: only the modules a piece really leans on', () => {
  const file = `import { z } from 'zod';\nimport type { HubTool } from './providers/types';\nimport { join } from 'node:path';\nconst fs = require('node:fs');\n`;
  assert.equal(usesOf(file, 'const tool: HubTool = { shape: z.string() };'), 'zod, ./providers/types');
  assert.equal(usesOf(file, 'fs.readFileSync(join(a, b))'), 'node:path, node:fs');
  assert.equal(usesOf(file, 'return 1;'), '');
});

test('index: follows git, leaves secrets out, and computes only what changed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-search-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const store = new SearchStore(':memory:');
  try {
    git('init', '-q');
    write('.gitignore', 'ignored/\n');
    write('src/billing.ts', `export function makeInvoice(order: Order): Invoice {\n${lines(24, (i) => `  const line${i} = order.lines[${i}];`)}\n  return build(order);\n}\n\nexport function refundOrder(id: string): void {\n${lines(24, (i) => `  step${i}(id);`)}\n}\n`);
    write('src/auth.ts', `const KEY = 'sk-${'k'.repeat(32)}';\nexport function login(user: string): boolean {\n${lines(24, (i) => `  check${i}(user);`)}\n  return true;\n}\n`);
    write('.env', 'TOKEN=abc');
    write('ignored/big.ts', 'export const invoice = 1;');
    write('node_modules/x/index.js', 'module.exports = 1;');
    git('add', 'src/billing.ts');

    let embedded = 0;
    const embed = async (texts: string[]) => ((embedded += texts.length), fakeEmbed(texts));
    const first = await syncFiles(store, root, root, 'fake');
    assert.equal(first.files, 2, 'tracked and new files, the ignored folder and node_modules left out');
    assert.equal(store.files(root).get('.env')?.skipped, 'secret-name');
    assert.ok(!store.files(root).has('ignored/big.ts'));
    await syncVectors(store, root, 'fake', embed, { root });
    assert.equal(embedded, first.chunks);
    assert.equal(store.stats(root, 'fake').vectors, first.chunks);

    // The key never reached the index: neither the text that is searched nor the one that is shown.
    const stages = { lexical: true, vectors: true, rerank: 0 };
    const engines = { embedQuery: async (q: string) => (await fakeEmbed([q]))[0] };
    const login = await search(store, root, 'fake', 'where is the login check', 5, stages, engines);
    assert.equal(login[0].path, 'src/auth.ts');
    const auth = (await search(store, root, 'fake', 'KEY login', 10, { ...stages, vectors: false }, {})).filter((h) => h.path === 'src/auth.ts');
    assert.ok(auth.some((h) => h.text.includes("const KEY = '[secret]'")));
    assert.ok(auth.every((h) => !h.text.includes('kkkk')));

    // Words only, meaning only, both.
    assert.equal((await search(store, root, 'fake', 'refundOrder', 5, { ...stages, vectors: false }, {}))[0].symbol, 'refundOrder');
    assert.equal((await search(store, root, 'fake', 'refund', 5, { ...stages, lexical: false }, engines))[0].symbol, 'refundOrder');
    assert.equal((await search(store, root, 'fake', 'invoice', 5, stages, engines, 'src/auth'))[0]?.path ?? 'src/auth.ts', 'src/auth.ts');
    // A reranker that prefers the last candidate turns the order around.
    const reversed = await search(store, root, 'fake', 'invoice refund login', 5, { ...stages, rerank: 30 }, { ...engines, rerank: async (_q, docs) => docs.map((_d, i) => i) });
    const plain = await search(store, root, 'fake', 'invoice refund login', 5, stages, engines);
    assert.deepEqual(reversed.map((h) => h.id), plain.map((h) => h.id).reverse());

    // One function changes: one text goes to the model, the other vectors stay.
    embedded = 0;
    write('src/billing.ts', `export function makeInvoice(order: Order): Invoice {\n${lines(24, (i) => `  const line${i} = order.lines[${i}];`)}\n  return build(order);\n}\n\nexport function refundOrder(id: string): void {\n${lines(24, (i) => `  step${i}(id);`)}\n  notifyWebhook(id);\n}\n`);
    const second = await syncFiles(store, root, root, 'fake');
    assert.equal(second.changed, 1);
    assert.equal(second.missing, 1);
    await syncVectors(store, root, 'fake', embed, { root });
    assert.equal(embedded, 1);
    assert.equal((await search(store, root, 'fake', 'webhook', 5, { ...stages, lexical: false }, engines))[0].symbol, 'refundOrder');

    // Nothing changed: nothing is read again. A file deleted leaves the index.
    assert.equal((await syncFiles(store, root, root, 'fake')).changed, 0);
    rmSync(join(root, 'src/auth.ts'));
    const third = await syncFiles(store, root, root, 'fake');
    assert.equal(third.removed, 1);
    assert.equal((await search(store, root, 'fake', 'login', 5, { ...stages, vectors: false }, {})).length, 0);

    // A second checkout of the same code shares the vectors: nothing to compute for it.
    assert.equal((await syncFiles(store, `${root}-worktree`, root, 'fake')).missing, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory: documents are searched like files and follow their changes', async () => {
  const store = new SearchStore(':memory:');
  try {
    const docs = [
      { id: 'topic/billing', text: '# billing\nMove invoices to the new provider.\n## Summary\nThe refund flow is done.' },
      { id: 'note/hub-web', text: 'The login page waits for the design.' },
    ];
    await syncDocs(store, 'memory:master', docs);
    assert.equal(await syncVectors(store, 'memory:master', 'fake', fakeEmbed), 2);
    const engines = { embedQuery: async (q: string) => (await fakeEmbed([q]))[0] };
    const stages = { lexical: true, vectors: true, rerank: 0 };
    assert.equal((await search(store, 'memory:master', 'fake', 'refund', 3, stages, engines))[0].path, 'topic/billing');
    await syncDocs(store, 'memory:master', [docs[1]]);
    assert.equal((await search(store, 'memory:master', 'fake', 'refund invoices', 3, { ...stages, vectors: false }, {})).length, 0);
    // Another scope never sees these.
    assert.equal((await search(store, 'memory:hub-web', 'fake', 'login', 3, stages, engines)).length, 0);
  } finally {
    store.close();
  }
});

test('answer: locations first, excerpts within the budget, whole pieces on demand', () => {
  const body = (name: string) => `function ${name}() {\n${lines(60, (i) => (i === 40 ? '  sendWebhook(order); // the call' : `  filler${i}();`))}\n}`;
  const hits = ['alpha', 'beta', 'gamma'].map((name, i) => ({ id: i, path: `src/${name}.ts`, start: 10, end: 71, symbol: name, kind: 'function' as const, hash: name, text: body(name), score: 1 }));
  const tokens = (s: string) => Math.ceil(s.length / 3.6);
  const out = formatHits(hits, 'where is sendWebhook called', 400);
  assert.ok(tokens(out) <= 400, String(tokens(out)));
  assert.ok(out.startsWith('src/alpha.ts:10-71 alpha\nfunction alpha() {'));
  assert.ok(out.includes('sendWebhook(order)'), 'the excerpt shows the lines that carry the words of the question');
  for (const h of hits) assert.ok(out.includes(`${h.path}:10-71`), 'every result keeps its location');
  const tight = formatHits(hits, 'x', 30);
  assert.deepEqual(tight.split('\n\n'), ['src/alpha.ts:10-71 alpha', 'src/beta.ts:10-71 beta', 'src/gamma.ts:10-71 gamma']);
  const whole = formatHits(hits.slice(0, 1), 'x', 4000, true);
  assert.ok(whole.includes('filler0();') && whole.includes('filler59();'));
  assert.equal(formatHits([], 'x', 100), 'No result.');
});

test('settings: off by default, and only sane values are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-search-cfg-'));
  try {
    const cfg = loadConfig(dir, 'fr');
    assert.deepEqual(cfg.search, SEARCH_DEFAULTS);
    assert.equal(cfg.search.enabled, false);
    assert.equal(applyPatch(cfg, { search: { enabled: true, idleMinutes: 10, device: 'cpu', budget: 2000, repos: [dir, dir] } }), null);
    assert.deepEqual({ ...cfg.search }, { enabled: true, idleMinutes: 10, device: 'cpu', budget: 2000, repos: [dir] });
    assert.equal(applyPatch(cfg, { search: { idleMinutes: 0 } }), 'search.idleMinutes');
    assert.equal(applyPatch(cfg, { search: { device: 'tpu' as never } }), 'search.device');
    assert.equal(applyPatch(cfg, { search: { budget: 50 } }), 'search.budget');
    assert.equal(applyPatch(cfg, { search: { repos: ['relative/path'] } }), 'search.repos');
    assert.equal(cfg.search.idleMinutes, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
