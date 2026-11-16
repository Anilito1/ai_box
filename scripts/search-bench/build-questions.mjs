// Builds evaluation questions for the local search from what really happened in a repo, with the files that were
// the answer (docs/recherche-semantique.md):
//   - its commits: the subject of a commit is the question, the code files it changed are where to look;
//   - the missions given to the hub's workers: the start of the mission is the question, the files the worker
//     edited are where to look. Only that start (cut, with secrets, e-mails and numbers masked) and file paths
//     are kept; nothing else of a conversation is read into the output.
// The output goes to a folder outside any repo (the lab): questions about private repos are not versioned.
//   node scripts/search-bench/build-questions.mjs <repo clone> <repo name> <out dir> [--commits 60] [--since 6.months]
//        [--sessions <folder of Claude Code projects> --match <text the session folders of this repo contain>]
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const [clone, repo, outDir, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);
const git = (...args) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const CODE = /\.(?:[cm]?[jt]sx?|py|cs|sql|css|html|vue|go|rs)$/i;
const NOT_AN_ANSWER = /(^|\/)(docs?|node_modules|dist|build|vendor|fixtures?|__tests__|tests?)\/|\.(test|spec)\.[a-z]+$|(^|\/)test[-_][^/]*$|\.min\.|\.d\.ts$|(^|\/)i18n\.ts$/i;
const tracked = new Set(git('ls-files').split('\n').filter(Boolean));
/** Files someone would be sent to: code that still exists, not a test, a doc, a translation table or a bundle. */
const answers = (paths) => [...new Set(paths)].filter((p) => tracked.has(p) && CODE.test(p) && !NOT_AN_ANSWER.test(p) && statSync(join(clone, p)).size < 400_000);
const mask = (text) =>
  text
    .replace(/\b(?:sk|rk)[-_][A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]{10,}|\b(?:ghp|sbp|shpat|xox[abp])[-_][A-Za-z0-9_-]{10,}/g, '[secret]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[mail]')
    .replace(/(?:\+|\b0)\d[\d .-]{8,}\d/g, '[number]');

function fromCommits(max, since) {
  const out = [];
  const log = git('log', '--no-merges', `--since=${since}`, '--pretty=format:%x01%s', '--name-only');
  for (const entry of log.split('\u0001').filter(Boolean)) {
    const [subject, ...files] = entry.split('\n').filter(Boolean);
    const expect = answers(files);
    // A subject long enough to describe something, a change small enough to have a place.
    if (subject.length < 30 || /^(wip|merge|revert|bump|release|chore\(release\))/i.test(subject) || expect.length < 1 || expect.length > 5) continue;
    out.push({ repo, type: 'commit', source: 'commit', q: mask(subject).slice(0, 300), expect: expect.map((path) => ({ path })) });
  }
  // Spread over the period rather than the latest ones only.
  const step = Math.max(1, Math.floor(out.length / max));
  return out.filter((_q, i) => i % step === 0).slice(0, max);
}

async function fromSessions(projects, match) {
  const out = [];
  const folders = readdirSync(projects).filter((d) => d.toLowerCase().includes(match.toLowerCase()));
  for (const folder of folders) {
    for (const file of readdirSync(join(projects, folder)).filter((f) => f.endsWith('.jsonl'))) {
      let mission = '';
      const edited = [];
      for await (const line of createInterface({ input: createReadStream(join(projects, folder, file)), crlfDelay: Infinity })) {
        // Two kinds of lines are looked at, by a cheap test first: the first message (the mission) and file edits.
        if (!mission && line.includes('[Mission du ma')) {
          try {
            const content = JSON.parse(line).message?.content;
            const text = typeof content === 'string' ? content : (content?.find?.((b) => b.type === 'text')?.text ?? '');
            const start = text.indexOf('[Mission du ma');
            if (start >= 0) mission = text.slice(start).split('\n').slice(1).join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          } catch {
            // not a message line
          }
        } else if (line.includes('"tool_use"') && /"name":"(Edit|Write|NotebookEdit)"/.test(line)) {
          for (const m of line.matchAll(/"file_path":"((?:[^"\\]|\\.)+)"/g)) edited.push(JSON.parse(`"${m[1]}"`).replace(/\\/g, '/'));
        }
      }
      if (mission.length < 60) continue;
      // Paths inside this repo or one of its worktrees (`<repo>` or `<repo>-something` on the way), relative to it.
      const inside = edited.flatMap((p) => {
        const m = new RegExp(`/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-[^/]+)?/(.+)$`, 'i').exec(p);
        return m && !m[1].startsWith('.aibox/') ? [m[1]] : [];
      });
      const expect = answers(inside);
      if (expect.length < 1 || expect.length > 6) continue;
      out.push({ repo, type: 'mission', source: 'session', q: mask(mission).slice(0, 300), expect: expect.map((path) => ({ path })) });
    }
  }
  // The same mission given twice (a worker relaunched) counts once.
  return out.filter((q, i) => out.findIndex((o) => o.q.slice(0, 120) === q.q.slice(0, 120)) === i);
}

const commits = fromCommits(Number(opt('--commits', '60')), opt('--since', '6.months'));
const sessionsDir = opt('--sessions', '');
const sessions = sessionsDir && existsSync(sessionsDir) ? await fromSessions(resolve(sessionsDir), opt('--match', repo)) : [];
writeFileSync(join(outDir, `questions-${repo}-commits.json`), `${JSON.stringify(commits, null, 1)}\n`);
writeFileSync(join(outDir, `questions-${repo}-sessions.json`), `${JSON.stringify(sessions, null, 1)}\n`);
console.log(JSON.stringify({ repo, commits: commits.length, sessions: sessions.length, filesPerCommit: (commits.reduce((n, q) => n + q.expect.length, 0) / Math.max(1, commits.length)).toFixed(1), filesPerSession: (sessions.reduce((n, q) => n + q.expect.length, 0) / Math.max(1, sessions.length)).toFixed(1) }));
