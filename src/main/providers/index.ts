import { claudeAdapter } from './claude/adapter';
import type { HarnessId, ProviderAdapter } from './types';

const ADAPTERS: Partial<Record<HarnessId, ProviderAdapter>> = { claude: claudeAdapter };

/** The adapter of a harness; a harness the hub has no adapter for (yet) is an error, never a silent Claude. */
export function adapterFor(harness: HarnessId): ProviderAdapter {
  const adapter = ADAPTERS[harness];
  if (!adapter) throw new Error(`No adapter for ${harness}`);
  return adapter;
}
