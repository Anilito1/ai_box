import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FILE_LIMITS, safeFileName, type AttachedFile, type FileInput } from '../shared/attachments';

/** Published paths never expire: transcripts and handoff notes retain them indefinitely.
 * Admission, rather than eviction, bounds storage. Existing installations above the cap are read-only.
 * These limits include captures and legacy copies, but cannot recover legacy external paths/deleted copies.
 */
export const ATTACHMENT_STORAGE = { bytes: 1024 ** 3, entries: 10_000, pendingAgeMs: 86_400_000 } as const;
const PENDING = /^\.pending-[0-9a-f-]{36}$/;

export class AttachmentLimitError extends Error {
  constructor(readonly reason: 'quota' | 'size') {
    super(reason === 'quota' ? 'Attachment storage full (1 GiB or 10,000 entries); no saved attachment was deleted.' : 'Attachment exceeds the copy size limit; no external reference was sent.');
  }
}

export class AttachmentStore {
  constructor(readonly dir: string) {}

  /** Only abandoned, unpublished staging folders expire. Never delete published or legacy paths. */
  prune(now = Date.now()): void {
    mkdirSync(this.dir, { recursive: true });
    for (const name of readdirSync(this.dir)) {
      if (!PENDING.test(name)) continue;
      const path = join(this.dir, name);
      try {
        if (now - lstatSync(path).mtimeMs > ATTACHMENT_STORAGE.pendingAgeMs) rmSync(path, { recursive: true, force: true });
      } catch { /* Retry on the next admission/startup; failed cleanup still counts against quota. */ }
    }
  }

  private usage(): { bytes: number; entries: number } {
    let bytes = 0;
    let entries = 0;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const st = lstatSync(path);
        entries++;
        // Do not follow links out of the store or silently undercount unknown contents.
        if (st.isSymbolicLink()) throw new Error('Unexpected symbolic link in attachment storage');
        if (st.isDirectory()) walk(path);
        else bytes += st.size;
      }
    };
    walk(this.dir);
    return { bytes, entries };
  }

  save(file: FileInput, maxBytes = FILE_LIMITS.copyBytes as number): Required<AttachedFile> {
    this.prune();
    let source: number | undefined;
    let stage: string | undefined;
    try {
      if (file.path) {
        // Reject devices/FIFOs before opening. O_NONBLOCK closes the stat/open FIFO race on POSIX;
        // Windows does not expose POSIX FIFOs or O_NONBLOCK, but still gets both regular-file checks.
        if (!statSync(file.path).isFile()) throw new Error('Not a regular file');
        source = openSync(file.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      }
      const before = source === undefined ? undefined : fstatSync(source);
      if (before && !before.isFile()) throw new Error('Not a regular file');
      if (source === undefined && !file.data) throw new Error('Missing attachment data');
      const size = before?.size ?? file.data!.byteLength;
      if (size > maxBytes) throw new AttachmentLimitError('size');
      const usage = this.usage();
      if (usage.bytes + size > ATTACHMENT_STORAGE.bytes || usage.entries + 2 > ATTACHMENT_STORAGE.entries) throw new AttachmentLimitError('quota');
      const id = randomUUID();
      stage = join(this.dir, `.pending-${id}`);
      mkdirSync(stage);
      const name = safeFileName(file.name);
      const dest = openSync(join(stage, name), 'wx');
      try {
        // Read at most the measured size + 1: a changing source cannot grow the store past quota.
        if (source !== undefined) {
          const buffer = Buffer.alloc(Math.min(size + 1, 1024 * 1024));
          let copied = 0;
          while (copied <= size) {
            const n = readSync(source, buffer, 0, Math.min(buffer.length, size + 1 - copied), null);
            if (!n) break;
            copied += n;
            if (copied > size) throw new Error('Attachment changed while copying');
            this.write(dest, buffer.subarray(0, n));
          }
          const after = fstatSync(source);
          if (copied !== size || after.size !== size || after.mtimeMs !== before!.mtimeMs) throw new Error('Attachment changed while copying');
        } else this.write(dest, file.data!);
        fsyncSync(dest);
      } finally { closeSync(dest); }
      const published = join(this.dir, id);
      this.syncDirectory(stage);
      renameSync(stage, published);
      // Still unpublished to the caller: failure to sync removes only this new copy.
      stage = published;
      this.syncDirectory(this.dir);
      this.syncDirectory(dirname(this.dir));
      stage = undefined;
      return { name: file.name, size, path: join(published, name) };
    } finally {
      if (source !== undefined) closeSync(source);
      if (stage) rmSync(stage, { recursive: true, force: true });
    }
  }

  /** Node cannot flush directories on Windows; some filesystems reject directory fsync.
   * On those platforms the file is synced but metadata persistence across power loss depends on
   * the OS/filesystem. Real I/O errors on supported platforms fail admission, never report success.
   */
  private syncDirectory(path: string): void {
    if (process.platform === 'win32') return;
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      fsyncSync(fd);
    } catch (err) {
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private write(fd: number, bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const n = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (!n) throw new Error('Could not write attachment');
      offset += n;
    }
  }
}
