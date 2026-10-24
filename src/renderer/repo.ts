import {
  ownUpstream,
  type CommitDetails,
  type CommitFile,
  type GitRefKind,
  type GraphFilter,
  type HubApi,
  type RepoAction,
  type RepoActionKind,
  type RepoActionResult,
  type RepoBranch,
  type RepoErrorKind,
  type RepoFile,
  type RepoGraph,
  type RepoState,
  type RepoStatus,
  type RepoTree,
  type SessionView,
} from '../shared/types';
import { ago, copyButton, displayName, h, icon, ICONS, openMenu } from './dom';
import { LANG, PLATFORM, t, tn, type Key } from './i18n';
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
  SWIMLANE_HEIGHT,
  toViewModels,
  type GraphNode,
  type HistoryItemViewModel,
  type HistoryRef,
} from './graph';

const PAGE = 50;
const HOVER_DELAY_MS = 450;
const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 260;
/** Rows are denser than VS Code's 22 px: the graph keeps its geometry, scaled down. */
const ROW = 18;
const SCALE = ROW / SWIMLANE_HEIGHT;

// Commit shortcut as the platform names it.
const SHORTCUT = t(PLATFORM === 'darwin' ? 'scm.shortcutMac' : 'scm.shortcut');

// Keys typed by kind: a new action, error or state cannot be left untranslated.
const BUSY: Record<RepoActionKind, Key> = {
  fetch: 'scm.busy.fetch',
  pull: 'scm.busy.pull',
  push: 'scm.busy.push',
  sync: 'scm.busy.sync',
  publish: 'scm.busy.publish',
  commit: 'scm.busy.commit',
  stage: 'scm.busy.stage',
  unstage: 'scm.busy.unstage',
  'stage-all': 'scm.busy.stage-all',
  'unstage-all': 'scm.busy.unstage-all',
  checkout: 'scm.busy.checkout',
  branch: 'scm.busy.branch',
  abort: 'scm.busy.abort',
};
const ERRORS: Record<RepoErrorKind, Key> = {
  'no-upstream': 'scm.error.no-upstream',
  rejected: 'scm.error.rejected',
  diverged: 'scm.error.diverged',
  conflict: 'scm.error.conflict',
  'local-changes': 'scm.error.local-changes',
  'nothing-to-commit': 'scm.error.nothing-to-commit',
  auth: 'scm.error.auth',
  busy: 'scm.error.busy',
  invalid: 'scm.error.invalid',
  other: 'scm.error.other',
};
const STATES: Record<Exclude<RepoState, ''>, { text: Key; abort: Key }> = {
  merge: { text: 'scm.state.merge', abort: 'scm.abort.merge' },
  rebase: { text: 'scm.state.rebase', abort: 'scm.abort.rebase' },
  'cherry-pick': { text: 'scm.state.cherry-pick', abort: 'scm.abort.cherry-pick' },
  revert: { text: 'scm.state.revert', abort: 'scm.abort.revert' },
};
const FILTERS: Record<GraphFilter, { name: Key; hint: Key }> = {
  auto: { name: 'scm.filter.auto', hint: 'scm.filterHint.auto' },
  all: { name: 'scm.filter.all', hint: 'scm.filterHint.all' },
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

/** The graph row at the panel's density: same drawing, viewBox scaled to ROW pixels. */
function fit(svg: SVGSVGElement): SVGSVGElement {
  const width = parseFloat(svg.style.width);
  svg.setAttribute('viewBox', `0 0 ${width} ${SWIMLANE_HEIGHT}`);
  svg.style.width = `${width * SCALE}px`;
  svg.style.height = `${ROW}px`;
  return svg;
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

/** Name and folder of a path; an untracked folder ("dir/") keeps its slash. */
function fileLabel(path: string): [string, string] {
  const i = path.replace(/\/$/, '').lastIndexOf('/');
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
  kind: RepoErrorKind;
  message: string;
  detail: string;
}

/**
 * The Source Control panel at the bottom of the sidebar, shaped like VS Code's but denser: one header line
 * (folded by default), then the commit box, the changes to stage and the Source Control Graph of one checkout
 * (main folder or worktree) of a followed repo.
 */
export class RepoPanel {
  readonly root = h('div', 'scm');
  private statuses = new Map<string, RepoStatus>();
  private workers: SessionView[] = [];
  private focusCwd: string | null = null;
  private choice = stored('scmCheckout') ?? 'auto';
  private filter: GraphFilter = stored('scmFilter') === 'all' ? 'all' : 'auto';
  private collapsed = stored('scmCollapsed') !== '0';
  /** Height chosen by dragging, kept while a smaller window squeezes the panel. */
  private preferred = DEFAULT_HEIGHT;
  private sections = { changes: stored('scmChangesOpen') !== '0', graph: stored('scmGraphOpen') !== '0' };

  // State of the checkout shown.
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
  private renderedKeys = { head: '', changes: '', alert: '' };

  private readonly head = h('div', 'scm-head');
  private readonly alertBox = h('div', 'scm-alert');
  private readonly body = h('div', 'scm-body');
  private readonly commitBox = h('div', 'scm-commit-box');
  private readonly message = h('textarea', 'scm-message');
  private readonly commitBtn = h('button', 'icon-btn scm-commit-btn');
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
    resize.title = t('scm.resize');
    this.setupResize(resize);
    this.head.addEventListener('dblclick', (e) => {
      if (e.target === this.head) this.setCollapsed(!this.collapsed);
    });

    this.message.rows = 1;
    this.message.spellcheck = false;
    this.message.addEventListener('input', () => {
      this.drafts.set(this.shownPath, this.message.value);
      this.fitMessage();
    });
    this.message.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.commit(false);
      }
    });
    this.commitBtn.append(icon(ICONS.check));
    this.commitBtn.addEventListener('click', () => this.commit(false));
    this.commitBox.append(this.message, this.commitBtn);

    this.body.append(this.alertBox, this.commitBox, this.changesHead, this.changesList, this.graphHead, this.graphList);
    this.root.append(resize, this.head, this.body);
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
    this.preferred = height >= MIN_HEIGHT ? height : DEFAULT_HEIGHT;
    this.root.style.height = `${this.preferred}px`;
    this.root.classList.toggle('collapsed', this.collapsed);
    window.addEventListener('resize', () => this.fitHeight());
  }

  update(status: RepoStatus): void {
    const first = this.statuses.size === 0;
    this.statuses.set(status.path, status);
    this.render();
    // Once in the page: the stored height may not fit this window.
    if (first) requestAnimationFrame(() => this.fitHeight());
  }

  /** Workers shown next to the checkout they work in. */
  setWorkers(sessions: SessionView[]): void {
    const workers = sessions.filter((s) => s.role === 'worker' && s.status !== 'exited');
    const key = (list: SessionView[]) => list.map((s) => `${s.name}@${s.cwd}`).join('|');
    if (key(workers) === key(this.workers)) return;
    this.workers = workers;
    this.render();
  }

  /** The repos the settings follow: a repo no longer followed leaves the panel. */
  setRepos(paths: string[]): void {
    const before = this.statuses.size;
    for (const path of this.statuses.keys()) if (!paths.includes(path)) this.statuses.delete(path);
    if (this.statuses.size !== before) this.render();
  }

  /** Folds or unfolds the panel (the keyboard shortcut). */
  toggle(): void {
    this.setCollapsed(!this.collapsed);
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
    this.root.hidden = !c;
    if (!c) return;
    if (c.tree.path !== this.shownPath) this.show(c.tree.path);
    const busy = c.repo.busy?.path === c.tree.path ? c.repo.busy.action : this.pending;
    this.root.classList.toggle('working', !!busy || c.repo.fetching);
    this.renderHead(c.repo, c.tree, busy);
    this.renderAlert();
    this.renderCommit(c.repo, c.tree);
    this.renderChanges(c.tree);
    const key = `${c.tree.path}|${c.tree.oid}|${c.tree.branch}|${c.tree.upstream}|${c.repo.refsKey}|${this.filter}`;
    // Folded, the graph waits: it loads when unfolded.
    if (key !== this.graphKey && !this.collapsed) {
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
    this.renderedKeys = { head: '', changes: '', alert: '' };
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
    this.fitHeight();
    this.renderedKeys.head = '';
    this.hideHover(true);
    this.render();
  }

  /** One line: fold, repo, branch, then the remote actions (shown on hover), sync and more. */
  private renderHead(repo: RepoStatus, tree: RepoTree, busy: RepoActionKind | null): void {
    const locked = !!repo.busy || !!this.pending;
    const key = JSON.stringify([repo.name, tree.path, tree.label, tree.branch, tree.oid, tree.error, tree.changes > 0, tree.upstream, tree.ahead, tree.behind, !!repo.fetchError, busy, locked, this.collapsed]);
    if (key === this.renderedKeys.head) return;
    this.renderedKeys.head = key;

    const chevron = iconButton(ICONS.chevron, this.collapsed ? t('scm.expand') : t('scm.collapse'), () => this.setCollapsed(!this.collapsed), 'icon-btn scm-chevron');

    const repoBtn = h('button', 'scm-repo');
    repoBtn.append(h('span', 'scm-repo-name', repo.name));
    if (tree.label) repoBtn.append(h('span', 'scm-repo-tree', tree.label));
    repoBtn.title = `${tree.path}\n${t('scm.pickRepo')}`;
    repoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openRepoPicker(repoBtn);
    });

    const branch = h('button', 'scm-branch');
    branch.append(icon(ICONS.branch, 'ico small'), h('span', '', tree.error ? t('scm.unreadable') : tree.branch || (tree.oid ? t('scm.detached', { oid: tree.oid.slice(0, 7) }) : t('scm.noCommit'))));
    if (tree.changes > 0) branch.append(h('span', 'scm-dirty', '*'));
    branch.title = t('scm.switchBranch');
    branch.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openBranchPicker(branch);
    });

    const remote = (kind: 'fetch' | 'pull' | 'push', path: string, label: string) => {
      const btn = iconButton(path, label, () => void this.run({ kind }));
      btn.disabled = locked;
      btn.classList.toggle('running', busy === kind);
      return btn;
    };
    const actions = h('div', 'scm-actions');
    actions.append(remote('fetch', ICONS.fetch, t('scm.fetch')), remote('pull', ICONS.pull, t('scm.pull')), remote('push', ICONS.push, t('scm.push')));

    const items: HTMLElement[] = [chevron, repoBtn, branch, h('span', 'scm-spacer'), actions];
    if (tree.branch) {
      // VS Code's status bar item: sync counts, or publish when the branch has no remote of its own.
      const own = ownUpstream(tree.branch, tree.upstream);
      const sync = h('button', 'scm-sync');
      if (own) {
        sync.append(icon(ICONS.sync, 'ico small'));
        if (tree.ahead + tree.behind > 0) sync.append(h('span', '', `${tree.behind}↓${tree.ahead}↑`));
        sync.classList.toggle('active', tree.ahead + tree.behind > 0);
      } else sync.append(icon(ICONS.publish, 'ico small'));
      sync.classList.toggle('running', busy === 'sync' || busy === 'publish');
      sync.classList.toggle('error', !!repo.fetchError);
      sync.disabled = locked;
      sync.addEventListener('mouseenter', () => (sync.title = this.syncTitle()));
      sync.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.run({ kind: own ? 'sync' : 'publish' });
      });
      items.push(sync);
    }
    const more = iconButton(ICONS.more, t('scm.more'), () => this.openMoreMenu(more));
    items.push(more);
    this.head.replaceChildren(...items);
  }

  /** Tooltip of the sync button, built when shown: the fetch time keeps aging. */
  private syncTitle(): string {
    const c = this.current();
    if (!c) return '';
    const { repo, tree } = c;
    const busy = repo.busy?.path === tree.path ? repo.busy.action : this.pending;
    return [
      ownUpstream(tree.branch, tree.upstream) ? t('scm.syncHint', { behind: tree.behind, ahead: tree.ahead, upstream: tree.upstream }) : t('scm.publishHint'),
      busy ? t(BUSY[busy]) : repo.fetching ? t('scm.busy.fetch') : repo.fetchError ? t('scm.fetchFailed', { error: repo.fetchError }) : repo.fetchedAt ? t('scm.fetchedAgo', { when: ago(repo.fetchedAt) }) : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Rebuilt only when what it says changes: an open « Détails » survives the status polls. */
  private renderAlert(): void {
    const c = this.current();
    const state: RepoState = c?.tree.state ?? '';
    const a = this.alert && c && this.alert.path === c.tree.path && !(state && this.alert.kind === 'conflict') ? this.alert : null;
    const key = JSON.stringify([state, a]);
    if (key === this.renderedKeys.alert) return;
    this.renderedKeys.alert = key;
    const items: HTMLElement[] = [];
    const fix = (label: string, path: string, action: RepoAction) => {
      const btn = h('button', 'scm-fix');
      btn.append(icon(path, 'ico small'), h('span', '', label));
      btn.addEventListener('click', () => void this.run(action));
      return btn;
    };
    if (state) {
      const box = h('div', 'scm-alert-box warn');
      box.append(h('div', 'scm-alert-text', t(STATES[state].text)));
      const fixes = h('div', 'scm-fixes');
      fixes.append(fix(t(STATES[state].abort), ICONS.undo, { kind: 'abort' }));
      box.append(fixes);
      items.push(box);
    }
    if (a) {
      const box = h('div', 'scm-alert-box error');
      const close = iconButton(ICONS.remove, t('scm.dismiss'), () => {
        this.alert = null;
        this.renderAlert();
      });
      const text = h('div', 'scm-alert-text');
      text.append(h('b', '', t(ERRORS[a.kind])), h('span', 'scm-alert-git', a.message));
      box.append(close, text);
      const fixes = h('div', 'scm-fixes');
      if (a.kind === 'no-upstream') fixes.append(fix(t('scm.publish'), ICONS.publish, { kind: 'publish' }));
      if (a.kind === 'rejected') fixes.append(fix(t('scm.sync'), ICONS.sync, { kind: 'sync' }));
      if (fixes.childElementCount) box.append(fixes);
      if (a.detail && a.detail !== a.message) {
        const more = h('details', 'scm-alert-detail');
        more.append(h('summary', '', t('scm.details')), h('pre', '', a.detail));
        box.append(more);
      }
      items.push(box);
    }
    this.alertBox.replaceChildren(...items);
  }

  /** A new error is shown at once, unfolding the panel if needed. */
  private showAlert(alert: Alert): void {
    this.alert = alert;
    if (this.collapsed) this.setCollapsed(false);
    else this.renderAlert();
  }

  // ---------- commit box & changes ----------

  private fitMessage(): void {
    // Empty, it stays one line high whatever the placeholder's length.
    this.message.style.height = '';
    if (!this.message.value) return;
    this.message.style.height = 'auto';
    this.message.style.height = `${Math.min(this.message.scrollHeight + 2, 100)}px`;
  }

  /** Shown only when there is something to commit; nothing staged means everything gets committed. */
  private renderCommit(repo: RepoStatus, tree: RepoTree): void {
    const { staged, conflicts } = splitChanges(tree.files);
    const all = staged.length === 0;
    const branch = tree.branch || 'HEAD';
    this.commitBox.hidden = tree.changes === 0 && !tree.state;
    this.message.placeholder = t(all ? 'scm.placeholderAll' : 'scm.placeholder', { branch, key: SHORTCUT });
    this.commitBtn.title = t(all ? 'scm.commitAll' : 'scm.commit', { branch, key: SHORTCUT });
    this.commitBtn.disabled = !!repo.busy || !!this.pending || tree.changes === 0 || conflicts.length > 0 || !!tree.error;
    this.commitBtn.classList.toggle('running', this.pending === 'commit');
  }

  private commit(push: boolean): void {
    const c = this.current();
    if (!c || this.commitBtn.disabled) return;
    const text = this.message.value.trim();
    if (!text) {
      this.message.focus();
      this.commitBox.classList.add('invalid');
      this.message.placeholder = t('scm.emptyMessage');
      window.setTimeout(() => this.commitBox.classList.remove('invalid'), 1200);
      return;
    }
    const path = c.tree.path;
    void this.run({ kind: 'commit', message: text }).then((ok) => {
      if (!ok) return;
      this.drafts.delete(path);
      if (this.shownPath === path) {
        this.message.value = '';
        this.fitMessage();
      }
      // Pushed apart: a refused push never hides that the commit is made.
      if (push) void this.run({ kind: 'push' });
    });
  }

  private renderChanges(tree: RepoTree): void {
    const key = JSON.stringify([tree.path, tree.files, tree.changes, this.sections.changes, this.pending]);
    if (key === this.renderedKeys.changes) return;
    this.renderedKeys.changes = key;
    const { conflicts, staged, unstaged } = splitChanges(tree.files);

    this.changesHead.hidden = tree.changes === 0;
    this.changesHead.replaceChildren(this.sectionTitle('changes', t('scm.changes'), tree.changes));
    const rows: HTMLElement[] = [];
    if (this.sections.changes && tree.changes > 0) {
      const group = (label: string, list: Change[], action: 'stage' | 'unstage') => {
        if (list.length === 0) return;
        const head = h('div', 'scm-group');
        head.append(h('span', 'scm-group-name', label));
        if (action === 'stage') head.append(iconButton(ICONS.plus, t('scm.stageAll'), () => void this.run({ kind: 'stage-all' }), 'icon-btn scm-row-action'));
        else head.append(iconButton(ICONS.minus, t('scm.unstageAll'), () => void this.run({ kind: 'unstage-all' }), 'icon-btn scm-row-action'));
        head.append(h('span', 'scm-count', String(list.length)));
        rows.push(head);
        for (const change of list) rows.push(this.changeRow(change, action));
      };
      group(t('scm.conflicts'), conflicts, 'stage');
      group(t('scm.staged'), staged, 'unstage');
      group(t('scm.unstaged'), unstaged, 'stage');
      if (tree.changes > tree.files.length) rows.push(h('div', 'scm-empty', t('scm.truncated', { shown: tree.files.length, total: tree.changes })));
    }
    this.changesList.replaceChildren(...rows);
  }

  private changeRow(change: Change, action: 'stage' | 'unstage'): HTMLElement {
    const row = h('div', 'scm-file');
    const [name, dir] = fileLabel(change.path);
    const label = h('span', 'scm-file-label');
    label.append(h('span', 'scm-file-name', name), h('span', 'scm-file-dir', dir));
    row.append(label);
    if (action === 'stage') row.append(iconButton(ICONS.plus, t('scm.stage'), () => void this.run({ kind: 'stage', paths: [change.path] }), 'icon-btn scm-row-action'));
    else row.append(iconButton(ICONS.minus, t('scm.unstage'), () => void this.run({ kind: 'unstage', paths: [change.path] }), 'icon-btn scm-row-action'));
    row.append(h('span', `scm-letter l-${change.letter === '!' ? 'conflict' : change.letter}`, change.letter));
    row.title = change.file.from ? `${change.file.from} → ${change.path}` : change.path;
    return row;
  }

  private sectionTitle(section: 'changes' | 'graph', label: string, count: number | null): HTMLElement {
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
    return toggle;
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
    this.graphHead.replaceChildren(this.sectionTitle('graph', t('scm.graph'), null), this.filterButton());
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
      this.graphList.replaceChildren(h('div', 'scm-empty', t('scm.loading')));
      return;
    }
    if (this.viewModels.length === 0) {
      this.graphList.replaceChildren(h('div', 'scm-empty', t('scm.noHistory')));
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
    btn.append(icon(ICONS.filter, 'ico small'), h('span', '', t(FILTERS[this.filter].name)));
    btn.title = t('scm.filterTooltip', { title: t('scm.filterTitle'), hint: t(FILTERS[this.filter].hint) });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(btn, (menu, close) => {
        menu.append(h('div', 'menu-label', t('scm.filterTitle')));
        for (const f of ['auto', 'all'] as GraphFilter[]) {
          const row = h('button', 'menu-row');
          const text = h('span', 'menu-text');
          text.append(h('span', 'menu-title', t(FILTERS[f].name)), h('span', 'menu-hint', t(FILTERS[f].hint)));
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
    graph.append(fit(renderGraph(vm)));
    const label = h('div', 'scm-commit-label');
    const subject = virtual ? (vm.kind === 'incoming-changes' ? t('scm.incoming') : t('scm.outgoing')) : item.subject;
    label.append(h('span', 'scm-subject', subject), h('span', 'scm-author', item.author ?? ''));
    const refs = h('div', 'scm-badges');
    refs.append(...badges(item.references ?? []));
    row.append(graph, label, refs);
    row.addEventListener('click', () => {
      if (this.expanded.has(item.id)) this.expanded.delete(item.id);
      else this.expanded.add(item.id);
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
    files.append(this.placeholderRow(columns, lane, h('span', 'scm-file-dir', t('scm.loading'))));
    rows.push(files);
    void this.detailsOf(vm.historyItem.id).then(
      (d) => files.replaceChildren(...d.files.map((f) => this.commitFileRow(f, columns, lane))),
      (err: unknown) => files.replaceChildren(this.placeholderRow(columns, lane, h('span', 'scm-file-dir error', remoteError(err)))),
    );
    return rows;
  }

  private placeholder(columns: GraphNode[], lane: number, stretch = false): HTMLElement {
    const cell = h('div', stretch ? 'scm-graph-cell stretch' : 'scm-graph-cell');
    const svg = fit(renderGraphPlaceholder(columns, lane));
    // Under a multi-line body the lanes stretch to its height.
    if (stretch) svg.setAttribute('preserveAspectRatio', 'none');
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
    if (f.added < 0) stats.textContent = t('scm.binary');
    else stats.append(h('span', 'add', `+${f.added}`), h('span', 'del', `−${f.deleted}`));
    row.append(stats, h('span', `scm-letter l-${f.status}`, f.status));
    row.title = f.from ? `${f.from} → ${f.path}` : f.path;
    return row;
  }

  private loadMoreRow(): HTMLElement {
    const row = h('div', 'scm-load-more');
    const cell = h('div', 'scm-graph-cell');
    cell.append(fit(renderGraphPlaceholder(this.viewModels.at(-1)?.outputSwimlanes ?? [])));
    row.append(cell, h('span', '', t('scm.loadMore')));
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
    if (item.at) who.append(h('span', 'scm-hover-dim', `, ${t('scm.when', { ago: ago(item.at), date: new Date(item.at).toLocaleString(LANG, { dateStyle: 'medium', timeStyle: 'short' }) })}`));
    card.append(who, h('div', 'scm-hover-message', virtual ? (vm.kind === 'incoming-changes' ? t('scm.incoming') : t('scm.outgoing')) : item.message));

    const stats = h('div', 'scm-hover-stats');
    card.append(stats);
    void this.detailsOf(item.id).then(
      // Insertions and deletions colored like VS Code's hover.
      (d) => stats.replaceChildren(h('span', '', tn('scm.files', d.files.length)), h('span', 'add', tn('scm.insertions', d.added)), h('span', 'del', tn('scm.deletions', d.deleted))),
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
      foot.append(icon(ICONS.target, 'ico small'), h('span', 'scm-hover-hash', item.id.slice(0, 8)), copyButton(() => item.id, t('scm.copyHash')));
      const web = this.current()?.repo.webUrl;
      if (web) foot.append(iconButton(ICONS.external, t('scm.openWeb'), () => this.hub.openExternal(`${web}/commit/${item.id}`)));
      card.append(foot);
    }

    card.classList.add('open');
    const r = row.getBoundingClientRect();
    card.style.left = `${this.root.getBoundingClientRect().right + 6}px`;
    card.style.top = '0px';
    card.style.top = `${Math.max(12, Math.min(r.top - 4, window.innerHeight - card.offsetHeight - 12))}px`;
  }

  // ---------- menus ----------

  private openRepoPicker(anchor: HTMLElement): void {
    openMenu(anchor, (menu, close) => {
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
      menu.append(row(t('scm.auto'), t('scm.autoHint'), this.choice === 'auto', () => this.choose('auto')));
      for (const repo of this.statuses.values()) {
        const label = h('div', 'menu-label scm-pick-repo');
        label.append(h('span', '', repo.name));
        label.append(iconButton(ICONS.remove, t('scm.removeRepo'), () => {
          close();
          window.dispatchEvent(new CustomEvent('hub:remove-repo', { detail: repo.path }));
        }));
        menu.append(h('div', 'menu-sep'), label);
        if (repo.error) menu.append(h('div', 'menu-note error', repo.error));
        for (const tree of repo.trees) {
          const workers = this.workersIn(tree.path);
          const hint = [tree.branch || (tree.oid ? t('scm.detached', { oid: tree.oid.slice(0, 7) }) : t('scm.noCommit')), workers.length ? t('scm.workers', { names: workers.join(', ') }) : '']
            .filter(Boolean)
            .join('  ');
          const chips = h('span', 'scm-chips');
          if (tree.error) chips.append(h('span', 'scm-chip danger', t('scm.unreadable')));
          if (tree.conflicts) chips.append(h('span', 'scm-chip danger', `!${tree.conflicts}`));
          if (tree.behind) chips.append(h('span', 'scm-chip warn', `${tree.behind}↓`));
          if (tree.ahead) chips.append(h('span', 'scm-chip accent', `${tree.ahead}↑`));
          if (tree.changes - tree.conflicts > 0) chips.append(h('span', 'scm-chip', `●${tree.changes - tree.conflicts}`));
          const item = row(tree.label || t('scm.mainFolder'), hint, this.choice === tree.path, () => this.choose(tree.path), [chips]);
          item.title = tree.path;
          menu.append(item);
        }
      }
      const add = h('button', 'menu-row');
      add.append(icon(ICONS.plus), h('span', 'menu-title', t('scm.addRepo')));
      add.addEventListener('click', () => {
        close();
        window.dispatchEvent(new CustomEvent('hub:add-repo'));
      });
      menu.append(h('div', 'menu-sep'), add);
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
        btn.disabled = disabled || !!repo.busy || !!this.pending;
        btn.addEventListener('click', () => {
          close();
          action();
        });
        return btn;
      };
      const { conflicts } = splitChanges(tree.files);
      menu.append(
        row(t('scm.fetch'), ICONS.fetch, () => void this.run({ kind: 'fetch' })),
        row(t('scm.pull'), ICONS.pull, () => void this.run({ kind: 'pull' }), !tree.upstream),
        row(t('scm.push'), ICONS.push, () => void this.run({ kind: 'push' }), !tree.branch),
        row(t('scm.sync'), ICONS.sync, () => void this.run({ kind: 'sync' }), !tree.upstream),
        row(t('scm.publish'), ICONS.publish, () => void this.run({ kind: 'publish' }), !tree.branch),
        h('div', 'menu-sep'),
        row(t('scm.commitPush'), ICONS.check, () => this.commit(true), tree.changes === 0 || conflicts.length > 0 || !this.message.value.trim()),
        h('div', 'menu-sep'),
        row(t('scm.switchBranch'), ICONS.branch, () => this.openBranchPicker(anchor)),
        row(t('scm.newBranch'), ICONS.plus, () => this.openBranchPicker(anchor)),
      );
      if (tree.state) menu.append(h('div', 'menu-sep'), row(t(STATES[tree.state].abort), ICONS.undo, () => void this.run({ kind: 'abort' })));
    });
  }

  /** VS Code's "Checkout to…": filter the branches, or type a new name to create it from HEAD. */
  private openBranchPicker(anchor: HTMLElement): void {
    const c = this.current();
    if (!c) return;
    const path = c.tree.path;
    openMenu(anchor, (menu, close) => {
      const input = h('input', 'scm-branch-input');
      input.placeholder = t('scm.branchFilter');
      input.spellcheck = false;
      const list = h('div', 'scm-branch-list');
      list.append(h('div', 'menu-note', t('scm.loading')));
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
          create.append(icon(ICONS.plus), h('span', 'menu-title', t('scm.createBranch', { name: q })));
          create.addEventListener('click', () => go({ kind: 'branch', name: q }));
          rows.push(create);
        }
        for (const remote of [false, true]) {
          const group = match.filter((b) => b.remote === remote);
          if (group.length === 0) continue;
          rows.push(h('div', 'menu-label', remote ? t('scm.remoteBranches') : t('scm.localBranches')));
          for (const b of group.slice(0, 80)) {
            const btn = h('button', 'menu-row');
            const text = h('span', 'menu-text');
            text.append(h('span', 'menu-title', b.name));
            const hint = b.current ? t('scm.current') : b.worktree && !within(b.worktree, path) ? t('scm.inWorktree', { folder: baseName(b.worktree) }) : b.at ? ago(b.at) : '';
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
    this.renderLocks();
    if (!result.ok) this.showAlert({ path, kind: result.kind, message: result.message, detail: result.detail });
    return result.ok;
  }

  /** Re-renders what depends on an action being in flight. */
  private renderLocks(): void {
    this.renderedKeys = { head: '', changes: '', alert: '' };
    this.render();
  }

  /** Room up to the workers' section, which always keeps its minimum height. */
  private maxHeight(): number {
    const workers = this.root.closest('.sidebar')?.querySelector<HTMLElement>('.side-workers');
    if (!workers) return Infinity;
    const keep = parseFloat(getComputedStyle(workers).minHeight) || 0;
    return this.root.getBoundingClientRect().bottom - workers.getBoundingClientRect().top - keep;
  }

  /** The height the user chose, within the room the window leaves: it comes back when the window grows again. */
  private fitHeight(): void {
    if (this.collapsed) return;
    this.root.style.height = `${Math.round(Math.max(MIN_HEIGHT, Math.min(this.preferred, this.maxHeight())))}px`;
  }

  private setupResize(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if (this.collapsed) return;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      const start = e.clientY;
      const from = this.root.getBoundingClientRect().height;
      const move = (ev: PointerEvent) => {
        this.preferred = Math.round(Math.max(MIN_HEIGHT, Math.min(this.maxHeight(), from + start - ev.clientY)));
        this.fitHeight();
      };
      const up = () => {
        handle.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        store('scmHeight', String(this.preferred));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }
}
