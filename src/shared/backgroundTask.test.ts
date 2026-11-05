import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portOf, summarize, taskView } from './backgroundTask';

test('the port is read from the words, the variable, the option or the address', () => {
  assert.equal(portOf('Relaunch calculette layout variant V1 on port 8821'), 8821);
  assert.equal(portOf('PORT=8822 node server.js'), 8822);
  assert.equal(portOf('vite --port 5173 --host'), 5173);
  assert.equal(portOf('Serveur sur localhost:3000'), 3000);
  assert.equal(portOf('Relance le serveur sur le port 4000'), 4000);
});

test('the port is found in the output when the command does not say it', () => {
  assert.equal(portOf('npm run dev', 'ready\nMaquette : http://localhost:8823\n'), 8823);
  assert.equal(taskView('Serve the mock', 8823).url, 'http://localhost:8823');
});

test('the description wins over the output, and numbers that are no port are ignored', () => {
  assert.equal(taskView('Serve on port 8821', 9000).port, 8821);
  assert.equal(portOf('Run 3 tests in 12 files'), null);
  assert.equal(portOf('port 99999'), null);
});

test('the summary has no leading verb and no port', () => {
  assert.equal(summarize('Relaunch calculette layout variant V1 on port 8821'), 'calculette layout variant V1');
  assert.equal(summarize('Serve calculette layout variant V2 on port 8822'), 'calculette layout variant V2');
  assert.equal(summarize('Start dev server PORT=3000'), 'dev server');
  assert.equal(summarize('Relance la maquette sur le port 8823'), 'maquette');
});

test('a task that is not a server has its summary and no link', () => {
  const task = taskView('Point 1 : Équipement seul');
  assert.deepEqual(task, { label: 'Point 1 : Équipement seul', summary: 'Point 1 : Équipement seul', port: null, url: null });
  assert.equal(taskView('Run the full test suite').url, null);
  assert.equal(taskView('Run the full test suite').summary, 'full test suite');
});

test('a long description is cut at a word with an ellipsis', () => {
  const long = summarize('Relaunch calculette layout validation finale complète avec un libellé très très long pour tester la troncature');
  assert.ok(long.length <= 60 && long.endsWith('…'), long);
  assert.ok(!long.includes('  '));
});

test('a description that is only a verb and a port keeps its words', () => {
  assert.equal(summarize('Serve port 8821'), 'Serve port 8821');
});
