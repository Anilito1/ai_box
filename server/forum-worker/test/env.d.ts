import type { D1Migration } from 'cloudflare:test';

import type { Env as WorkerEnv } from '../src/index';

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import('../src/index');
    }
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
