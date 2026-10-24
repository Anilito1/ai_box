import { execFile } from 'node:child_process';
import type { GithubDevice, GithubRepo } from '../shared/types';
import type { HubConfig } from './config';
import { CodedError, httpCode } from './errors';
import { git, GitError } from './git';

/**
 * Client ID of the GitHub OAuth App this build signs in with (device flow: a public client, no secret involved).
 * Empty until the publisher registers one; the settings can set another.
 */
export const DEFAULT_CLIENT_ID = '';
const SCOPES = 'repo read:org workflow';
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const HEADERS = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'claude-hub' };
const API_HEADERS = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'claude-hub' });
/** Answers of the device flow that mean the Client ID itself is wrong. */
const BAD_CLIENT = new Set(['unauthorized_client', 'incorrect_client_credentials', 'Not Found']);

export const clientIdOf = (cfg: HubConfig) => cfg.github.clientId || DEFAULT_CLIENT_ID;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const post = async (url: string, form: Record<string, string>, signal?: AbortSignal) => {
  const res = await fetch(url, { method: 'POST', headers: HEADERS, body: new URLSearchParams(form), signal: signal ?? AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const error = str(body.error);
  if (res.status === 404 || BAD_CLIENT.has(error)) throw new CodedError('client_id');
  if (!res.ok && !error) throw new CodedError(httpCode(res.status));
  return body;
};

/** One device-flow sign-in at a time: the code to show, then a poll until the user approves it on github.com. */
export class DeviceFlow {
  private abort: AbortController | null = null;
  private pending: { clientId: string; deviceCode: string; interval: number; expiresAt: number } | null = null;

  async start(clientId: string): Promise<GithubDevice> {
    this.cancel();
    const r = await post('https://github.com/login/device/code', { client_id: clientId, scope: SCOPES });
    const uri = str(r.verification_uri);
    if (r.error) throw new CodedError(str(r.error));
    if (!r.device_code || !uri.startsWith('https://github.com/')) throw new CodedError('http-200');
    const expiresIn = Number(r.expires_in) || 900;
    this.pending = { clientId, deviceCode: str(r.device_code), interval: Number(r.interval) || 5, expiresAt: Date.now() + expiresIn * 1000 };
    return { userCode: str(r.user_code), verificationUri: uri, expiresIn };
  }

  /** The access token once approved; throws a coded error on denial (access_denied), expiry (expired) or cancel. */
  async wait(): Promise<string> {
    const p = this.pending;
    if (!p) throw new CodedError('cancelled');
    const abort = (this.abort = new AbortController());
    try {
      while (Date.now() < p.expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, p.interval * 1000));
        if (abort.signal.aborted) throw new CodedError('cancelled');
        const r = await post(
          'https://github.com/login/oauth/access_token',
          { client_id: p.clientId, device_code: p.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
          AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
        );
        if (typeof r.access_token === 'string' && r.access_token) return r.access_token;
        if (r.error === 'authorization_pending') continue;
        if (r.error === 'slow_down') {
          p.interval = Number(r.interval) || p.interval + 5;
          continue;
        }
        throw new CodedError(r.error === 'expired_token' ? 'expired' : str(r.error) || 'http-200');
      }
      throw new CodedError('expired');
    } catch (err) {
      // Cancelling aborts the request in flight too: that is a cancel, not a network failure.
      throw abort.signal.aborted ? new CodedError('cancelled') : err;
    } finally {
      if (this.pending === p) this.pending = null;
      if (this.abort === abort) this.abort = null;
    }
  }

  cancel(): void {
    this.abort?.abort();
    this.abort = null;
    this.pending = null;
  }
}

/** Login of the account a token belongs to; a refused (expired, revoked) token throws `unauthorized`. */
export async function githubLogin(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', { headers: API_HEADERS(token), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new CodedError(httpCode(res.status));
  const login = str(((await res.json()) as Record<string, unknown>).login);
  if (!LOGIN.test(login)) throw new CodedError('http-200');
  return login;
}
const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });

/** The GitHub CLI's absolute path, or empty when it is not installed. */
export async function ghPath(): Promise<string> {
  const out = await run(process.platform === 'win32' ? 'where' : 'which', ['gh']);
  return out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && (process.platform !== 'win32' || /\.exe$/i.test(l))) ?? '';
}

/** Login of the account the GitHub CLI is signed in with, or empty. */
export async function ghLogin(): Promise<string> {
  const gh = await ghPath();
  if (!gh) return '';
  const saved = await run(gh, ['config', 'get', 'user', '-h', 'github.com']);
  const login = LOGIN.test(saved) ? saved : await run(gh, ['api', 'user', '--jq', '.login']);
  return LOGIN.test(login) ? login : '';
}

/** owner/name as GitHub allows them; never "." or "..", which would leave the folder a clone goes into. */
export const SLUG = /^[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const REPO_PAGES = 3;
const AFFILIATION = 'owner,collaborator,organization_member';

const toRepo = (r: Record<string, unknown>): GithubRepo | null => {
  const slug = str(r.full_name);
  if (!SLUG.test(slug)) return null;
  return { slug, private: r.private === true, description: str(r.description).slice(0, 200), pushedAt: Date.parse(str(r.pushed_at)) || 0 };
};

/** The account's repositories, most recently pushed first (300 at most), through the token or the GitHub CLI. */
export async function githubRepos(source: HubConfig['github']['source'], token: string, gh: string): Promise<GithubRepo[]> {
  const raw: Record<string, unknown>[] = [];
  if (source === 'gh') {
    if (!gh) throw new CodedError('gh-signed-out');
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        gh,
        ['api', '--paginate', `user/repos?per_page=100&sort=pushed&affiliation=${AFFILIATION}`, '--jq', '.[] | {full_name, private, description, pushed_at}'],
        { timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
        (err, stdout) => (err ? reject(new CodedError('gh-signed-out')) : resolve(stdout)),
      );
    });
    for (const line of out.split('\n').slice(0, REPO_PAGES * 100)) if (line.trim()) raw.push(JSON.parse(line) as Record<string, unknown>);
  } else if (token) {
    for (let page = 1; page <= REPO_PAGES; page++) {
      const res = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=${AFFILIATION}`, {
        headers: API_HEADERS(token),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new CodedError(httpCode(res.status));
      const batch = (await res.json()) as Record<string, unknown>[];
      raw.push(...batch);
      if (batch.length < 100) break;
    }
  } else {
    throw new CodedError('not-connected');
  }
  return raw.map(toRepo).filter((r): r is GithubRepo => r !== null);
}

/** `git clone` of github.com/owner/name into `root`/name, with the hub's sign-in and never a prompt. */
export async function cloneRepo(slug: string, root: string, dest: string): Promise<void> {
  try {
    await git(root, ['clone', '--quiet', '--', `https://github.com/${slug}.git`, dest], { timeout: 10 * 60_000 });
  } catch (err) {
    const output = err instanceof GitError ? err.stderr : '';
    if (/could not resolve host|failed to connect|timed out|connection (?:refused|reset)/i.test(output)) throw new CodedError('network');
    if (/authentication failed|could not read username|repository not found|returned error: 40[134]/i.test(output)) throw new CodedError('clone-denied');
    throw err;
  }
}

/**
 * Environment that makes git use the hub's GitHub sign-in for https://github.com, without touching any git config
 * file: git reads `GIT_CONFIG_KEY_n`/`VALUE_n` as command-line config. The empty helper first drops the helpers
 * configured elsewhere for github.com, so git never falls back to an interactive prompt. A token source passes the
 * token as GH_TOKEN, which the GitHub CLI reads too; the `gh` source lets the CLI answer and exposes no token.
 */
export function githubGitEnv(cfg: HubConfig, token: string, gh: string): Record<string, string> {
  const { source } = cfg.github;
  let helper = '';
  if (source === 'gh' && gh && !gh.includes("'")) helper = `!'${gh}' auth git-credential`;
  else if ((source === 'oauth' || source === 'token') && token) {
    helper = '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
  }
  if (!helper) return {};
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  return {
    ...(source === 'gh' ? {} : { GH_TOKEN: token }),
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${n + 1}`]: helper,
  };
}
