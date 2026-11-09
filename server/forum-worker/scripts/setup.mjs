// Sets up and deploys the forum Worker, start to end; safe to run again (it only does what is missing).
//
//   npm run cf:setup -- --account <id> [--subdomain <name>]   first time: pins the account in wrangler.toml
//   npm run deploy                                              later: migrations, deploy, check
//   npm run cf:setup -- --rotate-admin-key                      a new moderators' key (the old one stops working)
//
// Steps: account check (--guard), workers.dev subdomain, D1 database, migrations, deploy, secrets (IP_SALT and
// ADMIN_TOKEN_HASH, generated), HTTP check, then the address written into the app (src/shared/forumEndpoint.ts).
// The moderators' key is shown once at the end and written nowhere.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkAccount, fail, PLACEHOLDER, PROFILE, ROOT, setTomlValue, tomlValue, wrangler } from './cloudflare.mjs';

const ENDPOINT_FILE = join(ROOT, '..', '..', 'src', 'shared', 'forumEndpoint.ts');
const API = 'https://api.cloudflare.com/client/v4';

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? '') : '';
};

const step = (text) => console.log(`\n» ${text}`);

/** wrangler, output captured; stops the setup when it fails. */
function run(args, input) {
  const r = wrangler(args, { encoding: 'utf8', input });
  if (r.status !== 0) fail(`wrangler ${args.join(' ')} failed:\n${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout;
}

function pinAccount() {
  const wanted = option('--account');
  const pinned = tomlValue('account_id');
  if (wanted && !/^[0-9a-f]{32}$/.test(wanted)) fail('--account expects the 32-character account id.');
  if (PLACEHOLDER.test(pinned)) {
    if (!wanted) fail('no account pinned yet: run `npm run cf:setup -- --account <account id>`.');
    setTomlValue('account_id', wanted);
    console.log(`account ${wanted} pinned in wrangler.toml`);
  } else if (wanted && wanted !== pinned) fail(`wrangler.toml is pinned to ${pinned}, not ${wanted}: change it by hand if that is intended.`);
}

/** The OAuth token of the profile's login (refreshed by the `whoami` of the check), for the one call wrangler lacks. */
function oauthToken() {
  for (const file of [join(PROFILE, '.wrangler', 'config', 'default.toml'), join(PROFILE, 'xdg.config', '.wrangler', 'config', 'default.toml')]) {
    if (!existsSync(file)) continue;
    const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(readFileSync(file, 'utf8'))?.[1];
    if (token) return token;
  }
  return fail('no OAuth login found in the ai-box profile: run `npm run cf:login`.');
}

async function cf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${oauthToken()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function subdomain(account) {
  const current = await cf('GET', `/accounts/${account}/workers/subdomain`);
  if (current.status === 200 && current.data.result?.subdomain) return current.data.result.subdomain;
  const name = option('--subdomain') || `aibox-${randomBytes(3).toString('hex')}`;
  const created = await cf('PUT', `/accounts/${account}/workers/subdomain`, { subdomain: name });
  if (created.status !== 200) fail(`could not create the workers.dev subdomain "${name}": ${JSON.stringify(created.data.errors ?? created.data)}`);
  console.log(`workers.dev subdomain created: ${name}`);
  return name;
}

function database(name) {
  const find = () => JSON.parse(run(['d1', 'list', '--json'])).find((d) => d.name === name);
  let db = find();
  if (!db) {
    run(['d1', 'create', name]);
    db = find();
    if (!db) fail(`database ${name} was created but is not listed yet: run the setup again.`);
    console.log(`D1 database created: ${name}`);
  }
  if (tomlValue('database_id') !== db.uuid) setTomlValue('database_id', db.uuid);
  return db.uuid;
}

/** IP_SALT once for all; the moderators' key when there is none yet, or when asked. Returns the key to show. */
function secrets(worker) {
  const names = new Set(JSON.parse(run(['secret', 'list', '--name', worker, '--format', 'json'])).map((s) => s.name));
  if (!names.has('IP_SALT')) {
    run(['secret', 'put', 'IP_SALT', '--name', worker], randomBytes(32).toString('base64url'));
    console.log('IP_SALT set');
  }
  if (names.has('ADMIN_TOKEN_HASH') && !argv.includes('--rotate-admin-key')) return '';
  const key = randomBytes(32).toString('base64url');
  run(['secret', 'put', 'ADMIN_TOKEN_HASH', '--name', worker], createHash('sha256').update(key).digest('hex'));
  console.log('ADMIN_TOKEN_HASH set');
  return key;
}

async function check(url) {
  // A new workers.dev address can take a minute or two to answer.
  for (let i = 0; i < 30; i++) {
    try {
      const health = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(10_000) });
      if (health.ok && (await health.json()).ok === true) {
        const list = await fetch(`${url}/v1/posts`, { signal: AbortSignal.timeout(10_000) });
        const body = await list.json();
        if (list.ok && Array.isArray(body.listing?.posts)) return body.listing.posts.length;
        fail(`${url}/v1/posts answered ${list.status}: ${JSON.stringify(body)}`);
      }
    } catch {
      // Not reachable yet.
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return fail(`${url} did not answer within 2.5 minutes: run \`npm run deploy\` again in a moment.`);
}

function writeEndpoint(url) {
  const text = readFileSync(ENDPOINT_FILE, 'utf8');
  const next = text.replace(/export const FORUM_URL = '[^']*';/, `export const FORUM_URL = '${url}';`);
  if (next === text) return false;
  writeFileSync(ENDPOINT_FILE, next);
  return true;
}

pinAccount();
step('Account');
const { id: account, email } = checkAccount();
console.log(`${email} on account ${account}`);
const worker = tomlValue('name');
const dbName = tomlValue('database_name');
step('workers.dev subdomain');
const sub = await subdomain(account);
step(`D1 database ${dbName}`);
console.log(`id ${database(dbName)}`);
step('Migrations');
console.log(run(['d1', 'migrations', 'apply', dbName, '--remote']).trim().split('\n').slice(-3).join('\n'));
step(`Deploy ${worker}`);
run(['deploy']);
step('Secrets');
const adminKey = secrets(worker);
const url = `https://${worker}.${sub}.workers.dev`;
step(`Check ${url}`);
console.log(`health OK, ${await check(url)} message(s) in the forum`);
if (writeEndpoint(url)) console.log(`\nThe app now points at ${url} (src/shared/forumEndpoint.ts): commit it with wrangler.toml.`);
if (adminKey) {
  console.log('\nModerators\' key: paste it in the AI Box, Settings › About › Ideas forum. Shown this once, stored nowhere:');
  console.log(`\n    ${adminKey}\n`);
}
console.log('Done.');
