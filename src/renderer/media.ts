import { formatSize } from '../shared/attachments';
import { LOCAL_FILE_PREFIX } from '../shared/localFiles';
import { mediaType, remoteMedia, type MediaResult, type MediaSaveResult } from '../shared/media';
import { FILE_ICONS } from './attachments';
import { h, icon, ICONS, openLightbox } from './dom';
import { LANG, t } from './i18n';

/** What a conversation gives its media: main's answers for its session, and where an error is said. */
export interface MediaHost {
  resolve(path: string): Promise<MediaResult>;
  remote(url: string): Promise<MediaResult>;
  save(url: string): Promise<MediaSaveResult>;
  reveal(url: string): Promise<boolean>;
  openExternal(url: string): void;
  error(text: string): void;
}
type Shown = Extract<MediaResult, { ok: true }>;

/** The blocks a link sits in: alone in one, its card takes its place; in a sentence, the card follows the block. */
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote';
/** Web addresses the user chose to see here, kept while the hub runs: shown again when the conversation is redrawn. */
const shownRemote = new Set<string>();
/** Cards a message shows at most: a list of hundreds of files stays a list. */
const PER_MESSAGE = 40;

/**
 * The images and videos a finished message links to, shown in place: a local file once main allows it (a missing,
 * outside or unknown one stays a link), a web one as a card that loads nothing before a click. Each file once.
 */
export function decorateMedia(body: HTMLElement, host: MediaHost): void {
  const seen = new Set<string>();
  for (const a of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    let local: string | null = null;
    if (href.startsWith(LOCAL_FILE_PREFIX)) {
      try {
        local = decodeURIComponent(href.slice(LOCAL_FILE_PREFIX.length));
      } catch {
        continue;
      }
    }
    const remote = local === null ? remoteMedia(href) : null;
    if ((local === null || !mediaType(local)) && !remote) continue;
    const key = local ?? href;
    if (seen.has(key)) continue;
    if (seen.size >= PER_MESSAGE) break;
    seen.add(key);
    const slot = slotFor(a, body);
    if (local !== null) {
      void host
        .resolve(local)
        .then((r) => (r.ok ? slot.fill(mediaCard(r, host)) : slot.cancel()))
        .catch(() => slot.cancel());
    } else slot.fill(remoteCard(href, remote!, host));
  }
}

/**
 * Where a link's card goes, kept in the order of the message whatever order main answers in. Nothing moves before the
 * answer: a link whose file cannot be shown stays as it was.
 */
function slotFor(a: HTMLAnchorElement, body: HTMLElement): { fill(card: HTMLElement): void; cancel(): void } {
  const block = a.closest<HTMLElement>(BLOCK);
  const inBody = block && body.contains(block) ? block : null;
  const rest = ((inBody ?? a.parentElement)?.textContent ?? '').replace(a.textContent ?? '', '').replace(/[\s:.,;!?()[\]\-–—→]+/g, '');
  const alone = !rest;
  const slot = h('div', 'media-slot');
  // Alone: the whole paragraph gives way (no card inside a <p>); in a list item or a cell, the link alone.
  const replaced: Element = alone ? (inBody?.tagName === 'P' ? inBody : a) : a;
  if (alone) replaced.before(slot);
  else if (inBody && /^(?:LI|TD|TH)$/.test(inBody.tagName)) inBody.append(slot);
  else {
    let after: Element = inBody ?? a;
    while (after.nextElementSibling?.classList.contains('media-slot')) after = after.nextElementSibling;
    after.after(slot);
  }
  return {
    fill(card) {
      if (alone) replaced.remove();
      slot.replaceWith(card);
    },
    cancel: () => slot.remove(),
  };
}

function button(label: string, path: string, cls = 'btn small ghost'): HTMLButtonElement {
  const b = h('button', cls);
  b.type = 'button';
  // Its words hide in a narrow card (styles.css): the name stays in its tooltip and for screen readers.
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(path), h('span', '', label));
  return b;
}

/** A shown image or video, its name and size, and what to do with it: save a copy, open its folder (a local file). */
export function mediaCard(m: Shown, host: MediaHost, web?: string): HTMLElement {
  const card = h('figure', `media media-${m.kind}`);
  const label = m.kind === 'video' ? t('media.video', { name: m.name }) : t('media.image', { name: m.name });
  let view: HTMLImageElement | HTMLVideoElement;
  if (m.kind === 'video') {
    const video = h('video', 'media-view');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    // Saved by the card's button, through main: Chromium's own download would bypass the "Save as" it asks.
    video.setAttribute('controlslist', 'nodownload');
    video.setAttribute('aria-label', label);
    video.src = m.url;
    view = video;
  } else {
    const img = h('img', 'media-view');
    img.alt = label;
    img.title = t('chat.enlarge');
    img.loading = 'lazy';
    img.src = m.url;
    img.addEventListener('click', () => openLightbox(m.url));
    view = img;
  }
  view.addEventListener('error', () => {
    view.replaceWith(h('div', 'media-broken', t(web ? 'media.remoteFailed' : 'media.unplayable')));
    card.classList.add('broken');
  });
  const bar = h('figcaption', 'media-bar');
  const meta = h('span', 'media-text');
  meta.title = m.name;
  meta.append(h('span', 'media-name', m.name));
  if (m.size !== null) meta.append(h('span', 'media-meta', formatSize(m.size, LANG)));
  else if (web) meta.append(h('span', 'media-meta', hostOf(web)));
  const save = button(t('media.download'), ICONS.fetch);
  save.title = `${t('media.download')} · ${t('media.downloadHint')}`;
  save.addEventListener('click', () => {
    save.disabled = true;
    void host
      .save(m.url)
      .then((r) => {
        if (r.ok) {
          save.replaceChildren(icon(ICONS.check), h('span', '', t('media.saved')));
          window.setTimeout(() => save.replaceChildren(icon(ICONS.fetch), h('span', '', t('media.download'))), 1800);
        } else if (r.error !== 'canceled') host.error(t(r.error === 'missing' ? 'media.missing' : 'media.saveFailed'));
      })
      .catch(() => host.error(t('media.saveFailed')))
      .finally(() => (save.disabled = false));
  });
  bar.append(meta, save);
  if (web) {
    const open = button(t('media.openBrowser'), ICONS.external);
    open.addEventListener('click', () => host.openExternal(web));
    bar.append(open);
  } else {
    const reveal = button(t('media.reveal'), ICONS.folder);
    reveal.addEventListener('click', () => {
      void host.reveal(m.url).then((ok) => ok || host.error(t('media.missing')), () => host.error(t('media.missing')));
    });
    bar.append(reveal);
  }
  card.append(view, bar);
  return card;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * A web image or video: its site and name, nothing loaded. "Show here" has main fetch it (https only), since loading it
 * tells the site the user's address; the browser stays one click away.
 */
function remoteCard(href: string, found: NonNullable<ReturnType<typeof remoteMedia>>, host: MediaHost): HTMLElement {
  const card = h('div', 'media media-remote');
  card.dataset.kind = found.kind;
  const head = h('div', 'media-remote-head');
  head.append(icon(FILE_ICONS[found.kind], 'ico media-kind'), h('span', 'media-name', found.name), h('span', 'media-meta', found.host));
  head.title = href;
  const note = h('div', 'media-remote-note', t(found.secure ? 'media.remoteNote' : 'media.remoteInsecure'));
  const bar = h('div', 'media-bar');
  const show = () => {
    load.disabled = true;
    void host
      .remote(href)
      .then((r) => {
        if (!r.ok) {
          host.error(t(r.error === 'unsupported' ? 'media.remoteRefused' : 'media.remoteFailed'));
          load.disabled = false;
          return;
        }
        shownRemote.add(href);
        card.replaceWith(mediaCard(r, host, href));
      })
      .catch(() => {
        host.error(t('media.remoteFailed'));
        load.disabled = false;
      });
  };
  const load = button(t('media.show'), FILE_ICONS[found.kind], 'btn small');
  load.hidden = !found.secure;
  load.addEventListener('click', show);
  const open = button(t('media.openBrowser'), ICONS.external);
  open.addEventListener('click', () => host.openExternal(href));
  bar.append(load, open);
  card.append(head, note, bar);
  if (found.secure && shownRemote.has(href)) queueMicrotask(show);
  return card;
}
