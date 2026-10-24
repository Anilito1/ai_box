import type {
  CommitDetails,
  CommitFile,
  GitRefKind,
  GraphFilter,
  HubApi,
  RepoAction,
  RepoActionKind,
  RepoActionResult,
  RepoBranch,
  RepoErrorKind,
  RepoFile,
  RepoGraph,
  RepoState,
  RepoStatus,
  RepoTree,
  SessionView,
} from '../shared/types';
import { ago, copyButton, displayName, h, icon, ICONS, openMenu } from './dom';
import {
  BASE_REF_COLOR,
  cssColor,
  getHistoryItemIndex,
  INCOMING_ID,
  OUTGOING_ID,
  REF_COLOR,
  REMOTE_REF_COLOR,
  renderGraph,
  renderGraphPlaceholder,
  toViewModels,
  type GraphNode,
  type HistoryItemViewModel,
  type HistoryRef,
} from './graph';

const PAGE = 50;
const HOVER_DELAY_MS = 450;
const MIN_HEIGHT = 120;

const L = {
  noRepo: 'Aucun dépôt suivi',
  pickRepo: 'Choisir le dépôt affiché',
  auto: 'Auto',
  autoHint: 'Suit le worker ouvert, sinon le premier dépôt',
  mainFolder: 'dossier principal',
  detached: (oid: string) => `HEAD détachée ${oid}`,
  noCommit: 'aucun commit',
  unreadable: 'illisible',
  fetch: 'Fetch : récupérer les nouveautés du remote',
  pull: 'Pull : intégrer les commits du remote',
  push: 'Push : envoyer les commits locaux',
  more: "Plus d'actions",
  collapse: 'Replier le panneau',
  expand: 'Déplier le panneau',
  resize: 'Glisser pour redimensionner',
  sync: 'Synchroniser',
  syncHint: (behind: number, ahead: number, upstream: string) => `Synchroniser avec ${upstream} : pull de ${behind}, puis push de ${ahead}`,
  publish: 'Publier la branche',
  publishHint: 'Pousser la branche vers le remote et la suivre',
  switchBranch: 'Changer de branche',
  newBranch: 'Créer une branche…',
  branchFilter: 'Filtrer, ou nom de la nouvelle branche',
  createBranch: (name: string) => `Créer « ${name} » depuis HEAD`,
  localBranches: 'Branches',
  remoteBranches: 'Branches distantes',
  inWorktree: (folder: string) => `ouverte dans ${folder}`,
  current: 'branche courante',
  loading: 'Chargement…',
  abort: { merge: 'Annuler le merge', rebase: 'Annuler le rebase', 'cherry-pick': 'Annuler le cherry-pick', revert: 'Annuler le revert' },
  state: {
    merge: 'Merge en cours : résous les conflits, indexe les fichiers puis committe.',
    rebase: 'Rebase en cours : résous les conflits ou annule-le.',
    'cherry-pick': 'Cherry-pick en cours : résous les conflits ou annule-le.',
    revert: 'Revert en cours : résous les conflits ou annule-le.',
  },
  commitPlaceholder: (branch: string) => `Message (Ctrl+Entrée : commit sur ${branch})`,
  commit: 'Commit',
  commitAll: 'Commit (tout)',
  commitAllHint: 'Rien n’est indexé : tous les changements seront committés',
  commitPush: 'Commit & Push',
  commitOptions: 'Options de commit',
  emptyMessage: 'Écris un message de commit',
  changes: 'Changements',
  conflicts: 'Conflits',
  staged: 'Indexés',
  unstaged: 'Modifications',
  stage: 'Indexer',
  unstage: 'Retirer de l’index',
  stageAll: 'Tout indexer',
  unstageAll: 'Tout retirer de l’index',
  noChanges: 'Aucun changement local',
  truncated: (shown: number, total: number) => `${shown} sur ${total} affichés`,
  graph: 'Graphe',
  filterTitle: 'Branches affichées',
  filters: { auto: 'Auto', all: 'Toutes' } as Record<GraphFilter, string>,
  filterHints: {
    auto: 'Branche courante, upstream, base et branches des worktrees',
    all: 'Toutes les branches locales et distantes, et les tags',
  } as Record<GraphFilter, string>,
  loadMore: 'Charger plus…',
  noHistory: 'Aucun commit',
  incoming: 'Changements entrants',
  outgoing: 'Changements sortants',
  files: (n: number) => (n > 1 ? `${n} fichiers modifiés` : `${n} fichier modifié`),
  insertions: (n: number) => (n > 1 ? `${n} insertions(+)` : `${n} insertion(+)`),
  deletions: (n: number) => (n > 1 ? `${n} suppressions(-)` : `${n} suppression(-)`),
  binary: 'binaire',
  copyHash: 'Copier le hash',
  openWeb: 'Ouvrir sur le web',
  fetchedAgo: (when: string) => `vérifié ${when}`,
  fetchFailed: 'fetch en échec',
  workers: (names: string) => `↳ ${names}`,
  busy: {
    fetch: 'Fetch…',
    pull: 'Pull…',
    push: 'Push…',
    sync: 'Synchronisation…',
    publish: 'Publication…',
    commit: 'Commit…',
    stage: 'Indexation…',
    unstage: 'Retrait de l’index…',
    'stage-all': 'Indexation…',
    'unstage-all': 'Retrait de l’index…',
    checkout: 'Changement de branche…',
    branch: 'Création de la branche…',
    abort: 'Annulation…',
  } as Record<RepoActionKind, string>,
  errors: {
    'no-upstream': 'Cette branche n’a pas encore sa propre branche distante.',
    rejected: 'Push refusé : le remote a des commits que tu n’as pas encore. Fais un pull (ou synchronise) puis repousse.',
    diverged: 'La branche et son upstream ont divergé : git refuse de les fusionner avec ta configuration de pull.',
    conflict: 'Conflits : résous-les dans les fichiers, indexe-les puis committe — ou annule.',
    'local-changes': 'Des modifications locales seraient écrasées : committe-les d’abord.',
    'nothing-to-commit': 'Rien à committer.',
    auth: 'Authentification refusée par le remote : vérifie ta connexion GitHub (gh auth login).',
    busy: 'Une autre action git tourne déjà sur ce dépôt.',
    invalid: 'Action impossible.',
    other: 'Git a refusé l’opération.',
  } as Record<RepoErrorKind, string>,
  details: 'Détails',
  dismiss: 'Fermer',
};

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const REF_ICONS: Record<GitRefKind, string> = { head: ICONS.target, branch: ICONS.branch, remote: ICONS.cloud, tag: ICONS.tag };

// Paths compare case-insensitively where the file system does.
const caseless = /^(win|mac)/i.test(navigator.platform);
const norm = (p: string) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseless ? s.toLowerCase() : s;
};
/** `dir` is `root` or a folder inside it. */
const within = (dir: string, root: string) => norm(dir) === norm(root) || norm(dir).startsWith(`${norm(root)}/`);
const baseName = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? p;
const remoteError = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisted: fine.
  }
}
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function iconButton(path: string, label: string, run: () => void, cls = 'icon-btn'): HTMLButtonElement {
  const btn = h('button', cls);
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.append(icon(path));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return btn;
}

/** A file of the working tree as VS Code's SCM view shows it: one letter, colored by kind. */
interface Change {
  path: string;
  letter: string;
  file: RepoFile;
}

function splitChanges(files: RepoFile[]): { conflicts: Change[]; staged: Change[]; unstaged: Change[] } {
  const conflicts: Change[] = [];
  const staged: Change[] = [];
  const unstaged: Change[] = [];
  for (const file of files) {
    if (CONFLICT_CODES.has(file.code)) conflicts.push({ path: file.path, letter: '!', file });
    else if (file.code === '??') unstaged.push({ path: file.path, letter: 'U', file });
    else {
      if (file.code[0] !== '.') staged.push({ path: file.path, letter: file.code[0], file });
      if (file.code[1] !== '.') unstaged.push({ path: file.path, letter: file.code[1], file });
    }
  }
  return { conflicts, staged, unstaged };
}

function fileLabel(path: string): [string, string] {
  const i = path.lastIndexOf('/');
  return i === -1 ? [path, ''] : [path.slice(i + 1), path.slice(0, i)];
}

function badge(refs: HistoryRef[], withName: boolean): HTMLElement {
  const el = h('span', refs[0].color ? 'scm-badge colored' : 'scm-badge');
  if (refs[0].color) el.style.backgroundColor = cssColor(refs[0].color);
  if (refs.length > 1) el.append(h('span', 'scm-badge-count', String(refs.length)));
  el.append(icon(REF_ICONS[refs[0].kind], 'ico badge-ico'));
  if (withName) el.append(h('span', 'scm-badge-name', refs[0].name));
  el.title = refs.map((r) => r.name).join('\n');
  return el;
}

/**
 * VS Code's badges: the first colored ref with its name, then the other colored refs grouped by color and kind.
 * Refs with no color (outside the filter) get no badge.
 */
function badges(refs: HistoryRef[]): HTMLElement[] {
  const rest = refs.slice();
  const out: HTMLElement[] = [];
  if (rest[0]?.color) out.push(badge(rest.splice(0, 1), true));
  const groups = new Map<string, HistoryRef[]>();
  for (const ref of rest) {
    if (!ref.color) continue;
    const key = `${ref.color}|${ref.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), ref]);
  }
  for (const group of groups.values()) out.push(badge(group, false));
  return out;
}

interface Alert {
  path: string;
  action: RepoActionKind;
  kind: RepoErrorKind;
  message: string;
  detail: string;
}

/**
 * The Source Control panel at the bottom of the sidebar, shaped like VS Code's: actions on the remote, commit box,
 * changes to stage, and the Source Control Graph of one checkout (main folder or worktree) of a main repo.
 */
export class RepoPanel {
  readonly root = h('div', 'scm');
  private statuses = new Map<string, RepoStatus>();
  private workers: SessionView[] = [];
  private focusCwd: string | null = null;
  private choice = stored('scmCheckout') ?? 'auto';
  private filter: GraphFilter = stored('scmFilter') === 'all' ? 'all' : 'auto';
  private collapsed = stored('scmCollapsed') === '1';
  private sections = { changes: stored('scmChangesOpen') !== '0', graph: stored('scmGraphOpen') !== '0' };

  // Graph state of the checkout shown.
  private shownPath = '';
  private graphKey = '';
  private graph: RepoGraph | null = null;
  private viewModels: HistoryItemViewModel[] = [];
  private graphError = '';
  private limit = PAGE;
  private loadingGraph = 0;
  private expanded = new Set<string>();
  private details = new Map<string, Promise<CommitDetails>>();
  private drafts = new Map<string, string>();
  private alert: Alert | null = null;
  private pending: RepoActionKind | null = null;
  private renderedKeys = { head: '', changes: '' };

  private readonly head = h('div', 'scm-head');
  private readonly repoBtn = h('button', 'scm-repo');
  private readonly actions = h('div', 'scm-actions');
  private readonly bar = h('div', 'scm-bar');
  private readonly alertBox = h('div', 'scm-alert');
  private readonly body = h('div', 'scm-body');
  private readonly commitBox = h('div', 'scm-commit-box');
  private readonly message = h('textarea', 'scm-message');
  private readonly commitBtn = h('button', 'scm-primary');
  private readonly commitMenuBtn = h('button', 'scm-primary scm-primary-more');
  private readonly commitHint = h('div', 'scm-commit-hint');
  private readonly changesHead = h('div', 'scm-section');
  private readonly changesList = h('div', 'scm-changes');
  private readonly graphHead = h('div', 'scm-section');
  private readonly graphList = h('div', 'scm-graph');
  private readonly hover = h('div', 'scm-hover');
  private hoverTimer = 0;
  private hideTimer = 0;
  private loadMoreObserver: IntersectionObserver;

  constructor(private readonly hub: HubApi) {
    const resize = h('div', 'scm-resize');
    resize.title = L.resize;
    this.setupResize(resize);

    this.repoBtn.title = L.pickRepo;
    this.repoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openRepoPicker();
    });
    const chevron = iconButton(ICONS.chevron, L.collapse, () => this.setCollapsed(!this.collapsed), 'icon-btn scm-chevron');
    this.head.append(chevron, this.repoBtn, this.actions);
    this.head.addEventListener('dblclick', (e) => {
      if (e.target === this.head) this.setCollapsed(!this.collapsed);
    });

    this.message.rows = 1;
    this.message.spellcheck = false;
    this.message.addEventListener('input', () => {
      this.drafts.set(this.shownPath, this.message.value);
      this.fitMessage();
      this.renderCommitButton();
    });
    this.message.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.commitBtn.click();
      }
    });
    this.commitBtn.addEventListener('click', () => this.primaryAction());
    this.commitMenuBtn.title = L.commitOptions;
    this.commitMenuBtn.append(icon(ICONS.chevron));
    this.commitMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openCommitMenu();
    });
    const buttons = h('div', 'scm-commit-buttons');
    buttons.append(this.commitBtn, this.commitMenuBtn);
    this.commitBox.append(this.message, buttons, this.commitHint);

    this.body.append(this.alertBox, this.commitBox, this.changesHead, this.changesList, this.graphHead, this.graphList);
    this.root.append(resize, this.head, this.bar, this.body);
    document.body.append(this.hover);
    this.hover.addEventListener('mouseenter', () => window.clearTimeout(this.hideTimer));
    this.hover.addEventListener('mouseleave', () => this.hideHover());
    this.body.addEventListener('scroll', () => this.hideHover(true));

    this.loadMoreObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && this.graph?.more && !this.loadingGraph) this.loadMore();
      },
      { root: this.body },
    );

    const height = Number(stored('scmHeight'));
    if (height >= MIN_HEIGHT) this.root.style.height = `${height}px`;
    this.root.classList.toggle('collapsed', this.collapsed);
    // Relative times ("vérifié il y a 40 s") keep aging between two updates.
    window.setInterval(() => this.renderBar(), 10_000);
  }

  update(status: RepoStatus): void {
    this.statuses.set(status.path, status);
    this.render();
  }

  /** Workers shown next to the checkout they work in. */
  setWorkers(sessions: SessionView[]): void {
    const workers = sessions.filter((s) => s.role === 'worker' && s.status !== 'exited');
    const key = (list: SessionView[]) => list.map((s) => `${s.name}@${s.cwd}`).join('|');
    if (key(workers) === key(this.workers)) return;
    this.workers = workers;
    this.render();
  }

  /** Folder of the worker opened beside the master: in Auto, the panel follows it. */
  setFocus(cwd: string | null): void {
    if (cwd === this.focusCwd) return;
    this.focusCwd = cwd;
    if (this.choice === 'auto') this.render();
  }

  // ---------- which checkout ----------

  private allTrees(): { repo: RepoStatus; tree: RepoTree }[] {
    return [...this.statuses.values()].flatMap((repo) => repo.trees.map((tree) => ({ repo, tree })));
  }

  /** The deepest checkout holding `dir` (a worktree may sit inside the main folder). */
  private checkoutOf(dir: string): { repo: RepoStatus; tree: RepoTree } | undefined {
    return this.allTrees()
      .filter(({ tree }) => within(dir, tree.path))
      .reduce<{ repo: RepoStatus; tree: RepoTree } | undefined>((best, c) => (!best || c.tree.path.length > best.tree.path.length ? c : best), undefined);
  }

  private current(): { repo: RepoStatus; tree: RepoTree } | undefined {
    const all = this.allTrees();
    if (this.choice !== 'auto') {
      const chosen = all.find(({ tree }) => tree.path === this.choice);
      if (chosen) return chosen;
    }
    return (this.focusCwd ? this.checkoutOf(this.focusCwd) : undefined) ?? all[0];
  }

  private workersIn(path: string): string[] {
    return this.workers.filter((s) => this.checkoutOf(s.cwd)?.tree.path === path).map(displayName);
  }

  private choose(path: string): void {
    this.choice = path;
    store('scmCheckout', path);
    this.render();
  }

  // ---------- render ----------

  private render(): void {
    const c = this.current();
    this.root.hidden = this.statuses.size === 0;
    if (!c) {
      this.repoBtn.replaceChildren(h('span', 'scm-repo-name', L.noRepo));
      return;
    }
    if (c.tree.path !== this.shownPath) this.show(c.tree.path);
    this.renderHead(c.repo, c.tree);
    this.renderBar();
    this.renderAlert();
    this.renderChanges(c.tree);
    this.renderCommitButton();
    const key = `${c.tree.path}|${c.tree.oid}|${c.tree.branch}|${c.tree.upstream}|${c.repo.refsKey}|${this.filter}`;
    if (key !== this.graphKey) {
      this.graphKey = key;
      void this.loadGraph();
    }
  }

  /** Switches to another checkout: its own draft, a fresh graph. */
  private show(path: string): void {
    this.shownPath = path;
    this.graph = null;
    this.viewModels = [];
    this.graphError = '';
    this.limit = PAGE;
    this.expanded.clear();
    this.renderedKeys = { head: '', changes: '' };
    if (this.alert?.path !== path) this.alert = null;
    this.message.value = this.drafts.get(path) ?? '';
    this.fitMessage();
    this.graphList.replaceChildren();
    this.body.scrollTop = 0;
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    store('scmCollapsed', collapsed ? '1' : '0');
    this.root.classList.toggle('collapsed', collapsed);
    this.hideHover(true);
  }

  private renderHead(repo: RepoStatus, tree: RepoTree): void {
    const busy = repo.busy?.path === tree.path ? repo.busy.action : this.pending;
    const key = JSON.stringify([repo.name, tree.label, tree.branch, tree.oid, tree.error, busy, repo.busy?.path, this.collapsed]);
    if (key === this.renderedKeys.head) return;
    this.renderedKeys.head = key;

    const name = h('span', 'scm-repo-name', repo.name);
    this.repoBtn.replaceChildren(name);
    if (tree.label) this.repoBtn.append(h('span', 'scm-repo-tree', tree.label));
    this.repoBtn.append(icon(ICONS.chevron, 'ico small'));
    this.repoBtn.title = `${tree.path}\n${L.pickRepo}`;

    const locked = !!repo.busy || !!this.pending;
    const button = (kind: 'fetch' | 'pull' | 'push', path: string, label: string) => {
      const btn = iconButton(path, label, () => void this.run({ kind }));
      btn.disabled = locked;
      btn.classList.toggle('spinning', busy === kind || (kind === 'pull' && busy === 'sync'));
      return btn;
    };
    const more = iconButton(ICONS.more, L.more, () => this.openMoreMenu(more));
    this.actions.replaceChildren(button('fetch', ICONS.fetch, L.fetch), button('pull', ICONS.pull, L.pull), button('push', ICONS.push, L.push), more);
    const chevron = this.head.querySelector('.scm-chevron') as HTMLButtonElement;
    chevron.title = this.collapsed ? L.expand : L.collapse;
  }

  /** Branch, distance to the upstream, what runs now; under the header. */
  private renderBar(): void {
    const c = this.current();
    if (!c) return;
    const { repo, tree } = c;
    const busy = repo.busy?.path === tree.path ? repo.busy.action : this.pending;
    this.root.classList.toggle('working', !!busy || repo.fetching);
    const items: HTMLElement[] = [];

    const branch = h('button', 'scm-branch');
    branch.append(icon(ICONS.branch, 'ico small'), h('span', '', tree.error ? L.unreadable : tree.branch || (tree.oid ? L.detached(tree.oid.slice(0, 7)) : L.noCommit)));
    if (tree.changes > 0) branch.append(h('span', 'scm-dirty', '*'));
    branch.title = L.switchBranch;
    branch.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openBranchPicker(branch);
    });
    items.push(branch);

    if (tree.upstream) {
      const sync = h('button', 'scm-sync');
      sync.append(icon(ICONS.sync, 'ico small'), h('span', '', `${tree.behind}↓ ${tree.ahead}↑`));
      sync.title = L.syncHint(tree.behind, tree.ahead, tree.upstream);
      sync.disabled = !!repo.busy || !!this.pending;
      sync.classList.toggle('spinning', busy === 'sync');
      sync.classList.toggle('active', tree.behind + tree.ahead > 0);
      sync.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.run({ kind: 'sync' });
      });
      items.push(sync);
    } else if (tree.branch) {
      const publish = h('button', 'scm-sync active');
      publish.append(icon(ICONS.publish, 'ico small'));
      publish.title = L.publishHint;
      publish.disabled = !!repo.busy || !!this.pending;
      publish.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.run({ kind: 'publish' });
      });
      items.push(publish);
    }

    const state = h('span', 'scm-state');
    if (busy) state.textContent = L.busy[busy];
    else if (repo.fetching) state.textContent = L.busy.fetch;
    else if (repo.fetchError) {
      state.textContent = L.fetchFailed;
      state.classList.add('error');
      state.title = repo.fetchError;
    } else if (repo.fetchedAt) state.textContent = L.fetchedAgo(ago(repo.fetchedAt));
    items.push(state);

    const workers = this.workersIn(tree.path);
    if (workers.length > 0) {
      const w = h('span', 'scm-workers', L.workers(workers.join(', ')));
      w.title = w.textContent ?? '';
      items.push(w);
    }
    this.bar.replaceChildren(...items);
  }

  private renderAlert(): void {
    const c = this.current();
    const items: HTMLElement[] = [];
    const state: RepoState = c?.tree.state ?? '';
    const fix = (label: string, path: string, action: RepoAction) => {
      const btn = h('button', 'scm-fix');
      btn.append(icon(path, 'ico small'), h('span', '', label));
      btn.addEventListener('click', () => void this.run(action));
      return btn;
    };
    if (state) {
      const box = h('div', 'scm-alert-box warn');
      box.append(h('div', 'scm-alert-text', L.state[state]));
      const fixes = h('div', 'scm-fixes');
      fixes.append(fix(L.abort[state], ICONS.undo, { kind: 'abort' }));
      box.append(fixes);
      items.push(box);
    }
    const a = this.alert;
    if (a && c && a.path === c.tree.path && !(state && a.kind === 'conflict')) {
      const box = h('div', 'scm-alert-box error');
      const close = iconButton(ICONS.remove, L.dismiss, () => {
        this.alert = null;
        this.renderAlert();
      });
      const text = h('div', 'scm-alert-text');
      text.append(h('b', '', L.errors[a.kind]), h('span', 'scm-alert-git', a.message));
      box.append(close, text);
      const fixes = h('div', 'scm-fixes');
      if (a.kind === 'no-upstream') fixes.append(fix(L.publish, ICONS.publish, { kind: 'publish' }));
      if (a.kind === 'rejected') fixes.append(fix(L.sync, ICONS.sync, { kind: 'sync' }));
      if (fixes.childElementCount) box.append(fixes);
      if (a.detail && a.detail !== a.message) {
        const more = h('details', 'scm-alert-detail');
        more.append(h('summary', '', L.details), h('pre', '', a.detail));
        box.append(more);
      }
      items.push(box);
    }
    this.alertBox.replaceChildren(...items);
  }

  // ---------- commit box & changes ----------

  private fitMessage(): void {
    // Empty, it stays one line high whatever the placeholder's length.
    this.message.style.height = '';
    if (!this.message.value) return;
    this.message.style.height = 'auto';
    this.message.style.height = `${Math.min(this.message.scrollHeight + 2, 120)}px`;
  }

  /** VS Code's primary button: Commit while there is something to commit, else Sync or Publish. */
  private renderCommitButton(): void {
    const c = this.current();
    if (!c) return;
    const { repo, tree } = c;
    const { staged, unstaged, conflicts } = splitChanges(tree.files);
    const locked = !!repo.busy || !!this.pending;
    this.message.placeholder = L.commitPlaceholder(tree.branch || 'HEAD');
    let label = L.commit;
    let path = ICONS.check;
    let hint = '';
    let mode: 'commit' | 'sync' | 'publish' = 'commit';
    if (tree.changes === 0 && !tree.state) {
      if (tree.upstream && tree.ahead + tree.behind > 0) {
        mode = 'sync';
        label = `${L.sync} ${tree.behind}↓ ${tree.ahead}↑`;
        path = ICONS.sync;
      } else if (!tree.upstream && tree.branch && tree.oid) {
        mode = 'publish';
        label = L.publish;
        path = ICONS.publish;
      }
    } else if (staged.length === 0 && unstaged.length > 0 && conflicts.length === 0) {
      label = L.commitAll;
      hint = L.commitAllHint;
    }
    this.commitBtn.replaceChildren(icon(path), h('span', '', label));
    this.commitBtn.dataset.mode = mode;
    this.commitBtn.disabled = locked || (mode === 'commit' && (tree.changes === 0 || conflicts.length > 0 || !!tree.error));
    this.commitMenuBtn.hidden = mode !== 'commit';
    this.commitMenuBtn.disabled = this.commitBtn.disabled;
    this.commitHint.textContent = hint;
  }

  private primaryAction(push = false): void {
    const mode = this.commitBtn.dataset.mode;
    if (mode === 'sync') return void this.run({ kind: 'sync' });
    if (mode === 'publish') return void this.run({ kind: 'publish' });
    const c = this.current();
    if (!c) return;
    const text = this.message.value.trim();
    if (!text) {
      this.message.focus();
      this.message.classList.add('invalid');
      this.message.placeholder = L.emptyMessage;
      window.setTimeout(() => this.message.classList.remove('invalid'), 1200);
      return;
    }
    const { staged } = splitChanges(c.tree.files);
    const path = c.tree.path;
    void this.run({ kind: 'commit', message: text, all: staged.length === 0, push }).then((ok) => {
      if (!ok) return;
      this.drafts.delete(path);
      if (this.shownPath === path) {
        this.message.value = '';
        this.fitMessage();
      }
    });
  }

  private openCommitMenu(): void {
    openMenu(this.commitMenuBtn, (menu, close) => {
      const row = (label: string, path: string, push: boolean) => {
        const btn = h('button', 'menu-row');
        btn.append(icon(path), h('span', 'menu-title', label));
        btn.addEventListener('click', () => {
          close();
          this.primaryAction(push);
        });
        return btn;
      };
      menu.append(row(L.commit, ICONS.check, false), row(L.commitPush, ICONS.push, true));
    });
  }

  private renderChanges(tree: RepoTree): void {
    const key = JSON.stringify([tree.path, tree.files, tree.changes, this.sections.changes, this.pending]);
    if (key === this.renderedKeys.changes) return;
    this.renderedKeys.changes = key;
    const { conflicts, staged, unstaged } = splitChanges(tree.files);

    this.changesHead.replaceChildren(...this.sectionTitle('changes', L.changes, tree.changes));
    const rows: HTMLElement[] = [];
    if (this.sections.changes) {
      const group = (label: string, list: Change[], action: 'stage' | 'unstage' | null) => {
        if (list.length === 0) return;
        const head = h('div', 'scm-group');
        head.append(h('span', 'scm-group-name', label), h('span', 'scm-count', String(list.length)));
        if (action === 'stage') head.append(iconButton(ICONS.plus, L.stageAll, () => void this.run({ kind: 'stage-all' }), 'icon-btn scm-row-action'));
        if (action === 'unstage') head.append(iconButton(ICONS.minus, L.unstageAll, () => void this.run({ kind: 'unstage-all' }), 'icon-btn scm-row-action'));
        rows.push(head);
        for (const change of list) rows.push(this.changeRow(change, action));
      };
      group(L.conflicts, conflicts, 'stage');
      group(L.staged, staged, 'unstage');
      group(L.unstaged, unstaged, 'stage');
      if (tree.changes === 0) rows.push(h('div', 'scm-empty', L.noChanges));
      if (tree.changes > tree.files.length) rows.push(h('div', 'scm-empty', L.truncated(tree.files.length, tree.changes)));
    }
    this.changesList.replaceChildren(...rows);
  }

  private changeRow(change: Change, action: 'stage' | 'unstage' | null): HTMLElement {
    const row = h('div', 'scm-file');
    const [name, dir] = fileLabel(change.path);
    const label = h('span', 'scm-file-label');
    label.append(h('span', 'scm-file-name', name), h('span', 'scm-file-dir', dir));
    row.append(label);
    if (action === 'stage') row.append(iconButton(ICONS.plus, L.stage, () => void this.run({ kind: 'stage', paths: [change.path] }), 'icon-btn scm-row-action'));
    if (action === 'unstage') row.append(iconButton(ICONS.minus, L.unstage, () => void this.run({ kind: 'unstage', paths: [change.path] }), 'icon-btn scm-row-action'));
    row.append(h('span', `scm-letter l-${change.letter === '!' ? 'conflict' : change.letter}`, change.letter));
    row.title = change.file.from ? `${change.file.from} → ${change.path}` : change.path;
    if (CONFLICT_CODES.has(change.file.code)) row.classList.add('conflict');
    return row;
  }

  private sectionTitle(section: 'changes' | 'graph', label: string, count: number | null): HTMLElement[] {
    const open = this.sections[section];
    const toggle = h('button', open ? 'scm-section-toggle open' : 'scm-section-toggle');
    toggle.append(icon(ICONS.chevron, 'ico small'), h('span', '', label));
    if (count !== null && count > 0) toggle.append(h('span', 'scm-count', String(count)));
    toggle.addEventListener('click', () => {
      this.sections[section] = !this.sections[section];
      store(section === 'changes' ? 'scmChangesOpen' : 'scmGraphOpen', this.sections[section] ? '1' : '0');
      this.renderedKeys.changes = '';
      const c = this.current();
      if (section === 'changes' && c) this.renderChanges(c.tree);
      else this.renderGraph();
    });
    return [toggle];
  }

  // ---------- graph ----------

  private async loadGraph(): Promise<void> {
    const path = this.shownPath;
    const token = ++this.loadingGraph;
    try {
      const graph = await this.hub.repoGraph(path, this.filter, this.limit);
      if (token !== this.loadingGraph || path !== this.shownPath) return;
      this.graph = graph;
      this.graphError = '';
      this.viewModels = this.toViewModels(graph);
    } catch (err) {
      if (token !== this.loadingGraph || path !== this.shownPath) return;
      this.graphError = remoteError(err);
    }
    this.loadingGraph = 0;
    this.renderGraph();
  }

  private loadMore(): void {
    this.limit += PAGE;
    void this.loadGraph();
  }

  /** VS Code's color map: HEAD's branch blue, its upstream purple, the base orange; other refs of the filter take their lane's color. */
  private toViewModels(graph: RepoGraph): HistoryItemViewModel[] {
    const colorMap = new Map<string, string | undefined>();
    if (graph.head) {
      colorMap.set(graph.head.id, REF_COLOR);
      if (graph.upstream) colorMap.set(graph.upstream.id, REMOTE_REF_COLOR);
      if (graph.base) colorMap.set(graph.base.id, BASE_REF_COLOR);
    }
    for (const id of graph.refs) if (!colorMap.has(id)) colorMap.set(id, undefined);
    if (this.filter === 'all') for (const c of graph.commits) for (const r of c.refs) if (!colorMap.has(r.id)) colorMap.set(r.id, undefined);
    const items = graph.commits.map((c) => ({
      id: c.id,
      parentIds: c.parents,
      subject: c.subject,
      message: c.message,
      author: c.author,
      email: c.email,
      at: c.at,
      references: c.refs,
    }));
    return toViewModels(items, colorMap, graph.head ?? undefined, graph.upstream ?? undefined, graph.base ?? undefined, true, true, graph.mergeBase || undefined);
  }

  private renderGraph(): void {
    // The hovered row is about to be replaced: it will never fire its mouseleave.
    this.hideHover(true);
    this.graphHead.replaceChildren(...this.sectionTitle('graph', L.graph, null), this.filterButton());
    this.loadMoreObserver.disconnect();
    if (!this.sections.graph) {
      this.graphList.replaceChildren();
      return;
    }
    if (this.graphError) {
      this.graphList.replaceChildren(h('div', 'scm-empty error', this.graphError));
      return;
    }
    if (!this.graph) {
      this.graphList.replaceChildren(h('div', 'scm-empty', L.loading));
      return;
    }
    if (this.viewModels.length === 0) {
      this.graphList.replaceChildren(h('div', 'scm-empty', L.noHistory));
      return;
    }
    const rows: HTMLElement[] = [];
    for (const vm of this.viewModels) {
      rows.push(this.commitRow(vm));
      if (this.expanded.has(vm.historyItem.id)) rows.push(...this.expansion(vm));
    }
    if (this.graph.more) rows.push(this.loadMoreRow());
    this.graphList.replaceChildren(...rows);
    const last = rows.at(-1);
    if (this.graph.more && last) this.loadMoreObserver.observe(last);
  }

  private filterButton(): HTMLElement {
    const btn = h('button', 'scm-filter');
    btn.append(icon(ICONS.filter, 'ico small'), h('span', '', L.filters[this.filter]));
    btn.title = `${L.filterTitle} : ${L.filterHints[this.filter]}`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(btn, (menu, close) => {
        menu.append(h('div', 'menu-label', L.filterTitle));
        for (const f of ['auto', 'all'] as GraphFilter[]) {
          const row = h('button', 'menu-row');
          const text = h('span', 'menu-text');
          text.append(h('span', 'menu-title', L.filters[f]), h('span', 'menu-hint', L.filterHints[f]));
          row.append(icon(f === this.filter ? ICONS.check : ''), text);
          row.addEventListener('click', () => {
            close();
            if (f === this.filter) return;
            this.filter = f;
            store('scmFilter', f);
            this.limit = PAGE;
            this.render();
          });
          menu.append(row);
        }
      });
    });
    return btn;
  }

  private commitRow(vm: HistoryItemViewModel): HTMLElement {
    const item = vm.historyItem;
    const virtual = vm.kind === 'incoming-changes' || vm.kind === 'outgoing-changes';
    const row = h('div', `scm-commit ${vm.kind}`);
    row.classList.toggle('expanded', this.expanded.has(item.id));
    const graph = h('div', 'scm-graph-cell');
    graph.append(renderGraph(vm));
    const label = h('div', 'scm-commit-label');
    const subject = virtual ? (vm.kind === 'incoming-changes' ? L.incoming : L.outgoing) : item.subject;
    label.append(h('span', 'scm-subject', subject), h('span', 'scm-author', item.author ?? ''));
    row.append(graph, label);
    const refs = h('div', 'scm-badges');
    refs.append(...badges(item.references ?? []));
    row.append(refs);
    row.addEventListener('click', () => {
      if (this.expanded.has(item.id)) this.expanded.delete(item.id);
      else this.expanded.add(item.id);
      this.hideHover(true);
      this.renderGraph();
    });
    row.addEventListener('mouseenter', () => this.scheduleHover(row, vm));
    row.addEventListener('mouseleave', () => this.hideHover());
    return row;
  }

  /** Rows under an expanded commit: its message body, then the files it changed. */
  private expansion(vm: HistoryItemViewModel): HTMLElement[] {
    const columns = vm.outputSwimlanes;
    const lane = getHistoryItemIndex(vm);
    const rows: HTMLElement[] = [];
    const body = vm.historyItem.message.split('\n').slice(1).join('\n').trim();
    if (body) {
      const row = h('div', 'scm-commit-body');
      row.append(this.placeholder(columns, lane, true), h('div', 'scm-body-text', body));
      rows.push(row);
    }
    const files = h('div', 'scm-commit-files');
    files.append(this.placeholderRow(columns, lane, h('span', 'scm-file-dir', L.loading)));
    rows.push(files);
    void this.detailsOf(vm.historyItem.id).then(
      (d) => files.replaceChildren(...d.files.map((f) => this.commitFileRow(f, columns, lane))),
      (err: unknown) => files.replaceChildren(this.placeholderRow(columns, lane, h('span', 'scm-file-dir error', remoteError(err)))),
    );
    return rows;
  }

  private placeholder(columns: GraphNode[], lane: number, stretch = false): HTMLElement {
    const cell = h('div', stretch ? 'scm-graph-cell stretch' : 'scm-graph-cell');
    const svg = renderGraphPlaceholder(columns, lane);
    if (stretch) {
      svg.setAttribute('viewBox', `0 0 ${svg.style.width.replace('px', '')} 22`);
      svg.setAttribute('preserveAspectRatio', 'none');
    }
    cell.append(svg);
    return cell;
  }

  private placeholderRow(columns: GraphNode[], lane: number, content: HTMLElement): HTMLElement {
    const row = h('div', 'scm-commit-file');
    row.append(this.placeholder(columns, lane), content);
    return row;
  }

  private commitFileRow(f: CommitFile, columns: GraphNode[], lane: number): HTMLElement {
    const [name, dir] = fileLabel(f.path);
    const label = h('span', 'scm-file-label');
    label.append(h('span', 'scm-file-name', name), h('span', 'scm-file-dir', dir));
    const row = this.placeholderRow(columns, lane, label);
    const stats = h('span', 'scm-file-stats');
    if (f.added < 0) stats.textContent = L.binary;
    else stats.append(h('span', 'add', `+${f.added}`), h('span', 'del', `−${f.deleted}`));
    row.append(stats, h('span', `scm-letter l-${f.status}`, f.status));
    row.title = f.from ? `${f.from} → ${f.path}` : f.path;
    return row;
  }

  private loadMoreRow(): HTMLElement {
    const row = h('div', 'scm-load-more');
    const last = this.viewModels.at(-1);
    const cell = h('div', 'scm-graph-cell');
    cell.append(renderGraphPlaceholder(last?.outputSwimlanes ?? []));
    row.append(cell, h('span', '', L.loadMore));
    row.addEventListener('click', () => this.loadMore());
    return row;
  }

  /** Files of a commit, or of the incoming / outgoing changes: a hash never changes, the virtual nodes follow their refs. */
  private detailsOf(id: string): Promise<CommitDetails> {
    const g = this.graph;
    const virtual = id === INCOMING_ID || id === OUTGOING_ID;
    const key = virtual ? `${this.shownPath}|${id}|${g?.mergeBase}|${g?.head?.revision}|${g?.upstream?.revision}` : `${this.shownPath}|${id}`;
    let promise = this.details.get(key);
    if (!promise) {
      if (this.details.size > 300) this.details.clear();
      promise = this.hub.repoDetails(this.shownPath, id === INCOMING_ID ? 'incoming' : id === OUTGOING_ID ? 'outgoing' : id);
      promise.catch(() => this.details.delete(key));
      this.details.set(key, promise);
    }
    return promise;
  }

  // ---------- hover ----------

  private scheduleHover(row: HTMLElement, vm: HistoryItemViewModel): void {
    window.clearTimeout(this.hoverTimer);
    window.clearTimeout(this.hideTimer);
    const delay = this.hover.classList.contains('open') ? 80 : HOVER_DELAY_MS;
    this.hoverTimer = window.setTimeout(() => this.showHover(row, vm), delay);
  }

  private hideHover(now = false): void {
    window.clearTimeout(this.hoverTimer);
    window.clearTimeout(this.hideTimer);
    const hide = () => this.hover.classList.remove('open');
    if (now) hide();
    else this.hideTimer = window.setTimeout(hide, 150);
  }

  /** VS Code's commit hover: author and date, full message, stats, refs, hash. */
  private showHover(row: HTMLElement, vm: HistoryItemViewModel): void {
    const item = vm.historyItem;
    const virtual = vm.kind === 'incoming-changes' || vm.kind === 'outgoing-changes';
    const card = this.hover;
    card.replaceChildren();

    const who = h('div', 'scm-hover-who');
    who.append(h('b', '', item.author ?? ''));
    if (item.email) who.append(h('span', 'scm-hover-dim', ` <${item.email}>`));
    if (item.at) {
      const when = h('span', 'scm-hover-dim', `, ${ago(item.at)} (${new Date(item.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })})`);
      who.append(when);
    }
    card.append(who);
    card.append(h('div', 'scm-hover-message', virtual ? (vm.kind === 'incoming-changes' ? L.incoming : L.outgoing) : item.message));

    const stats = h('div', 'scm-hover-stats');
    card.append(stats);
    void this.detailsOf(item.id).then(
      // Insertions and deletions colored like VS Code's hover.
      (d) => stats.replaceChildren(h('span', '', L.files(d.files.length)), h('span', 'add', L.insertions(d.added)), h('span', 'del', L.deletions(d.deleted))),
      () => stats.remove(),
    );

    const refs = (item.references ?? []).filter((r) => r.color || this.filter === 'all');
    if (refs.length > 0) {
      const list = h('div', 'scm-hover-refs');
      for (const ref of refs) list.append(badge([ref], true));
      card.append(list);
    }

    if (!virtual) {
      const foot = h('div', 'scm-hover-foot');
      foot.append(icon(ICONS.target, 'ico small'), h('span', 'scm-hover-hash', item.id.slice(0, 8)), copyButton(() => item.id, L.copyHash));
      const web = this.current()?.repo.webUrl;
      if (web) {
        const link = iconButton(ICONS.external, L.openWeb, () => this.hub.openExternal(`${web}/commit/${item.id}`));
        foot.append(link);
      }
      card.append(foot);
    }

    card.classList.add('open');
    const r = row.getBoundingClientRect();
    const sidebar = this.root.getBoundingClientRect();
    card.style.left = `${sidebar.right + 6}px`;
    card.style.top = '0px';
    const top = Math.min(r.top - 4, window.innerHeight - card.offsetHeight - 12);
    card.style.top = `${Math.max(12, top)}px`;
  }

  // ---------- menus ----------

  private openRepoPicker(): void {
    openMenu(this.repoBtn, (menu, close) => {
      const row = (title: string, hint: string, checked: boolean, pick: () => void, extra: HTMLElement[] = []) => {
        const btn = h('button', 'menu-row');
        const text = h('span', 'menu-text');
        text.append(h('span', 'menu-title', title));
        if (hint) text.append(h('span', 'menu-hint', hint));
        btn.append(icon(checked ? ICONS.check : ''), text, ...extra);
        btn.addEventListener('click', () => {
          close();
          pick();
        });
        return btn;
      };
      menu.append(row(L.auto, L.autoHint, this.choice === 'auto', () => this.choose('auto')));
      for (const repo of this.statuses.values()) {
        menu.append(h('div', 'menu-sep'), h('div', 'menu-label', repo.name));
        if (repo.error) menu.append(h('div', 'menu-note error', repo.error));
        for (const tree of repo.trees) {
          const workers = this.workersIn(tree.path);
          const hint = [tree.branch || (tree.oid ? L.detached(tree.oid.slice(0, 7)) : L.noCommit), workers.length ? L.workers(workers.join(', ')) : '']
            .filter(Boolean)
            .join('  ');
          const chips = h('span', 'scm-chips');
          if (tree.error) chips.append(h('span', 'scm-chip danger', L.unreadable));
          if (tree.conflicts) chips.append(h('span', 'scm-chip danger', `!${tree.conflicts}`));
          if (tree.behind) chips.append(h('span', 'scm-chip warn', `${tree.behind}↓`));
          if (tree.ahead) chips.append(h('span', 'scm-chip accent', `${tree.ahead}↑`));
          if (tree.changes - tree.conflicts > 0) chips.append(h('span', 'scm-chip', `●${tree.changes - tree.conflicts}`));
          const item = row(tree.label || L.mainFolder, hint, this.choice === tree.path, () => this.choose(tree.path), [chips]);
          item.title = tree.path;
          menu.append(item);
        }
      }
    });
  }

  private openMoreMenu(anchor: HTMLElement): void {
    const c = this.current();
    if (!c) return;
    const { repo, tree } = c;
    openMenu(anchor, (menu, close) => {
      const row = (label: string, path: string, action: () => void, disabled = false) => {
        const btn = h('button', 'menu-row');
        btn.append(icon(path), h('span', 'menu-title', label));
        btn.disabled = disabled || !!repo.busy;
        btn.addEventListener('click', () => {
          close();
          action();
        });
        return btn;
      };
      menu.append(
        row(tree.upstream ? L.syncHint(tree.behind, tree.ahead, tree.upstream) : L.sync, ICONS.sync, () => void this.run({ kind: 'sync' }), !tree.upstream),
        row(L.publish, ICONS.publish, () => void this.run({ kind: 'publish' }), !tree.branch),
        h('div', 'menu-sep'),
        row(L.switchBranch, ICONS.branch, () => this.openBranchPicker(this.bar.querySelector('.scm-branch') ?? this.repoBtn)),
        row(L.newBranch, ICONS.plus, () => this.openBranchPicker(this.bar.querySelector('.scm-branch') ?? this.repoBtn)),
      );
      if (tree.state) menu.append(h('div', 'menu-sep'), row(L.abort[tree.state], ICONS.undo, () => void this.run({ kind: 'abort' })));
    });
  }

  /** VS Code's "Checkout to…": filter the branches, or type a new name to create it from HEAD. */
  private openBranchPicker(anchor: HTMLElement): void {
    const c = this.current();
    if (!c) return;
    const path = c.tree.path;
    openMenu(anchor, (menu, close) => {
      const input = h('input', 'scm-branch-input');
      input.placeholder = L.branchFilter;
      input.spellcheck = false;
      const list = h('div', 'scm-branch-list');
      list.append(h('div', 'menu-note', L.loading));
      const picker = h('div', 'scm-branch-picker');
      picker.append(input, list);
      menu.append(picker);
      let branches: RepoBranch[] = [];
      const go = (action: RepoAction) => {
        close();
        void this.run(action);
      };
      const renderList = () => {
        const q = input.value.trim();
        const match = branches.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()));
        const rows: HTMLElement[] = [];
        if (q && !branches.some((b) => !b.remote && b.name === q)) {
          const create = h('button', 'menu-row');
          create.append(icon(ICONS.plus), h('span', 'menu-title', L.createBranch(q)));
          create.addEventListener('click', () => go({ kind: 'branch', name: q }));
          rows.push(create);
        }
        for (const remote of [false, true]) {
          const group = match.filter((b) => b.remote === remote);
          if (group.length === 0) continue;
          rows.push(h('div', 'menu-label', remote ? L.remoteBranches : L.localBranches));
          for (const b of group.slice(0, 80)) {
            const btn = h('button', 'menu-row');
            const text = h('span', 'menu-text');
            text.append(h('span', 'menu-title', b.name));
            const hint = b.current ? L.current : b.worktree && !within(b.worktree, path) ? L.inWorktree(baseName(b.worktree)) : b.at ? ago(b.at) : '';
            if (hint) text.append(h('span', 'menu-hint', hint));
            btn.append(icon(b.current ? ICONS.check : b.remote ? ICONS.cloud : ICONS.branch), text);
            btn.disabled = b.current;
            btn.addEventListener('click', () => go({ kind: 'checkout', ref: b.ref }));
            rows.push(btn);
          }
        }
        list.replaceChildren(...rows);
      };
      input.addEventListener('input', renderList);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const q = input.value.trim();
        const exact = branches.find((b) => b.name === q);
        if (exact && !exact.current) go({ kind: 'checkout', ref: exact.ref });
        else if (q && !exact) go({ kind: 'branch', name: q });
      });
      void this.hub.repoBranches(path).then(
        (list) => {
          branches = list;
          renderList();
        },
        (err: unknown) => list.replaceChildren(h('div', 'menu-note error', remoteError(err))),
      );
      window.setTimeout(() => input.focus(), 0);
    });
  }

  // ---------- actions ----------

  private async run(action: RepoAction): Promise<boolean> {
    const c = this.current();
    if (!c || this.pending || c.repo.busy) return false;
    const path = c.tree.path;
    this.alert = null;
    this.pending = action.kind;
    this.renderLocks();
    let result: RepoActionResult;
    try {
      result = await this.hub.repoAction(path, action);
    } catch (err) {
      result = { ok: false, kind: 'other', message: remoteError(err), detail: '' };
    }
    this.pending = null;
    if (!result.ok) this.alert = { path, action: action.kind, kind: result.kind, message: result.message, detail: result.detail };
    this.renderLocks();
    return result.ok;
  }

  /** Re-renders what depends on an action being in flight. */
  private renderLocks(): void {
    this.renderedKeys = { head: '', changes: '' };
    this.render();
  }

  private setupResize(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if (this.collapsed) return;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      const start = e.clientY;
      const from = this.root.getBoundingClientRect().height;
      const sidebar = this.root.parentElement?.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
      const move = (ev: PointerEvent) => {
        const height = Math.min(sidebar - 140, Math.max(MIN_HEIGHT, from + start - ev.clientY));
        this.root.style.height = `${Math.round(height)}px`;
      };
      const up = () => {
        handle.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        store('scmHeight', String(Math.round(this.root.getBoundingClientRect().height)));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }
}
