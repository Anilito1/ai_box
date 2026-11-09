import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { askConsumerKey, ovhPower, ovhSignature, powerOf } from './power';

const p = { kind: 'ovh' as const, endpoint: 'ovh-eu' as const, project: 'abcdef0123456789', instance: '11111111-2222-3333-4444-555555555555', idleHours: 2 };
const keys = { appKey: 'AK0123456789', appSecret: 'AS0123456789abcdef', consumerKey: 'CK0123456789' };

test("OVH's signature: $1$ and the SHA1 of secret, consumer, method, url, body and time", () => {
  const url = 'https://eu.api.ovh.com/1.0/cloud/project/x/instance/y/shelve';
  const want = `$1$${createHash('sha1').update(`AS+CK+POST+${url}++1700000000`).digest('hex')}`;
  assert.equal(ovhSignature('AS', 'CK', 'post', url, '', 1700000000), want);
});

test('an instance is on, off or on its way: shelved and stopped are off', () => {
  assert.equal(powerOf('ACTIVE'), 'on');
  assert.equal(powerOf('SHELVED_OFFLOADED'), 'off');
  assert.equal(powerOf('SHUTOFF'), 'off');
  assert.equal(powerOf('UNSHELVING'), 'starting');
  assert.equal(powerOf('SHELVING'), 'stopping');
  assert.equal(powerOf('ERROR'), 'unknown');
});

/** A fake OVH: answers the time and the instance, records the calls. */
function fakeOvh(status: string) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/auth/time')) return new Response('1700000000');
    calls.push(`${method} ${url.replace('https://eu.api.ovh.com/1.0', '')}`);
    const h = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(h['X-Ovh-Signature'], ovhSignature(keys.appSecret, keys.consumerKey, method, url, '', 1700000000));
    if (method === 'GET') return new Response(JSON.stringify({ status }));
    return new Response('');
  }) as typeof fetch;
  return { f, calls };
}

test('switched on: a shelved instance is unshelved, a running one left alone; switched off: shelved, never just stopped', async () => {
  const base = `/cloud/project/${p.project}/instance/${p.instance}`;
  const shelved = fakeOvh('SHELVED_OFFLOADED');
  await ovhPower(p, keys, shelved.f).start();
  assert.deepEqual(shelved.calls, [`GET ${base}`, `POST ${base}/unshelve`]);
  const active = fakeOvh('ACTIVE');
  await ovhPower(p, keys, active.f).start();
  assert.deepEqual(active.calls, [`GET ${base}`]);
  const on = fakeOvh('ACTIVE');
  await ovhPower(p, keys, on.f).stop();
  assert.deepEqual(on.calls, [`GET ${base}`, `POST ${base}/shelve`]);
  assert.equal(await ovhPower(p, keys, fakeOvh('ACTIVE').f).state(), 'on');
});

test("the hub's OVH access is asked for this one instance, and only OVH's page is opened", async () => {
  let body = '';
  const ok = (async (_u: string | URL | Request, init?: RequestInit) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ validationUrl: 'https://www.ovh.com/auth/sso/api?credentialToken=x', consumerKey: 'CK', state: 'pendingValidation' }));
  }) as typeof fetch;
  const r = await askConsumerKey('AK', p, ok);
  assert.equal(r.consumerKey, 'CK');
  const rules = (JSON.parse(body) as { accessRules: { method: string; path: string }[] }).accessRules;
  assert.ok(rules.every((x) => x.path.startsWith(`/cloud/project/${p.project}/instance/${p.instance}`)));
  assert.ok(!rules.some((x) => x.method === 'DELETE' || x.path.includes('*')));
  const evil = (async () => new Response(JSON.stringify({ validationUrl: 'https://evil.example/', consumerKey: 'CK' }))) as typeof fetch;
  await assert.rejects(askConsumerKey('AK', p, evil));
  assert.throws(() => ovhPower({ ...p, instance: '../x' }, keys));
});
