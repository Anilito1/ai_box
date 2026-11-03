import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  assert.equal(googleRefusal('Request failed with status code 401'), 'google-signed-out');
  assert.equal(googleRefusal('PERMISSION_DENIED'), 'google-signed-out');
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

/** A stand-in for `gemini --acp`: answers initialize, then authenticate with ANSWER (an error message, or "ok"). */
const AGENT = `
const fs = require('fs');
fs.appendFileSync(process.env.CALLS, 'x');
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o }) + '\\n');
  if (m.method === 'initialize') out({ result: { protocolVersion: 1 } });
  else if (process.env.ANSWER === 'ok') out({ result: {} });
  else out({ error: { code: -32000, message: process.env.ANSWER } });
});
`;

test('Google is asked once per sign-in; an answer that says nothing about the account is asked again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-gemini-test-'));
  try {
    const agent = join(dir, 'agent.js');
    writeFileSync(agent, AGENT);
    const home = join(dir, 'home');
    mkdirSync(join(home, '.gemini'), { recursive: true });
    const creds = join(home, '.gemini', 'oauth_creds.json');
    writeFileSync(creds, '{}');
    const calls = join(dir, 'calls');
    writeFileSync(calls, '');
    const env = (answer: string) => ({ ...(process.env as Record<string, string>), CALLS: calls, ANSWER: answer });
    const count = () => readFileSync(calls, 'utf8').length;

    assert.equal(await googleAccess(agent, home, env('fetch failed')), null);
    assert.equal(await googleAccess(agent, home, env(INELIGIBLE)), 'google-refused');
    assert.equal(count(), 2, 'not kept: the network said nothing about the account');
    assert.equal(await googleAccess(agent, home, env('ok')), 'google-refused', 'kept for this sign-in');
    assert.equal(count(), 2);

    // Signed in again: asked afresh.
    utimesSync(creds, new Date(), new Date(Date.now() + 5000));
    assert.equal(await googleAccess(agent, home, env('ok')), null);
    assert.equal(count(), 3);
    assert.equal(await googleAccess(agent, home, env(INELIGIBLE)), null);
    assert.equal(count(), 3);

    // A session that saw the refusal first.
    noteGoogleRefusal(home, 'google-refused');
    assert.equal(await googleAccess(agent, home, env('ok')), 'google-refused');
    assert.equal(count(), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
