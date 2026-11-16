import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language, Node, Parser } from '@vscode/tree-sitter-wasm';

/** One searchable piece of a file. Lines are 1-based, both included. */
export interface Chunk {
  start: number;
  end: number;
  /** `Class.method`, a heading, a statement's object; '' when the piece has no name. */
  symbol: string;
  kind: 'function' | 'method' | 'class' | 'type' | 'code' | 'doc' | 'sql' | 'outline';
  text: string;
}

/** A definition longer than this is cut along its own structure (members, statements), then by windows. */
export const MAX_LINES = 90;
/** Pieces shorter than this are put together with their neighbours. */
const SMALL = 20;
const GROUP_MAX = 50;
const WINDOW = 60;
const OVERLAP = 10;
/** A file longer than this also gets an outline: its imports and the list of its symbols. */
const OUTLINE_FROM = 150;
const OUTLINE_CHARS = 5000;

const GRAMMARS: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.cs': 'c-sharp', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.php': 'php',
  '.c': 'cpp', '.h': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.sh': 'bash', '.ps1': 'powershell', '.css': 'css',
};

interface Unit { start: number; end: number; name: string; kind: Chunk['kind'] | 'import' }

/** Where the grammars are: next to the built app, else in the package (tests, scripts). */
function grammarDir(): string {
  const built = join(dirname(fileURLToPath(import.meta.url)), 'grammars');
  if (existsSync(join(built, 'tree-sitter.wasm'))) return built;
  return dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm'));
}

let runtime: Promise<typeof import('@vscode/tree-sitter-wasm')> | null = null;
const languages = new Map<string, Promise<Language>>();
const parsers = new Map<string, Parser>();

async function parserFor(grammar: string): Promise<Parser> {
  const ready = parsers.get(grammar);
  if (ready) return ready;
  const dir = grammarDir();
  runtime ??= (async () => {
    const ts = createRequire(import.meta.url)(join(dir, 'tree-sitter.js')) as typeof import('@vscode/tree-sitter-wasm');
    await ts.Parser.init({ locateFile: (file: string) => join(dir, file) });
    return ts;
  })();
  const ts = await runtime;
  let language = languages.get(grammar);
  if (!language) languages.set(grammar, (language = ts.Language.load(join(dir, `tree-sitter-${grammar}.wasm`))));
  const parser = new ts.Parser();
  parser.setLanguage(await language);
  parsers.set(grammar, parser);
  return parser;
}

const clip = (s: string, max = 80): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const linesOf = (n: Node): number => n.endPosition.row - n.startPosition.row + 1;
const kids = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c !== null);

/** The declaration inside `export …`, a decorator or a template header. */
function unwrap(node: Node): Node {
  let n = node;
  for (let i = 0; i < 3; i++) {
    const inner = n.childForFieldName('declaration') ?? n.childForFieldName('definition');
    if (!inner) break;
    n = inner;
  }
  return n;
}

function nameOf(node: Node): string {
  const n = unwrap(node);
  const name = n.childForFieldName('name');
  if (name) return clip(name.text);
  if (/declaration|variable_statement|field/.test(n.type)) {
    const declarator = n.descendantsOfType('variable_declarator')[0];
    const inner = declarator?.childForFieldName('name') ?? declarator?.namedChild(0);
    if (inner) return clip(inner.text);
  }
  if (n.type === 'pair' || n.type === 'property_assignment') return clip(n.childForFieldName('key')?.text ?? '');
  if (n.type === 'expression_statement') {
    const e = n.namedChild(0);
    if (e?.type === 'assignment_expression' || e?.type === 'assignment') return clip(e.childForFieldName('left')?.text ?? '', 60);
    if (e?.type === 'call_expression' || e?.type === 'call') {
      const callee = clip(e.childForFieldName('function')?.text ?? '', 50);
      const first = e.childForFieldName('arguments')?.namedChild(0);
      // `describe('…')`, `test('…')`, `app.get('/path')`: the string says which one.
      return first && /string/.test(first.type) && first.text.length < 70 ? `${callee}(${first.text})` : callee.length < 50 ? callee : '';
    }
  }
  return '';
}

function kindOf(node: Node): Unit['kind'] {
  const n = unwrap(node);
  const type = n.type;
  if (/^import|^using_directive|^use_declaration|^package_clause|^extern_alias/.test(type)) return 'import';
  if (/method|constructor/.test(type)) return 'method';
  if (/function/.test(type)) return 'function';
  if (/class|impl_item|namespace|module/.test(type)) return 'class';
  if (/interface|type_alias|enum|struct|record|trait/.test(type)) return 'type';
  if (/declaration|variable_statement/.test(type) && n.descendantsOfType(['arrow_function', 'function_expression', 'function']).some((f) => f !== null && linesOf(f) >= linesOf(n) - 1)) return 'function';
  return 'code';
}

/**
 * The part of a long definition that holds its members: followed down while one child takes most of the lines (a
 * class's body, a function's block, the callback of an IIFE or of `describe`), until several children share them.
 */
function bodyOf(node: Node): Node | null {
  let n = node;
  for (let depth = 0; depth < 14; depth++) {
    const children = kids(n);
    const main = children.find((c) => linesOf(c) >= 0.6 * linesOf(n));
    if (main) n = main;
    else return children.length >= 2 ? n : null;
  }
  return null;
}

function split(node: Node, start: number, prefix: string, out: Unit[], depth: number): void {
  const end = node.endPosition.row;
  const name = nameOf(node);
  const full = name ? prefix + name : '';
  const unit: Unit = { start, end, name: full || prefix.replace(/\.$/, ''), kind: kindOf(node) };
  const body = end - start + 1 > MAX_LINES && depth < 8 ? bodyOf(node) : null;
  if (!body) {
    out.push(unit);
    return;
  }
  const members = kids(body);
  const first = members[0].startPosition.row;
  // The signature above the members stays with the first of them.
  if (first > start) out.push({ ...unit, end: first - 1 });
  collect(members, name ? `${full}.` : prefix, out, depth + 1);
}

function collect(children: Node[], prefix: string, out: Unit[], depth: number): void {
  let comment: { start: number; end: number } | null = null;
  const flush = () => {
    if (comment) out.push({ ...comment, name: prefix.replace(/\.$/, ''), kind: 'code' });
    comment = null;
  };
  for (const child of children) {
    if (/comment/.test(child.type)) {
      if (comment && child.startPosition.row - comment.end <= 1) comment.end = child.endPosition.row;
      else {
        flush();
        comment = { start: child.startPosition.row, end: child.endPosition.row };
      }
      continue;
    }
    // A comment right above a definition is its documentation: one piece.
    const attached = comment && child.startPosition.row - comment.end <= 1 ? comment.start : child.startPosition.row;
    if (attached === child.startPosition.row) flush();
    comment = null;
    split(child, attached, prefix, out, depth);
  }
  flush();
}

const SQL_OBJECT = /^\s*(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:(?:unique|materialized|temp|temporary|recursive|security|definer|invoker)\s+)*(function|procedure|table|view|policy|trigger|index|type|schema|extension|role|publication|sequence)\s+(?:concurrently\s+)?(?:if\s+(?:not\s+)?exists\s+)?("[^"]+"|[\w.]+)/i;

/** SQL cut at statements: a `;` outside strings, comments and `$tag$ … $tag$` bodies. */
function sqlUnits(text: string): Unit[] {
  const units: Unit[] = [];
  let row = 0;
  let startRow = -1;
  let statement = '';
  let i = 0;
  const push = () => {
    if (startRow < 0) return;
    const m = SQL_OBJECT.exec(statement.replace(/--[^\n]*\n/g, ''));
    units.push({ start: startRow, end: row, name: m ? `${m[1].toLowerCase()} ${m[2].replace(/"/g, '')}` : clip(statement.replace(/--[^\n]*/g, ''), 50), kind: 'sql' });
    startRow = -1;
    statement = '';
  };
  const until = (close: string, from: number, include: boolean): number => {
    const at = text.indexOf(close, from);
    return at < 0 ? text.length : include ? at + close.length : at;
  };
  while (i < text.length) {
    const c = text[i];
    if (startRow < 0 && !/\s/.test(c)) startRow = row;
    let stop = i + 1;
    if (c === '-' && text[i + 1] === '-') stop = until('\n', i, false);
    else if (c === '/' && text[i + 1] === '*') stop = until('*/', i + 2, true);
    else if (c === "'") stop = until("'", i + 1, true);
    else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 40))?.[0];
      if (tag) stop = until(tag, i + tag.length, true);
    }
    const piece = text.slice(i, stop);
    statement += piece;
    i = stop;
    if (c === ';') push();
    for (let p = 0; p < piece.length; p++) if (piece.charCodeAt(p) === 10) row++;
  }
  if (statement.trim()) push();
  return units;
}

function markdownUnits(lines: string[]): Unit[] {
  const units: Unit[] = [];
  let fence = false;
  let start = 0;
  let name = '';
  for (let row = 0; row <= lines.length; row++) {
    const line = lines[row] ?? '';
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^#{1,4}\s+(.*)/.exec(line);
    if (row === lines.length || heading) {
      if (row > start) units.push({ start, end: row - 1, name, kind: 'doc' });
      start = row;
      name = heading ? clip(heading[1]) : '';
    }
  }
  return units;
}

/** Small neighbours go together, a piece still too long is cut in overlapping windows. Imports are dropped. */
function pack(units: Unit[], lines: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  const emit = (start: number, end: number, symbol: string, kind: Chunk['kind']) => {
    while (start <= end && !lines[start]?.trim()) start++;
    while (end >= start && !lines[end]?.trim()) end--;
    if (end < start) return;
    const text = lines.slice(start, end + 1).join('\n');
    if (text.trim().length >= 12) chunks.push({ start: start + 1, end: end + 1, symbol, kind, text });
  };
  let group: Unit[] = [];
  const flush = () => {
    if (!group.length) return;
    const names = [...new Set(group.map((u) => u.name).filter(Boolean))];
    const kinds = new Set(group.map((u) => u.kind));
    emit(group[0].start, group[group.length - 1].end, clip(names.join(', '), 140), kinds.size === 1 ? (group[0].kind as Chunk['kind']) : 'code');
    group = [];
  };
  for (const unit of [...units].sort((a, b) => a.start - b.start)) {
    if (unit.kind === 'import') continue;
    const size = unit.end - unit.start + 1;
    if (size < SMALL) {
      if (group.length && unit.end - group[0].start + 1 > GROUP_MAX) flush();
      group.push(unit);
      continue;
    }
    flush();
    if (size <= MAX_LINES) {
      emit(unit.start, unit.end, unit.name, unit.kind);
      continue;
    }
    const step = WINDOW - OVERLAP;
    const count = Math.ceil((size - OVERLAP) / step);
    for (let w = 0; w < count; w++) {
      const from = unit.start + w * step;
      emit(from, Math.min(unit.end, from + WINDOW - 1), unit.name ? `${unit.name} (${w + 1}/${count})` : '', unit.kind);
    }
  }
  flush();
  return chunks;
}

const IMPORTS = /(?:\bfrom\s+|\brequire\(\s*|^\s*import\s+)['"]([^'"\n]+)['"]|^\s*(?:from|import)\s+([\w.]+)(?:\s+import\b|\s*$)|^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm;

export function importsOf(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(IMPORTS)) found.add(m[1] ?? m[2] ?? m[3]);
  return [...found].slice(0, 40);
}

function outline(chunks: Chunk[], lines: string[], imports: string[]): Chunk | null {
  if (lines.length < OUTLINE_FROM || chunks.length < 4) return null;
  const named = chunks.filter((c) => c.symbol);
  if (named.length < 3) return null;
  const rows = named.map((c) => `${c.symbol} L${c.start}-${c.end}`);
  const text = `${imports.length ? `imports: ${imports.join(', ')}\n` : ''}symbols:\n${rows.join('\n')}`.slice(0, OUTLINE_CHARS);
  return { start: 1, end: lines.length, symbol: '', kind: 'outline', text };
}

/**
 * A file as pieces to search: one function, method, class or type each where a grammar reads the language, SQL by
 * statement, Markdown by section, the rest by windows of lines. A long file also gets its outline.
 */
export async function chunkFile(path: string, text: string): Promise<Chunk[]> {
  const lines = text.split(/\r?\n/);
  const ext = extname(path).toLowerCase();
  let units: Unit[] | null = null;
  const grammar = GRAMMARS[ext];
  if (grammar) {
    try {
      const tree = (await parserFor(grammar)).parse(text);
      if (tree) {
        units = [];
        collect(kids(tree.rootNode), '', units, 0);
        tree.delete();
      }
    } catch {
      units = null; // a grammar that cannot be loaded leaves the file to the windows
    }
  } else if (ext === '.sql') units = sqlUnits(text);
  else if (ext === '.md' || ext === '.mdx') units = markdownUnits(lines);
  units ??= [{ start: 0, end: lines.length - 1, name: '', kind: 'code' }];
  const chunks = pack(units, lines);
  const top = outline(chunks, lines, importsOf(text));
  return top ? [top, ...chunks] : chunks;
}
