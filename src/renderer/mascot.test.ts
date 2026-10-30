import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mascotOf, providerMascot, sessionMascot } from './mascot';
import type { AccountBadge, SessionView } from '../shared/types';

const account = (id: string, provider: string, name: string): AccountBadge => ({ id, name, kind: 'openai', provider, limitedUntil: null, pinned: true });
const session = (acct: string, model: string, modelLabel = model) => ({ account: acct, model, modelLabel }) as SessionView;

describe('mascots', () => {
  it('leaves the built-in providers as they are, whatever they run', () => {
    assert.equal(mascotOf('anthropic'), 'clawd');
    assert.equal(mascotOf('openai'), 'codex');
    assert.equal(mascotOf('gemini'), 'gemini');
    assert.equal(mascotOf('deepseek'), 'deepseek');
    assert.equal(mascotOf('anthropic', 'deepseek-v4-pro'), 'clawd');
    assert.equal(mascotOf('openai', 'DeepSeek'), 'codex');
  });

  it('dresses a provider the user added as DeepSeek when its id, name or model says so', () => {
    assert.equal(mascotOf('deepseek-uncensored'), 'deepseek');
    assert.equal(mascotOf('venice', 'Deep Seek via Venice'), 'deepseek');
    assert.equal(mascotOf('venice', 'Venice', 'deepseek-v4-1-flash-1017-uncensored'), 'deepseek');
  });

  it('leaves an unrelated provider the user added on the default', () => {
    assert.equal(mascotOf('local-llama', 'Local Llama', 'llama-4'), 'clawd');
    assert.equal(mascotOf('', ''), 'clawd');
    assert.equal(mascotOf('seekers', 'Deep Thought', 'deep-seeker-1'), 'clawd');
  });

  it('follows the model a session really runs, a pinned account keeping the Claude choice aside', () => {
    const accounts = [account('venice', 'venice', 'Venice'), account('llama', 'local-llama', 'Local Llama'), account('default', 'anthropic', 'Claude')];
    assert.equal(sessionMascot(session('venice', 'opus', 'deepseek-v4-1-flash-1017-uncensored'), accounts), 'deepseek');
    assert.equal(sessionMascot(session('venice', 'qwen-3'), accounts), 'clawd');
    assert.equal(sessionMascot(session('llama', 'llama-4'), accounts), 'clawd');
    assert.equal(sessionMascot(session('default', 'claude-opus-5-5'), accounts), 'clawd');
    assert.equal(sessionMascot(session('gone', ''), accounts), 'clawd');
  });

  it('reads the name of a session on a DeepSeek provider of the user', () => {
    assert.equal(sessionMascot(session('a', 'some-model'), [account('a', 'deepseek-uncensored', 'Uncensored')]), 'deepseek');
    assert.equal(sessionMascot(session('a', 'some-model'), [account('a', 'venice', 'DeepSeek at Venice')]), 'deepseek');
  });

  it('gives a provider the DeepSeek mark on its models only when they all are DeepSeek', () => {
    assert.equal(providerMascot('venice', 'Venice', ['deepseek-v4-1-flash-1017-uncensored']), 'deepseek');
    assert.equal(providerMascot('venice', 'Venice', ['deepseek-a', 'qwen-3', 'llama-4']), 'clawd');
    assert.equal(providerMascot('venice', 'Venice', []), 'clawd');
    assert.equal(providerMascot('deepseek-uncensored', 'Uncensored', ['qwen-3']), 'deepseek');
    assert.equal(providerMascot('gemini', 'Gemini', ['deepseek-a']), 'gemini');
  });
});
