import type { ContextGraphError, ContextGraphStatus } from '../shared/contextGraph';
import type { HubApi } from '../shared/types';
import { h } from './dom';
import { LANG, t, type Key } from './i18n';

type Action = 'status' | 'enable' | 'disable' | 'export' | 'purge';
const errorKeys: Record<ContextGraphError, Key> = {
  'sqlite-unavailable': 'context.error.sqlite',
  'storage-error': 'context.error.storage',
  'unsupported-schema': 'context.error.schema',
  closed: 'context.error.closed',
  'quota-exceeded': 'context.error.quota',
};

/** Settings for the master's known session. Only counts and dates are rendered, never graph records or identifiers. */
export class ContextGraphSection {
  readonly el = h('div', 'context-graph');
  private id: string | null = null;
  private active = false;
  private revision = 0;
  private busy = false;
  private status: ContextGraphStatus | null = null;
  private confirmPurge = false;
  private note: { key: Key; error: boolean } | null = null;

  constructor(private readonly hub: HubApi, private readonly session: () => string | null) {}

  mount(): HTMLElement {
    this.updateSession();
    return this.el;
  }

  updateSession(): void {
    const id = this.session();
    if (this.active && this.id === id) return;
    this.revision++;
    this.active = true;
    this.id = id;
    this.status = null;
    this.note = null;
    this.confirmPurge = false;
    this.busy = false;
    this.render();
    if (id) void this.run('status');
  }

  /** Closing or leaving the section invalidates both confirmations and pending responses. */
  unmount(): void {
    this.active = false;
    this.revision++;
    this.id = null;
  }

  private current(revision: number, id: string): boolean {
    return this.active && this.revision === revision && this.id === id && this.session() === id;
  }

  private async run(action: Action): Promise<void> {
    const id = this.id;
    if (this.busy || !id || !this.active || this.session() !== id) return;
    const revision = ++this.revision;
    this.busy = true;
    this.confirmPurge = false;
    this.note = null;
    this.render();
    try {
      if (action === 'export') {
        const result = await this.hub.contextGraphExportSnapshot(id);
        if (!this.current(revision, id)) return;
        this.status = result.status;
        if (!result.status.error && result.status.state !== 'unavailable') {
          // Fixed filename and opaque snapshot supplied by the main process: no path or conversation in the UI.
          const url = URL.createObjectURL(new Blob([JSON.stringify(result.snapshot, null, 2)], { type: 'application/json' }));
          const link = h('a');
          link.href = url;
          link.download = 'context-graph-snapshot.json';
          link.hidden = true;
          this.el.append(link);
          try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
          this.note = { key: 'context.exported', error: false };
        }
      } else {
        const status = await (action === 'status' ? this.hub.contextGraphStatus(id)
          : action === 'purge' ? this.hub.contextGraphPurge(id)
          : this.hub.contextGraphSetEnabled(id, action === 'enable'));
        if (!this.current(revision, id)) return;
        this.status = status;
        if (!status.error && action === 'purge') this.note = { key: 'context.purged', error: false };
      }
    } catch {
      // IPC errors can contain file paths or details from storage: never render their messages.
      if (this.current(revision, id)) {
        this.status = null;
        this.note = { key: 'context.error.request', error: true };
      }
    } finally {
      if (this.current(revision, id)) {
        this.busy = false;
        this.render();
      }
    }
  }

  private button(key: Key, action: string, run: () => void, disabled = false): HTMLButtonElement {
    const button = h('button', 'btn ghost small', t(key));
    button.type = 'button';
    button.dataset.contextAction = action;
    button.disabled = this.busy || disabled;
    button.addEventListener('click', () => { if (!button.disabled && !this.busy) run(); });
    return button;
  }

  private render(): void {
    const focused = this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.contextAction : undefined;
    this.el.replaceChildren();
    this.el.setAttribute('aria-busy', String(this.busy));
    const state = h('div', 'setup-field context-state');
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    const status = this.status;
    state.append(h('div', 'setup-label', t(!this.id ? 'context.noSession' : !status ? this.busy ? 'context.loading' : 'context.unknown' : `context.state.${status.state}`)));
    this.el.append(state);
    if (!this.id) {
      state.append(h('div', 'setup-hint', t('context.noSession.hint')));
      return;
    }
    if (status) {
      const toggle = h('label', 'setup-toggle context-toggle');
      const input = h('input');
      input.type = 'checkbox';
      input.checked = status.enabled;
      input.disabled = this.busy || (status.state === 'unavailable' && !status.enabled);
      input.dataset.contextAction = 'toggle';
      input.addEventListener('change', () => void this.run(input.checked ? 'enable' : 'disable'));
      const words = h('span');
      words.append(h('span', 'setup-label', t('context.enable')), h('span', 'setup-hint', t('context.scope')));
      toggle.append(input, words);
      this.el.append(toggle);
      const details = h('dl', 'context-details');
      const row = (key: Key, value: string) => details.append(h('dt', '', t(key)), h('dd', '', value));
      const number = (value: number) => value.toLocaleString(LANG);
      if (status.countsAvailable) {
        row('context.nodes', number(status.counts.nodes));
        row('context.edges', number(status.counts.edges));
        row('context.archived', t('context.archived.value', { nodes: number(status.counts.archivedNodes), edges: number(status.counts.archivedEdges) }));
      } else row('context.counts', t('context.counts.unavailable'));
      row('context.capacity', t('context.capacity.value', { nodes: number(status.limits.nodes), edges: number(status.limits.edges), bytes: number(status.limits.bytes) }));
      row('context.retrieval', t('context.retrieval.value', { nodes: number(status.limits.retrievalNodes), edges: number(status.limits.retrievalEdges) }));
      if (status.lastProvenance && Number.isFinite(status.lastProvenance.at)) {
        row('context.updated', new Date(status.lastProvenance.at).toLocaleString(LANG));
      }
      this.el.append(details);
      if (status.error) this.message(errorKeys[status.error] ?? 'context.error.request', true);
      else if (status.state === 'unavailable') this.message('context.error.request', true);
    }
    const unavailable = !status || status.state === 'unavailable';
    const actions = h('div', 'setup-row context-actions');
    actions.append(
      this.button('context.refresh', 'refresh', () => void this.run('status')),
      this.button('context.export', 'export', () => void this.run('export'), unavailable),
      this.button('context.purge', 'purge', () => {
        this.confirmPurge = true;
        this.note = null;
        this.render();
        this.el.querySelector<HTMLButtonElement>('[data-context-action="cancel"]')?.focus();
      }, unavailable && status?.error !== 'quota-exceeded'),
    );
    this.el.append(actions);
    if (this.confirmPurge) {
      const confirm = h('div', 'setup-confirm context-confirm');
      confirm.setAttribute('role', 'group');
      confirm.setAttribute('aria-labelledby', 'context-purge-title');
      const title = h('div', 'setup-label', t('context.purge.title'));
      title.id = 'context-purge-title';
      confirm.append(title, h('div', 'setup-hint', t('context.purge.hint')));
      const buttons = h('div', 'setup-row');
      buttons.append(
        this.button('setup.cancel', 'cancel', () => {
          this.confirmPurge = false;
          this.render();
          this.el.querySelector<HTMLButtonElement>('[data-context-action="purge"]')?.focus();
        }),
        this.button('context.purge.confirm', 'confirm', () => void this.run('purge')),
      );
      confirm.append(buttons);
      this.el.append(confirm);
    }
    if (this.note) this.message(this.note.key, this.note.error);
    if (focused) this.el.querySelector<HTMLButtonElement>(`[data-context-action="${focused}"]`)?.focus();
  }

  private message(key: Key, error: boolean): void {
    const note = h('div', `setup-hint context-note${error ? ' error' : ''}`, t(key));
    note.setAttribute('role', error ? 'alert' : 'status');
    this.el.append(note);
  }
}
