import { linuxEnergy } from './linux';
import type { EnergyDeps, EnergyPlatform } from './types';
import { win32Energy } from './win32';

export type { EnergyPlatform } from './types';
export { EnergyManager } from './manager';

/** This system's adapter; null where the module does not run (macOS). */
export function energyPlatform(deps: EnergyDeps, platform: NodeJS.Platform = process.platform): EnergyPlatform | null {
  if (platform === 'win32') return win32Energy(deps);
  if (platform === 'linux') return linuxEnergy(deps);
  return null;
}
