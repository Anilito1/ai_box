export interface NewsBotConfig {
  enabled: boolean; scheduler: boolean; intervalMs: number; network: false;
  publishers: { x: false; tiktok: false }; sources: ('playstation' | 'xbox' | 'nintendo' | 'steam')[];
  games: string[];
}
export interface NewsBotStatus {
  config: NewsBotConfig; running: boolean; busy: boolean; cycles: number;
  lastReport: { drafts: number; manifests: number; qa: string[]; publication: 'BLOCKED_DRY_RUN' } | null;
  logs: { at: number; code: string }[];
}
export type NewsBotAction = 'state' | 'configure' | 'start' | 'stop' | 'dry-run';
