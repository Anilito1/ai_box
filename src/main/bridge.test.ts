import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { after, before, test } from 'node:test';

const { Bridge } = await import('./bridge');

// A fake OpenAI-compatible server: it records each request and answers as a test tells it to.
type Reply = (body: Record<string, unknown>, req: IncomingMessage) => { status: number; body: string; sse?: boolean };
let reply: Reply = () => ({ status: 500, body: '{}' });
const seen: { body: Record<string, unknown>; auth: string }[] = [];
let upstream: Server;
let base = '';

before(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      seen.push({ body, auth: String(req.headers.authorization ?? '') });
      const r = reply(body, req);
      res.writeHead(r.status, { 'content-type': r.sse ? 'text/event-stream' : 'application/json' });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const address = upstream.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
});
after(() => upstream.close());

const ID = 'a-test0001';
const account = () => ({ baseUrl: base, key: 'sk-test', model: 'gpt-test', smallModel: 'gpt-mini' });

async function withBridge(fn: (b: InstanceType<typeof Bridge>) => Promise<void>) {
  const b = new Bridge((id) => (id === ID ? account() : null));
  await b.start();
  try {
    await fn(b);
  } finally {
    b.stop();
  }
}

const post = (b: InstanceType<typeof Bridge>, body: unknown, token = b.token(), id = ID) =>
  fetch(`${b.url(id)}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token }, body: JSON.stringify(body) });

test('refuses a caller without the bridge token, and an unknown account', async () => {
  await withBridge(async (b) => {
    const r = await post(b, { messages: [] }, 'wrong');
    assert.equal(r.status, 401);
    assert.equal(((await r.json()) as { error: { type: string } }).error.type, 'authentication_error');
    const r2 = await post(b, { messages: [] }, b.token(), 'a-nobody00');
    assert.equal(r2.status, 404);
  });
});

test('a request without stream: translated there and back, with the account key', async () => {
  reply = () => ({
    status: 200,
    body: JSON.stringify({ model: 'gpt-test', choices: [{ finish_reason: 'stop', message: { content: 'Hi!' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
  });
  seen.length = 0;
  await withBridge(async (b) => {
    const r = await post(b, { model: 'claude-haiku-4-5', max_tokens: 50, messages: [{ role: 'user', content: 'Hello' }] });
    assert.equal(r.status, 200);
    const msg = (await r.json()) as Record<string, unknown>;
    assert.deepEqual(msg.content, [{ type: 'text', text: 'Hi!' }]);
    assert.equal(msg.stop_reason, 'end_turn');
    assert.equal(seen[0].auth, 'Bearer sk-test');
    assert.equal(seen[0].body.model, 'gpt-mini', 'a haiku call goes to the small model');
    assert.equal(seen[0].body.max_tokens, 50, 'max_tokens for a server that is not OpenAI’s own');
  });
});

test('a stream: Anthropic events out of OpenAI chunks', async () => {
  const chunks = [
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_path":"a"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
  ];
  reply = () => ({ status: 200, sse: true, body: `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n` });
  seen.length = 0;
  await withBridge(async (b) => {
    const r = await post(b, { model: 'claude-opus-5-5', stream: true, messages: [{ role: 'user', content: 'Read a' }], tools: [{ name: 'Read', input_schema: { type: 'object' } }] });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await r.text();
    const names = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    assert.deepEqual(names, [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    assert.match(text, /"stop_reason":"tool_use"/);
    assert.match(text, /"partial_json":"\{\\"file_path\\":\\"a\\"\}"/);
    assert.equal(seen[0].body.model, 'gpt-test');
    assert.deepEqual(seen[0].body.stream_options, { include_usage: true });
  });
});

test('a parameter the server refuses is left out and the request sent again; the next request knows', async () => {
  reply = (body) =>
    'temperature' in body
      ? { status: 400, body: JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." } }) }
      : { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }) };
  seen.length = 0;
  await withBridge(async (b) => {
    const first = await post(b, { model: 'x', temperature: 0.2, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(first.status, 200);
    assert.equal(seen.length, 2);
    const second = await post(b, { model: 'x', temperature: 0.2, messages: [{ role: 'user', content: 'again' }] });
    assert.equal(second.status, 200);
    assert.equal(seen.length, 3, 'learned: sent once without temperature');
  });
});

test('errors keep their status, an exhausted quota is no rate limit', async () => {
  reply = () => ({ status: 429, body: JSON.stringify({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }) });
  await withBridge(async (b) => {
    const r = await post(b, { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 403);
    const e = ((await r.json()) as { error: { type: string; message: string } }).error;
    assert.equal(e.type, 'permission_error');
    assert.match(e.message, /quota/);
  });
  reply = () => ({ status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key' } }) });
  await withBridge(async (b) => {
    const r = await post(b, { model: 'x', messages: [] });
    assert.equal(r.status, 401);
  });
});

test('count_tokens and models answer without the server', async () => {
  seen.length = 0;
  await withBridge(async (b) => {
    const r = await fetch(`${b.url(ID)}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token()}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(400) }] }),
    });
    const { input_tokens } = (await r.json()) as { input_tokens: number };
    assert.ok(input_tokens > 100 && input_tokens < 200);
    const m = await fetch(`${b.url(ID)}/v1/models`, { headers: { 'x-api-key': b.token() } });
    const list = (await m.json()) as { data: { id: string }[] };
    assert.deepEqual(list.data.map((d) => d.id), ['gpt-test', 'gpt-mini']);
    assert.equal(seen.length, 0);
  });
});
