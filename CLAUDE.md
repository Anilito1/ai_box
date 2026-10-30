# claude-hub (AI Box)

Electron + TypeScript. `npm run typecheck`, `npm test`, `npm run build` must be green before a merge.

## Release notes

A change users can see adds one short French line, for users (no file, commit or jargon), at the top of
`docs/notes-de-version.md` under `### Ajouté`, `### Modifié` or `### Supprimé` of a `## AAAA-MM-JJ` entry; the app shows
the lines it has not shown yet at the next start. Never reword a published line (it would show again). `npm run notes`
drafts them from the commits since the file last changed; `npm test` checks the file.

## Checking the UI

`npm test` also starts the built app, isolated, for the composer's keyboard path (`src/renderer/dictation.test.ts`).

Use `npm run ui`, never the installed app and never its data folder. It builds if needed, starts an isolated instance
(Playwright's Electron support, temporary user-data-dir in /tmp, removed at the end), runs the steps, and quits.
Steps are chained with `+` so the app starts once (about 2.5 s, then each step is instant):

```
npm run ui -- snapshot @scripts/ui-fixtures/providers.json + click .cbtn-model + shot /tmp/menu.png --width 1100 --height 700
npm run ui -- fit .composer 360 + check-overflow .composer-bar + shot /tmp/narrow.png --selector .composer
npm run ui -- --help                      # every step
```

- Output is a few lines on purpose; keep it that way: `text`/`eval` for facts, `check-overflow <sel>` for layout bugs
  (lists the descendants outside the box), `count`. Take a capture only when a fact cannot answer, and open the file
  (Read) only then; shoot `--selector` rather than the full window. Captures are CSS-size (1x).
- `fit <sel> <px>` sets the width of a pane (the window content = that + the ~380 px sidebar); `size`/`--width` set the window.
- Fake states, no code change: `snapshot <json|@file>` merges keys (`sessions`, `topics`, `providers`, `models`, `accounts`...)
  into the hub snapshot; `send hub:items '[id, items, true]'` fills a conversation; `mock <channel> <json>` then `reload`
  answers an invoke channel (`providers:state`, `settings:get`...). `--config '{...}'` adds settings. See `scripts/ui-fixtures/`.
- Selectors: look in `src/renderer/*.ts` (`h('div', 'composer-box')`) rather than dumping the DOM.
- The window is moved off screen: it does not take over the desktop. `--show` keeps it in place.
