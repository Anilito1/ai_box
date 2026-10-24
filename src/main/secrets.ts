import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';

export type SecretName = 'anthropicApiKey' | 'githubToken';
const NAMES: SecretName[] = ['anthropicApiKey', 'githubToken'];

/**
 * Secrets encrypted with the OS keychain (DPAPI, Keychain, libsecret/kwallet) through Electron's safeStorage, in
 * secrets.json. Never stored in clear: without a real keychain (Linux "basic_text" backend) nothing is saved. The
 * values are decrypted once at start and never leave the main process, except as environment variables of the
 * processes that need them.
 */
export class Secrets {
  private readonly file: string;
  private values: Partial<Record<SecretName, string>> = {};
  private usable = false;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'secrets.json');
  }

  async load(): Promise<void> {
    this.usable = (await safeStorage.isAsyncEncryptionAvailable()) && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    if (!this.usable || !existsSync(this.file)) return;
    let stale = false;
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const name of NAMES) {
        const v = stored[name];
        if (typeof v !== 'string' || !v) continue;
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(v, 'base64'));
        this.values[name] = result;
        stale ||= shouldReEncrypt;
      }
    } catch {
      // Unreadable, or encrypted under another OS account: treated as absent, the user enters them again.
      this.values = {};
    }
    if (stale) await this.write();
  }

  available(): boolean {
    return this.usable;
  }

  get(name: SecretName): string {
    return this.values[name] ?? '';
  }

  has(name: SecretName): boolean {
    return this.get(name) !== '';
  }

  async set(name: SecretName, value: string | null): Promise<void> {
    if (value !== null && !this.usable) throw new Error('no-keychain');
    if (value === null) delete this.values[name];
    else this.values[name] = value;
    await this.write();
  }

  private async write(): Promise<void> {
    const stored: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.values)) stored[k] = (await safeStorage.encryptStringAsync(v)).toString('base64');
    writeFileSync(`${this.file}.tmp`, JSON.stringify(stored), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
