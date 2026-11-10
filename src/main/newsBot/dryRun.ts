import { mkdirSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NewsBotConfig, NewsBotStatus } from '../../shared/newsBot';
import { LocalStore } from './store';
import { NewsBotService } from './service';
import { fixtureFeeds } from './fixtures';
import { parseFeed } from './collect';
import { renderPremium, type Recipe } from './premium';
import type { Runner } from './media';
import type { Source, Story } from './model';
/** Fixture-only; no network branch, transport, credentials, publisher or free-text instructions. */
export async function dryRun(root: string, config: NewsBotConfig, run?: Runner): Promise<NonNullable<NewsBotStatus['lastReport']>> {
  const now = Date.now(); const folder = join(root, 'dry-run'); mkdirSync(folder, { recursive: true, mode: 0o700 });
  // Bounded retention: stop before accumulating another full batch; removal is explicit.
  if (readdirSync(folder).filter(name => lstatSync(join(folder, name)).isDirectory()).length > 64) throw new Error('BLOCKED_DRY_RUN_STORAGE');
  const store = new LocalStore(join(folder, 'news.sqlite')); const bot = new NewsBotService(store);
  const result: NonNullable<NewsBotStatus['lastReport']> = { drafts: 0, manifests: 0, qa: [], publication: 'BLOCKED_DRY_RUN' };
  try {
    store.prune(now); const game = config.games[0] ?? 'fixture-game';
    for (const brand of config.sources) {
      const source: Source = { id: brand, origin: brand, url: `https://${brand}.example.invalid/feed`, hosts: [`${brand}.example.invalid`], format: ['xbox', 'steam'].includes(brand) ? 'atom' : 'rss', primary: true, authenticated: true, editorialHistory: false, fixture: true, rights: { collect: true, summarize: true, llm: false, reference: 'synthetic-only', retainMs: 86_400_000, expiresAt: now + 86_400_000 } };
      const items = parseFeed(fixtureFeeds[brand], source, now); store.transaction(() => { for (const item of items.items) store.ingest(item); });
      bot.registerGame({ id: game, status: 'ACTIVE', identityVerified: true, sourceIds: [brand], addedAt: now, expiresAt: null });
      const story: Story = { id: `fixture-${brand}`, gameId: game, revision: 1, eventAt: now, observedAt: now, claims: [{ id: `claim-${brand}`, text: items.items[0].title, contradiction: false, rumor: false, evidence: [{ sourceId: brand, itemId: items.items[0].id, excerpt: items.items[0].title, verifiedAt: now, ownVerification: true }] }], novelty: 20, official: true, relevantEvent: false, ttlMs: 900_000, fixture: true, topic: 'gaming-product' };
      const prepared = bot.prepare(story, [source], items.items, { windows: [], engagement: { q: null, posts: 0, origins: 0, minimumHistory: 0 }, activity: null }, now);
      writeFileSync(join(folder, `${brand}-draft.json`), JSON.stringify(prepared, null, 2)); result.drafts++;
      for (const recipe of ['Flash', 'Patch', 'Dossier', 'Radar'] as Recipe[]) for (const platform of ['x', 'tiktok'] as const) {
        const qa = await renderPremium(prepared.draft, platform, recipe, folder, undefined, run); result.manifests++;
        result.qa.push(...qa.checks.filter(c => c.state === 'BLOCKED').map(c => c.code));
      }
    }
    result.qa = [...new Set(result.qa)]; writeFileSync(join(folder, 'report.json'), JSON.stringify(result, null, 2)); return result;
  } finally { store.close(); }
}
