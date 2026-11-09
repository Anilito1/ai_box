// Runs wrangler for the forum Worker only, with its own isolated login (~/.cloudflare-profiles/ai-box). The
// machine-wide login (~/.wrangler) belongs to other projects: it is never read nor written here.
//
//   node scripts/cloudflare.mjs <wrangler args>          e.g. login, whoami
//   node scripts/cloudflare.mjs --guard <wrangler args>  checks the account first, then runs
//   node scripts/cloudflare.mjs --check                  checks the account only
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TOML = join(ROOT, 'wrangler.toml');
export const PROFILE = join(homedir(), '.cloudflare-profiles', 'ai-box');
export const PLACEHOLDER = /^REPLACE_WITH_/;
mkdirSync(PROFILE, { recursive: true });

// Wrangler stores its login in os.homedir()/.wrangler when that folder exists, else in XDG_CONFIG_HOME/.wrangler.
// Pointing all three at the profile isolates it on every OS.
export const env = { ...process.env, USERPROFILE: PROFILE, HOME: PROFILE, XDG_CONFIG_HOME: PROFILE };
for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) delete env[name];

const wranglerBin = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** Runs wrangler without a shell, so arguments stay literal. No prompt (CI), except for the browser login. */
export function wrangler(args, options = {}) {
  return spawnSync(process.execPath, [wranglerBin, ...args], { env: args[0] === 'login' ? env : { ...env, CI: '1' }, cwd: ROOT, ...options });
}

export function fail(message) {
  console.error(`cloudflare: ${message}`);
  process.exit(1);
}

/** A top-level `key = "value"` of wrangler.toml (the first one: the Worker's own, before any section). */
export function tomlValue(key) {
  return new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(readFileSync(TOML, 'utf8'))?.[1] ?? '';
}

export function setTomlValue(key, value) {
  const text = readFileSync(TOML, 'utf8');
  writeFileSync(TOML, text.replace(new RegExp(`^(${key}\\s*=\\s*)"[^"]*"`, 'm'), `$1"${value}"`));
}

export function accountId() {
  const id = tomlValue('account_id');
  if (!id || PLACEHOLDER.test(id)) fail('no Cloudflare account chosen yet: run `npm run cf:setup -- --account <account id>`.');
  return id;
}

/** The profile must be logged in and see the account pinned in wrangler.toml; every command then targets it alone. */
export function checkAccount() {
  const id = accountId();
  const result = wrangler(['whoami', '--json'], { encoding: 'utf8' });
  let who;
  try {
    who = JSON.parse(result.stdout);
  } catch {
    fail('the ai-box profile is not logged in: run `npm run cf:login`.');
  }
  const accounts = (who.accounts ?? []).map((account) => account.id);
  if (!accounts.includes(id)) fail(`the ai-box profile (${who.email}) cannot see account ${id}; it sees [${accounts.join(', ')}].`);
  env.CLOUDFLARE_ACCOUNT_ID = id;
  return { id, email: who.email };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    const { id, email } = checkAccount();
    console.log(`cloudflare: OK, ${email} on account ${id}.`);
  } else {
    if (args[0] === '--guard') {
      args.shift();
      checkAccount();
    }
    process.exit(wrangler(args, { stdio: 'inherit' }).status ?? 1);
  }
}
