import { join } from 'node:path';
import { builtStamp, sourceStamp } from '../../scripts/sourceStamp.mjs';
import { cleanEnv, run } from './updateExec';

// A hub run from source starts on its last build, whichever way it is opened (a shortcut runs `electron .`, not
// `npm start`): when the sources changed since (a `git pull`), it builds them and starts again on the new build.

/** Set for the start that follows a build: it never builds again, even if a file changed meanwhile. */
const REBUILT = 'AI_BOX_REBUILT';

export type SelfBuild = { kind: 'fresh' } | { kind: 'rebuilt' } | { kind: 'failed'; detail: string };

/** Builds the checkout at `root` when its build is older than its sources. Electron runs build.mjs as Node.js. */
export async function buildIfStale(root: string): Promise<SelfBuild> {
  const rebuilt = process.env[REBUILT] === '1';
  // Not passed on: a later restart of this hub checks again.
  delete process.env[REBUILT];
  if (rebuilt || builtStamp(root) === sourceStamp(root)) return { kind: 'fresh' };
  const r = await run(process.execPath, [join(root, 'build.mjs')], root, { ...cleanEnv(process.env), ELECTRON_RUN_AS_NODE: '1' }, 5 * 60_000);
  if (r.code !== 0) return { kind: 'failed', detail: r.out.trim().slice(-6000) };
  process.env[REBUILT] = '1';
  return { kind: 'rebuilt' };
}
