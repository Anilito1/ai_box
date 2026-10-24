import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeStatus } from '../shared/types';
import type { HubConfig } from './config';
import { errorCode, httpCode } from './errors';

const require = createRequire(import.meta.url);
const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';
const PROVIDER_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

/** The Claude Code binary npm installed with the Agent SDK (absent from a packaged build, which never ships it). */
function bundledExecutable(): string {
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of process.platform === 'linux' ? [base, `${base}-musl`] : [base]) {
    try {
      const exe = join(dirname(require.resolve(`${pkg}/package.json`)), EXE);
      if (existsSync(exe)) return exe;
    } catch {
      // Not installed for this platform.
    }
  }
  return '';
}

/** Claude Code installed by the user: on the PATH, else in the native installer's folder. */
function installedExecutable(): Promise<string> {
  const fallback = join(homedir(), '.local', 'bin', EXE);
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['claude'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const lines = err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // A .cmd shim (npm install on Windows) cannot be spawned without a shell: run the binary it points to.
      const real = (l: string) =>
        process.platform !== 'win32' || /\.exe$/i.test(l) ? l : join(dirname(l), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      const found = lines.map(real).find((p) => existsSync(p));
      resolve(found ?? (existsSync(fallback) ? fallback : ''));
    });
  });
}

/** Executable the sessions run: the configured one, else the SDK's own binary, else the user's install. */
export async function claudeExecutable(cfg: HubConfig, installed?: string): Promise<string> {
  if (cfg.claudePath && existsSync(cfg.claudePath)) return cfg.claudePath;
  return bundledExecutable() || (installed ?? (await installedExecutable()));
}

/**
 * Environment that selects the Claude access chosen in the settings. `claude-code` adds nothing: Claude Code uses its
 * own configuration and sign-in, which the hub never reads.
 */
export function claudeEnv(cfg: HubConfig, apiKey: string): { set: Record<string, string>; unset: string[] } {
  const others = (keep: string) => PROVIDER_FLAGS.filter((f) => f !== keep);
  switch (cfg.provider) {
    case 'api-key':
      return { set: apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}, unset: [...PROVIDER_FLAGS, 'ANTHROPIC_AUTH_TOKEN'] };
    case 'bedrock':
      return {
        set: {
          CLAUDE_CODE_USE_BEDROCK: '1',
          ...(cfg.bedrock.region ? { AWS_REGION: cfg.bedrock.region } : {}),
          ...(cfg.bedrock.profile ? { AWS_PROFILE: cfg.bedrock.profile } : {}),
        },
        unset: others('CLAUDE_CODE_USE_BEDROCK'),
      };
    case 'vertex':
      return {
        set: {
          CLAUDE_CODE_USE_VERTEX: '1',
          ...(cfg.vertex.region ? { CLOUD_ML_REGION: cfg.vertex.region } : {}),
          ...(cfg.vertex.projectId ? { ANTHROPIC_VERTEX_PROJECT_ID: cfg.vertex.projectId } : {}),
        },
        unset: others('CLAUDE_CODE_USE_VERTEX'),
      };
    default:
      return { set: {}, unset: [] };
  }
}

/** Checks an Anthropic API key with a free call (the model list): null when accepted, else an error code. */
export async function checkApiKey(key: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? null : httpCode(res.status);
  } catch (err) {
    return errorCode(err);
  }
}

/**
 * Starts Claude Code once, with no prompt (nothing is sent to the API) and nothing saved, and asks it which
 * credentials it would use. The hub only reads this summary: the sign-in itself stays inside Claude Code.
 */
export async function claudeStatus(cfg: HubConfig, env: Record<string, string>): Promise<ClaudeStatus> {
  const installed = await installedExecutable();
  const executable = await claudeExecutable(cfg, installed);
  const status: ClaudeStatus = { executable, installed, account: null, error: '' };
  if (!executable) return status;
  // A cloud provider authenticates with its own credentials, which Claude Code only tries on the first request (and
  // its start can take a minute while it looks for them): nothing useful to read here.
  if (cfg.provider === 'bedrock' || cfg.provider === 'vertex') {
    status.account = { ready: true, provider: cfg.provider, email: '', plan: '', source: '' };
    return status;
  }
  let close = () => undefined as void;
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => (close = () => resolve({ value: undefined, done: true }))) }),
  };
  const q = query({
    prompt,
    options: { cwd: homedir(), pathToClaudeCodeExecutable: executable, env, persistSession: false, strictMcpConfig: true, mcpServers: {} },
  });
  try {
    const info = await Promise.race([
      q.accountInfo(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
    ]);
    const provider = info.apiProvider ?? 'firstParty';
    // An API key names its source; a Claude account sign-in shows as the account's email and plan.
    const source = info.apiKeySource && info.apiKeySource !== 'none' ? info.apiKeySource : '';
    status.account = {
      ready: provider !== 'firstParty' || source !== '' || !!info.subscriptionType || !!info.email,
      provider,
      email: info.email ?? '',
      plan: info.subscriptionType ?? '',
      source,
    };
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
  } finally {
    close();
    q.close();
  }
  return status;
}
