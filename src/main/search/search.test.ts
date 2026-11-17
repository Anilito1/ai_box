import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SEARCH_DEFAULTS } from '../../shared/search';
import { applyPatch, loadConfig } from '../config';
import { chunkFile, cutFile, MAX_LINES } from './chunker';
import { pickDevice } from './engine';
import { looksWritten, redact, skipReason } from './files';
import { importRefs, infraOf, statusPaths, syncDocs, syncFiles, syncVectors, usesOf } from './indexer';
import { answer, formatHits, formatUnsure, ftsQuery, lookup, nearest, routeOf, rrf, search, TUNING, type Hit } from './search';
import { lastDefinitions, shorten } from './service';
import { identifierParts, quantize, SearchStore } from './store';
import { rangesOf, SearchTelemetry, type SearchRecord } from './telemetry';

const lines = (n: number, of: (i: number) => string): string => Array.from({ length: n }, (_, i) => of(i)).join('\n');

/** A stand-in for the model: a text's vector says which of these words it holds. */
const WORDS = ['invoice', 'refund', 'login', 'webhook'];
const fakeEmbed = async (texts: string[]): Promise<Float32Array[]> =>
  texts.map((t) => {
    const v = Float32Array.from(WORDS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)));
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
const engines = { embedQuery: async (q: string) => (await fakeEmbed([q]))[0] };
const stages = { lexical: true, vectors: true, rerank: 0 };

function tempRepo(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git('init', '-q');
  return { root, git, write };
}

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
  const { root, write } = tempRepo('hub-search-secrets-');
  const store = new SearchStore(':memory:');
  try {
    write(
      'billing/config.js',
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
    write('deploy/settings.yml', `name: billing\nauth_token: ${FAKE.bareToken}\nclient_secret: "${FAKE.clientSecret}"\nregion: eu-west-3\n`);

    const seenByModel: string[] = [];
    await syncFiles(store, root, root, 'fake');
    await syncVectors(store, root, 'fake', async (texts) => (seenByModel.push(...texts), fakeEmbed(texts)), { root });
    const indexed = [...store.vectors(root, 'fake').ids].map((id) => store.chunk(id)!);
    assert.ok(indexed.length >= 3);
    const hits = indexed.map((c): Hit => ({ ...c, score: 1, by: 'meaning' }));
    const answers = [formatHits(hits, 'stripe api key password token', 8000, true), formatHits(hits, 'RINGOVER_API_KEY service_role', 600), formatHits(hits, 'x', 40), formatUnsure(hits)];
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
    assert.equal(lookup(store, root, routeOf('chargeCustomer'), 3)[0].symbol, 'chargeCustomer');

    // An answer is checked again on its way out, whatever the index holds (one built before a rule existed).
    const old: Hit = { id: 1, path: 'old.js', start: 1, end: 2, symbol: 'legacy', kind: 'code', hash: 'x', score: 1, by: 'words', text: `const a = '${FAKE.stripeLive}';\nconst webhookSecret = "${FAKE.clientSecret}";` };
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
  const { chunks, symbols } = await cutFile('src/orders.ts', source);
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
  // Every name the file defines, each with its whole extent: the class from its comment to its closing brace.
  const orders = symbols.find((s) => s.name === 'Orders');
  assert.deepEqual([orders?.kind, orders?.start, source.split('\n')[(orders?.end ?? 0) - 1]], ['class', 4, '}']);
  assert.deepEqual(symbols.map((s) => s.name), ['Orders', 'Orders.count', 'Orders.load', 'Orders.save', 'Orders.refund', 'Orders.close', 'tiny', 'other']);
  // What a function keeps to itself is not a name to look up; a function inside a function is.
  const nested = await cutFile('src/deep.ts', `export function outer() {\n  const local = 1;\n  function inner() {\n    const deeper = 2;\n${lines(100, (i) => `    step${i}();`)}\n  }\n}\n`);
  assert.deepEqual(nested.symbols.map((s) => s.name), ['outer', 'outer.inner']);
  const long = await cutFile('src/long.ts', `export function syncAll() {\n  const known = 1;\n  const seen = 2;\n${lines(100, (i) => `  step${i}();`)}\n}\n`);
  assert.deepEqual(long.symbols.map((s) => s.name), ['syncAll']);
  // A short class is one piece, and its methods are names all the same; so are the members of an object.
  const small = await cutFile('src/small.ts', `export class Cart {\n  total = 0;\n  refund(): void {}\n  charge(): void {}\n}\nexport const api = {\n  start() {},\n  stop: () => {},\n};\n`);
  assert.deepEqual(small.symbols.map((s) => `${s.kind} ${s.name}`), ['class Cart', 'code Cart.total', 'method Cart.refund', 'method Cart.charge', 'code api']);
  assert.equal(small.chunks.length, 1);
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
  const statements = await cutFile('supabase/migrations/1_orders.sql', sql);
  assert.deepEqual(statements.chunks.map((c) => c.symbol), ['table public.orders', 'function public.count_orders', 'policy read own']);
  assert.ok(statements.chunks[1].text.trimEnd().endsWith('$$;'));
  assert.deepEqual(statements.symbols.map((s) => `${s.kind} ${s.name}`), ['table public.orders', 'function public.count_orders', 'policy read own']);
  // Changing a table is not making it: only the statement that creates is where the table "is".
  const later = await cutFile('supabase/migrations/2_more.sql', `alter table public.orders enable row level security;\ndrop function if exists public.old_count(text);\ncreate index orders_shop on public.orders(shop);\n`);
  assert.deepEqual(later.symbols.map((s) => `${s.kind} ${s.name}`), ['index orders_shop']);
  assert.ok(later.chunks[0].symbol.includes('alter table public.orders'));
  // Names quoted part by part, as a dump of the database writes them.
  const dumped = await cutFile('supabase/migrations/3_dump.sql', `CREATE TABLE IF NOT EXISTS "public"."orders" (id int);\nCREATE OR REPLACE FUNCTION "public"."count_orders"() RETURNS int LANGUAGE sql AS $$ select 1 $$;\n`);
  assert.deepEqual(dumped.symbols.map((s) => `${s.kind} ${s.name}`), ['table public.orders', 'function public.count_orders']);

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
  // A French question also asks for the English words code is written with, after its own words.
  assert.equal(ftsQuery('Où se fait la mise à jour du jeton ?'), '"mise" OR "jour" OR "update" OR "jeton" OR "token"');
  assert.equal(ftsQuery('Où se fait la mise à jour du jeton ?', false), '"mise" OR "jour" OR "jeton"');
  assert.deepEqual(rrf([[1, 2, 3], [3, 4], [3, 1]]), [3, 1, 2, 4]);
  assert.deepEqual(rrf([[1, 2], [3, 4]], [0.5, 1]), [3, 4, 1, 2]);
  const data = new Int8Array(6);
  [Float32Array.of(1, 0), Float32Array.of(0, 1), Float32Array.of(0.6, 0.8)].forEach((v, i) => data.set(quantize(v), i * 2));
  const index = { ids: Int32Array.of(10, 11, 12), data, dims: 2 };
  const near = nearest(index, Float32Array.of(0, 1), 2);
  assert.deepEqual(near.map((x) => x.id), [11, 12]);
  assert.deepEqual(near.map((x) => Number(x.score.toFixed(1))), [1, 0.8]);
  assert.deepEqual(nearest(index, Float32Array.of(0, 1), 2, (id) => id !== 11).map((x) => x.id), [12, 10]);
  assert.deepEqual(nearest(index, Float32Array.of(1, 0), 5).map((x) => x.id), [10, 12, 11]);
  const short = shorten(Float32Array.of(3, 4, 12), 2);
  assert.deepEqual([...short].map((x) => Number(x.toFixed(2))), [0.6, 0.8]);
  assert.equal(pickDevice(['Intel(R) UHD Graphics', 'NVIDIA GeForce RTX 4060 Laptop GPU']), 1);
  assert.equal(pickDevice(['AMD Radeon RX 7600', 'Intel(R) Iris Xe']), 0);
  assert.equal(pickDevice(['Intel(R) UHD Graphics']), -1);
  assert.equal(pickDevice([]), -1);
});

test('route: a name or a path needs no model, a described behaviour does', () => {
  const kind = (q: string) => routeOf(q).kind;
  for (const q of ['hubTools', 'redact', 'où est hubTools ?', 'list_repos', 'SessionManager.onEvent', 'la fonction `redact`', 'stripe-webhook', 'clamp_app_session_expiry trigger']) assert.equal(kind(q), 'symbol', q);
  for (const q of ['src/main/sessions.ts', 'où est sessions.ts', 'supabase/functions/stripe-webhook']) assert.equal(kind(q), 'path', q);
  for (const q of ['où est géré le délai avant de décharger un modèle ?', 'how are secrets removed before indexing', 'comment hubTools décide quels outils donner à un worker distant selon son rôle']) assert.equal(kind(q), 'concept', q);
  assert.deepEqual(routeOf('comment hubTools décide quels outils donner à un worker distant').names, ['hubTools']);
  assert.deepEqual(routeOf('Orders#refund et McpHub::start').names, ['Orders.refund', 'McpHub.start']);
  // What surrounds a name is not the name; words that only look like names or paths are words.
  assert.deepEqual([routeOf('hubTools()').kind, routeOf('hubTools()').names], ['symbol', ['hubTools']]);
  assert.deepEqual(routeOf('e.g. timeouts on a read/write lock and/or retries').names, []);
  assert.deepEqual(routeOf('e.g. timeouts on a read/write lock and/or retries').paths, []);
  assert.deepEqual(routeOf('where in src/main/sessions.ts is the handoff note written').paths, ['src/main/sessions.ts']);
  assert.equal(kind('where in src/main/sessions.ts is the handoff note written'), 'concept');
});

test('uses and infra: what a piece leans on, what a file sets up', () => {
  const imports = importRefs(`import { z } from 'zod';\nimport type { HubTool } from './providers/types';\nimport { join } from 'node:path';\nconst fs = require('node:fs');\nimport {\n  refundOrder,\n  makeInvoice as invoice,\n} from './billing';\n`);
  assert.deepEqual(imports.map((i) => `${i.source}:${i.names.join('+')}`), ['zod:z', './providers/types:HubTool', 'node:path:join', 'node:fs:fs', './billing:refundOrder+makeInvoice+invoice']);
  assert.equal(usesOf(imports, 'const tool: HubTool = { shape: z.string() };'), 'zod, ./providers/types');
  assert.equal(usesOf(imports, 'fs.readFileSync(join(a, b))'), 'node:path, node:fs');
  assert.equal(usesOf(imports, 'return 1;'), '');

  assert.deepEqual(infraOf('supabase/functions/stripe-webhook/index.ts', 'a\nb\nc'), [{ name: 'stripe-webhook', kind: 'edge', start: 1, end: 3 }]);
  assert.deepEqual(infraOf('apps/api/supabase/functions/send-mail/index.ts', 'x'), [{ name: 'send-mail', kind: 'edge', start: 1, end: 1 }]);
  assert.deepEqual(infraOf('supabase/functions/_shared/cors.ts', 'x'), []);
  assert.deepEqual(infraOf('supabase/migrations/2_jobs.sql', `select 1;\nselect cron.schedule(\n  'purge-sessions', '*/5 * * * *', $$ delete from s $$);`), [{ name: 'purge-sessions', kind: 'cron', start: 2, end: 2 }]);

  // An SQL function replaced by later migrations is its last definition; code keeps every definition.
  const def = (path: string, name: string, kind: string, start = 1) => ({ path, name, kind, start, end: start + 5 });
  const last = lastDefinitions([
    def('supabase/migrations/20260101_a.sql', 'public.count_orders', 'function'),
    def('supabase/migrations/20260301_c.sql', 'public.count_orders', 'function'),
    def('supabase/migrations/20260201_b.sql', 'public.count_orders', 'function'),
    def('src/orders.ts', 'count_orders', 'function'),
    def('supabase/migrations/20260101_a.sql', 'public.orders', 'table'),
  ]);
  assert.deepEqual(last.map((x) => `${x.def.kind} ${x.def.path} +${x.earlier}`), ['table supabase/migrations/20260101_a.sql +0', 'function supabase/migrations/20260301_c.sql +2', 'function src/orders.ts +0']);
  assert.deepEqual(statusPaths(' M src/a.ts\u0000?? new file.ts\u0000R  src/b.ts\u0000src/old.ts\u0000 D gone.ts\u0000'), ['src/a.ts', 'new file.ts', 'src/b.ts', 'src/old.ts', 'gone.ts']);
});

test('index: follows git, leaves secrets out, and computes only what changed', async () => {
  const { root, git, write } = tempRepo('hub-search-');
  const store = new SearchStore(':memory:');
  const billing = (extra = '') => `export function makeInvoice(order: Order): Invoice {\n${lines(24, (i) => `  const line${i} = order.lines[${i}];`)}\n  return build(order);\n}\n\nexport function refundOrder(id: string): void {\n${lines(24, (i) => `  step${i}(id);`)}\n${extra}}\n`;
  try {
    write('.gitignore', 'ignored/\n');
    write('src/billing.ts', billing());
    write('src/auth.ts', `const KEY = 'sk-${'k'.repeat(32)}';\nexport function login(user: string): boolean {\n${lines(24, (i) => `  check${i}(user);`)}\n  return true;\n}\n`);
    write('.env', 'TOKEN=abc');
    write('ignored/big.ts', 'export const invoice = 1;');
    write('node_modules/x/index.js', 'module.exports = 1;');
    git('add', 'src/billing.ts', '.gitignore');
    git('commit', '-q', '-m', 'first');

    let embedded = 0;
    const embed = async (texts: string[]) => ((embedded += texts.length), fakeEmbed(texts));
    const first = await syncFiles(store, root, root, 'fake');
    assert.ok(first.full);
    assert.equal(first.files, 2, 'tracked and new files, the ignored folder and node_modules left out');
    assert.equal(store.files(root).get('.env')?.skipped, 'secret-name');
    assert.ok(!store.files(root).has('ignored/big.ts'));
    await syncVectors(store, root, 'fake', embed, { root });
    assert.equal(embedded, first.chunks);
    assert.equal(store.stats(root, 'fake').vectors, first.chunks);

    // The key never reached the index: neither the text that is searched nor the one that is shown.
    const login = await search(store, root, 'fake', 'where is the login check', 5, stages, engines);
    assert.equal(login[0].path, 'src/auth.ts');
    const auth = (await search(store, root, 'fake', 'KEY login', 10, { ...stages, vectors: false }, {})).filter((h) => h.path === 'src/auth.ts');
    assert.ok(auth.some((h) => h.text.includes("const KEY = '[secret]'")));
    assert.ok(auth.every((h) => !h.text.includes('kkkk')));

    // Words only, meaning only, both; each result says what put it there and how sure it is.
    const byWords = await search(store, root, 'fake', 'refundOrder', 5, { ...stages, vectors: false }, {});
    assert.deepEqual([byWords[0].symbol, byWords[0].by], ['refundOrder', 'words']);
    const byMeaning = await search(store, root, 'fake', 'refund', 5, { ...stages, lexical: false }, engines);
    assert.deepEqual([byMeaning[0].symbol, byMeaning[0].by, byMeaning[0].score > 0.9], ['refundOrder', 'meaning', true]);
    assert.ok((await search(store, root, 'fake', 'invoice', 5, stages, engines, 'src/auth')).every((h) => h.path === 'src/auth.ts'));
    // A reranker that prefers the last candidate turns the order around…
    const reversed = await search(store, root, 'fake', 'invoice refund login', 5, { ...stages, rerank: 30 }, { ...engines, rerank: async (_q, docs) => docs.map((_d, i) => i) });
    const plain = await search(store, root, 'fake', 'invoice refund login', 5, stages, engines);
    assert.deepEqual(reversed.map((h) => h.id), plain.map((h) => h.id).reverse());
    assert.equal(reversed[0].by, 'reranker');
    // One piece per file leaves room for the other files.
    const spread = await search(store, root, 'fake', 'invoice refund login', 5, { ...stages, perFile: 1 }, engines);
    assert.deepEqual([plain.length > spread.length, new Set(spread.map((h) => h.path)).size === spread.length], [true, true]);
    // …and is not asked at all when it fails, or when the order by meaning is already clear.
    let asked = 0;
    const counting = { ...engines, rerank: async (_q: string, docs: string[]) => (asked++, docs.map(() => 0)) };
    await search(store, root, 'fake', 'refund', 5, { ...stages, rerank: 30, rerankGap: 2 }, counting);
    assert.equal(asked, 1);
    const failing = await search(store, root, 'fake', 'refund', 5, { ...stages, rerank: 30 }, { ...engines, rerank: async () => Promise.reject(new Error('no card')) });
    assert.equal(failing[0].symbol, 'refundOrder');

    // A name is answered from the definitions, with no model; a path gives the file.
    const def = lookup(store, root, routeOf('où est makeInvoice ?'), 5);
    assert.deepEqual(def.map((h) => [h.symbol, h.by, h.start, h.end]), [['makeInvoice', 'definition', 1, 27]]);
    assert.ok(def[0].text.startsWith('export function makeInvoice(') && def[0].text.endsWith('}'));
    assert.deepEqual(lookup(store, root, routeOf('src/auth.ts'), 5).map((h) => h.path), ['src/auth.ts', 'src/auth.ts']);
    assert.deepEqual(lookup(store, root, routeOf('nothingNamedLikeThis'), 5), []);

    // One function changes: git names the file, one text goes to the model, the other vectors stay.
    embedded = 0;
    write('src/billing.ts', billing('  notifyWebhook(id);\n'));
    const second = await syncFiles(store, root, root, 'fake');
    assert.deepEqual([second.full, second.changed, second.missing], [false, 1, 1]);
    await syncVectors(store, root, 'fake', embed, { root });
    assert.equal(embedded, 1);
    assert.equal((await search(store, root, 'fake', 'webhook', 5, { ...stages, lexical: false }, engines))[0].symbol, 'refundOrder');

    // Nothing changed: nothing is read again. A commit, a file put back, a file deleted: each is followed.
    assert.equal((await syncFiles(store, root, root, 'fake')).changed, 0);
    git('add', '-A');
    git('commit', '-q', '-m', 'second');
    assert.equal((await syncFiles(store, root, root, 'fake')).changed, 0);
    write('src/billing.ts', billing());
    git('commit', '-q', '-am', 'third');
    const afterCommit = await syncFiles(store, root, root, 'fake');
    assert.deepEqual([afterCommit.full, afterCommit.changed], [false, 1]);
    rmSync(join(root, 'src/auth.ts'));
    const gone = await syncFiles(store, root, root, 'fake');
    assert.equal(gone.removed, 1);
    assert.equal((await search(store, root, 'fake', 'login', 5, { ...stages, vectors: false }, {})).length, 0);
    assert.deepEqual(lookup(store, root, routeOf('login'), 5), []);

    // A file renamed by a commit: its old path leaves the index, its new one comes in.
    git('mv', 'src/billing.ts', 'src/invoices.ts');
    git('commit', '-q', '-m', 'rename');
    const renamed = await syncFiles(store, root, root, 'fake');
    assert.deepEqual([renamed.full, renamed.changed, renamed.removed], [false, 1, 1]);
    assert.deepEqual(lookup(store, root, routeOf('makeInvoice'), 5).map((h) => h.path), ['src/invoices.ts']);
    // A qualified name is not answered by a namesake; an importer is found by the exact name.
    write('src/cart.ts', `import { makeInvoice } from './invoices';\nexport class Cart {\n  refundOrder(): void {\n    makeInvoice(order);\n  }\n}\n`);
    await syncFiles(store, root, root, 'fake');
    assert.deepEqual(store.definitions(root, 'refundOrder').map((d) => d.name).sort(), ['Cart.refundOrder', 'refundOrder']);
    assert.deepEqual(store.definitions(root, 'Cart.refundOrder').map((d) => d.name), ['Cart.refundOrder']);
    assert.deepEqual(store.importers(root, 'makeInvoice'), ['src/cart.ts']);
    assert.deepEqual(store.importers(root, 'makeinvoice'), []);

    // An index that was emptied (a worktree removed, then made again at the same place) is read from the start.
    store.dropTree(root);
    const anew = await syncFiles(store, root, root, 'fake');
    assert.ok(anew.full && anew.files === 2 && anew.chunks > 0);

    // A second checkout of the same code shares the vectors: only what differs is computed.
    assert.equal((await syncFiles(store, `${root}-worktree`, root, 'fake')).missing, store.missing(root, 'fake').length);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('index: one writer at a time across processes, no hole while files are cut again, no wipe under a writer', async () => {
  const { root, git, write } = tempRepo('hub-search-race-');
  const dir = mkdtempSync(join(tmpdir(), 'hub-search-db-'));
  const file = join(dir, 'repo.sqlite');
  // Two connections to one file: what two processes (the app, a bench, the MCP bridge) each open.
  const a = new SearchStore(file);
  const b = new SearchStore(file);
  try {
    for (let i = 0; i < 40; i++) write(`src/m${i}.ts`, `export function handler${i}(order: Order): void {\n${lines(24, (n) => `  step${n}(order, ${i});`)}\n}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'first');

    // Both start at once: one passes over the files, the other waits for it and finds nothing left to do.
    const both = await Promise.all([syncFiles(a, root, root, 'fake'), syncFiles(b, root, root, 'fake')]);
    assert.deepEqual(both.map((s) => s.changed).sort(), [0, 40]);
    await syncVectors(a, root, 'fake', fakeEmbed, { root });
    assert.deepEqual([b.stats(root, 'fake').chunks, b.stats(root, 'fake').vectors], [40, 40]);

    // The way files are cut changed: they are cut again in place. A reader never sees the index emptied, and the
    // vectors of the unchanged texts are still there at the end.
    a.setMeta(`rules:${root}`, 'older');
    let done = false;
    const pass = syncFiles(a, root, root, 'fake').finally(() => (done = true));
    let fewest = 40;
    while (!done) {
      fewest = Math.min(fewest, b.stats(root, 'fake').chunks);
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.deepEqual([(await pass).changed, fewest, b.stats(root, 'fake').vectors], [40, 40, 40]);

    // A claim is held against another owner until it ends; a writer that died frees the index at once.
    const now = Date.now();
    assert.ok(a.claim('first', 1000, now));
    assert.ok(!b.claim('second', 1000, now + 500, () => true));
    assert.ok(b.claim('second', 1000, now + 500, () => false));
    assert.ok(!a.claim('first', 1000, now + 600, () => true));
    assert.ok(a.claim('first', 1000, now + 1600, () => true));
    a.release('first');

    // Another version of the search opens the file while it is written: the index is not wiped under the writer.
    assert.ok(a.claim('writer', 60_000));
    const raw = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(file);
    raw.exec('PRAGMA user_version=1');
    raw.close();
    assert.throws(() => new SearchStore(file), /Another version/);
    assert.equal(b.stats(root, 'fake').chunks, 40);
    a.release('writer');
  } finally {
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('answer: a name from the index alone, a behaviour by the search after the definitions it names', async () => {
  const store = new SearchStore(':memory:');
  try {
    const put = async (path: string, text: string, imports: { source: string; names: string[] }[] = []) => {
      const { chunks, symbols } = await cutFile(path, text);
      store.transaction(() => store.putFile('t', path, { size: text.length, mtime: 1, skipped: '' }, { chunks: chunks.map((c) => ({ ...c, hash: `${path}:${c.start}` })), symbols, imports }));
    };
    await put('src/billing.ts', 'export function makeInvoice(order: Order): Invoice {\n  return build(order);\n}\n');
    await put('src/cart.ts', "import { makeInvoice } from './billing';\nexport function pay(cart: Cart): void {\n  makeInvoice(cart.order);\n}\n", [{ source: './billing', names: ['makeInvoice'] }]);
    const cart = store.chunk(store.byPath('t', 'src/cart.ts', 1)[0])!;
    const within: string[] = [];
    const find = async (under: string) => (within.push(under), [{ ...cart, score: 0.2, by: 'meaning' as const }]);

    const byName = await answer(store, 't', 'makeInvoice', 5, '', find);
    assert.deepEqual([byName.known, byName.hits[0].symbol, byName.hits[0].by, byName.users, within], [true, 'makeInvoice', 'definition', ['src/cart.ts'], []]);
    const byBehaviour = await answer(store, 't', 'where does makeInvoice get called when a cart is paid', 5, '', find, { ...TUNING, pinned: 2 });
    assert.deepEqual([byBehaviour.known, byBehaviour.unsure, byBehaviour.hits.map((h) => h.by)], [false, false, ['definition', 'meaning']]);
    assert.deepEqual((await answer(store, 't', 'where does makeInvoice get called when a cart is paid', 5, '', find, { ...TUNING, pinned: 0 })).hits.map((h) => h.by), ['meaning']);
    // A file the question names is where the search looks; a weak best result is said to be unsure, unless a definition answers.
    await answer(store, 't', 'how does src/cart.ts pay a cart and send the order', 5, '', find);
    assert.equal(within.at(-1), 'src/cart.ts');
    assert.ok((await answer(store, 't', 'how are refunds paid back to the customer', 5, '', find, { ...TUNING, minMeaning: 0.5 })).unsure);
    assert.ok(!(await answer(store, 't', 'where does makeInvoice get called when a cart is paid', 5, '', find, { ...TUNING, pinned: 2, minMeaning: 0.5 })).unsure);
  } finally {
    store.close();
  }
});

test('memory: documents are searched by their words and follow their changes', async () => {
  const store = new SearchStore(':memory:');
  try {
    const docs = [
      { id: 'topic/billing', text: '# billing\nMove invoices to the new provider.\n## Summary\nThe refund flow is done.' },
      { id: 'note/hub-web', text: 'The login page waits for the design.' },
    ];
    const ask = (tree: string, q: string) => store.lexical(tree, ftsQuery(q), 3).map((id) => store.chunk(id)?.path);
    await syncDocs(store, 'memory:master', docs);
    assert.deepEqual(ask('memory:master', 'où en est le refund ?'), ['topic/billing']);
    await syncDocs(store, 'memory:master', [docs[1]]);
    assert.deepEqual(ask('memory:master', 'refund invoices'), []);
    // Another scope never sees these.
    assert.deepEqual(ask('memory:hub-web', 'login'), []);
  } finally {
    store.close();
  }
});

test('answer: locations and scores first, excerpts within the budget, whole pieces on demand', () => {
  const body = (name: string) => `function ${name}() {\n${lines(60, (i) => (i === 40 ? '  sendWebhook(order); // the call' : `  filler${i}();`))}\n}`;
  const hits = ['alpha', 'beta', 'gamma'].map((name, i): Hit => ({ id: i, path: `src/${name}.ts`, start: 10, end: 71, symbol: name, kind: 'function', hash: name, text: body(name), score: 0.9 - i / 10, by: i === 0 ? 'reranker' : 'meaning' }));
  const tokens = (s: string) => Math.ceil(s.length / 3.6);
  const out = formatHits(hits, 'where is sendWebhook called', 400);
  assert.ok(tokens(out) <= 400, String(tokens(out)));
  assert.ok(out.startsWith('src/alpha.ts:10-71 alpha (0.90)\nfunction alpha() {'));
  assert.ok(out.includes('sendWebhook(order)'), 'the excerpt shows the lines that carry the words of the question');
  for (const h of hits) assert.ok(out.includes(`${h.path}:10-71`), 'every result keeps its location');
  const tight = formatHits(hits, 'x', 30);
  assert.deepEqual(tight.split('\n\n'), ['src/alpha.ts:10-71 alpha (0.90)', 'src/beta.ts:10-71 beta (0.80)', 'src/gamma.ts:10-71 gamma (0.70)']);
  const whole = formatHits(hits.slice(0, 1), 'x', 4000, true);
  assert.ok(whole.includes('filler0();') && whole.includes('filler59();'));
  assert.equal(formatHits([], 'x', 100), 'No result.');
  assert.ok(formatHits([{ ...hits[0], by: 'definition' }, { ...hits[1], by: 'words' }], 'x', 30).startsWith('src/alpha.ts:10-71 alpha (definition)\n\nsrc/beta.ts:10-71 beta (words)'));
  // Nothing close enough: said so, with leads and no code to read.
  const unsure = formatUnsure(hits);
  assert.ok(unsure.startsWith('No confident match. Nearest, unverified:\nsrc/alpha.ts:10-71 alpha (0.90)'));
  assert.ok(!unsure.includes('filler') && tokens(unsure) < 80);
});

test('telemetry: a search is judged on what the agent does next, without keeping what was asked', () => {
  const records: SearchRecord[] = [];
  const log = new SearchTelemetry('unused', (r) => records.push(r));
  const answer = 'src/main/sessions.ts:3621-3700 SessionManager.hubTools (0.83)\n  private hubTools() {\n\nsrc/main/mcpHub.ts:21-79 McpHub (0.41)';
  assert.deepEqual(rangesOf(answer), [{ path: 'src/main/sessions.ts', start: 3621, end: 3700 }, { path: 'src/main/mcpHub.ts', start: 21, end: 79 }]);
  assert.deepEqual(rangesOf('edge stripe-webhook — shop supabase/functions/stripe-webhook/index.ts:1-104\nused in:\n  shop src/pay.ts:40-88'), [{ path: 'supabase/functions/stripe-webhook/index.ts', start: 1, end: 104 }, { path: 'src/pay.ts', start: 40, end: 88 }]);
  const outcome = (calls: [string, unknown][], text = answer) => {
    records.length = 0;
    log.searched('w', 'search_code', text);
    calls.forEach(([name, input], i) => log.used('w', `call-${records.length}-${i}-${Math.random()}`, name, input));
    log.settle('w');
    return records.map((r) => r.outcome).join(',');
  };
  assert.equal(outcome([['Read', { file_path: 'C:\\repo\\src\\main\\sessions.ts', offset: 3620, limit: 90 }]]), 'read-range');
  assert.equal(outcome([['Read', { file_path: '/repo/src/main/mcpHub.ts' }]]), 'read-whole');
  assert.equal(outcome([['Read', { file_path: '/repo/src/main/sessions.ts', offset: 10, limit: 50 }]]), 'read-whole');
  assert.equal(outcome([['Grep', { pattern: 'hubTools' }], ['Read', { file_path: '/repo/src/other.ts' }]]), 'grep');
  assert.equal(outcome([['Read', { file_path: '/repo/src/other.ts' }], ['Edit', {}], ['Bash', {}], ['Bash', {}], ['Read', { file_path: '/repo/src/main/mcpHub.ts', offset: 20, limit: 60 }]]), 'unused');
  assert.equal(outcome([]), 'unused');
  // The same call seen twice (a program repeats its events) counts once; a second search closes the first.
  records.length = 0;
  log.searched('w', 'search_code', answer);
  for (let i = 0; i < 6; i++) log.used('w', 'same-id', 'Bash', {});
  log.searched('w', 'where_is', 'Nothing is named x in shop.');
  log.settle('w');
  assert.deepEqual(records.map((r) => [r.tool, r.outcome, r.calls, r.results, r.unsure]), [['search_code', 'searched-again', 1, 2, false], ['where_is', 'unused', 0, 0, true]]);
  assert.deepEqual(Object.keys(records[0]).sort(), ['at', 'calls', 'outcome', 'results', 'tool', 'unsure']);
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
