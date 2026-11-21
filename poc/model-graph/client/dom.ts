// The page's few DOM helpers, in the manner of the hub's renderer.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

export function button(className: string, label: string, onClick: (event: MouseEvent) => void, title = ''): HTMLButtonElement {
  const el = h('button', className, label);
  el.type = 'button';
  if (title) el.title = title;
  el.addEventListener('click', onClick);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

/** The children that are there: what a conditional left out is dropped. */
export const present = (...children: (Node | string | null | undefined | false)[]): (Node | string)[] => children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);

export const usd = (n: number): string => (n > 0 && n < 0.001 ? '< 0,001 $' : `${n.toFixed(n < 0.1 ? 3 : 2).replace('.', ',')} $`);
export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
