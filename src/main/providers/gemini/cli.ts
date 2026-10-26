import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { errorCode } from '../../errors';
import { geminiScript, localTool, toolCommand } from '../tools';
import { AcpClient } from './acp';
import type { AgentModel } from '../types';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

const EXE = process.platform === 'win32' ? 'gemini.cmd' : 'gemini';

/**
 * The Gemini CLI: the configured path, else the app's own copy, else the user's install (the PATH, then the usual
 * folders). On Windows npm puts a .cmd wrapper on the PATH, which cannot start without a shell: Node runs its script.
 */
export function geminiExecutable(configured = ''): Promise<string> {
  if (configured && existsSync(configured)) return Promise.resolve(configured);
  const local = localTool('gemini');
  if (local) return Promise.resolve(local);
  const usual = [join(homedir(), '.local', 'bin', EXE), `/opt/homebrew/bin/${EXE}`, `/usr/local/bin/${EXE}`];
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['gemini'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const lines = err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const real = (l: string) => (process.platform === 'win32' ? geminiScript(join(dirname(l), 'node_modules')) : l);
      resolve([...lines, ...usual].map(real).find((p) => p && existsSync(p)) ?? '');
    });
  });
}

export function geminiVersion(executable: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    if (!executable) return resolve('');
    const [file, args] = toolCommand(executable, ['--version']);
    execFile(file, args, { env, timeout: 15_000, windowsHide: true }, (err, stdout) => resolve(err ? '' : (/\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? '')));
  });
}

/** Oldest Gemini CLI whose Agent Client Protocol the hub has been written against. */
export const GEMINI_MIN_VERSION = '0.65.0';

/** Where the CLI keeps what belongs to an account: `<GEMINI_CLI_HOME>/.gemini`. */
export const geminiDir = (home: string) => join(home, '.gemini');

/**
 * Whether the account's folder holds a Google sign-in, and as whom. Only the presence of the CLI's own file is asked,
 * and the email it keeps apart from the tokens: the tokens themselves are never read.
 */
export function googleSignIn(home: string): { signedIn: boolean; email: string } {
  const dir = geminiDir(home);
  if (!existsSync(join(dir, 'oauth_creds.json'))) return { signedIn: false, email: '' };
  try {
    const accounts = obj(JSON.parse(readFileSync(join(dir, 'google_accounts.json'), 'utf8')));
    return { signedIn: true, email: typeof accounts.active === 'string' ? accounts.active : '' };
  } catch {
    return { signedIn: true, email: '' };
  }
}

/** Checks a Gemini API key with the free list of models: null when accepted, else an error code. */
export async function checkGeminiKey(key: string): Promise<string | null> {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return null;
    // Google answers a key it does not know with a 400 ("API key not valid").
    return res.status === 400 || res.status === 401 || res.status === 403 ? 'unauthorized' : res.status === 429 ? 'rate-limited' : `http-${res.status}`;
  } catch (err) {
    return errorCode(err);
  }
}

let catalog: AgentModel[] | null = null;

/**
 * The models the Gemini CLI offers: its own list, which comes with any session and does not depend on the account. A
 * throw-away folder and a placeholder key are enough to ask (nothing is sent to Google).
 */
export async function geminiCatalog(executable: string): Promise<AgentModel[]> {
  if (catalog) return catalog;
  if (!executable) return [];
  const home = mkdtempSync(join(tmpdir(), 'hub-gemini-'));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GEMINI_CLI_HOME: home, GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_API_KEY: 'placeholder-key-never-sent' };
  const client = new AcpClient({ executable, env, version: '0.2' });
  try {
    await Promise.race([
      client.start(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000).unref()),
    ]);
    await client.request('authenticate', { methodId: 'gemini-api-key' });
    const session = obj(await client.request('session/new', { cwd: tmpdir(), mcpServers: [] }));
    catalog = modelsOfSession(session);
    return catalog;
  } catch {
    return [];
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/** The models of a `session/new` answer. */
export function modelsOfSession(session: Json): AgentModel[] {
  const list = Array.isArray(obj(session.models).availableModels) ? (obj(session.models).availableModels as unknown[]) : [];
  return list.map(obj).flatMap((m) =>
    typeof m.modelId === 'string'
      ? [{ value: m.modelId, displayName: typeof m.name === 'string' ? m.name : m.modelId, description: typeof m.description === 'string' ? m.description : '', efforts: [], noEffort: true }]
      : [],
  );
}

/**
 * The Google sign-in of an account, run by the CLI itself: an Agent Client Protocol session asks it to authenticate with
 * "Log in with Google", and the CLI opens the browser and keeps the result in the account's folder. The hub only waits.
 */
export function startGoogleLogin(executable: string, env: Record<string, string>, onEnd: (ok: boolean) => void): () => void {
  const [file, args] = toolCommand(executable, ['--acp']);
  const child = spawn(file, args, { env: { ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let id = 0;
  const send = (method: string, params: Json) => child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`);
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    child.kill();
    onEnd(ok);
  };
  let buffer = '';
  child.stdout?.on('data', (d: Buffer) => {
    buffer += d.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const m = JSON.parse(line) as Json;
        if (m.id === 1) send('authenticate', { methodId: 'oauth-personal' });
        else if (m.id === 2) finish(!m.error);
      } catch {
        // A log line.
      }
    }
  });
  child.once('error', () => finish(false));
  child.once('exit', () => finish(false));
  send('initialize', { protocolVersion: 1, clientCapabilities: {} });
  // Left open, a sign-in nobody completed ends by itself.
  const timer = setTimeout(() => finish(false), 5 * 60_000);
  timer.unref();
  return () => finish(false);
}
