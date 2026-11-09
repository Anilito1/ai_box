// The user's fine-grained GitHub token for the checks outside the app, as the app's keychain would give it: the one
// handed over for the remote server (%LOCALAPPDATA%\aibox-vps\gh-personal.dpapi, this Windows account's), else
// AIBOX_GH_TOKEN. Never this PC's GitHub CLI token nor a classic one: they reach every repo of the account.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPersonalGithubToken } from '../../src/shared/vps';

function handed(): string {
  const file = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'aibox-vps', 'gh-personal.dpapi') : '';
  if (process.platform !== 'win32' || !file || !existsSync(file)) return '';
  const ps = `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${file.replace(/'/g, "''")}'), $null, 'CurrentUser'))`;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim();
  } catch {
    // Another Windows account's, or damaged: the environment's is tried.
    return '';
  }
}

export function personalToken(): string {
  const token = [handed(), process.env.AIBOX_GH_TOKEN ?? ''].find(isPersonalGithubToken);
  if (!token) throw new Error('no fine-grained GitHub token (github_pat_…): hand one over for the remote server, or set AIBOX_GH_TOKEN to one');
  return token;
}
