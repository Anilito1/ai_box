import { createSign } from 'node:crypto';

// An organisation's repos on the remote server: a GitHub App installed on the organisation gives a token valid one
// hour, made by the hub at each launch of a worker of that organisation and given to that worker only. Nothing of it
// stays on the server. The App's private key lives in this PC's keychain (secrets.ts).

const API = 'https://api.github.com';
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** The App's own token (RS256, ten minutes, backdated a minute for clock drift), as GitHub asks for it. */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

type Fetch = typeof fetch;

/** A one-hour token of the App's installation on `org`, limited to contents, pull requests, workflows and metadata. */
export async function installationToken(appId: string, privateKey: string, org: string, f: Fetch = fetch): Promise<{ token: string; expiresAt: number }> {
  if (!/^\d{1,12}$/.test(appId) || !/^[\w.-]{1,39}$/.test(org)) throw new Error('github app: bad id or organisation');
  const headers = { Authorization: `Bearer ${appJwt(appId, privateKey)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const inst = await f(`${API}/orgs/${org}/installation`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!inst.ok) throw new Error(`github app: not installed on the organisation (HTTP ${inst.status})`);
  const { id } = (await inst.json()) as { id?: unknown };
  if (typeof id !== 'number') throw new Error('github app: unexpected answer');
  const res = await f(`${API}/app/installations/${id}/access_tokens`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ permissions: { contents: 'write', pull_requests: 'write', workflows: 'write', metadata: 'read' } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`github app: token refused (HTTP ${res.status})`);
  const o = (await res.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof o.token !== 'string' || typeof o.expires_at !== 'string') throw new Error('github app: unexpected answer');
  return { token: o.token, expiresAt: Date.parse(o.expires_at) };
}
