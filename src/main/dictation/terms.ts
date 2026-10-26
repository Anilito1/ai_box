import { TERM_MAX_LENGTH, TERMS_MAX } from '../../shared/dictation';

/** Words a developer says that a general model writes wrong; they go to the engine with the window's own terms. */
export const COMMON_TERMS = [
  'React', 'Vitest', 'TypeScript', 'JavaScript', 'Node.js', 'npm', 'esbuild', 'Electron', 'GitHub', 'Git', 'Swift', 'SwiftUI', 'Python', 'Docker', 'Kubernetes',
  'Supabase', 'PostgreSQL', 'GraphQL', 'JSON', 'API', 'CSS', 'HTML', 'SQL', 'CLI', 'Claude', 'Anthropic', 'OpenAI', 'Gemini', 'Codex', 'commit', 'pull request',
  'worktree', 'merge', 'rebase', 'refactor', 'linter', 'build', 'debug', 'webhook', 'frontend', 'backend', 'localhost',
];

/** The terms to send: the window's (repo and branch names…) first, the common ones after, no duplicate, bounded. */
export function mergeTerms(own: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== 'string') return;
    const term = v.replace(/\s+/g, ' ').trim();
    if (term.length < 2 || term.length > TERM_MAX_LENGTH || /[\0-\x1f]/.test(term)) return;
    const key = term.toLowerCase();
    if (seen.has(key) || out.length >= TERMS_MAX) return;
    seen.add(key);
    out.push(term);
  };
  if (Array.isArray(own)) for (const v of own.slice(0, TERMS_MAX)) add(v);
  for (const v of COMMON_TERMS) add(v);
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The engine hears the words but writes them as a sentence: "react", "github". Terms that are not plain lowercase
 * words get their own spelling back.
 */
export function applyTerms(text: string, terms: string[]): string {
  let out = text;
  for (const term of terms) {
    if (term === term.toLowerCase() && !/[.]/.test(term)) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'giu'), term);
  }
  return out;
}
