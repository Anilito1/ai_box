import { extname } from 'node:path';
import { git } from '../git';

/** A file past this size is generated or data, not code someone searches. */
export const MAX_FILE_BYTES = 400_000;

const SKIP_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|\.next|\.nuxt|\.turbo|\.cache|\.aibox|\.venv|venv|__pycache__)\//;
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock|composer\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|packages\.lock\.json)$/;
/** Files whose name says they hold secrets: never read, whatever is inside. */
const SECRET_NAMES = /(^|\/)(\.env(\..*)?|.*\.env|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.jks|.*\.keystore|credentials[^/]*|secrets?\.(json|ya?ml|toml|txt)|id_(rsa|dsa|ecdsa|ed25519)[^/]*|\.npmrc|\.netrc|\.dev\.vars|.*service[-_]?account[^/]*\.json)$/i;
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.cs', '.sql', '.md', '.mdx', '.json', '.jsonc', '.yml', '.yaml', '.toml',
  '.html', '.css', '.scss', '.vue', '.svelte', '.go', '.rs', '.java', '.rb', '.php', '.sh', '.ps1', '.swift', '.kt', '.c', '.h', '.cpp', '.hpp', '.liquid', '.txt',
]);

export const REDACTED = '[secret]';

/**
 * Keys recognised by their shape, wherever they stand: a private key block, an API key (OpenAI and Anthropic `sk-`,
 * Stripe `sk_live_`/`rk_live_`/`whsec_`, Supabase `sbp_`, GitHub, Slack, AWS, Google, Shopify `shpat_`…, Mailchimp
 * `…-us12`, Groq, xAI) or a JWT (`eyJ…` in three parts).
 */
const KEY_SHAPES = new RegExp(
  [
    '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)',
    '\\bsk-[A-Za-z0-9_-]{20,}',
    '\\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}',
    '\\bwhsec_[A-Za-z0-9]{24,}',
    '\\bsbp_[A-Za-z0-9]{20,}',
    '\\bsb_secret_[A-Za-z0-9_-]{20,}',
    '\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
    '\\bgh[pousr]_[A-Za-z0-9]{30,}',
    '\\bgithub_pat_[A-Za-z0-9_]{30,}',
    '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
    '\\bAKIA[0-9A-Z]{16}\\b',
    '\\bAIza[0-9A-Za-z_-]{35}\\b',
    '\\bshp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}\\b',
    '\\b[0-9a-f]{32}-us\\d{1,2}\\b',
    '\\bgsk_[A-Za-z0-9]{30,}',
    '\\bxai-[A-Za-z0-9]{30,}',
  ].join('|'),
  'g',
);

/**
 * A literal given to something whose name says it is a secret (`apiKey = "…"`, `"service_role": "…"`, `PASSWORD=…`):
 * the name and the quotes stay, the value goes. A key with no known shape (Ringover's, a home-made token) is caught
 * here. Groups: what precedes the value, its quote and the quoted value, or the bare value.
 */
const NAMED_VALUE = /((?:secret|token(?!s|i[sz])|passw(?:or)?d|api[_-]?key|service[_-]?role)[A-Za-z0-9_.-]*["'`]?\s*(?:=>|[:=])\s*)(?:(["'`])((?:(?!\2)[^\\\n]|\\.){4,400})\2|([A-Za-z0-9_\-/+=]{16,})(?![\w(.[]))/gi;

/**
 * The text without its secrets, and how many were taken out. Applied before anything is cut or given to a model,
 * so an index never becomes a second copy of a key, and again on every answer. The code around stays searchable:
 * a service worker that carries its project's public key is still the first file someone looks for.
 */
export function redact(text: string): { text: string; count: number } {
  let count = 0;
  const shapes = text.replace(KEY_SHAPES, () => (count++, REDACTED));
  const clean = shapes.replace(NAMED_VALUE, (all: string, before: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
    if (quoted !== undefined) {
      // A sentence (three words or more) is a label or a message about the secret, not the secret.
      if (quoted === REDACTED || quoted.trim().split(/\s+/).length >= 3) return all;
      count++;
      return `${before}${quote}${REDACTED}${quote}`;
    }
    // Without quotes, only what looks like a key: letters and digits together, not a name of the code.
    if (!bare || !/\d/.test(bare) || !/[A-Za-z]/.test(bare)) return all;
    count++;
    return `${before}${REDACTED}`;
  });
  return { text: clean, count };
}

/** Why a path is not indexed, or '' when it is. Paths use forward slashes, relative to the repo. */
export function skipReason(path: string, size = 0): '' | 'dir' | 'lock' | 'secret-name' | 'type' | 'size' | 'minified' {
  if (SKIP_DIRS.test(path)) return 'dir';
  if (LOCKFILES.test(path)) return 'lock';
  if (SECRET_NAMES.test(path)) return 'secret-name';
  if (/\.min\.(js|css)$|\.(map|snap)$|\.d\.ts$/.test(path)) return 'minified';
  if (!TEXT_EXT.has(extname(path).toLowerCase())) return 'type';
  if (size > MAX_FILE_BYTES) return 'size';
  return '';
}

/** Text a person wrote: no NUL byte, no line long enough to be a bundle or a data dump. */
export function looksWritten(text: string): boolean {
  if (text.includes('\u0000')) return false;
  let start = 0;
  let lines = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      if (i - start > 2000) return false;
      start = i + 1;
      lines++;
    }
  }
  return text.length / lines < 300;
}

/** What git tracks plus what is new and not ignored: `.gitignore` is git's to read, not ours. */
export async function listFiles(repo: string): Promise<string[]> {
  const out = await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeout: 60_000 });
  return [...new Set(out.split('\u0000').filter(Boolean))];
}
