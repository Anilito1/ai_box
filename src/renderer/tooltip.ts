import { h } from './dom';

// One tooltip for the whole window, in the hub's own style, for every element with a title: it shows after a short
// rest of the pointer, then at once while the pointer moves on to the next control. The title steps aside while
// shown (or Chromium would draw its own tooltip too) and comes back when the pointer leaves.
const SHOW_MS = 550;
const WARM_MS = 700;
const GAP = 6;

const tip = h('div', 'tooltip');
tip.setAttribute('role', 'tooltip');
let target: HTMLElement | null = null;
let timer = 0;
let warmUntil = 0;

/** A title rewritten while its element is hovered (a status that changed) steps aside too, and updates the tooltip. */
const rewritten = new MutationObserver(() => {
  const text = target?.getAttribute('title');
  if (!target || text == null) return;
  target.removeAttribute('title');
  if (text === target.dataset.tip) return; // Rewritten unchanged, as renders do: nothing to move.
  target.dataset.tip = text;
  if (tip.classList.contains('open') && text) {
    tip.textContent = text;
    place(target);
  }
});

function place(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const ht = tip.offsetHeight;
  const below = r.bottom + GAP + ht <= window.innerHeight - 4;
  const left = Math.min(window.innerWidth - w - 6, Math.max(6, r.left + r.width / 2 - w / 2));
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(below ? r.bottom + GAP : r.top - GAP - ht)}px)`;
}

function show(el: HTMLElement): void {
  const text = el.dataset.tip ?? '';
  if (!text || !el.isConnected) return;
  tip.textContent = text;
  if (!tip.isConnected) document.body.append(tip);
  place(el);
  tip.classList.add('open');
}

function release(): void {
  window.clearTimeout(timer);
  rewritten.disconnect();
  if (target) {
    if (!target.hasAttribute('title') && target.dataset.tip) target.setAttribute('title', target.dataset.tip);
    delete target.dataset.tip;
    if (tip.classList.contains('open')) warmUntil = performance.now() + WARM_MS;
  }
  target = null;
  tip.classList.remove('open');
}

document.addEventListener('pointerover', (e) => {
  // Still over the element shown (its title is away: closest() would skip it for an ancestor).
  if (target?.contains(e.target as Node)) return;
  const el = (e.target as Element | null)?.closest?.<HTMLElement>('[title]');
  if (el === target || (!el && !target)) return;
  release();
  const text = el?.getAttribute('title');
  if (!el || !text) return;
  target = el;
  el.dataset.tip = text;
  el.removeAttribute('title');
  rewritten.observe(el, { attributes: true, attributeFilter: ['title'] });
  timer = window.setTimeout(() => show(el), performance.now() < warmUntil ? 0 : SHOW_MS);
});
document.addEventListener('pointerout', (e) => {
  if (target && !target.contains(e.relatedTarget as Node | null)) release();
});
/** A click, a key or a scroll puts the tooltip away until the pointer reaches another control. */
function dismiss(): void {
  window.clearTimeout(timer);
  tip.classList.remove('open');
}
for (const type of ['pointerdown', 'keydown', 'wheel'] as const) document.addEventListener(type, dismiss, { capture: true, passive: true });
window.addEventListener('blur', dismiss);
