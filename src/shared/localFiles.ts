/** Renderer hints are untrusted; only the main process authorizes a path. */
export type LocalFileResult = { ok: true } | { ok: false; error: 'invalid' | 'outside' | 'missing' | 'unsupported' | 'failed' };
export const LOCAL_FILE_PREFIX = '#ai-box-file=';
export function localFilePath(href: string): string | null {
  if (!href || href.length > 8192 || /[\x00-\x1f\x7f]/.test(href) || href.startsWith('#')) return null;
  // A drive-qualified local path is allowed; URLs, UNC/network shares and drive-relative paths are not.
  if (/^(?:[a-z][a-z0-9+.-]*:|[\\]{2}|\/\/)/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return null;
  // Source links may carry a line/column or a Markdown fragment; neither is a filename.
  return href.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '');
}
