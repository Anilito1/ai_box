import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyOf, PROVIDER_CAPABILITIES, refusedPolicy, requireAppliedPolicy, type PolicySpec } from './capabilities';

const spec: PolicySpec = { mode: 'default', readOnly: false, cwd: '/workspace', extraDirs: ['/extra'], readDirs: ['/attachments'] };

test('the capability matrix distinguishes provider controls from filesystem and network isolation', () => {
  assert.deepEqual(Object.keys(PROVIDER_CAPABILITIES).sort(), ['claude', 'codex', 'gemini']);
  assert.equal(PROVIDER_CAPABILITIES.claude.permissions.write, 'tool-filter');
  assert.equal(PROVIDER_CAPABILITIES.claude.subagents, 'native');
  assert.equal(PROVIDER_CAPABILITIES.gemini.permissions.write, 'provider-mode');
  assert.deepEqual(PROVIDER_CAPABILITIES.gemini.permissions.unsupportedModes, ['dontAsk']);
  assert.equal(PROVIDER_CAPABILITIES.gemini.transport, 'acp-stdio');
  assert.equal(PROVIDER_CAPABILITIES.codex.permissions.write, 'provider-sandbox');
  assert.equal(PROVIDER_CAPABILITIES.codex.transport, 'app-server');
  for (const harness of ['claude', 'gemini'] as const) {
    assert.equal(PROVIDER_CAPABILITIES[harness].permissions.network, 'unsupported');
    assert.equal(PROVIDER_CAPABILITIES[harness].permissions.roots, 'workspace-hint');
    assert.equal(PROVIDER_CAPABILITIES[harness].commands, 'discovered');
    assert.equal(PROVIDER_CAPABILITIES[harness].compaction, 'native');
  }
});

for (const harness of ['claude', 'gemini'] as const) {
  test(`${harness} policy remains unknown until the provider acknowledges it`, () => {
    const pending = policyOf(harness, { ...spec, readOnly: true });
    assert.equal(pending.status, 'pending');
    assert.deepEqual(pending.requested.roots, ['/workspace', '/extra', '/attachments']);
    assert.deepEqual(pending.effective, { mode: null, write: 'unknown', network: 'unknown', roots: null, approvals: 'unknown' });
    const applied = policyOf(harness, { ...spec, readOnly: true }, 'plan');
    assert.equal(applied.status, 'partial');
    assert.equal(applied.effective.roots, null);
    assert.equal(applied.effective.network, 'unknown');
    assert.match(applied.limitations.join(' '), /not guaranteed read-only/);
  });
}

test('a failed policy change retains the acknowledged policy separately from the refused request', () => {
  const previous = policyOf('gemini', spec, 'default');
  const requested = policyOf('gemini', { ...spec, mode: 'dontAsk' });
  const refused = refusedPolicy(previous, requested.requested, 'unsupported');
  assert.equal(refused.status, 'refused');
  assert.equal(refused.requested.mode, 'dontAsk');
  assert.equal(refused.effective.mode, 'default');
  assert.deepEqual(previous.requested, policyOf('gemini', spec).requested, 'previous snapshot is not mutated');
});

test('pending and refused policies block input, while acknowledged controls disclose partial isolation', () => {
  const pending = policyOf('claude', spec);
  assert.throws(() => requireAppliedPolicy(pending), /not applied.*pending/);
  const applied = policyOf('claude', spec, 'default');
  assert.doesNotThrow(() => requireAppliedPolicy(applied));
  assert.doesNotThrow(() => requireAppliedPolicy(policyOf('claude', { ...spec, readOnly: true }, 'default')));
  assert.throws(() => requireAppliedPolicy(refusedPolicy(applied, pending.requested, 'refused')), /not applied.*refused/);
  assert.doesNotThrow(() => requireAppliedPolicy(undefined), 'older adapter contracts remain compatible');
});
