import type { EnergyDeps, EnergyPlatform } from './types';

// Placeholder until the Linux adapter lands (hub-energy-linux replaces this file): nothing is held, and the settings
// say so.

export function linuxEnergy(_deps: EnergyDeps): EnergyPlatform {
  const none = async () => {
    throw new Error('energy: not available on Linux yet');
  };
  return {
    caps: async () => ({ platform: 'linux', holdAwake: false, lidClosedAwake: false, needsElevation: false, battery: false, displayOff: false, radios: false, notes: [] }),
    battery: none,
    hold: none,
    restoreLeftovers: async () => 0,
    displayOff: none,
    suspend: none,
  };
}
