import type { Effort, Mode } from '../../../shared/types';

// The hub's permission modes (Claude Code's) as Codex's approval policy and sandbox.

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export interface CodexPolicy {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  reviewer: 'user' | 'auto_review';
}

/**
 * default: everything outside the known-safe commands asks, edits stay in the workspace; acceptEdits: the model asks
 * when it judges it needs to; plan: nothing is written; auto: the approvals go to Codex's automatic reviewer;
 * dontAsk: nothing asks, the sandbox is the limit; bypass: no approval, no sandbox. A read-only session never writes,
 * whatever the mode.
 */
export function policyOf(mode: Mode | null, readOnly: boolean): CodexPolicy {
  const base = ((): CodexPolicy => {
    switch (mode ?? 'default') {
      case 'acceptEdits':
        return { approvalPolicy: 'on-request', sandbox: 'workspace-write', reviewer: 'user' };
      case 'plan':
        return { approvalPolicy: 'untrusted', sandbox: 'read-only', reviewer: 'user' };
      case 'auto':
        return { approvalPolicy: 'on-request', sandbox: 'workspace-write', reviewer: 'auto_review' };
      case 'dontAsk':
        return { approvalPolicy: 'never', sandbox: 'workspace-write', reviewer: 'user' };
      case 'bypassPermissions':
        return { approvalPolicy: 'never', sandbox: 'danger-full-access', reviewer: 'user' };
      default:
        return { approvalPolicy: 'untrusted', sandbox: 'workspace-write', reviewer: 'user' };
    }
  })();
  return readOnly ? { ...base, sandbox: 'read-only' } : base;
}

/** The sandbox as a turn takes it (an object), with the folders a post adds. */
export function sandboxPolicy(sandbox: SandboxMode, roots: string[]): Record<string, unknown> {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false };
  return { type: 'workspaceWrite', writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

const ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The effort a model takes: the one asked, else the highest it takes below it (then the lowest above). */
export function clampEffort(asked: Effort, supported: string[]): Effort | null {
  const ok = ORDER.filter((e) => supported.includes(e));
  if (ok.length === 0 || ok.includes(asked)) return ok.length === 0 ? null : asked;
  const below = ok.filter((e) => ORDER.indexOf(e) < ORDER.indexOf(asked));
  return below.length > 0 ? below[below.length - 1] : ok[0];
}
