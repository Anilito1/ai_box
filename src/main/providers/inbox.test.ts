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
  assert.equal(recovered.pending, 2);
  assert.throws(() => inbox.push('too late'), /closed/);
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
