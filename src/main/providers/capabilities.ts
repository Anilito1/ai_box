import type { HarnessId, Mode } from '../../shared/types';
import type { LaunchSpec } from './types';

/** What the adapter can control. A provider mode or a tool filter is not an OS sandbox. */
export interface ProviderCapabilities {
  permissions: {
    write: 'tool-filter' | 'provider-mode' | 'provider-sandbox' | 'unknown';
    network: 'unsupported' | 'provider-sandbox' | 'unknown';
    roots: 'workspace-hint' | 'provider-sandbox' | 'unknown';
    approvals: 'provider-mode' | 'unknown';
    unsupportedModes: readonly Mode[];
  };
  commands: 'discovered' | 'unknown';
  compaction: 'native' | 'unknown';
  subagents: 'native' | 'unsupported' | 'unknown';
  transport: 'sdk' | 'acp-stdio' | 'app-server' | 'unknown';
}

/** Deliberately conservative until an adapter has verified its own protocol contract. */
export const PROVIDER_CAPABILITIES: Readonly<Record<HarnessId, ProviderCapabilities>> = {
  claude: {
    permissions: { write: 'tool-filter', network: 'unsupported', roots: 'workspace-hint', approvals: 'provider-mode', unsupportedModes: [] },
    commands: 'discovered', compaction: 'native', subagents: 'native', transport: 'sdk',
  },
  gemini: {
    permissions: { write: 'provider-mode', network: 'unsupported', roots: 'workspace-hint', approvals: 'provider-mode', unsupportedModes: ['dontAsk'] },
    commands: 'discovered', compaction: 'native', subagents: 'unsupported', transport: 'acp-stdio',
  },
  codex: {
    permissions: { write: 'provider-sandbox', network: 'provider-sandbox', roots: 'provider-sandbox', approvals: 'provider-mode', unsupportedModes: [] },
    commands: 'unknown', compaction: 'native', subagents: 'unknown', transport: 'app-server',
  },
};

export type PolicySpec = Pick<LaunchSpec, 'mode' | 'readOnly' | 'cwd' | 'extraDirs' | 'readDirs'>;

export interface EffectivePolicy {
  requested: { mode: Mode | null; readOnly: boolean; roots: string[] };
  effective: {
    /** The native mode acknowledged by the provider, not a guessed translation. */
    mode: string | null;
    write: 'unknown' | 'tool-filtered' | 'provider-controlled' | 'provider-sandbox' | 'unrestricted';
    network: 'unknown' | 'restricted' | 'unrestricted';
    /** Null: the adapter has no evidence of a filesystem boundary. */
    roots: string[] | null;
    approvals: 'unknown' | 'provider-controlled';
    sandbox?: string;
    approvalPolicy?: string;
    reviewer?: string;
  };
  status: 'pending' | 'applied' | 'partial' | 'refused';
  limitations: string[];
}

/** No requested constraint becomes effective just because a launch flag was sent. */
export function policyOf(harness: HarnessId, spec: PolicySpec, acknowledgedMode?: string): EffectivePolicy {
  const acknowledged = acknowledgedMode !== undefined;
  const limitations = ['Workspace directories do not establish a filesystem sandbox.', 'Network isolation is not enforced by this adapter.'];
  if (spec.readOnly) limitations.push(harness === 'claude'
    ? 'Read-only filters Edit, Write and NotebookEdit; Bash, MCP and other tools are not guaranteed read-only.'
    : 'The provider plan mode is not a filesystem sandbox; external tools are not guaranteed read-only.');
  return {
    requested: { mode: spec.mode, readOnly: spec.readOnly, roots: [spec.cwd, ...spec.extraDirs, ...spec.readDirs] },
    effective: {
      mode: acknowledgedMode ?? null,
      write: !acknowledged ? 'unknown' : harness === 'claude' && spec.readOnly ? 'tool-filtered' : 'provider-controlled',
      network: 'unknown', roots: null,
      approvals: acknowledged ? 'provider-controlled' : 'unknown',
    },
    status: !acknowledged ? 'pending' : spec.readOnly ? 'partial' : 'applied',
    limitations,
  };
}

/** A rejected change keeps the last acknowledged policy and the failed request separately. */
export function refusedPolicy(previous: EffectivePolicy, requested: EffectivePolicy['requested'], reason: string): EffectivePolicy {
  return { requested, effective: previous.effective, status: 'refused', limitations: [...previous.limitations, reason] };
}

/** Partial means acknowledged provider controls with disclosed isolation limits, never an unacknowledged mode. */
export function requireAppliedPolicy(policy: EffectivePolicy | undefined): void {
  if (policy && ((policy.status !== 'applied' && policy.status !== 'partial') || policy.effective.mode === null || policy.effective.write === 'unknown' || policy.effective.approvals === 'unknown')) {
    throw new Error(`Provider permission policy was not applied (${policy.status}): ${policy.limitations.join(' ')}`);
  }
}
