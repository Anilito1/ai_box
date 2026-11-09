import { monthCost, OVH_HOURLY, REMOTE_SECRETS, VPS_STEPS, type RemoteView, type VpsStepId } from '../shared/vps';
import type { AwayView, HubApi } from '../shared/types';
import { copyButton, h, icon, ICONS, techDetails } from './dom';
import { t, type Key } from './i18n';

// Settings › Remote server (experimental) and the "I'm stepping away" button. Both exist only once the user opened the
// section (from the command palette) or set a server up: with remote workers off, the window is as it always was.

const DETAIL_KEYS = new Set([
  'target', 'no-ssh', 'keygen', 'acl', 'unreachable', 'fingerprint', 'hostChanged', 'pasteKey', 'noSudo', 'installed', 'done',
  'workerKey', 'upload', 'setup', 'lockedOut', 'worker', 'launcherVersion', 'noClaude', 'code', 'login', 'repos', 'noRepos', 'token', 'refused',
]);

/** The header button: "I'm stepping away", "I'm back", or what is under way. Hidden while remote workers are off. */
export class AwayButton {
  readonly el = h('button', 'ph-settings ph-away');

  constructor(private readonly hub: HubApi) {
    this.el.hidden = true;
    this.el.addEventListener('click', () => {
      if (this.el.dataset.phase === 'away') this.hub.awayBack();
      else if (!this.el.dataset.phase) this.hub.awayLeave();
    });
  }

  update(away: AwayView | undefined): void {
    this.el.hidden = !away;
    if (!away) return;
    const phase = away.phase ?? '';
    if (this.el.dataset.phase === phase && this.el.childElementCount > 0) return;
    this.el.dataset.phase = phase;
    const label = t(phase === 'away' ? 'away.btn.back' : phase === 'leaving' ? 'away.btn.leaving' : phase === 'returning' ? 'away.btn.returning' : 'away.btn.leave');
    this.el.replaceChildren(icon(ICONS.cloud), h('span', '', label));
    this.el.title = t(phase === 'away' ? 'away.btn.back.hint' : 'away.btn.leave.hint');
    this.el.disabled = phase === 'leaving' || phase === 'returning';
    this.el.classList.toggle('on', phase === 'away');
  }
}

/** Settings › Remote server: the setup's steps, then the server's settings once it works. */
export class RemoteSection {
  private view: RemoteView | null = null;
  private target = { host: '', admin: 'ubuntu', port: '22' };
  private error = '';
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
    el.append(this.connection(v), this.access(v), this.steps(v));
    if (v.wizard.target && (v.enabled || v.wizard.steps.save.state === 'ok')) el.append(this.settings(v), this.power(v));
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

  private connection(v: RemoteView): HTMLElement {
    const box = h('div', 'remote-block');
    box.append(h('h3', 'remote-title', t('remote.connect.title')));
    if (v.wizard.adminKey) {
      const key = this.field(t('remote.adminKey'), t('remote.adminKey.hint'));
      const code = h('div', 'remote-code');
      code.append(h('span', '', v.wizard.adminKey), copyButton(() => v.wizard.adminKey));
      key.append(code);
      box.append(key);
    }
    const row = h('div', 'setup-row remote-target');
    row.append(
      this.input(this.target.host, t('remote.host.placeholder'), (x) => (this.target.host = x.trim())),
      this.input(this.target.admin, 'ubuntu', (x) => (this.target.admin = x.trim())),
      this.input(this.target.port, '22', (x) => (this.target.port = x.trim())),
      this.button(t(v.wizard.target ? 'remote.rerun' : 'remote.connect'), 'btn primary', () => this.act(this.hub.remoteWizard('run', { host: this.target.host, admin: this.target.admin, port: Number(this.target.port) })), v.wizard.running),
    );
    const f = this.field(t('remote.target'), t('remote.target.hint'));
    f.append(row);
    box.append(f);
    return box;
  }

  private steps(v: RemoteView): HTMLElement {
    const w = v.wizard;
    const list = h('ol', 'remote-steps');
    for (const id of VPS_STEPS) {
      const step = w.steps[id];
      const li = h('li', `remote-step ${step.state}`);
      li.append(icon(step.state === 'ok' ? ICONS.check : step.state === 'fail' ? ICONS.shield : ICONS.minus), h('span', 'remote-step-name', t(`remote.step.${id}` as Key)));
      const detail = this.detail(id, step.detail, v);
      if (detail) li.append(h('span', 'remote-step-detail', detail));
      list.append(li);
      const extra = this.waitBox(id, v);
      if (extra) list.append(extra);
    }
    const box = h('div', 'remote-block');
    box.append(list);
    if (w.log.length > 0) box.append(techDetails(w.log.join('\n')));
    return box;
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
      if (step.detail === 'token') box.append(h('div', 'setup-hint', t('remote.repos.token')), this.secretRow(v, 'personal', 'GH_TOKEN'));
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

  /** The repos the server may hold, the owners it never may, the organisations; and the tokens of each scope. */
  private access(v: RemoteView): HTMLElement {
    const box = h('div', 'remote-block');
    box.append(h('h3', 'remote-title', t('remote.access.title')));
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
    const box = h('div', 'remote-block');
    box.append(h('h3', 'remote-title', t('remote.settings.title')));
    box.append(this.toggle(t('remote.enabled'), t('remote.enabled.hint'), v.enabled, (on) => this.act(this.hub.remoteSet({ kind: 'enabled', on }))));
    box.append(this.toggle(t('remote.autoAway'), t('remote.autoAway.hint'), v.autoAway, (on) => this.act(this.hub.remoteSet({ kind: 'autoAway', on }))));
    const max = this.field(t('remote.max'), t('remote.max.hint', { mb: v.wizard.memoryMb.total ? String(v.wizard.memoryMb.total) : '?' }));
    const sel = h('select', 'setup-select');
    for (let n = 1; n <= 8; n++) sel.append(new Option(String(n), String(n)));
    sel.value = String(v.max);
    sel.addEventListener('change', () => this.act(this.hub.remoteSet({ kind: 'max', value: Number(sel.value) })));
    max.append(sel);
    box.append(max);
    if (v.wizard.latencyMs) box.append(h('p', 'setup-hint', t('remote.latency', { ms: String(v.wizard.latencyMs) })));
    const phone = this.field(t('remote.ntfy'), t('remote.ntfy.hint'));
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
    box.append(phone);
    return box;
  }

  private power(v: RemoteView): HTMLElement {
    const box = h('div', 'remote-block');
    box.append(h('h3', 'remote-title', t('remote.power.title')));
    const p = v.power;
    if (p.kind === 'ovh') {
      box.append(h('p', '', t('remote.power.ovh', { state: t(`remote.server.${v.server || 'unknown'}` as Key), hours: String(p.idleHours) })));
      box.append(this.button(t('remote.power.forget'), 'btn ghost small', () => this.act(this.hub.remoteOvhForget())));
    } else {
      box.append(h('p', 'setup-hint', t('remote.power.always')));
      const o = { project: p.project, instance: p.instance, appKey: '', appSecret: '', consumerKey: '' };
      const grid = h('div', 'remote-ovh');
      grid.append(
        this.input(o.project, t('remote.ovh.project'), (x) => (o.project = x.trim())),
        this.input(o.instance, t('remote.ovh.instance'), (x) => (o.instance = x.trim())),
        this.input('', t('remote.ovh.appKey'), (x) => (o.appKey = x.trim())),
        this.input('', t('remote.ovh.appSecret'), (x) => (o.appSecret = x.trim()), 'password'),
        this.input('', t('remote.ovh.consumerKey'), (x) => (o.consumerKey = x.trim()), 'password'),
      );
      const row = h('div', 'setup-row');
      row.append(this.button(t('remote.ovh.ask'), 'btn', () => this.act(this.hub.remoteOvh(o))));
      if (p.pending) row.append(this.button(t('remote.ovh.confirm'), 'btn primary', () => this.act(this.hub.remoteOvhConfirm())));
      const f = this.field(t('remote.ovh'), t('remote.ovh.hint'));
      f.append(grid, row);
      box.append(f);
    }
    const hourly = OVH_HOURLY['d2-8'];
    const cost = h('p', 'setup-hint', t('remote.cost', { h2: monthCost(60, hourly).toFixed(2), h5: monthCost(150, hourly).toFixed(2), full: monthCost(730, hourly).toFixed(2) }));
    box.append(cost);
    return box;
  }
}
