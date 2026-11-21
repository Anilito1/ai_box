/**
 * Whether a blob of Electron's safeStorage was encrypted with Chromium's fixed Linux key ("v10" there): what Linux
 * falls back to when no keychain answers, even under a keychain backend's name. Such a blob is as good as clear. A
 * keychain's key (libsecret, kwallet) gives "v11"; on Windows and macOS "v10" is the system's own key.
 */
export function fixedKeyBlob(blob: Uint8Array, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' && Buffer.from(blob.subarray(0, 3)).toString('latin1') === 'v10';
}
