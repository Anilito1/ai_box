import type { HubApi, RepoCommit, RepoStatus, RepoTree, SessionView } from '../shared/types';
import { ago, displayName, h, icon, ICONS, openMenu } from './dom';

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
/** `dir` is `root` or a folder inside it. */
const within = (dir: string, root: string) => norm(dir) === norm(root) || norm(dir).startsWith(`${norm(root)}\\`);

/** Compact counters of a checkout: behind / ahead of its base, local changes, conflicts. */
function chips(t: RepoTree, main: boolean): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (t.error) return [h('span', 'chip danger', 'illisible')];
  if (t.conflicts) out.push(h('span', 'chip danger', plural(t.conflicts, 'conflit')));
  if (t.behind) out.push(h('span', main ? 'chip warn' : 'chip', `↓${t.behind}`));
  if (t.ahead) out.push(h('span', 'chip accent', `↑${t.ahead}`));
  if (t.changes - t.conflicts > 0) out.push(h('span', 'chip', `●${t.changes - t.conflicts}`));
  if (out.length === 0 && main) out.push(h('span', 'chip ok', t.base ? '✓' : 'sans remote'));
  return out;
}

const chipTitle = (t: RepoTree) =>
  [
    t.base ? `comparé à ${t.base}` : 'sans branche de référence',
    t.behind ? `${t.behind} commit${t.behind > 1 ? 's' : ''} à récupérer` : '',
    t.ahead ? `${t.ahead} commit${t.ahead > 1 ? 's' : ''} pas encore sur ${t.base}` : '',
    t.changes ? plural(t.changes, 'fichier modifié') : '',
  ]
    .filter(Boolean)
    .join(' · ');

/** A main repo at the bottom of the sidebar: its main folder and every worktree, with the workers active in each. */
export class RepoPanel {
  readonly root = h('div', 'side-repo');
  private status: RepoStatus | null = null;
  private workers: SessionView[] = [];
  private readonly name = h('span', 'repo-name');
  private readonly refresh = h('button', 'icon-btn repo-refresh');
  private readonly trees = h('div', 'repo-trees');
  private readonly foot = h('div', 'repo-foot');

  constructor(private readonly hub: HubApi) {
    this.refresh.title = 'Vérifier maintenant (git fetch)';
    this.refresh.setAttribute('aria-label', this.refresh.title);
    this.refresh.append(icon(ICONS.resume));
    this.refresh.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.status) this.hub.refreshRepo(this.status.path);
    });
    const head = h('div', 'repo-head');
    head.append(h('span', 'dot'), icon(ICONS.branch), this.name, this.foot, this.refresh);
    this.root.append(head, this.trees);
    this.root.addEventListener('click', () => this.openDetails());
    // Relative times ("vérifié il y a 40 s") keep aging between two updates.
    window.setInterval(() => this.renderFoot(), 10_000);
  }

  update(status: RepoStatus): void {
    this.status = status;
    this.render();
  }

  /** Workers running in this repo's folders, shown next to the checkout they work in. */
  setWorkers(sessions: SessionView[]): void {
    const workers = sessions.filter((s) => s.role === 'worker' && s.status !== 'exited');
    const key = (list: SessionView[]) => list.map((s) => `${s.name}@${s.cwd}`).join('|');
    if (key(workers) === key(this.workers)) return;
    this.workers = workers;
    this.render();
  }

  /** Each worker counts once, in the deepest checkout holding its folder (a worktree may sit inside the main folder). */
  private workersIn(path: string): string[] {
    const trees = this.status?.trees ?? [];
    const home = (cwd: string) =>
      trees.filter((t) => within(cwd, t.path)).reduce<RepoTree | null>((best, t) => (!best || t.path.length > best.path.length ? t : best), null);
    return this.workers.filter((s) => home(s.cwd)?.path === path).map(displayName);
  }

  private render(): void {
    const st = this.status;
    if (!st) return;
    const main = st.trees[0];
    const state = st.error || main?.error || main?.conflicts ? 'error' : main?.behind ? 'behind' : main?.ahead || main?.changes ? 'local' : 'ok';
    this.root.className = `side-repo ${state}`;
    this.root.title = `${st.path} · clic pour le détail`;
    this.name.textContent = st.name;
    this.refresh.classList.toggle('spinning', st.fetching || st.pulling);

    if (st.error) {
      this.trees.replaceChildren(h('div', 'repo-error', st.error));
    } else {
      // A worktree with nothing to land, no local change and no worker is noise here; the details list it.
      const [first, ...worktrees] = st.trees;
      const live = worktrees.filter((t) => t.ahead || t.changes || t.error || this.workersIn(t.path).length > 0);
      const rows = [...(first ? [this.treeRow(first, true)] : []), ...live.map((t) => this.treeRow(t, false))];
      const idle = worktrees.length - live.length;
      if (idle > 0) rows.push(h('div', 'repo-more', `+ ${plural(idle, 'worktree')} sans travail en cours`));
      this.trees.replaceChildren(...rows);
    }
    this.renderFoot();
  }

  private treeRow(t: RepoTree, main: boolean): HTMLElement {
    const row = h('div', main ? 'repo-tree main' : 'repo-tree');
    const text = h('div', 'repo-tree-text');
    if (!main) text.append(h('span', 'repo-label', t.label));
    text.append(h('span', 'repo-branch-name', t.error ? t.error : t.branch));
    const badges = h('div', 'repo-badges');
    badges.append(...chips(t, main));
    badges.title = chipTitle(t);
    row.append(text, badges);
    const workers = this.workersIn(t.path);
    if (workers.length > 0) row.append(h('div', 'repo-workers', `↳ ${workers.join(', ')}`));
    row.title = `${t.path}\n${t.branch}${t.base ? ` → ${t.base}` : ''}`;
    return row;
  }

  private renderFoot(): void {
    const st = this.status;
    if (!st) return;
    const state = st.pulling
      ? 'mise à jour…'
      : st.pullError
        ? `pull refusé : ${st.pullError}`
        : st.fetching
          ? 'vérification…'
          : st.fetchError
            ? 'fetch en échec'
            : st.fetchedAt
              ? ago(st.fetchedAt)
              : '';
    this.foot.textContent = state;
    this.foot.className = st.pullError || st.fetchError ? 'repo-foot error' : 'repo-foot';
    this.foot.title = st.pullError || st.fetchError;
  }

  private openDetails(): void {
    const st = this.status;
    if (!st) return;
    openMenu(this.root, (menu, close) => {
      const title = h('div', 'repo-pop-title');
      title.append(icon(ICONS.branch), h('b', '', st.name), h('span', '', st.path));
      menu.append(title);
      if (st.error) {
        menu.append(h('div', 'menu-note error', st.error));
        return;
      }
      const main = st.trees[0];
      if (main && main.behind > 0 && main.ahead === 0 && main.conflicts === 0 && !main.error && !main.branch.startsWith('détachée')) {
        const pull = h('button', 'menu-row');
        const label = h('span', 'menu-text');
        label.append(
          h('span', 'menu-title', `Mettre à jour ${main.branch} (${plural(main.behind, 'commit')})`),
          h('span', 'menu-hint', `git pull --ff-only depuis ${main.base} · refusé par git si ça écraserait des modifs`),
        );
        pull.append(icon(ICONS.resume), label);
        pull.addEventListener('click', () => {
          this.hub.pullRepo(st.path);
          close();
        });
        menu.append(pull, h('div', 'menu-sep'));
      }
      st.trees.forEach((t, i) => this.treeDetails(menu, t, i === 0));
      const note = st.fetchError
        ? `Fetch en échec : ${st.fetchError}`
        : st.fetchedAt
          ? `Remote vérifié ${ago(st.fetchedAt)} · auto toutes les minutes`
          : 'Remote pas encore vérifié';
      menu.append(h('div', 'menu-sep'), h('div', st.fetchError ? 'menu-note error' : 'menu-note', note));
    });
  }

  private treeDetails(menu: HTMLElement, t: RepoTree, main: boolean): void {
    const head = h('div', 'menu-label repo-pop-tree');
    head.append(h('span', '', main ? 'Dossier principal' : t.label), h('span', 'repo-pop-branch', `${t.branch}${t.base ? ` → ${t.base}` : ''}`));
    menu.append(head);
    if (t.error) {
      menu.append(h('div', 'menu-note error', t.error));
      return;
    }
    const workers = this.workersIn(t.path);
    if (workers.length > 0) menu.append(h('div', 'menu-note', `Workers ici : ${workers.join(', ')}`));
    if (t.behind) this.commits(menu, `À récupérer · ${t.behind}`, t.incoming, t.behind);
    if (t.ahead) this.commits(menu, `Pas encore sur ${t.base} · ${t.ahead}`, t.outgoing, t.ahead);
    if (!t.behind && !t.ahead && t.head) this.commits(menu, '', [t.head], 1);
    if (t.changes) {
      menu.append(h('div', 'repo-sub', `Modifications locales · ${t.changes}`));
      for (const f of t.files) {
        const row = h('div', 'repo-row');
        row.append(h('span', `repo-code${f.code === 'UU' ? ' danger' : ''}`, f.code), h('span', 'repo-path', f.path));
        row.title = f.path;
        menu.append(row);
      }
      if (t.changes > t.files.length) menu.append(h('div', 'menu-note', `… et ${t.changes - t.files.length} autres`));
    }
  }

  private commits(menu: HTMLElement, label: string, commits: RepoCommit[], total: number): void {
    if (label) menu.append(h('div', 'repo-sub', label));
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
