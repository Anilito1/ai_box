import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { googleAccess, googleAccountStatus, googleRefusal, noteGoogleRefusal } from './cli';

const INELIGIBLE =
  'This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google';

test('what Google answers a sign-in: refused, signed out, or nothing about the account', () => {
  assert.equal(googleRefusal(INELIGIBLE), 'google-refused');
  assert.equal(googleRefusal('IneligibleTierError: not eligible'), 'google-refused');
  assert.equal(googleRefusal('User location is not supported for the API use. (UNSUPPORTED_LOCATION)'), 'google-refused');
  assert.equal(googleRefusal('invalid_grant: Token has been expired or revoked.'), 'google-signed-out');
  assert.equal(googleRefusal('Internal error: Please re-authenticate'), 'google-signed-out');
  // A project to set up or a server error is no sign-in to redo.
  assert.equal(googleRefusal('403 PERMISSION_DENIED: set GOOGLE_CLOUD_PROJECT'), null);
  assert.equal(googleRefusal('fetch failed'), null);
  assert.equal(googleRefusal('Request failed with status code 503'), null);
  assert.equal(googleRefusal('quota 4013 exceeded'), null);
});

test('a refused account is not connected, and says why', () => {
  const who = { signedIn: true, email: 'a@b.c' };
  assert.deepEqual(googleAccountStatus(who, null), { ready: true, detail: 'a@b.c', error: '', models: [] });
  assert.deepEqual(googleAccountStatus(who, 'google-refused'), { ready: false, detail: 'a@b.c', error: 'google-refused', models: [] });
  assert.deepEqual(googleAccountStatus({ signedIn: false, email: '' }, null), { ready: false, detail: '', error: '', models: [] });
});

/** A stand-in for `gemini --acp`: answers initialize, then authenticate with ANSWER (an error message, "data:" one wrapped, or "ok"). */
const AGENT = `
const fs = require('fs');
fs.appendFileSync(process.env.CALLS, 'x');
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o }) + '\\n');
  if (m.method === 'initialize') out({ result: { protocolVersion: 1 } });
  else if (process.env.ANSWER === 'ok') out({ result: {} });
  else if (process.env.ANSWER.startsWith('data:')) out({ error: { code: -32603, message: 'Internal error', data: { details: process.env.ANSWER.slice(5) } } });
  else out({ error: { code: -32000, message: process.env.ANSWER } });
});
`;

test('Google is asked once per sign-in and for a while; an answer that says nothing is asked again soon', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-gemini-test-'));
  try {
    const agent = join(dir, 'agent.js');
    writeFileSync(agent, AGENT);
    const home = join(dir, 'home');
    mkdirSync(join(home, '.gemini'), { recursive: true });
    const signIn = (token: string) => writeFileSync(join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: token, access_token: String(Math.random()) }));
    signIn('r1');
    const calls = join(dir, 'calls');
    writeFileSync(calls, '');
    const env = (answer: string) => ({ ...(process.env as Record<string, string>), CALLS: calls, ANSWER: answer });
    const count = () => readFileSync(calls, 'utf8').length;
    const min = 60_000;
    let now = 1_000_000_000;

    // No network: counted as accepted, asked again after 10 minutes.
    assert.equal(await googleAccess(agent, home, env('fetch failed'), now), null);
    assert.equal(await googleAccess(agent, home, env(INELIGIBLE), now + 5 * min), null);
    assert.equal(count(), 1);
    now += 11 * min;
    assert.equal(await googleAccess(agent, home, env(INELIGIBLE), now), 'google-refused');
    assert.equal(count(), 2);

    // Kept for this sign-in, even when a session refreshes its token (the file changes, not the sign-in).
    signIn('r1');
    assert.equal(await googleAccess(agent, home, env('ok'), now + 60 * min), 'google-refused');
    assert.equal(count(), 2);
    // Asked again after 6 hours, or at once for a new sign-in.
    assert.equal(await googleAccess(agent, home, env('ok'), now + 7 * 60 * min), null);
    assert.equal(count(), 3);
    signIn('r2');
    assert.equal(await googleAccess(agent, home, env('data:invalid_grant'), now + 7 * 60 * min), 'google-signed-out');
    assert.equal(count(), 4);

    // Checks at the same time share one question.
    signIn('r3');
    const both = await Promise.all([googleAccess(agent, home, env('ok'), now), googleAccess(agent, home, env('ok'), now)]);
    assert.deepEqual(both, [null, null]);
    assert.equal(count(), 5);

    // A session that met the refusal first.
    noteGoogleRefusal(home, 'google-refused', now);
    assert.equal(await googleAccess(agent, home, env('ok'), now), 'google-refused');
    assert.equal(count(), 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
