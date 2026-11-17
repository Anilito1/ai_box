import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Inbox, type InboxEntry } from './inbox';

test('delivery journal retains sent messages until receipt and matches repeated inputs in FIFO order', async () => {
  const entries: InboxEntry<string>[] = [];
  const persisted: string[] = [];
  const inbox = new Inbox(entries, () => persisted.push(JSON.stringify(entries)));
  inbox.push('same', 'first'); inbox.push('same', 'second');
  const consumer = inbox[Symbol.asyncIterator]();
  assert.equal((await consumer.next()).value, 'same');
  assert.equal((await consumer.next()).value, 'same');
  assert.deepEqual(entries.map(e => e.state), ['sent', 'sent']);
  assert.equal(inbox.pending, 2);
  assert.ok(inbox.acknowledge(value => value === 'same'));
  assert.deepEqual(entries.map(e => e.state), ['acknowledged', 'sent']);
  assert.ok(inbox.acknowledge('second'));
  assert.equal(inbox.pending, 0);
  assert.equal(JSON.parse(persisted.at(-1)!).length, 2);
});

test('closing a stream preserves queued input and recovery never resends an ambiguous input', async () => {
  const inbox = new Inbox<string>();
  inbox.push('possibly received', 'first'); inbox.push('never sent', 'second');
  const consumer = inbox[Symbol.asyncIterator]();
  await consumer.next(); inbox.close();
  assert.equal((await consumer.next()).done, true);
  const recovered = new Inbox(Inbox.recover(JSON.parse(JSON.stringify(inbox.entries)) as InboxEntry<string>[]));
  assert.deepEqual(recovered.entries.map(e => e.state), ['unknown', 'queued']);
  assert.equal((await recovered[Symbol.asyncIterator]().next()).value, 'never sent');
  assert.equal(recovered.pending, 1, 'an unknown input waits on no process');
  assert.throws(() => inbox.push('too late'), /closed/);
});

test('inputs the provider coalesced into one echo are all received', async () => {
  const inbox = new Inbox<string>();
  inbox.push('stale', 'old'); inbox.push('[Worker A] report', 'a'); inbox.push('[Worker B] report', 'b'); inbox.push('later', 'c');
  const consumer = inbox[Symbol.asyncIterator]();
  for (let i = 0; i < 4; i++) await consumer.next();
  // Claude Code takes the prompts that waited during a turn together and echoes them as one message.
  assert.ok(inbox.acknowledgeEcho('[Worker A] report\n[Worker B] report', v => v));
  assert.deepEqual(inbox.entries.map(e => e.state), ['sent', 'acknowledged', 'acknowledged', 'sent']);
  assert.equal(inbox.acknowledgeEcho('[Worker A] report\nsomething else', v => v), false);
  assert.ok(inbox.acknowledgeEcho('later', v => v));
  assert.equal(inbox.pending, 1);
});

test('an echo is never pieced together inside a word, and goes to the live input before an unknown one', async () => {
  const inbox = new Inbox<string>();
  inbox.entries.push({ id: 'old', value: 'yes', state: 'unknown', createdAt: 0, updatedAt: 0 });
  inbox.push('ok', 'a'); inbox.push('ay', 'b'); inbox.push('yes', 'c');
  const consumer = inbox[Symbol.asyncIterator]();
  for (let i = 0; i < 3; i++) await consumer.next();
  assert.equal(inbox.acknowledgeEcho('okay', v => v), false);
  assert.ok(inbox.acknowledgeEcho('yes', v => v));
  assert.deepEqual(inbox.entries.map(e => e.state), ['unknown', 'sent', 'sent', 'acknowledged']);
  inbox.requeue();
  assert.deepEqual(inbox.entries.map(e => e.state), ['unknown', 'queued', 'queued', 'acknowledged']);
});

test('a turn that ends with nothing held receives the inputs sent before the last echo, not those written after', async () => {
  const inbox = new Inbox<string>();
  inbox.push('first', 'a'); inbox.push('second', 'b');
  const consumer = inbox[Symbol.asyncIterator]();
  await consumer.next(); await consumer.next();
  const echoedAt = Date.now();
  inbox.entries[1].updatedAt = echoedAt + 1; // Written as the turn ended: its own echo is still to come.
  assert.ok(inbox.settle(0, echoedAt));
  assert.deepEqual(inbox.entries.map(e => e.state), ['acknowledged', 'sent']);
  assert.equal(inbox.settle(1, echoedAt + 1), false, 'the provider still holds it');
  assert.ok(inbox.settle(0, echoedAt + 1));
  assert.equal(inbox.pending, 0);
});

test('persistence must succeed before an input can reach a waiting consumer', async () => {
  let fail = true;
  const inbox = new Inbox<string>([], () => { if (fail) throw new Error('disk full'); });
  const next = inbox[Symbol.asyncIterator]().next();
  assert.throws(() => inbox.push('discarded write'), /disk full/);
  assert.equal(inbox.entries.length, 0);
  fail = false; inbox.push('durable');
  assert.equal((await next).value, 'durable');
  inbox.close();
});

test('pausing a transition holds queued messages even when the provider is waiting', async () => {
  const inbox = new Inbox<string>();
  inbox.pause();
  let delivered = false;
  const next = inbox[Symbol.asyncIterator]().next().then(result => { delivered = true; return result; });
  inbox.push('wait');
  await Promise.resolve();
  assert.equal(delivered, false);
  assert.equal(inbox.entries[0].state, 'queued');
  inbox.resume();
  assert.equal((await next).value, 'wait');
  assert.equal(inbox.entries[0].state, 'sent');
  inbox.close();
});

test('disk failure during close still releases a waiting provider', async () => {
  const inbox = new Inbox<string>([], () => { throw new Error('disk full'); });
  const next = inbox[Symbol.asyncIterator]().next();
  assert.doesNotThrow(() => inbox.close());
  assert.equal((await next).done, true);
});
