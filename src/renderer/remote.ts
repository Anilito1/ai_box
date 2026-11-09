import { monthCost, OVH_HOURLY, REMOTE_SECRETS, VPS_STEPS, type RemoteView, type VpsStepId, type VpsStepState } from '../shared/vps';
import type { AwayView, HubApi } from '../shared/types';
import { copyButton, h, icon, ICONS, openMenu, techDetails } from './dom';
import { t, type Key } from './i18n';

// Settings › Remote server (experimental) and the "I'm stepping away" button. The section is always there, with a short
// sheet of what it is and an "Install" button; the button in the header exists only once remote workers are on.

const DETAIL_KEYS = new Set([
  'target', 'no-ssh', 'keygen', 'acl', 'unreachable', 'fingerprint', 'hostChanged', 'pasteKey', 'noSudo', 'installed', 'done',
  'workerKey', 'upload', 'setup', 'lockedOut', 'worker', 'launcherVersion', 'runner', 'noClaude', 'code', 'login', 'repos', 'noRepos', 'token', 'refused',
]);

/** The fine-grained token page of GitHub, its name, lifetime and permissions filled in; the repos are the user's pick. */
const GITHUB_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=AI%20Box%20server&description=Remote%20workers%20of%20the%20AI%20Box&expires_in=90&contents=write&pull_requests=write&workflows=write&metadata=read';

/** OVH's page that makes a key limited to these calls on this instance (the user signs in and validates there). */
function ovhTokenUrl(project: string, instance: string, posts: string[]): string {
  const base = `/cloud/project/${encodeURIComponent(project)}/instance/${encodeURIComponent(instance)}`;
  return `https://eu.api.ovh.com/createToken/?GET=${base}${posts.map((p) => `&POST=${base}/${p}`).join('')}`;
}

/** The header button: "I'm stepping away", "I'm back", or what is under way. Hidden while remote workers are off. */
export class AwayButton {
  readonly el = h('button', 'ph-settings ph-away');
  private away: AwayView | undefined;

  constructor(private readonly hub: HubApi) {
    this.el.hidden = true;
    this.el.addEventListener('click', () => {
      const phase = this.el.dataset.phase;
      if (phase === 'away' || phase === 'server') this.choose();
      else if (!phase) this.hub.awayLeave();
    });
  }

  /** Back: the workers on the server come back here, or finish there. */
  private choose(): void {
    const onServer = this.away?.onServer ?? 0;
    if (onServer === 0) return this.hub.awayBack('bring');
    openMenu(
      this.el,
      (menu, close) => {
        menu.append(h('div', 'menu-label', t('away.choice', { count: String(onServer) })));
        for (const mode of ['bring', 'leave'] as const) {
          const row = h('button', 'menu-row');
          const text = h('span', 'menu-text');
          text.append(h('span', 'menu-title', t(`away.choice.${mode}`)), h('span', 'menu-hint', t(`away.choice.${mode}.hint`)));
          row.append(h('span', 'ico'), text);
          row.addEventListener('click', () => {
            close();
            this.hub.awayBack(mode);
          });
          menu.append(row);
        }
      },
      true,
    );
  }

  update(away: AwayView | undefined): void {
    this.away = away;
    this.el.hidden = !away;
    if (!away) return;
    // Back, with workers still finishing on the server: a way to bring them here stays at hand.
    const phase = away.phase ?? (away.onServer > 0 ? 'server' : '');
    const key = `${phase}:${away.safe}:${away.onServer}`;
    if (this.el.dataset.key === key && this.el.childElementCount > 0) return;
    this.el.dataset.key = key;
    this.el.dataset.phase = phase;
    const label = t(
      phase === 'away' ? 'away.btn.back' : phase === 'server' ? 'away.btn.server' : phase === 'leaving' ? 'away.btn.leaving' : phase === 'returning' ? 'away.btn.returning' : 'away.btn.leave',
      { count: String(away.onServer) },
    );
    this.el.replaceChildren(icon(ICONS.cloud), h('span', '', label));
    // Away: whether the PC may go off is the runner's answer, said where the user looks before leaving.
    this.el.title = t(phase === 'away' ? (away.safe ? 'away.btn.back.safe' : 'away.btn.back.hint') : phase === 'server' ? 'away.btn.server.hint' : 'away.btn.leave.hint');
    this.el.disabled = phase === 'leaving' || phase === 'returning';
    this.el.classList.toggle('on', phase === 'away' || phase === 'server');
  }
}

type GuideId = 'order' | 'key' | 'connect' | 'login' | 'github' | 'power' | 'phone' | 'enable';

/** Settings › Remote server: what it is, then the setup, step by step, then the server's settings once it works. */
export class RemoteSection {
  private view: RemoteView | null = null;
  private target = { host: '', admin: 'ubuntu', port: '22' };
  private error = '';
  /** The setup is shown: asked by "Install", or already begun. */
  private setup = false;
  private scrollToGuide = false;
  private redraw: () => void = () => {};

  constructor(private readonly hub: HubApi) {
    hub.onRemote((v) => {
      this.view = v;
      this.redraw();
    });
  }

  render(el: HTMLElement, redraw: () => void): void {
    this.redraw = redraw;
    if (!this.view) {
      void this.hub.remoteState().then((v) => {
        this.view = v;
        const tg = v.wizard.target;
        if (tg) this.target = { host: tg.host, admin: tg.admin, port: String(tg.port) };
        redraw();
      });
      el.append(h('p', 'setup-hint', t('remote.loading')));
      return;
    }
    const v = this.view;
    const begun = !!v.wizard.target;
    if (begun) el.append(this.status(v));
    el.append(this.sheet(begun));
    if (this.setup || begun) {
      const guide = this.guide(v);
      el.append(guide);
      // "Install": the first step in view, the sheet above it.
      if (this.scrollToGuide) requestAnimationFrame(() => guide.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      this.scrollToGuide = false;
    }
    if (v.wizard.target && (v.enabled || v.wizard.steps.save.state === 'ok')) el.append(this.settings(v), this.access(v));
    if (this.error) el.append(h('div', 'setup-note error', this.error));
  }

  private act(p: Promise<RemoteView>): void {
    this.error = '';
    void p.then(
      (v) => {
        this.view = v;
        this.redraw();
      },
      () => {
        this.error = t('remote.error');
        this.redraw();
      },
    );
  }

  // ---------- what it is, and where it stands ----------

  /** Where things stand now: the server as its power control and the runner say, the workers there, the last sync. */
  private status(v: RemoteView): HTMLElement {
    const box = h('div', 'remote-status');
    const server = v.server || (v.enabled ? 'always' : 'off-setting');
    const time = v.env.at ? new Date(v.env.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
    box.append(
      h('span', `remote-status-dot s-${server}`),
      h('span', '', t(`remote.status.${server}` as Key)),
      h('span', 'remote-status-sep', '·'),
      h('span', '', t('remote.status.missions', { count: String(v.missions) })),
      h('span', 'remote-status-sep', '·'),
      h('span', '', time ? t('remote.status.sync', { time }) : t('remote.status.noSync')),
    );
    return box;
  }

  /** The short sheet: what it is for, what it takes, what goes on with the PC off, the limits; then Install. */
  private sheet(begun: boolean): HTMLElement {
    // Once set up, folded: the status line and the steps come first.
    const box = h(begun ? 'details' : 'div', begun ? 'remote-block remote-sheet remote-more' : 'remote-block remote-sheet');
    if (begun) box.append(h('summary', 'remote-title', t('remote.sheet.title')));
    const list = h('ul', 'remote-sheet-list');
    for (const k of ['what', 'needs', 'away', 'off', 'stays', 'limits'] as const) list.append(h('li', '', t(`remote.sheet.${k}`)));
    const row = h('div', 'setup-row');
    const install = () => {
      this.setup = true;
      this.scrollToGuide = true;
      this.redraw();
    };
    if (!begun) row.append(this.button(t(this.setup ? 'remote.sheet.installing' : 'remote.sheet.install'), 'btn primary', install, this.setup));
    const prompt = this.button(t('remote.sheet.prompt'), 'btn', () =>
      void navigator.clipboard.writeText(t('remote.prompt')).then(() => {
        prompt.textContent = t('remote.sheet.copied');
        window.setTimeout(() => (prompt.textContent = t('remote.sheet.prompt')), 1500);
      }),
    );
    row.append(prompt);
    box.append(list, row, h('p', 'setup-hint', t('remote.sheet.prompt.hint')));
    return box;
  }

  // ---------- the setup, step by step ----------

  private guideState(id: GuideId, v: RemoteView): VpsStepState {
    const s = v.wizard.steps;
    const worst = (ids: VpsStepId[]): VpsStepState => {
      const states = ids.map((i) => s[i].state);
      for (const st of ['fail', 'wait', 'run'] as const) if (states.includes(st)) return st;
      return states.every((st) => st === 'ok') ? 'ok' : 'todo';
    };
    switch (id) {
      case 'order':
        return s.admin.state === 'ok' ? 'ok' : 'todo';
      case 'key':
        return s.admin.state === 'ok' ? 'ok' : s.admin.detail === 'pasteKey' ? 'fail' : 'todo';
      case 'connect':
        return worst(['local', 'hostkey', 'admin', 'setup', 'worker']);
      case 'login':
        return s.login.state;
      case 'github':
        return worst(['repos', 'save']);
      case 'power':
        return v.power.kind === 'ovh' ? 'ok' : 'todo';
      case 'phone':
        return v.ntfyUrl ? 'ok' : 'todo';
      case 'enable':
        return v.enabled ? 'ok' : 'todo';
    }
  }

  private guide(v: RemoteView): HTMLElement {
    const box = h('div', 'remote-block');
    const head = h('div', 'remote-guide-head');
    head.append(h('h3', 'remote-title', t('remote.guide.title')));
    if (v.wizard.target) head.append(this.button(t('remote.rerun'), 'btn small', () => this.act(this.hub.remoteWizard('retry')), v.wizard.running));
    box.append(head);
    const list = h('ol', 'remote-guide');
    const ids: GuideId[] = ['order', 'key', 'connect', 'login', 'github', 'power', 'phone', 'enable'];
    let current = true;
    ids.forEach((id, i) => {
      const state = this.guideState(id, v);
      const step = h('details', `remote-guide-step ${state}`);
      // Open: the first step left to do, one that waits for the user or failed. The others fold to one line.
      step.open = (current && state !== 'ok') || state === 'wait' || state === 'fail';
      if (state !== 'ok' && !['order', 'power', 'phone'].includes(id)) current = false;
      const summary = h('summary', 'remote-guide-summary');
      const badge = h('span', `remote-guide-badge ${state}`);
      if (state === 'ok') badge.append(icon(ICONS.check));
      else badge.textContent = String(i + 1);
      summary.append(badge, h('span', 'remote-guide-name', t(`remote.guide.${id}` as Key)));
      if (id === 'power' || id === 'phone') summary.append(h('span', 'remote-guide-optional', t('remote.guide.optional')));
      step.append(summary, h('p', 'remote-guide-text', t(`remote.guide.${id}.text` as Key)), this.guideBody(id, v));
      list.append(step);
    });
    box.append(list);
    if (v.wizard.log.length > 0) box.append(techDetails(v.wizard.log.join('\n')));
    return box;
  }

  private guideBody(id: GuideId, v: RemoteView): HTMLElement {
    const body = h('div', 'remote-guide-body');
    const w = v.wizard;
    if (id === 'order') {
      body.append(this.button(t('remote.guide.order.open'), 'btn', () => this.hub.openExternal(t('remote.guide.order.url'))));
    } else if (id === 'key') {
      if (w.adminKey) {
        const code = h('div', 'remote-code');
        code.append(h('span', '', w.adminKey), copyButton(() => w.adminKey));
        body.append(code);
      } else body.append(h('p', 'setup-hint', t('remote.guide.key.later')));
      if (w.steps.admin.detail === 'pasteKey') body.append(h('p', 'remote-fail', t('remote.detail.pasteKey')));
    } else if (id === 'connect') {
      const row = h('div', 'setup-row remote-target');
      row.append(
        this.input(this.target.host, t('remote.host.placeholder'), (x) => (this.target.host = x.trim())),
        this.input(this.target.admin, 'ubuntu', (x) => (this.target.admin = x.trim())),
        this.input(this.target.port, '22', (x) => (this.target.port = x.trim())),
        this.button(t(w.target ? 'remote.rerun' : 'remote.connect'), 'btn primary', () => this.act(this.hub.remoteWizard('run', { host: this.target.host, admin: this.target.admin, port: Number(this.target.port) })), w.running),
      );
      body.append(row, this.steps(v, ['local', 'hostkey', 'admin', 'setup', 'worker']));
    } else if (id === 'login') {
      body.append(this.steps(v, ['login']));
    } else if (id === 'github') {
      const open = this.button(t('remote.guide.github.open'), 'btn', () => this.hub.openExternal(GITHUB_TOKEN_URL));
      body.append(open, this.secretRow(v, 'personal', 'GH_TOKEN'), this.repoPicker(v), this.steps(v, ['repos', 'save']));
    } else if (id === 'power') {
      body.append(this.power(v));
    } else if (id === 'phone') {
      body.append(this.phone(v));
    } else {
      const ready = w.steps.save.state === 'ok' || v.enabled;
      body.append(this.toggle(t('remote.enabled'), t(ready ? 'remote.enabled.hint' : 'remote.guide.enable.notYet'), v.enabled, (on) => this.act(this.hub.remoteSet({ kind: 'enabled', on }))));
    }
    return body;
  }

  /** The repos of this PC that are on GitHub, and those already listed: checked ones may get a copy on the server. */
  private repoPicker(v: RemoteView): HTMLElement {
    const f = this.field(t('remote.guide.github.repos'), t('remote.guide.github.repos.hint'));
    const picked = new Set(v.lists.allowed);
    const all = [...new Set([...v.lists.allowed, ...v.candidates])];
    if (all.length === 0) f.append(h('p', 'setup-hint', t('remote.guide.github.noRepo')));
    for (const slug of all) {
      const row = h('label', 'setup-toggle');
      const box = h('input');
      box.type = 'checkbox';
      box.checked = picked.has(slug);
      box.addEventListener('change', () => {
        if (box.checked) picked.add(slug);
        else picked.delete(slug);
      });
      row.append(box, h('span', 'setup-choice-title', slug));
      f.append(row);
    }
    if (all.length > 0) f.append(this.button(t('remote.guide.github.save'), 'btn small', () => this.act(this.hub.remoteSet({ kind: 'repos', allowed: [...picked], denied: v.lists.denied, orgs: v.lists.orgs }).then(() => this.hub.remoteWizard('retry')))));
    return f;
  }

  private field(label: string, hint = ''): HTMLDivElement {
    const f = h('div', 'setup-field');
    f.append(h('div', 'setup-label', label));
    if (hint) f.append(h('div', 'setup-hint', hint));
    return f;
  }

  private input(value: string, placeholder: string, onInput: (v: string) => void, type = 'text'): HTMLInputElement {
    const i = h('input', 'setup-input');
    i.type = type;
    i.value = value;
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }

  private button(label: string, cls: string, run: () => void, disabled = false): HTMLButtonElement {
    const b = h('button', cls, label);
    b.disabled = disabled;
    b.addEventListener('click', run);
    return b;
  }

  /** The setup's own steps, each with ✓ or what went wrong in plain words, and what the user has to do where it waits. */
  private steps(v: RemoteView, ids: readonly VpsStepId[] = VPS_STEPS): HTMLElement {
    const w = v.wizard;
    const list = h('ol', 'remote-steps');
    for (const id of ids) {
      const step = w.steps[id];
      const li = h('li', `remote-step ${step.state}`);
      li.append(icon(step.state === 'ok' ? ICONS.check : step.state === 'fail' ? ICONS.shield : ICONS.minus), h('span', 'remote-step-name', t(`remote.step.${id}` as Key)));
      const detail = this.detail(id, step.detail, v);
      if (detail) li.append(h('span', 'remote-step-detail', detail));
      list.append(li);
      const extra = this.waitBox(id, v);
      if (extra) list.append(extra);
    }
    return list;
  }

  private detail(id: VpsStepId, code: string, v: RemoteView): string {
    if (!code) return '';
    if (id === 'worker' && v.wizard.claude) return v.wizard.claude;
    if (id === 'admin' && /^ubuntu|^debian/.test(code)) return code;
    if (id === 'save') return t('remote.detail.saved', { count: code });
    return DETAIL_KEYS.has(code) ? t(`remote.detail.${code}` as Key) : code;
  }

  /** What the user has to do where a step waits for them. */
  private waitBox(id: VpsStepId, v: RemoteView): HTMLElement | null {
    const w = v.wizard;
    const step = w.steps[id];
    if (id === 'hostkey' && step.state === 'wait') {
      const box = h('div', 'setup-device');
      box.append(h('div', 'setup-hint', t('remote.fingerprint.hint')), h('div', 'remote-code', w.fingerprint));
      box.append(this.button(t('remote.trust'), 'btn primary', () => this.act(this.hub.remoteWizard('trust', w.fingerprint))));
      return box;
    }
    if (id === 'admin' && step.state === 'fail' && step.detail === 'hostChanged') {
      const box = h('div', 'setup-device');
      box.append(h('div', 'setup-hint', t('remote.hostChanged.hint')), this.button(t('remote.forget'), 'btn', () => this.act(this.hub.remoteWizard('forget'))));
      return box;
    }
    if (id === 'login' && step.state === 'wait' && w.loginUrl) {
      const box = h('div', 'setup-device');
      let code = '';
      const row = h('div', 'setup-row');
      row.append(
        this.input('', t('remote.login.code'), (x) => (code = x)),
        this.button(t('remote.login.send'), 'btn primary', () => this.act(this.hub.remoteWizard('code', code))),
      );
      box.append(h('div', 'setup-hint', t('remote.login.hint')), this.button(t('remote.login.open'), 'btn', () => this.hub.openExternal(w.loginUrl)), row);
      return box;
    }
    if (id === 'repos' && step.state === 'wait') {
      const box = h('div', 'setup-device remote-keys');
      if (step.detail === 'noRepos') box.append(h('div', 'setup-hint', t('remote.repos.none')));
      if (step.detail === 'token') box.append(h('div', 'setup-hint', t('remote.repos.token')));
      for (const k of w.repos) {
        const row = h('div', `remote-key-row${k.ready ? ' ready' : ''}`);
        row.append(h('b', '', k.slug), h('span', 'setup-hint', t(k.ready ? 'remote.repos.ready' : 'remote.repos.refused')));
        box.append(row);
      }
      box.append(this.button(t('remote.repos.check'), 'btn primary', () => this.act(this.hub.remoteWizard('retry'))));
      return box;
    }
    return null;
  }

  /** A token field: masked, its value never shown back; "set" once the keychain holds one. */
  private secretRow(v: RemoteView, scope: 'personal' | 'org', name: string): HTMLElement {
    const row = h('div', 'setup-row');
    let value = '';
    const set = (v.secrets[scope] as string[]).includes(name);
    row.append(
      h('span', 'remote-secret-name', name),
      this.input('', t(set ? 'remote.secret.set' : 'remote.secret.paste'), (x) => (value = x.trim()), 'password'),
      this.button(t('remote.secret.save'), 'btn small', () => this.act(this.hub.remoteSecret({ scope, name, value }))),
    );
    if (set) row.append(this.button(t('remote.secret.remove'), 'btn ghost small', () => this.act(this.hub.remoteSecret({ scope, name, value: null }))));
    return row;
  }

  // ---------- once it works ----------

  /** The repos the server may hold, the owners it never may, the organisations; and the tokens of each scope. */
  private access(v: RemoteView): HTMLElement {
    const box = h('details', 'remote-block remote-more');
    box.append(h('summary', 'remote-title', t('remote.access.title')));
    const lists = { allowed: v.lists.allowed.join('\n'), denied: v.lists.denied.join('\n'), orgs: v.lists.orgs.join('\n') };
    const area = (key: keyof typeof lists, label: string, hint: string) => {
      const f = this.field(label, hint);
      const a = h('textarea', 'setup-textarea');
      a.rows = key === 'allowed' ? 5 : 2;
      a.value = lists[key];
      a.spellcheck = false;
      a.addEventListener('input', () => (lists[key] = a.value));
      f.append(a);
      return f;
    };
    const split = (text: string) => text.split(/[\s,]+/).filter(Boolean);
    box.append(
      area('allowed', t('remote.lists.allowed'), t('remote.lists.allowed.hint')),
      area('denied', t('remote.lists.denied'), t('remote.lists.denied.hint')),
      area('orgs', t('remote.lists.orgs'), t('remote.lists.orgs.hint')),
      this.button(t('remote.lists.save'), 'btn small', () =>
        this.act(this.hub.remoteSet({ kind: 'repos', allowed: split(lists.allowed), denied: split(lists.denied), orgs: split(lists.orgs) })),
      ),
    );
    const personal = this.field(t('remote.secrets.personal'), t('remote.secrets.hint'));
    for (const name of REMOTE_SECRETS) personal.append(this.secretRow(v, 'personal', name));
    box.append(personal);
    if (v.lists.orgs.length > 0) {
      const org = this.field(t('remote.secrets.org'), t('remote.app.hint'));
      const app = { id: v.app.id, org: v.app.org || v.lists.orgs[0], key: '' };
      const grid = h('div', 'remote-ovh');
      const pem = h('textarea', 'setup-textarea');
      pem.rows = 2;
      pem.placeholder = t('remote.app.key');
      pem.addEventListener('input', () => (app.key = pem.value.trim()));
      grid.append(this.input(app.id, t('remote.app.id'), (x) => (app.id = x.trim())), this.input(app.org, t('remote.app.org'), (x) => (app.org = x.trim())));
      org.append(h('p', 'setup-hint', t(v.app.key ? 'remote.app.set' : 'remote.app.none')), grid, pem, this.button(t('remote.app.save'), 'btn small', () => this.act(this.hub.remoteApp(app))));
      for (const name of REMOTE_SECRETS.filter((n) => n !== 'GH_TOKEN')) org.append(this.secretRow(v, 'org', name));
      box.append(org);
    }
    return box;
  }

  private toggle(label: string, hint: string, on: boolean, change: (on: boolean) => void): HTMLLabelElement {
    const row = h('label', 'setup-toggle');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = on;
    box.addEventListener('change', () => change(box.checked));
    const text = h('span', 'setup-choice-text');
    text.append(h('span', 'setup-choice-title', label), h('span', 'setup-choice-hint', hint));
    row.append(box, text);
    return row;
  }

  private settings(v: RemoteView): HTMLElement {
    const box = h('details', 'remote-block remote-more');
    box.append(h('summary', 'remote-title', t('remote.settings.title')));
    box.append(this.toggle(t('remote.autoAway'), t('remote.autoAway.hint'), v.autoAway, (on) => this.act(this.hub.remoteSet({ kind: 'autoAway', on }))));
    const max = this.field(t('remote.max'), t('remote.max.hint', { mb: v.wizard.memoryMb.total ? String(v.wizard.memoryMb.total) : '?' }));
    const sel = h('select', 'setup-select');
    for (let n = 1; n <= 8; n++) sel.append(new Option(String(n), String(n)));
    sel.value = String(v.max);
    sel.addEventListener('change', () => this.act(this.hub.remoteSet({ kind: 'max', value: Number(sel.value) })));
    max.append(sel);
    box.append(max);
    if (v.wizard.latencyMs) box.append(h('p', 'setup-hint', t('remote.latency', { ms: String(v.wizard.latencyMs) })));
    box.append(this.envSync(v));
    return box;
  }

  private phone(v: RemoteView): HTMLElement {
    const phone = h('div', 'remote-guide-body');
    if (v.ntfyUrl) {
      const code = h('div', 'remote-code');
      code.append(h('span', '', v.ntfyUrl), copyButton(() => v.ntfyUrl));
      const row = h('div', 'setup-row');
      row.append(
        this.button(t('remote.ntfy.test'), 'btn small', () => void this.hub.remoteTestNtfy()),
        this.button(t('remote.ntfy.off'), 'btn ghost small', () => this.act(this.hub.remoteSet({ kind: 'ntfy', on: false }))),
      );
      phone.append(code, row);
    } else phone.append(this.button(t('remote.ntfy.on'), 'btn small', () => this.act(this.hub.remoteSet({ kind: 'ntfy', on: true }))));
    phone.append(this.button(t('remote.guide.phone.app'), 'btn ghost small', () => this.hub.openExternal('https://ntfy.sh/')));
    return phone;
  }

  /** This PC's skills, plugins and CLAUDE.md copied to the server: by hand here, and by itself on stepping away. */
  private envSync(v: RemoteView): HTMLElement {
    const field = this.field(t('remote.env'), t('remote.env.hint'));
    const e = v.env;
    const time = e.at ? new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
    if (e.state === 'done') field.append(h('p', 'setup-hint', t('remote.env.done', { time, sent: String(e.sent), removed: String(e.removed), held: String(e.held.length) })));
    if (e.state === 'done' && e.pluginsFailed.length > 0) field.append(h('p', 'setup-hint', t('remote.env.plugins', { list: e.pluginsFailed.map((p) => p.split('@')[0]).join(', ') })));
    if (e.state === 'failed') field.append(h('p', 'setup-hint remote-fail', t(e.reason === 'refused' ? 'remote.env.refused' : 'remote.env.failed', { time })));
    const details = e.state === 'failed' ? e.detail : e.state === 'done' ? e.held.join('\n') : '';
    if (details) field.append(techDetails(details));
    const running = e.state === 'running';
    field.append(this.button(t(running ? 'remote.env.running' : 'remote.env.sync'), 'btn small', () => this.act(this.hub.remoteWizard('syncEnv')), running || !v.enabled));
    return field;
  }

  /** Switching it on before a move and off when unused (OVHcloud): this PC's key, then the server's own. */
  private power(v: RemoteView): HTMLElement {
    const box = h('div', 'remote-guide-body');
    const p = v.power;
    if (p.kind === 'ovh') {
      box.append(h('p', '', t('remote.power.ovh', { state: t(`remote.server.${v.server || 'unknown'}` as Key), hours: String(p.idleHours) })));
      box.append(this.selfOff(v));
      box.append(this.button(t('remote.power.forget'), 'btn ghost small', () => this.act(this.hub.remoteOvhForget())));
    } else {
      box.append(h('p', 'setup-hint', t('remote.power.always')));
      const o = { project: p.project, instance: p.instance, appKey: '', appSecret: '', consumerKey: '' };
      const ids = h('div', 'remote-ovh');
      ids.append(this.input(o.project, t('remote.ovh.project'), (x) => (o.project = x.trim())), this.input(o.instance, t('remote.ovh.instance'), (x) => (o.instance = x.trim())));
      const keys = h('div', 'remote-ovh');
      keys.append(
        this.input('', t('remote.ovh.appKey'), (x) => (o.appKey = x.trim())),
        this.input('', t('remote.ovh.appSecret'), (x) => (o.appSecret = x.trim()), 'password'),
        this.input('', t('remote.ovh.consumerKey'), (x) => (o.consumerKey = x.trim()), 'password'),
      );
      const make = this.button(t('remote.guide.power.make'), 'btn small', () => {
        if (o.project && o.instance) this.hub.openExternal(ovhTokenUrl(o.project, o.instance, ['start', 'stop', 'shelve', 'unshelve']));
      });
      const row = h('div', 'setup-row');
      row.append(this.button(t('remote.ovh.ask'), 'btn', () => this.act(this.hub.remoteOvh(o))));
      if (p.pending) row.append(this.button(t('remote.ovh.confirm'), 'btn primary', () => this.act(this.hub.remoteOvhConfirm())));
      box.append(h('p', 'setup-hint', t('remote.guide.power.ids')), ids, make, keys, row);
    }
    const hourly = OVH_HOURLY['d2-8'];
    box.append(h('p', 'setup-hint', t('remote.cost', { h2: monthCost(60, hourly).toFixed(2), h5: monthCost(150, hourly).toFixed(2), full: monthCost(730, hourly).toFixed(2) })));
    return box;
  }

  /** The server's own key, which may only switch it off: it does so while the PC is away too. */
  private selfOff(v: RemoteView): HTMLElement {
    const p = v.power;
    const f = this.field(t('remote.selfOff'), t('remote.selfOff.hint', { hours: String(p.idleHours) }));
    if (p.selfOff) {
      f.append(h('p', '', t('remote.selfOff.on')), this.button(t('remote.selfOff.off'), 'btn ghost small', () => this.act(this.hub.remoteServerPower({ off: true }))));
      return f;
    }
    const o = { appKey: '', appSecret: '', consumerKey: '' };
    const keys = h('div', 'remote-ovh');
    keys.append(
      this.input('', t('remote.ovh.appKey'), (x) => (o.appKey = x.trim())),
      this.input('', t('remote.ovh.appSecret'), (x) => (o.appSecret = x.trim()), 'password'),
      this.input('', t('remote.ovh.consumerKey'), (x) => (o.consumerKey = x.trim()), 'password'),
    );
    f.append(
      this.button(t('remote.selfOff.make'), 'btn small', () => this.hub.openExternal(ovhTokenUrl(p.project, p.instance, ['shelve']))),
      keys,
      this.button(t('remote.selfOff.send'), 'btn primary small', () => this.act(this.hub.remoteServerPower(o))),
    );
    return f;
  }
}
