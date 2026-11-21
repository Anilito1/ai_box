import { LANG } from '../i18n';

// The Graphs view's few DOM helpers: an element with its children, a button, an SVG element.

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

export function button(className: string, label: string, onClick: (event: MouseEvent) => void, title = ''): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  if (title) {
    b.title = title;
    if (!label.trim() || label.length <= 2) b.setAttribute('aria-label', title);
  }
  b.addEventListener('click', onClick);
  return b;
}

const SVG = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** The children that are there: what a conditional left out is dropped. */
export const present = (...children: Child[]): (Node | string)[] => children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);

const decimal = (n: number, digits: number) => (LANG === 'fr' ? n.toFixed(digits).replace('.', ',') : n.toFixed(digits));
export const usd = (n: number): string => (n > 0 && n < 0.001 ? `< ${decimal(0.001, 3)} $` : `${decimal(n, n < 0.1 ? 3 : 2)} $`);
export const seconds = (ms: number): string => `${decimal(ms / 1000, 1)} s`;
