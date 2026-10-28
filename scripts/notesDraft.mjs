import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// `npm run notes`: a draft of the next release notes from the commits since docs/notes-de-version.md last changed (or
// since the revision given), sorted into Ajouté / Modifié / Supprimé. Commit subjects are English and technical: the
// draft is to be rewritten in short French lines for users, then put at the top of the file. Nothing is written.

export const NOTES_FILE = 'docs/notes-de-version.md';

/** Files that never change what a user sees: a commit touching only these is left out. */
const INTERNAL = [/^README\.md$/, /^docs\//, /^scripts\//, /\.test\.ts$/, /^\.github\//, /^LICENSE$/, /^THIRD_PARTY_NOTICES\.md$/, /^CLAUDE\.md$/, /^\.gitignore$/];
const CONVENTIONAL = { feat: 'added', fix: 'changed', perf: 'changed', refactor: 'changed', revert: 'changed' };
const ADDED = /^(add|adds|show|let|offer|support|allow|introduce|give|sign in|new)\b/i;
const REMOVED = /^(drop|remove|delete|retire)\b/i;

/**
 * Where a commit goes in the notes, null when users would not see it (a merge, an internal type, internal files only).
 * @param {string} subject @param {string[]} files @returns {'added' | 'changed' | 'removed' | null}
 */
export function classify(subject, files) {
  if (/^Merge\b/.test(subject)) return null;
  if (files.length > 0 && files.every((f) => INTERNAL.some((re) => re.test(f)))) return null;
  const conv = /^(\w+)(?:\([^)]*\))?!?:\s*(.*)$/.exec(subject);
  let text = subject;
  if (conv) {
    const type = /** @type {keyof typeof CONVENTIONAL} */ (conv[1].toLowerCase());
    if (!(type in CONVENTIONAL)) return null;
    text = conv[2];
    if (type !== 'feat') return REMOVED.test(text) ? 'removed' : CONVENTIONAL[type];
  }
  if (REMOVED.test(text)) return 'removed';
  return conv || ADDED.test(text) ? 'added' : 'changed';
}

const LABELS = { added: 'Ajouté', changed: 'Modifié', removed: 'Supprimé' };

/** @param {{ subject: string, files: string[] }[]} commits @returns {string} */
export function draft(commits) {
  /** @type {Record<string, string[]>} */
  const groups = { added: [], changed: [], removed: [] };
  for (const c of commits) {
    const section = classify(c.subject, c.files);
    if (section) groups[section].push(c.subject);
  }
  const body = Object.entries(groups)
    .filter(([, list]) => list.length > 0)
    .map(([section, list]) => `### ${LABELS[/** @type {keyof typeof LABELS} */ (section)]}\n\n${list.map((s) => `- ${s}`).join('\n')}`);
  return body.length === 0 ? '' : `## ${new Date().toISOString().slice(0, 10)}\n\n${body.join('\n\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { encoding: 'utf8' });
  const since = process.argv[2] || git('log', '-1', '--format=%H', '--', NOTES_FILE).trim();
  const log = git('log', '--no-merges', '--name-only', '--format=%x00%s', since ? `${since}..HEAD` : 'HEAD');
  const commits = log
    .split('\0')
    .filter(Boolean)
    .map((block) => {
      const [subject, ...files] = block.split('\n').filter(Boolean);
      return { subject, files };
    });
  const text = draft(commits);
  console.log(text ? `${text}\nBrouillon : réécrire chaque ligne en français, courte et vue par l'utilisateur, puis la mettre en haut de ${NOTES_FILE}.` : 'Rien de visible pour les utilisateurs depuis la dernière note.');
}
