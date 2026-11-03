import { FILE_LIMITS, fileKind, fileLabel, formatSize, type AttachedFile, type FileInput, type FileKind } from '../shared/attachments';
import { ATTACH_LIMITS, type ImageInput, type ImageType } from '../shared/types';
import { h, icon } from './dom';
import { LANG, t } from './i18n';

// A long edge the model reads in full (larger images are downscaled anyway).
const MAX_EDGE = 2000;

/** An image the model reads inline, or any other file, which the session opens by its path. */
export type Attachment =
  | { kind: 'image'; image: ImageInput; url: string }
  | { kind: 'file'; name: string; size: number; type: FileKind; path: string; file: File };

/** One icon per kind of file (16 px grid, stroked like the others). */
export const FILE_ICONS: Record<FileKind, string> = {
  pdf: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8.5h4M6 10.5h4',
  doc: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8.5h4M6 10.5h4',
  text: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8.5h4M6 10.5h2.5',
  sheet: 'M3 3.5h10v9H3zM3 6.5h10M3 9.5h10M6.5 3.5v9',
  slides: 'M2.5 3.5h11v7h-11zM8 10.5v3M5.5 13.5h5',
  archive: 'M4 2.5h8v11H4zM8 2.5v1M8 4.5v1M8 6.5v1M7 8.5h2v2H7z',
  code: 'M6 4.5L2.5 8 6 11.5M10 4.5l3.5 3.5-3.5 3.5',
  data: 'M6 3c-1.5 0-1.5 1-1.5 2.5S4 7.5 3 8c1 .5 1.5 1 1.5 2.5S4.5 13 6 13M10 3c1.5 0 1.5 1 1.5 2.5S12 7.5 13 8c-1 .5-1.5 1-1.5 2.5S11.5 13 10 13',
  audio: 'M6 11.5V4l6-1.5V10M6 11.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M12 10a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0',
  video: 'M2.5 4.5h8v7h-8zM10.5 7l3-2v6l-3-2',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6h.01',
  other: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
};

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error(t('img.readFailed'))); // The browser's own message is English and technical.
    reader.readAsDataURL(blob);
  });
}

/** Format from the file's first bytes: Windows derives `File.type` from the extension, and the API rejects a mismatch. */
async function sniff(blob: Blob): Promise<ImageType | null> {
  const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Decoded straight from the bytes: an <img> on a blob: URL would be blocked by the page's CSP (img-src 'self' data:).
const decode = (file: Blob): Promise<ImageBitmap> => createImageBitmap(file).catch(() => Promise.reject(new Error(t('img.unreadable'))));

function encode(img: ImageBitmap, scale: number, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error(t('img.noCanvas')));
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff'; // JPEG has no alpha: transparent areas would turn black.
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('img.encodeFailed')))), type, 0.88));
}

/** An image, kept as is when the API accepts it, else downscaled and re-encoded. */
async function toImage(file: Blob): Promise<{ image: ImageInput; url: string }> {
  const img = await decode(file);
  const max = ATTACH_LIMITS.imageBytes;
  let blob: Blob = file;
  let type = await sniff(file);
  try {
    const edge = Math.max(img.width, img.height);
    if (!type || file.size > max || edge > MAX_EDGE) {
      const scale = Math.min(1, MAX_EDGE / edge);
      blob = await encode(img, scale, 'image/png');
      type = 'image/png';
      if (blob.size > max) {
        blob = await encode(img, scale, 'image/jpeg');
        type = 'image/jpeg';
      }
      if (blob.size > max) throw new Error(t('img.tooHeavy'));
    }
  } finally {
    img.close();
  }
  const data = await readBase64(blob);
  return { image: { mediaType: type, data }, url: `data:${type};base64,${data}` };
}

/** An image the app can hand the model (SVG is text, which the session reads better from the file). */
const looksLikeImage = async (file: File) => (file.type.startsWith('image/') && file.type !== 'image/svg+xml') || (!file.type && (await sniff(file)) !== null);

/**
 * A pasted, dropped or picked file: an image the model reads inline when the app can decode it, else (PDF, HEIC, an
 * archive, no extension...) a file the session opens by its path. Refused only when it has no path on disk and is too
 * large to travel as bytes.
 */
export async function toAttachment(file: File, pathOf: (file: File) => string): Promise<Attachment> {
  if (await looksLikeImage(file)) {
    try {
      return { kind: 'image', ...(await toImage(file)) };
    } catch {
      // Not one the app can decode or shrink enough (HEIC, a huge scan...): it goes as a file.
    }
  }
  const name = file.name || t('chat.pastedFile');
  const path = pathOf(file);
  if (!path && file.size > FILE_LIMITS.dataBytes) throw new Error(t('chat.fileTooHeavy', { name, max: formatSize(FILE_LIMITS.dataBytes, LANG) }));
  return { kind: 'file', name, size: file.size, type: fileKind(name, file.type), path, file };
}

/** What the main process gets for a file: its path, or its bytes when it has none (read only now, at sending). */
export async function fileInput(a: Extract<Attachment, { kind: 'file' }>): Promise<FileInput> {
  if (a.path) return { name: a.name, size: a.size, path: a.path };
  try {
    return { name: a.name, size: a.size, data: new Uint8Array(await a.file.arrayBuffer()) };
  } catch {
    throw new Error(t('chat.fileUnreadable', { name: a.name }));
  }
}

/** A file's chip: the icon of its kind, its name, its extension and size. Never opened from here: it is only shown. */
export function fileChip(file: AttachedFile, cls: string, kind = fileKind(file.name)): HTMLElement {
  const chip = h('div', cls);
  chip.dataset.kind = kind;
  chip.title = file.name;
  const meta = [fileLabel(file.name), file.size === undefined ? '' : formatSize(file.size, LANG)].filter(Boolean).join(' · ');
  const text = h('div', 'file-text');
  text.append(h('div', 'file-name', file.name));
  if (meta) text.append(h('div', 'file-meta', meta));
  chip.append(icon(FILE_ICONS[kind], 'ico file-ico'), text);
  return chip;
}
