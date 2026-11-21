import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linuxTerminals } from './terminal';

test('Linux terminals: $TERMINAL first with its own way to run a program, then the usual ones', () => {
  const names = (list: [string, string[]][]) => list.map(([t]) => t);
  const args = (list: [string, string[]][], name: string) => list.find(([t]) => t === name)?.[1];
  const usual = linuxTerminals();
  assert.deepEqual(names(usual).slice(0, 5), ['xdg-terminal-exec', 'x-terminal-emulator', 'kitty', 'foot', 'alacritty']);
  // kitty and foot run their arguments; -e is not theirs.
  assert.deepEqual(args(usual, 'kitty'), []);
  assert.deepEqual(args(usual, 'foot'), []);
  assert.deepEqual(args(usual, 'alacritty'), ['-e']);
  assert.deepEqual(args(usual, 'gnome-terminal'), ['--']);
  assert.deepEqual(args(usual, 'wezterm'), ['start', '--']);
  const kitty = linuxTerminals('/usr/bin/kitty');
  assert.deepEqual(kitty[0], ['/usr/bin/kitty', []]);
  assert.equal(names(kitty).filter((t) => t === 'kitty').length, 0, 'not tried twice');
  assert.deepEqual(linuxTerminals(' st ')[0], ['st', ['-e']]);
  assert.deepEqual(linuxTerminals('  '), usual);
});
