/** What a file attachment is, for its icon and label: the model gets its path whatever the kind. */
export type FileKind = 'pdf' | 'doc' | 'sheet' | 'slides' | 'archive' | 'code' | 'data' | 'text' | 'audio' | 'video' | 'image' | 'other';

export const FILE_LIMITS = {
  /** Copied into the hub's folder up to this size; a larger file is referenced where it is (a copy would block the app). */
  copyBytes: 50 * 1024 * 1024,
  /** A file without a path on disk (pasted from the clipboard) travels as bytes: each one, and all of a message's. */
  dataBytes: 50 * 1024 * 1024,
  dataTotalBytes: 100 * 1024 * 1024,
} as const;

/** A file attached to a message, from the renderer: its path on disk, or its bytes when it has none. */
export interface FileInput {
  name: string;
  size: number;
  path?: string;
  data?: Uint8Array;
}

/** A file attached to a sent message, as the conversation shows it (the size is unknown once read back from a transcript). */
export interface AttachedFile {
  name: string;
  size?: number;
}

const KINDS: [FileKind, string[]][] = [
  ['pdf', ['pdf']],
  ['doc', ['doc', 'docx', 'odt', 'rtf', 'pages']],
  ['sheet', ['xls', 'xlsx', 'xlsm', 'ods', 'numbers']],
  ['slides', ['ppt', 'pptx', 'odp', 'key']],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']],
  ['data', ['csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'sql', 'ipynb', 'parquet', 'db', 'sqlite']],
  ['text', ['txt', 'md', 'log', 'ini', 'cfg', 'env']],
  ['audio', ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus', 'wma']],
  ['video', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv']],
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff', 'svg', 'ico', 'psd', 'raw', 'cr2', 'nef', 'dng']],
  ['code', ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'ps1', 'bat', 'cmd', 'html', 'css', 'scss', 'vue', 'svelte', 'lua', 'dart']],
];

/** The extension, lower case, without the dot ('' when there is none, or for a dotfile like ".env"). */
export function extensionOf(name: string): string {
  const m = /\.([^.\\/]+)$/.exec(name);
  return m && m.index > 0 ? m[1].toLowerCase() : '';
}

/** From the extension, else the MIME type the system gives. */
export function fileKind(name: string, mime = ''): FileKind {
  const ext = extensionOf(name);
  const found = KINDS.find(([, exts]) => exts.includes(ext));
  if (found) return found[0];
  if (mime === 'application/pdf') return 'pdf';
  const top = mime.split('/')[0];
  if (top === 'image' || top === 'audio' || top === 'video') return top;
  if (top === 'text') return 'text';
  return 'other';
}

/** The short label next to a file's size: its extension, or nothing when it has none. */
export const fileLabel = (name: string) => extensionOf(name).toUpperCase().slice(0, 6);

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * A name safe to write in the attachments folder, close to the original: no folder part (nothing can climb out of the
 * folder), no character Windows refuses, no device name, at most 120 characters with the extension kept.
 */
export function safeFileName(name: string): string {
  let base = name.split(/[\\/]/).pop() ?? '';
  base = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim();
  if (!base) return 'fichier';
  if (RESERVED.test(base)) base = `_${base}`;
  if (base.length > 120) {
    const ext = extensionOf(base);
    const keep = ext && ext.length <= 16 ? `.${ext}` : '';
    base = `${base.slice(0, 120 - keep.length).trimEnd()}${keep}`;
  }
  return base;
}

/** "2,4 Mo" / "2.4 MB". */
export function formatSize(bytes: number, lang: 'fr' | 'en'): string {
  const units = lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go'] : ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  const digits = u === 0 || n >= 10 ? 0 : 1;
  return `${n.toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: digits })} ${units[u]}`;
}

const isAbsolutePath = (p: string) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p);

/**
 * Files from the renderer, or null when any is malformed or over the limits: a name, and either an absolute path or
 * the bytes of a file that has none. `room`: how many attachments the message may still carry beside its images.
 */
export function parseFiles(value: unknown, room: number): FileInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > room) return null;
  const files: FileInput[] = [];
  let total = 0;
  for (const v of value) {
    const { name, size, path, data } = (v ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name || name.length > 1024) return null;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
    if (typeof path === 'string' && data === undefined) {
      if (path.length > 4096 || !isAbsolutePath(path) || path.includes('\0')) return null;
      files.push({ name, size, path });
    } else if (data instanceof Uint8Array && path === undefined) {
      total += data.byteLength;
      if (data.byteLength > FILE_LIMITS.dataBytes || total > FILE_LIMITS.dataTotalBytes) return null;
      files.push({ name, size: data.byteLength, data });
    } else {
      return null;
    }
  }
  return files;
}
