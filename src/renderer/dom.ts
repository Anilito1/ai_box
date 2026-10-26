import type { SessionView } from '../shared/types';
import { t } from './i18n';

export const displayName = (s: SessionView) =>
  s.role === 'master' ? t('master') : s.instance?.post ? `${s.instance.post} · ${s.instance.topic}` : s.name.replace(/^hub-/, '');

/** Closed on an error (its last start or run failed), not closed on purpose. */
export const failed = (s: SessionView) => s.status === 'exited' && s.error !== '';
/** A permanent worker with nothing to do: closed on purpose, a message wakes it. */
export const asleep = (s: SessionView) => s.post !== null && s.status === 'exited' && s.error === '';
/** The state's word, with "stopped on an error" for a failed session and "asleep" for a resting permanent one. */
export const statusLabel = (s: SessionView) => (failed(s) ? t('status.failed') : asleep(s) ? t('status.asleep') : t(`status.${s.status}`));
/** Class of its status dot. */
export const statusDot = (s: SessionView) => `dot s-${failed(s) ? 'failed' : s.status}`;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function icon(path: string, cls = 'ico'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', cls);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

export const ICONS = {
  stop: 'M4.5 4.5h7v7h-7z',
  resume: 'M3.5 8a4.5 4.5 0 1 0 1.4-3.3M4.5 2.5v2.4h2.4',
  remove: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  send: 'M8 13V3M3.5 7.5L8 3l4.5 4.5',
  chevron: 'M4.5 6.5L8 10l3.5-3.5',
  check: 'M3.5 8.5l3 3 6-7',
  shield: 'M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z',
  branch: 'M6.5 3.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M6.5 12.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M12.5 5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M5 5v6M11 6.5c0 2.5-6 1.5-6 4.5',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  attach: 'M10.5 5.5l-4.3 4.3a1.4 1.4 0 0 0 2 2l4.6-4.6a2.8 2.8 0 0 0-4-4L4.2 7.8a4.2 4.2 0 0 0 6 6l3.3-3.3',
  fetch: 'M8 2.5v7M5 6.5l3 3 3-3M3 12.5h10',
  pull: 'M8 2.5v10M4 8.5l4 4 4-4',
  push: 'M8 13.5v-10M4 7.5l4-4 4 4',
  sync: 'M12.8 9.5A5 5 0 0 1 3.6 10.6M3.2 6.5a5 5 0 0 1 9.2-1.1M12.6 2.5v3h-3M3.4 13.5v-3h3',
  publish: 'M5 12.5H4.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.8-.6 2.9 2.9 0 0 1 .1 6.6H11M8 8v6M6 10l2-2 2 2',
  plus: 'M8 3.5v9M3.5 8h9',
  minus: 'M3.5 8h9',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  tag: 'M2.5 2.5h5.2l5.8 5.8-5.2 5.2-5.8-5.8zM5.5 5.5h.01',
  cloud: 'M4.5 12.5h7a2.6 2.6 0 0 0 .3-5.2 4 4 0 0 0-7.6-1.1A3.2 3.2 0 0 0 4.5 12.5z',
  target: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
  external: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4',
  undo: 'M5.5 3.5l-3 3 3 3M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7',
  filter: 'M2.5 3.5h11l-4.3 5v4.5l-2.4 1V8.5z',
  gear:
    'M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6M8 4.6a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 1 0 0-6.8M8 5.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4',
  up: 'M8 12.5v-9M4.5 7L8 3.5L11.5 7',
  down: 'M8 3.5v9M4.5 9L8 12.5L11.5 9',
  edit: 'M10.5 3l2.5 2.5l-7 7H3.5V10z',
  moon: 'M12.5 9.6A5 5 0 0 1 6.4 3.5a5 5 0 1 0 6.1 6.1z',
  info: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 7.5v3.5M8 5.2h.01',
  user: 'M8 2.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4',
};

/** Icon button copying `text()` to the clipboard, with a brief check mark as feedback. */
export function copyButton(text: () => string, label = t('copy')): HTMLButtonElement {
  const btn = h('button', 'icon-btn copy-btn');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.append(icon(ICONS.copy));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(text()).then(() => {
      btn.replaceChildren(icon(ICONS.check));
      btn.classList.add('done');
      window.setTimeout(() => {
        btn.replaceChildren(icon(ICONS.copy));
        btn.classList.remove('done');
      }, 1200);
    });
  });
  return btn;
}

/** The raw words behind an error (git's, the system's), folded under "Details" with a copy button: never in the sentence shown. */
export function techDetails(raw: string): HTMLDetailsElement {
  const box = h('details', 'tech-details');
  const copy = copyButton(() => raw, t('details.copy'));
  copy.classList.add('tech-copy');
  box.append(h('summary', '', t('details')), h('pre', '', raw), copy);
  return box;
}

/** A short error sentence for the user, with its technical detail folded under it when there is one. */
export function errorNote(cls: string, text: string, raw = ''): HTMLDivElement {
  const note = h('div', `${cls} error`);
  note.append(h('span', '', text));
  if (raw) note.append(techDetails(raw));
  return note;
}

/** A folder as the interface names it: its last part (the full path stays in a tooltip). */
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Full-size view of an image; closes on click or Escape. */
export function openLightbox(src: string): void {
  const overlay = h('div', 'lightbox');
  const img = h('img');
  img.src = src;
  overlay.append(img);
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
}

export const fmtCost = (v: number | undefined) => (v === undefined ? '—' : `$${v.toFixed(2)}`);
export const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}%`);
export const fmtTokens = (v: number) => (v >= 1_000_000 ? `${+(v / 1_000_000).toFixed(1)}M` : `${Math.round(v / 1000)}k`);
export const level = (pct: number | null | undefined) => (pct == null ? '' : pct >= 85 ? 'danger' : pct >= 65 ? 'warn' : '');
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 10) return t('ago.now');
  if (s < 60) return t('ago.s', { n: s });
  if (s < 3600) return t('ago.min', { n: Math.floor(s / 60) });
  if (s < 86_400) return t('ago.h', { n: Math.floor(s / 3600) });
  return t('ago.d', { n: Math.floor(s / 86_400) });
}

/** Popover anchored above a button (`below`: under it); closes on outside click, Escape or window blur. */
export function openMenu(anchor: HTMLElement, build: (menu: HTMLElement, close: () => void) => void, below = false): void {
  const menu = document.getElementById('menu') as HTMLDivElement;
  const close = () => {
    menu.hidden = true;
    menu.replaceChildren();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
  };
  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  menu.replaceChildren();
  build(menu, close);
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 12);
  menu.style.left = `${Math.max(12, left)}px`;
  // Never taller than the room on its side of the anchor: long contents scroll inside.
  menu.style.top = below ? `${r.bottom + 6}px` : '';
  menu.style.bottom = below ? '' : `${window.innerHeight - r.top + 6}px`;
  menu.style.maxHeight = `${Math.max(160, below ? window.innerHeight - r.bottom - 18 : r.top - 18)}px`;
  menu.classList.toggle('below', below);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
}
