import type { BatteryInfo, EnergyCaps } from '../main/energy/types';

/** Keeping the PC awake while workers run, lid closed included. */
export interface EnergySettings {
  /** No idle sleep while a worker works. */
  whileWorking: boolean;
  /** The lid can be closed while the PC is kept awake. */
  lidClosed: boolean;
  /** On battery at or under this percentage, the PC stops being kept awake and hibernates if nobody uses it. */
  batteryFloor: number;
}

export const ENERGY_DEFAULTS: EnergySettings = { whileWorking: true, lidClosed: false, batteryFloor: 15 };
export const BATTERY_FLOORS = [5, 10, 15, 20, 30, 50];
export const isBatteryFloor = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 5 && v <= 50;

/** What keeps the PC awake: workers at work, the user's own request, workers moving to or from the server. */
export type EnergyReason = 'workers' | 'manual' | 'move';

export interface EnergyView {
  /** Null while the system is asked, or where the module does not run. */
  caps: EnergyCaps | null;
  battery: BatteryInfo | null;
  /** The PC is kept awake now. */
  awake: boolean;
  /** And the lid can be closed. */
  lidClosed: boolean;
  reasons: EnergyReason[];
  /** The end of the user's own request, null for "until I stop it" (or none). */
  until: number | null;
  /** The battery guard ended it: nothing is kept awake again until the PC is plugged in or charged. */
  guard: boolean;
  error: string | null;
}
