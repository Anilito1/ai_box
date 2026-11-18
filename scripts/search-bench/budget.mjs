// One spending ceiling for every bench of a study, at API prices: each paid run is written to BENCH_SPEND_FILE
// (JSONL, numbers and a label), and nothing starts once the total plus the next run's reserve would pass
// BENCH_BUDGET_USD. The file outlives a script, so the ceiling holds across runs and across scripts.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export function budget(file = process.env.BENCH_SPEND_FILE, cap = Number(process.env.BENCH_BUDGET_USD ?? 30)) {
  if (!file) throw new Error('BENCH_SPEND_FILE is required: the ceiling is kept there');
  const spent = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).reduce((a, l) => a + (JSON.parse(l).usd ?? 0), 0) : 0);
  return {
    cap,
    spent,
    room: (reserve) => spent() + reserve <= cap,
    charge: (label, usd) => appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), label, usd })}\n`),
  };
}
