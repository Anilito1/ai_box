import { ATTACH_LIMITS, type ImageInput, type ImageType } from '../shared/types';
import { t } from './i18n';

// A long edge the model reads in full (larger images are downscaled anyway).
const MAX_EDGE = 2000;

export interface Attachment {
  image: ImageInput;
  url: string;
}

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error(t('img.readFailed')));
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

/** A pasted, dropped or picked image, kept as is when the API accepts it, else downscaled and re-encoded. */
export async function toAttachment(file: Blob): Promise<Attachment> {
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
