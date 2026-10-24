import { clawdStage } from './stage';

// Loaded after the first paint (clawd/load.ts): hands the stage to the main bundle.
window.hubClawdStage = clawdStage;
