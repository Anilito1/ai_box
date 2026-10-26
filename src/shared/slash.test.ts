import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterCommands, needsArgument, parseSlash, pickOption, resolveSlash, type CliCommand } from './slash';

const cli = (name: string, aliases: string[] = [], argumentHint = ''): CliCommand => ({ name, description: `${name} command`, argumentHint, aliases });
const CLI = [cli('context'), cli('usage', ['stats']), cli('feature-dev:feature-dev'), cli('rename', [], '[name]'), cli('clear'), cli('__remote-workflow')];

test('parseSlash reads a command and its argument', () => {
  assert.deepEqual(parseSlash('/compact'), { name: 'compact', arg: '' });
  assert.deepEqual(parseSlash('  /compact  keep the plan\nand the tests  '), { name: 'compact', arg: 'keep the plan\nand the tests' });
  assert.deepEqual(parseSlash('/feature-dev:feature-dev add a toggle'), { name: 'feature-dev:feature-dev', arg: 'add a toggle' });
  assert.deepEqual(parseSlash('/Model opus'), { name: 'Model', arg: 'opus' });
});

test('parseSlash leaves plain text alone', () => {
  assert.equal(parseSlash('hello /compact'), null);
  assert.equal(parseSlash('/usr/local/bin is missing'), null);
  assert.equal(parseSlash('/'), null);
  assert.equal(parseSlash('/ space'), null);
  assert.equal(parseSlash('//compact'), null);
});

test('resolveSlash prefers the hub, then Claude Code by name or alias', () => {
  assert.deepEqual(resolveSlash({ name: 'CLEAR', arg: '' }, CLI), { kind: 'hub', command: 'clear', arg: '' });
  assert.deepEqual(resolveSlash({ name: 'cost', arg: '' }, CLI), { kind: 'hub', command: 'cost', arg: '' });
  const usage = resolveSlash({ name: 'stats', arg: 'x' }, CLI);
  assert.equal(usage.kind, 'cli');
  assert.equal(usage.kind === 'cli' && usage.command.name, 'usage');
  assert.equal(resolveSlash({ name: 'feature-dev:feature-dev', arg: '' }, CLI).kind, 'cli');
});

test('resolveSlash never passes hidden or unknown commands through', () => {
  assert.deepEqual(resolveSlash({ name: 'rename', arg: 'x' }, CLI), { kind: 'unknown', name: 'rename' });
  assert.deepEqual(resolveSlash({ name: '__remote-workflow', arg: '' }, CLI), { kind: 'unknown', name: '__remote-workflow' });
  assert.deepEqual(resolveSlash({ name: 'nope', arg: '' }, []), { kind: 'unknown', name: 'nope' });
});

test('filterCommands ranks prefix, then substring, then description', () => {
  const list = [
    { name: 'context', description: 'Show context' },
    { name: 'compact', description: 'Summarize' },
    { name: 'recompile', description: 'x' },
    { name: 'usage', description: 'cost and compaction info' },
  ];
  assert.deepEqual(
    filterCommands(list, 'comp').map((c) => c.name),
    ['compact', 'recompile', 'usage'],
  );
  assert.deepEqual(
    filterCommands(list, 'co').map((c) => c.name),
    ['context', 'compact', 'recompile'],
  );
  assert.equal(filterCommands(list, '').length, 4);
  assert.deepEqual(filterCommands(list, 'zzz'), []);
});

test('pickOption: exact, then prefix, then substring, accents and case ignored', () => {
  const modes = [
    { value: 'default', names: ['default', 'Default'] },
    { value: 'acceptEdits', names: ['acceptEdits', 'Accepter les modifications'] },
    { value: 'bypassPermissions', names: ['bypassPermissions', 'bypass', 'Tout autoriser'] },
  ];
  assert.equal(pickOption(modes, 'accept-edits'), 'acceptEdits');
  assert.equal(pickOption(modes, 'BYPASS'), 'bypassPermissions');
  assert.equal(pickOption(modes, 'tout'), 'bypassPermissions');
  assert.equal(pickOption(modes, 'modifs'), null);
  assert.equal(pickOption(modes, 'modif'), 'acceptEdits');
  assert.equal(pickOption(modes, ''), null);
  const models = [
    { value: 'default', names: ['default', 'Default (recommended)'] },
    { value: 'opus[1m]', names: ['opus[1m]', 'Opus 5.5 (1M)'] },
    { value: 'opus', names: ['opus', 'Opus 5.5'] },
  ];
  assert.equal(pickOption(models, 'opus'), 'opus');
  assert.equal(pickOption(models, 'Opus 5.5'), 'opus');
  assert.equal(pickOption(models, 'élevé'), null);
});

test('needsArgument: only a required hint', () => {
  assert.equal(needsArgument('<instruction>'), true);
  assert.equal(needsArgument('[url]'), false);
  assert.equal(needsArgument(''), false);
});
