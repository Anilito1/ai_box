/** Words that say a commit is on the remote; on a line with a commit id, the report claims it was pushed. */
const PUSHED = /(^|[^a-z])(push(ed)?|pouss[ée]e?s?|merg(ed|[ée]e?s?)|publi[ée]e?s?|published|sur (main|master|origin)|on (main|master|origin))(?![a-z])/i;
/** ...unless the line says the opposite. */
const NOT_PUSHED = /non pouss|pas (encore )?pouss|not (yet )?pushed|unpushed|en local|locally|local only|à pousser|to push/i;
/** A commit id: 7 to 40 hex characters, with a letter and a digit (a plain number or word is not one). */
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi;

/**
 * The commits a worker's report says are pushed: an id on a line that speaks of a push, a merge or the remote branch,
 * without saying it is not pushed. At most five, in order: the hub checks them on the remote before the master reads.
 */
export function announcedCommits(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!PUSHED.test(line) || NOT_PUSHED.test(line)) continue;
    for (const m of line.matchAll(SHA)) {
      const sha = m[0].toLowerCase();
      if (!out.includes(sha)) out.push(sha);
    }
  }
  return out.slice(0, 5);
}
