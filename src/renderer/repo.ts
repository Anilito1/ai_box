import type { HubApi, RepoCommit, RepoStatus } from '../shared/types';
import { ago, h, icon, ICONS, openMenu } from './dom';

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Repo pinned at the bottom of the sidebar: branch, behind/ahead of its base, local changes, last commit. */
export class RepoPanel {
  private status: RepoStatus | null = null;
  private readonly name = h('span', 'repo-name');
  private readonly refresh = h('button', 'icon-btn repo-refresh');
  private readonly branch = h('div', 'repo-branch');
  private readonly chips = h('div', 'repo-chips');
  private readonly commit = h('div', 'repo-commit');
  private readonly foot = h('div', 'repo-foot');

  constructor(
    private readonly root: HTMLElement,
    private readonly hub: HubApi,
  ) {
    this.refresh.title = 'Vérifier maintenant (git fetch)';
    this.refresh.setAttribute('aria-label', this.refresh.title);
    this.refresh.append(icon(ICONS.resume));
    this.refresh.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hub.refreshRepo();
    });
    const head = h('div', 'repo-head');
    head.append(h('span', 'dot'), icon(ICONS.branch), this.name, this.refresh);
    root.append(head, this.branch, this.chips, this.commit, this.foot);
    root.addEventListener('click', () => this.openDetails());
    // Relative times ("vérifié il y a 40 s") keep aging between two updates.
    window.setInterval(() => this.render(), 10_000);
  }

  update(status: RepoStatus): void {
    this.status = status;
    this.render();
  }

  private render(): void {
    const st = this.status;
    if (!st) return;
    const state = st.error || st.conflicts ? 'error' : st.behind ? 'behind' : st.ahead || st.changes ? 'local' : 'ok';
    this.root.className = `side-repo ${state}`;
    this.root.title = st.path;
    this.name.textContent = st.name;
    this.refresh.classList.toggle('spinning', st.fetching);

    if (st.error) {
      this.branch.textContent = st.error;
      this.chips.replaceChildren();
      this.commit.textContent = '';
      this.foot.textContent = '';
      return;
    }

    this.branch.replaceChildren(h('span', 'repo-branch-name', st.branch));
    if (st.base) this.branch.append(h('span', 'repo-base', ` → ${st.base}`));

    const chips: HTMLElement[] = [];
    if (!st.base) chips.push(h('span', 'chip', 'sans remote'));
    else if (st.behind) chips.push(h('span', 'chip warn', `↓ ${st.behind} en retard`));
    else if (!st.ahead) chips.push(h('span', 'chip ok', '✓ À jour'));
    if (st.ahead) chips.push(h('span', 'chip accent', `↑ ${st.ahead} à pousser`));
    if (st.conflicts) chips.push(h('span', 'chip danger', plural(st.conflicts, 'conflit')));
    if (st.changes - st.conflicts > 0) chips.push(h('span', 'chip', `● ${plural(st.changes - st.conflicts, 'modif')}`));
    this.chips.replaceChildren(...chips);

    this.commit.replaceChildren();
    if (st.head) this.commit.append(h('span', 'repo-hash', st.head.hash), h('span', 'repo-subject', st.head.subject));
    this.commit.title = st.head?.subject ?? '';

    const fetchState = st.fetching ? 'vérification…' : st.fetchError ? 'fetch en échec' : st.fetchedAt ? `vérifié ${ago(st.fetchedAt)}` : '';
    this.foot.replaceChildren();
    if (st.head) this.foot.append(h('span', '', `${st.head.author} · ${ago(st.head.at)}`));
    if (fetchState) this.foot.append(h('span', st.fetchError ? 'repo-fetch error' : 'repo-fetch', fetchState));
    this.foot.title = st.fetchError;
  }

  private openDetails(): void {
    const st = this.status;
    if (!st) return;
    openMenu(this.root, (menu) => {
      const title = h('div', 'repo-pop-title');
      title.append(icon(ICONS.branch), h('b', '', st.name), h('span', '', `${st.branch}${st.base ? ` → ${st.base}` : ''}`));
      menu.append(title);
      if (st.error) {
        menu.append(h('div', 'menu-note', st.error));
        return;
      }
      if (st.behind) this.commits(menu, `À récupérer · ${st.behind}`, st.incoming, st.behind);
      if (st.ahead) this.commits(menu, `À pousser · ${st.ahead}`, st.outgoing, st.ahead);
      if (!st.behind && !st.ahead && st.head) this.commits(menu, 'Dernier commit', [st.head], 1);
      if (st.changes) {
        menu.append(h('div', 'menu-label', `Modifications locales · ${st.changes}`));
        for (const f of st.files) {
          const row = h('div', 'repo-row');
          row.append(h('span', `repo-code${f.code === 'UU' ? ' danger' : ''}`, f.code), h('span', 'repo-path', f.path));
          row.title = f.path;
          menu.append(row);
        }
        if (st.changes > st.files.length) menu.append(h('div', 'menu-note', `… et ${st.changes - st.files.length} autres`));
      }
      const note = st.fetchError
        ? `Fetch en échec : ${st.fetchError}`
        : st.fetchedAt
          ? `Remote vérifié ${ago(st.fetchedAt)} · auto toutes les minutes`
          : 'Remote pas encore vérifié';
      menu.append(h('div', 'menu-sep'), h('div', st.fetchError ? 'menu-note error' : 'menu-note', note));
    });
  }

  private commits(menu: HTMLElement, label: string, commits: RepoCommit[], total: number): void {
    menu.append(h('div', 'menu-label', label));
    for (const c of commits) {
      const row = h('div', 'repo-row');
      const text = h('span', 'repo-commit-text');
      text.append(h('span', 'repo-subject', c.subject), h('span', 'repo-meta', `${c.author} · ${ago(c.at)}`));
      row.append(h('span', 'repo-hash', c.hash), text);
      row.title = c.subject;
      menu.append(row);
    }
    if (total > commits.length) menu.append(h('div', 'menu-note', `… et ${total - commits.length} autres`));
  }
}
