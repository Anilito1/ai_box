import { LocalStore } from './store';
import { draftStory, type Traction } from './editorial';
import { publication } from './publish';
import { initialGames, type Game, type Platform, type Source, type SourceItem, type Story } from './model';
/** No app startup hook, scheduler, IPC or credentials. Caller owns an isolated data directory. */
export class NewsBotService {
  constructor(readonly store: LocalStore) {}
  registerGame(game: Game): void { this.store.put('game', game.id, game); }
  prepare(story: Story, sources: Source[], items: SourceItem[], traction: Traction, now: number, destinations: { platform: Platform; account: string }[] = []) {
    const game = this.store.get<Game>('game', story.gameId) ?? { id: story.gameId, status: 'WATCH', identityVerified: false, sourceIds: [], addedAt: now, expiresAt: null } as Game;
    const result = draftStory(story, game, sources, items, traction, now);
    this.store.transaction(() => {
      this.store.put('story', story.id, story, result.draft.expiresAt); this.store.put('draft', result.draft.id, result, result.draft.expiresAt);
      if (!result.gate) for (const destination of destinations) this.store.enqueue(publication(result.draft, destination.platform, destination.account));
    });
    return result;
  }
  seed(now: number): void { this.store.transaction(() => { for (const id of initialGames) if (!this.store.get('game', id)) this.registerGame({ id, status: 'WATCH', identityVerified: false, sourceIds: [], addedAt: now, expiresAt: null }); }); }
}
export * from './model';
export * from './collect';
export * from './editorial';
export * from './store';
export * from './publish';
export * from './media';
export * from './metrics';
