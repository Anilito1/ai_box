import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

import { TEST_ADMIN_HASH } from './test/credentials';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: { ADMIN_TOKEN_HASH: TEST_ADMIN_HASH, IP_SALT: 'test-salt', TEST_MIGRATIONS: await readD1Migrations('./migrations') },
      },
    })),
  ],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
});
