// A compact map of a repo, in the manner of Aider's repo map: each file with its definitions and their lines, the most
// referenced files first, cut to a token budget. Prototype to measure what a map costs and brings
// (scripts/search-bench/tokens/rapport.md, section 6); run it through scripts/search-bench/repo-map.mjs.
//   repo-map.mjs <repo> [budget tokens=2000] [under=folder]   prints the map, then its size on stderr
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { cutFile, type SymbolDef } from '../../src/main/search/chunker';

const CODE = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.sql', '.sh', '.ps1']);
const SKIP = /(^|\/)(node_modules|dist|build|vendor|\.next|coverage)\/|\.min\.|\.d\.ts$|\.test\.|\.spec\./;
const MAX_BYTES = 400_000;
const CHARS_PER_TOKEN = 3;

interface FileMap { path: string; lines: number; symbols: SymbolDef[]; score: number }

export async function repoMap(repo: string, budget: number, under = ''): Promise<{ text: string; files: number; shown: number; symbols: number }> {
  const tracked = execFileSync('git', ['-C', repo, 'ls-files', ...(under ? ['--', under] : [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter((f) => f && CODE.has(extname(f)) && !SKIP.test(f));
  const files: FileMap[] = [];
  const texts = new Map<string, string>();
  for (const path of tracked) {
    const full = join(repo, path);
    if (statSync(full).size > MAX_BYTES) continue;
    const text = readFileSync(full, 'utf8');
    const { symbols } = await cutFile(path, text);
    // Top-level definitions and methods; a constant only when it is named like one.
    const kept = symbols.filter((s) => s.kind !== 'code' || /^[A-Z][A-Z0-9_]{3,}$/.test(s.name));
    files.push({ path, lines: text.split('\n').length, symbols: kept, score: 0 });
    texts.set(path, text);
  }
  // A file matters as much as the other files name what it defines (a cheap stand-in for a reference graph).
  const owners = new Map<string, FileMap[]>();
  for (const f of files) for (const s of f.symbols) {
    const name = s.name.split('.').pop() ?? '';
    if (name.length >= 5) owners.set(name, [...(owners.get(name) ?? []), f]);
  }
  for (const [path, text] of texts) {
    const seen = new Set<FileMap>();
    for (const word of new Set(text.match(/[A-Za-z_$][\w$]{4,}/g) ?? [])) {
      const defs = owners.get(word);
      // A name defined in many files says little about any of them.
      if (!defs || defs.length > 3) continue;
      for (const f of defs) if (f.path !== path) seen.add(f);
    }
    for (const f of seen) f.score++;
  }
  files.sort((a, b) => b.score - a.score || b.symbols.length - a.symbols.length);
  const lines: string[] = [];
  let chars = 0;
  let shown = 0;
  let symbols = 0;
  for (const f of files) {
    if (!f.symbols.length) continue;
    // The most a file may take: a long file lists its largest definitions.
    const top = [...f.symbols].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 14).sort((a, b) => a.start - b.start);
    const line = `${f.path} (${f.lines}): ${top.map((s) => `${s.name}@${s.start}`).join(' ')}${f.symbols.length > top.length ? ` +${f.symbols.length - top.length}` : ''}`;
    if (chars + line.length > budget * CHARS_PER_TOKEN) break;
    lines.push(line);
    chars += line.length + 1;
    shown++;
    symbols += top.length;
  }
  return { text: lines.join('\n'), files: files.length, shown, symbols };
}

const [repo, budget = '2000', under = ''] = process.argv.slice(2);
if (repo) {
  const t0 = Date.now();
  const map = await repoMap(repo, Number(budget), under);
  console.log(map.text);
  console.error(JSON.stringify({ files: map.files, shown: map.shown, symbols: map.symbols, chars: map.text.length, tokens: Math.round(map.text.length / CHARS_PER_TOKEN), ms: Date.now() - t0 }));
}
