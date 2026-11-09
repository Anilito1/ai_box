import { LOCAL_FILE_PREFIX, localFilePath } from '../shared/localFiles';
/** Only finished assistant messages; code blocks remain copyable code. */
export function decorateLocalFiles(body: HTMLElement, cwd: string, hint: string): void {
  for (const code of body.querySelectorAll('code')) {
    if (code.closest('pre, a')) continue;
    const value = code.textContent ?? '';
    if (!/^(?:\/|[a-z]:[\\/]|\.\.?[\\/])/i.test(value)) continue;
    const path = localFilePath(value);
    if (path === null) continue;
    const a = document.createElement('a');
    a.setAttribute('href', LOCAL_FILE_PREFIX + encodeURIComponent(path));
    code.replaceWith(a);
    a.append(code);
  }
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest('a, pre, code')) texts.push(node);
  }
  for (const node of texts) {
    // Bare paths have no whitespace; use Markdown links or inline code for names containing spaces.
    const pattern = /(?:^|(?<=\s))((?:\/(?!\/)|[a-z]:[\\/]|\.\.?[\\/])[^\s<>"`]+)(?=$|\s)/gi;
    const fragment = document.createDocumentFragment();
    let end = 0;
    for (const match of (node.textContent ?? '').matchAll(pattern)) {
      const value = match[1].replace(/[.,;!)]*$/, '');
      const path = localFilePath(value);
      if (!path) continue;
      fragment.append(node.textContent!.slice(end, match.index));
      const a = document.createElement('a');
      a.textContent = value;
      a.setAttribute('href', LOCAL_FILE_PREFIX + encodeURIComponent(path));
      fragment.append(a);
      end = match.index! + value.length;
    }
    if (end) {
      fragment.append(node.textContent!.slice(end));
      node.replaceWith(fragment);
    }
  }
  for (const a of body.querySelectorAll<HTMLAnchorElement>('a')) {
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith(LOCAL_FILE_PREFIX)) continue;
    let path: string;
    try { path = decodeURIComponent(href.slice(LOCAL_FILE_PREFIX.length)); } catch { continue; }
    const absolute = /^(?:\/|[a-z]:[\\/])/i.test(path) ? path : `${cwd}/${path}`;
    a.title = `${absolute}\n${hint}`;
    a.setAttribute('aria-label', `${a.textContent}: ${absolute}. ${hint}`);
  }
}
