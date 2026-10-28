import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backgroundTokens, contrast, parseHex, toneOf } from './background';

test('parseHex takes the long and short forms, with or without #, and refuses the rest', () => {
  assert.equal(parseHex('#1A2b3C'), '#1a2b3c');
  assert.equal(parseHex('1a2b3c'), '#1a2b3c');
  assert.equal(parseHex(' #abc '), '#aabbcc');
  assert.equal(parseHex('F0a'), '#ff00aa');
  for (const bad of ['', '#', '#12', '#1234', '#12345g', 'red', '##123456', '#1234567']) assert.equal(parseHex(bad), null, bad);
});

test('the tone follows the lightness of the colour', () => {
  assert.equal(toneOf('#000000'), 'dark');
  assert.equal(toneOf('#0d0e11'), 'dark');
  assert.equal(toneOf('#ffffff'), 'light');
  assert.equal(toneOf('#ebebef'), 'light');
  assert.equal(toneOf('#ffff00'), 'light');
  assert.equal(toneOf('#0000ff'), 'dark');
});

test('the text stays readable on the window and on the panels, whatever the colour', () => {
  const samples = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#808080', '#767676', '#777777', '#3b5998', '#c0ffee', '#5a3e1b', '#e91e63'];
  for (const hex of samples) {
    const { vars } = backgroundTokens(hex);
    for (const surface of ['--bg', '--panel', '--chat']) {
      assert.ok(contrast(vars['--text'], vars[surface]) >= 4.5, `text on ${surface} of ${hex}`);
      assert.ok(contrast(vars['--text-3'], vars[surface]) >= 4.5, `secondary text on ${surface} of ${hex}`);
    }
  }
});

test('the built-in dark window keeps its own text colours', () => {
  const { tone, vars } = backgroundTokens('#0d0e11');
  assert.equal(tone, 'dark');
  assert.equal(vars['--text'], '#ececef');
});

test('an invalid colour falls back to the dark default instead of failing', () => {
  assert.equal(backgroundTokens('nope').vars['--bg'], '#0d0e11');
});
