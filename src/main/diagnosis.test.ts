import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readReport } from '../shared/diagnosis';
import type { SessionView, TeamRole } from '../shared/types';
import { loadConfig } from './config';
import type { CostLog } from './costLog';
import { DIAG_ACTIVITY, diagContext, type DiagFacts } from './diagnosis';
import type { McpHub } from './mcpHub';
import { disallowedTools } from './providers/claude/adapter';
import { Inbox } from './providers/inbox';
import { SessionManager } from './sessions';

// "Analyser" on a worker's signal: what the diagnosis worker is told, and when the hub refuses to start one.

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const MIN = 60_000;

const facts = (over: Partial<DiagFacts> = {}): DiagFacts => ({
  name: 'hub-render',
  status: 'busy',
  cwd: 'C:\\work\\render',
  mission: 'Render the scene.\n'.repeat(80),
  now: NOW,
  signalAt: NOW - 21 * MIN,
  busySince: NOW - 23 * MIN,
  approvedAt: null,
  limit: null,
  retrying: false,
  compacting: false,
  tools: [{ name: 'Bash', summary: `blender -b scene.blend -a ${'x'.repeat(500)}`, since: NOW - 20 * MIN }],
  background: [{ label: 'render frames', command: 'blender -b scene.blend -a', outputFile: 'C:\\tmp\\tasks\\b1.output', since: NOW - 20 * MIN }],
  subagents: [],
  pending: [{ tool: 'Bash', summary: 'rm -rf build' }],
  activity: Array.from({ length: 30 }, (_, i) => `· step ${i}`),
  transcript: 'C:\\Users\\u\\.claude\\projects\\C--work-render\\abc.jsonl',
  procs: [{ pid: 4242, startedAt: NOW - 30 * MIN }],
  children: [{ pid: 5151, ppid: 4242, created: NOW - 20 * MIN }],
  ...over,
});

test('the context names the worker, its last signal, the turn, the tool and the background task, with their times', () => {
  const text = diagContext(facts(), 'fr');
  assert.match(text, /Worker : hub-render/);
  assert.match(text, /Statut : busy/);
  assert.match(text, /Dossier : C:\\work\\render/);
  assert.match(text, /Dernier signal du process : 2026-11-15T11:39:00.000Z \(il y a 21 min 00 s\)/);
  assert.match(text, /Tour en cours depuis : 2026-11-15T11:37:00.000Z \(il y a 23 min 00 s\)/);
  assert.match(text, /- Bash blender -b scene\.blend -a x+… — depuis 2026-11-15T11:40:00.000Z/);
  assert.match(text, /- render frames — commande : blender -b scene\.blend -a — sortie : C:\\tmp\\tasks\\b1\.output — lancée 2026-11-15T11:40:00.000Z/);
  assert.match(text, /Validations en attente de l’utilisateur :\n- Bash rm -rf build/);
  assert.match(text, /Transcript de sa conversation : C:\\Users\\u\\\.claude\\projects\\C--work-render\\abc\.jsonl/);
  assert.match(text, /PID 4242/);
  assert.match(text, /5151 4242 2026-11-15T11:40:00.000Z/);
});

test('the context cuts long arguments and the mission, and keeps only the latest activity', () => {
  const text = diagContext(facts(), 'en');
  const tool = text.split('\n').find((l) => l.startsWith('- Bash blender')) ?? '';
  assert.ok(tool.length < 400, `tool line kept short: ${tool.length}`);
  const mission = text.split('\n').find((l) => l.startsWith('Mission (summary)')) ?? '';
  assert.ok(mission.length < 640, `mission kept short: ${mission.length}`);
  assert.ok(!text.includes('· step 14\n'));
  assert.match(text, new RegExp(`· step ${30 - DIAG_ACTIVITY}\\n`));
  assert.match(text, /· step 29\n/);
});

test('the context says what the hub does not know instead of leaving it out', () => {
  const text = diagContext(facts({ signalAt: null, busySince: null, tools: [], background: [], pending: [], transcript: '', procs: [], children: null, limit: { resetsAt: null }, retrying: true }), 'en');
  assert.match(text, /Last signal from its process: none since this process started/);
  assert.match(text, /Turn in progress since: no turn in progress/);
  assert.match(text, /Tool calls in progress:\n- none/);
  assert.match(text, /Background tasks:\n- none/);
  assert.match(text, /Account limit reached/);
  assert.match(text, /API call failed, retrying/);
  assert.match(text, /Its conversation’s transcript: unknown/);
  assert.match(text, /Child processes \(pid, parent pid, created\): not listed/);
});

test('a report in the fixed format gives its verdict and cause, in French or English, markdown or not', () => {
  assert.deepEqual(readReport('**Verdict** : À surveiller\n**Cause** : le rendu avance lentement.\nPreuves :\n- CPU 98 %'), { verdict: 'watch', cause: 'le rendu avance lentement.' });
  assert.deepEqual(readReport('- Verdict: Blocked\n- Cause: the API call hangs'), { verdict: 'blocked', cause: 'the API call hangs' });
  assert.deepEqual(readReport('Verdict : Bloqué\nCause : process figé'), { verdict: 'blocked', cause: 'process figé' });
  assert.equal(readReport('Verdict: Normal').verdict, 'normal');
  assert.deepEqual(readReport('Nothing in the format'), { verdict: null, cause: '' });
});

test('a diagnosis worker cannot write to the others', () => {
  assert.ok(disallowedTools({ role: 'worker', readOnly: true, ultracode: false, observer: true }).includes('SendMessage'));
  assert.ok(disallowedTools({ role: 'worker', readOnly: true, ultracode: false, observer: true }).includes('Edit'));
  assert.ok(!disallowedTools({ role: 'worker', readOnly: false, ultracode: false }).includes('SendMessage'));
});

interface Fake {
  id: string;
  name: string;
  status: string;
  inbox: unknown;
  query: unknown;
  readOnly: boolean;
  fixedModel: string;
  fixedEffort: string | null;
  closeWhenDone: boolean;
  owesReport: boolean;
  busySince: number | null;
  signalAt: number | null;
  tools: Map<string, { name: string; summary: string; since: number }>;
  diagOf: { target: string; dirs: string[]; reported: boolean } | null;
  deliveries: unknown[];
}
interface Inner {
  sessions: Map<string, Fake>;
  createRole(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  launch(s: Fake, resume: boolean, prompt?: { text: string }): Promise<void>;
  messageMaster(s: Fake, text: string): string;
  onEvent(s: Fake, q: unknown, ev: unknown): void;
  deliver(s: Fake, prompt: { text: string }): void;
  create(id: string, role: string, name: string, mission: string, cwd: string, model: string, effort: null): Fake;
}

async function hub(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-diag-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  const cfg = loadConfig(dir, 'en');
  cfg.workspaces = [work];
  const m = new SessionManager({
    cfg,
    dataDir: dir,
    executable: () => '',
    codexExecutable: () => '',
    geminiExecutable: () => '',
    mcpHub: {} as McpHub,
    sessionEnv: () => ({ set: {}, unset: [] }),
    persist: () => undefined,
    costLog: { today: () => 0 } as unknown as CostLog,
    capabilities: async () => '',
  });
  t.after(() => (m.killAll(), rmSync(dir, { recursive: true, force: true })));
  const inner = m as unknown as Inner;
  await inner.createRole({ name: 'render', description: 'renders', folders: [work] }, new AbortController().signal);
  inner.create('master', 'master', 'hub-master', '', work, '', null);
  const role = cfg.team.find((r) => r.name === 'render') as TeamRole;
  const target = inner.sessions.get(role.id) as Fake;
  // Busy for 20 minutes on one command, nothing heard since it started.
  Object.assign(target, { status: 'busy', inbox: new Inbox(), busySince: Date.now() - 20 * MIN, signalAt: Date.now() - 20 * MIN });
  target.tools.set('t1', { name: 'Bash', summary: 'npm run build', since: Date.now() - 20 * MIN });
  // No program is started: the launch only claims its inbox, as start() does synchronously, and keeps the first prompt.
  const launched: { s: Fake; text: string }[] = [];
  inner.launch = async (s, _resume, prompt) => {
    s.inbox = new Inbox();
    launched.push({ s, text: prompt?.text ?? '' });
  };
  const delivered: { to: string; text: string }[] = [];
  inner.deliver = (s, prompt) => void delivered.push({ to: s.id, text: prompt.text });
  const view = (id: string) => m.snapshot().sessions.find((x) => x.id === id) as SessionView;
  const diags = () => [...inner.sessions.values()].filter((s) => s.diagOf);
  return { m, inner, cfg, target, launched, delivered, view, diags };
}

test('Analyser starts one read-only diagnosis worker, on sonnet at medium, named after the target, told what the hub knows', async (t) => {
  const { m, target, launched, view, diags } = await hub(t);
  assert.equal(await m.analyze(target.id), '');
  const [d] = diags();
  assert.ok(d);
  assert.equal(d.name, `hub-diag-${target.name.replace(/^hub-/, '')}`);
  assert.equal(d.readOnly, true);
  assert.equal(d.fixedModel, 'sonnet');
  assert.equal(d.fixedEffort, 'medium');
  assert.equal(d.closeWhenDone, true);
  assert.equal(d.owesReport, false);
  assert.equal(launched.length, 1);
  assert.match(launched[0].text, /<hub-note>/);
  assert.match(launched[0].text, new RegExp(`Worker: ${target.name}`));
  assert.match(launched[0].text, /- Bash npm run build — since .* \(20 min 0\d s ago\)/);
  assert.equal(view(target.id).diagnosis?.state, 'running');
  assert.equal(view(d.id).diagFor, target.name);
});

test('a second click while the analysis runs starts nothing more', async (t) => {
  const { m, target, launched, view, diags } = await hub(t);
  // Both before the first has listed the processes: the first one holds the place from the click.
  const [first, second] = await Promise.all([m.analyze(target.id), m.analyze(target.id)]);
  assert.equal(first, '');
  assert.match(second, /already running/);
  assert.match(await m.analyze(target.id), /already running/);
  assert.equal(diags().length, 1);
  assert.equal(launched.length, 1);
  assert.equal(view(target.id).diagnosis?.state, 'running');
});

test('at the workers limit the analysis is refused with a clear message, kept under the worker', async (t) => {
  const { m, cfg, target, launched, view, diags } = await hub(t);
  cfg.parallel = { ...cfg.parallel, maxWorkers: 1 }; // The target itself takes the only place.
  const refusal = await m.analyze(target.id);
  assert.match(refusal, /Analysis not started: the limit of 1 running workers is reached/);
  assert.equal(diags().length, 0);
  assert.equal(launched.length, 0);
  const shown = view(target.id).diagnosis;
  assert.equal(shown?.state, 'failed');
  assert.equal(shown?.cause, refusal);
  // Not a running analysis: once a place is free, a new click starts one.
  cfg.parallel = { ...cfg.parallel, maxWorkers: 5 };
  assert.equal(await m.analyze(target.id), '');
  assert.equal(diags().length, 1);
});

test('the report shows under the target with its verdict and reaches the master; a new analysis can start then', async (t) => {
  const { m, inner, target, view, diags, delivered } = await hub(t);
  await m.analyze(target.id);
  const [d] = diags();
  inner.messageMaster(d, 'Verdict : Bloqué\nCause : le build attend une validation.\nPreuves :\n- transcript figé depuis 20 min');
  const shown = view(target.id).diagnosis;
  assert.equal(shown?.state, 'done');
  assert.equal(shown?.verdict, 'blocked');
  assert.equal(shown?.cause, 'le build attend une validation.');
  assert.equal(shown?.by, d.name);
  assert.ok(delivered.some((x) => x.to === 'master' && x.text.includes('le build attend une validation.')));
  assert.equal(await m.analyze(target.id), '');
});

test('a report written only as the turn text still reaches the master; a turn without one fails the analysis', async (t) => {
  const { m, inner, target, view, diags, delivered } = await hub(t);
  await m.analyze(target.id);
  const [d] = diags();
  const turn = (result: string) => ({ type: 'turn', subtype: 'success', isError: false, result, queued: 0, contextWindows: [], usage: { cost: 0, models: {} } });
  inner.onEvent(d, d.query, turn('Verdict: Normal\nCause: a long build is progressing.'));
  assert.equal(view(target.id).diagnosis?.verdict, 'normal');
  assert.ok(delivered.some((x) => x.to === 'master' && x.text.includes('a long build is progressing.')));

  // Closed by hand before its report: the analysis is over, and says so.
  m.stop(d.id);
  assert.equal(await m.analyze(target.id), '');
  const second = diags().find((x) => x.inbox) as Fake;
  inner.onEvent(second, second.query, turn(''));
  assert.equal(view(target.id).diagnosis?.state, 'failed');
});
