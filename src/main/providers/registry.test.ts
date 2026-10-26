import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harnessOf } from '../../shared/accounts';
import { PROVIDER_DEFS, providerOfAccount } from '../../shared/providers';
import { ACCOUNT_KINDS, HARNESSES, type Account, type AccountKind } from '../../shared/types';

// The real registry the session manager resolves adapters from: no adapter built by hand here. A provider whose
// accounts run on a harness with no adapter registered would only fail when a session starts (it did, once, for Codex).
const { adapterFor } = await import('./index');

test('every harness has an adapter in the registry, and it is the harness asked for', () => {
  for (const harness of Object.keys(HARNESSES) as (keyof typeof HARNESSES)[]) assert.equal(adapterFor(harness).harness, harness, harness);
});

test('every kind of account runs on a harness the registry has an adapter for', () => {
  for (const kind of [...ACCOUNT_KINDS, 'default' as const]) {
    const harness = harnessOf(kind);
    assert.doesNotThrow(() => adapterFor(harness), `${kind} → ${harness}`);
  }
});

test('every provider of the registry is reached by a kind of account that has an adapter', () => {
  const account = (kind: AccountKind): Pick<Account, 'kind' | 'baseUrl'> => ({ kind, baseUrl: kind === 'openai' ? 'https://api.openai.com/v1' : kind === 'anthropic-compatible' ? 'https://api.deepseek.com/anthropic' : '' });
  for (const def of PROVIDER_DEFS) {
    const kinds = ACCOUNT_KINDS.filter((k) => providerOfAccount(account(k)) === def.id);
    assert.ok(kinds.length > 0, `${def.id} has no kind of account`);
    for (const kind of kinds) assert.doesNotThrow(() => adapterFor(harnessOf(kind)), `${def.id} (${kind})`);
  }
  assert.ok(providerOfAccount('default'));
});
