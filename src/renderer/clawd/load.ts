import { onPresence, presence } from '../presence';
import type { Stage } from './stage';

declare global {
  interface Window {
    hubClawdStage?: () => Promise<Stage | null>;
  }
}

let script: Promise<boolean> | null = null;

/**
 * three.js and the model come in their own file, fetched once the hub is drawn and idle: setting up the stage takes the
 * main thread for a moment, which must not delay the first paint nor the first clicks.
 */
function load(): Promise<boolean> {
  return (script ??= new Promise((resolve) => {
    requestIdleCallback(() => inject(resolve), { timeout: 1500 });
  }));
}

function inject(resolve: (ok: boolean) => void): void {
  const el = document.createElement('script');
  el.src = 'clawd.js';
  el.addEventListener('load', () => resolve(true));
  el.addEventListener('error', () => resolve(false));
  document.head.append(el);
}

let watched: Stage | null = null;

/** The shared stage, or null when WebGL, the model or its file is unavailable (the avatars then keep their SVG). */
export async function clawdStage(): Promise<Stage | null> {
  const stage = (await load()) && window.hubClawdStage ? await window.hubClawdStage() : null;
  if (stage && stage !== watched) {
    watched = stage;
    const show = () => stage.setPresence(!presence.focused, presence.onBattery);
    onPresence(show);
    show();
  }
  return stage;
}
