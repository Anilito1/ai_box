import type { SessionView } from '../shared/types';

export const displayName = (s: SessionView) => (s.role === 'master' ? 'Maître' : s.name.replace(/^hub-/, ''));

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
};

/** Icon button copying `text()` to the clipboard, with a brief check mark as feedback. */
export function copyButton(text: () => string, label = 'Copier'): HTMLButtonElement {
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
  if (s < 10) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86_400)} j`;
}

/** Popover anchored above a button; closes on outside click, Escape or window blur. */
export function openMenu(anchor: HTMLElement, build: (menu: HTMLElement, close: () => void) => void): void {
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
  menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  // Never taller than the room above its anchor: long contents scroll inside.
  menu.style.maxHeight = `${Math.max(160, r.top - 18)}px`;
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
}
