import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { outputFileOf, portOfRun, runFor, runOf } from './backgroundPorts';

test('only a Bash call asked to run in the background is a run', () => {
  assert.equal(runOf('Bash', { command: 'npm test' }), null);
  assert.equal(runOf('Read', { run_in_background: true }), null);
  assert.deepEqual(runOf('Bash', { command: 'node s.js', description: 'Serve V1', run_in_background: true }), { description: 'Serve V1', command: 'node s.js', outputFile: '' });
});

test('the output file is read from the result of the call', () => {
  const text = 'Command running in background with ID: abc12. Output is being written to: /tmp/claude/tasks/abc12.output.';
  assert.equal(outputFileOf(text), '/tmp/claude/tasks/abc12.output');
  assert.equal(outputFileOf('done'), '');
});

test('the port comes from the command, else from what the task printed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bgports-'));
  try {
    const file = join(dir, 'x.output');
    writeFileSync(file, 'listening\nMaquette : http://localhost:8823\n');
    assert.equal(await portOfRun({ description: 'd', command: 'PORT=8821 node s.js', outputFile: file }), 8821);
    assert.equal(await portOfRun({ description: 'd', command: 'node s.js', outputFile: file }), 8823);
    assert.equal(await portOfRun({ description: 'd', command: 'node s.js', outputFile: join(dir, 'missing') }), null);
    assert.equal(await portOfRun({ description: 'd', command: 'npm test', outputFile: '' }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a task is matched to its run by description, else by command', () => {
  const a = { description: 'Serve V1', command: 'a', outputFile: '' };
  const b = { description: '', command: 'node b.js', outputFile: '' };
  assert.equal(runFor('Serve V1', [a, b]), a);
  assert.equal(runFor('node b.js', [a, b]), b);
  assert.equal(runFor('other', [a, b]), undefined);
});
