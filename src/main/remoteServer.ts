import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { HubConfig } from './config';
import { remoteOf as originOf } from './repos';
import { mainRepoPath } from './config';
import type { Secrets } from './secrets';
import type { RemoteServerControl, SessionManager } from './sessions';
import { alwaysOn, askConsumerKey, ovhPower, switchOn, type PowerControl, type PowerState } from './power';
import { parseRemote, remoteLatency, remoteStatus, sendNtfy } from './remote';
import { newTopic, realExec, realTty, VpsWizard } from './vps';
import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { installationToken } from './githubApp';
import { EnvSyncError, personalRepos, sshEnvExec, syncEnvironment } from './remote/envSync';
import { isOwner, isPersonalGithubToken, isRemoteSecret, isSecretValue, isSlug, ntfyUrl, personalSecrets, REMOTE_SECRETS, scopeOf, type RemoteView, type SecretScope } from '../shared/vps';
import type { AwayView } from '../shared/types';

// The remote server as the app runs it: its setup (Settings › Remote server), its power (switched on before a move,
// off once nobody works there), and stepping away by hand or when the screen locks. Nothing here starts while remote
// workers are off: no timer, no connection, no process.

// An unshelve of a set-up d2-8 took 9 to 10 minutes up to SSH (SBG5); a shelve still under way ends first.
const WAKE_MS = 20 * 60_000;
const GUARD_MS = 10 * 60_000;
const IDLE_AWAY_S = 10 * 60;

export class RemoteServer implements RemoteServerControl {
  private wizardInst: VpsWizard | null = null;
  private power: PowerState = 'unknown';
  private lastBusy = Date.now();
  private guard: NodeJS.Timeout | null = null;
  private idleWatch: NodeJS.Timeout | null = null;
  /** A consumer key waiting for the user to validate it on OVH's page. */
  private pendingCk = '';
  private started = false;

  constructor(
    private readonly o: {
      cfg: HubConfig;
      secrets: Secrets;
      scripts: string;
      save(): void;
      send(state: RemoteView): void;
      openExternal(url: string): void;
      /** Keeps the PC awake while workers move (Electron's powerSaveBlocker). */
      keepAwake(): () => void;
      idleSeconds(): number;
      /** A dialog of the main process: the user confirms this server's fingerprint. */
      confirmHost(host: string, fingerprint: string): Promise<boolean>;
    },
  ) {}

  /** Set by the hub once its session manager exists. */
  mgr: SessionManager | null = null;

  private get r() {
    return this.o.cfg.remoteWorkers;
  }

  private wizard(): VpsWizard {
    this.wizardInst ??= new VpsWizard({
      exec: realExec,
      tty: realTty,
      home: homedir(),
      scripts: this.o.scripts,
      platform: process.platform,
      user: userInfo().username,
      current: () => this.r,
      save: (r) => {
        this.o.cfg.remoteWorkers = parseRemote(r);
        this.o.save();
        this.start();
      },
      mainRepos: () => this.o.cfg.mainRepos.map((p) => mainRepoPath(this.o.cfg, p)),
      originOf,
      token: () => {
        const gh = this.o.secrets.get('remote:personal:GH_TOKEN');
        return isPersonalGithubToken(gh) ? gh : '';
      },
      status: remoteStatus,
      latency: remoteLatency,
      onChange: () => this.push(),
    });
    return this.wizardInst;
  }

  view(): RemoteView {
    const p = this.r.power;
    return {
      wizard: this.wizard().state(),
      enabled: this.r.enabled,
      ntfyUrl: this.r.ntfy ? ntfyUrl(this.r.ntfy) : '',
      autoAway: this.r.autoAway,
      max: this.r.max,
      power: { kind: p.kind, project: p.project, instance: p.instance, idleHours: p.idleHours, keys: this.keys() !== null, pending: this.pendingCk !== '' },
      server: this.state(),
      lists: { allowed: this.r.allowed, denied: this.r.denied, orgs: this.r.orgs },
      secrets: {
        // A GitHub token saved before only fine-grained ones were taken (classic): not shown as set, since none is used.
        personal: REMOTE_SECRETS.filter((n) => (n === 'GH_TOKEN' ? isPersonalGithubToken(this.o.secrets.get('remote:personal:GH_TOKEN')) : this.o.secrets.has(`remote:personal:${n}`))),
        org: REMOTE_SECRETS.filter((n) => this.o.secrets.has(`remote:org:${n}`)),
      },
      app: { ...this.r.app, key: this.o.secrets.has('githubAppKey') },
      env: this.env,
    };
  }

  private env: RemoteView['env'] = { state: 'idle', at: 0, sent: 0, removed: 0, held: [], pluginsFailed: [], reason: '', detail: '' };

  /**
   * This PC's Claude environment to the server (remote/envSync.ts), within `limitMs`; `wake`: switched on first if
   * it sleeps (the button; stepping away has just woken it). Never throws: a failure is shown in Settings, and the
   * caller (stepping away) goes on without it.
   */
  async syncEnv(limitMs = 5 * 60_000, wake = false): Promise<void> {
    if (!this.r.enabled || this.env.state === 'running') return;
    this.env = { ...this.env, state: 'running' };
    this.push();
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), limitMs);
    try {
      if (wake && ['unreachable', 'off'].includes((await this.wake()) ?? '')) throw new EnvSyncError('unreachable', 'server not answering');
      const rep = await syncEnvironment(sshEnvExec(this.r, stop.signal), { repos: personalRepos(this.r, originOf), forbid: [this.r.host, ...this.r.orgs, ...this.r.denied] });
      const held = rep.skipped.map((s) => `${s.path.replace(/^\.claude\//, '')} (${s.why})`).slice(0, 50);
      this.env = { state: 'done', at: Date.now(), sent: rep.sent, removed: rep.removed, held, pluginsFailed: rep.pluginsFailed, reason: '', detail: '' };
    } catch (err) {
      const e = err instanceof EnvSyncError ? err : new EnvSyncError('unreachable', stop.signal.aborted ? 'took too long' : 'no answer');
      this.env = { ...this.env, state: 'failed', at: Date.now(), reason: e.reason, detail: e.detail };
    } finally {
      clearTimeout(timer);
    }
    this.push();
  }

  private push(): void {
    this.o.send(this.view());
  }

  async wizardAction(action: unknown, arg?: unknown): Promise<RemoteView> {
    const w = this.wizard();
    if (action === 'run') void w.run(arg);
    else if (action === 'retry') void w.run();
    // Trusting a server is asked again by this process, out of the page's reach, with the fingerprint shown.
    else if (action === 'trust' && typeof arg === 'string' && arg === w.state().fingerprint && (await this.o.confirmHost(w.state().target?.host ?? '', arg))) void w.trust(arg);
    else if (action === 'forget') void w.forget();
    else if (action === 'code') w.code(arg);
    else if (action === 'cancel') w.cancel();
    // Switched on first if it sleeps; unreachable, the sync fails and says so.
    else if (action === 'syncEnv') void this.syncEnv(undefined, true);
    return this.view();
  }

  /** A change from the window, checked field by field: anything else is ignored. */
  async set(raw: unknown): Promise<RemoteView> {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<'kind' | 'on' | 'value' | 'allowed' | 'denied' | 'orgs', unknown>>;
    const r = this.r;
    const on = s.on === true;
    const value = typeof s.value === 'number' && Number.isFinite(s.value) ? s.value : NaN;
    // As parseRemote wants it: never on without the server's own recorded key.
    if (s.kind === 'enabled') r.enabled = on && !!r.host && !!r.key && !!r.knownHosts;
    if (s.kind === 'autoAway') r.autoAway = on;
    if (s.kind === 'max' && Number.isInteger(value) && value >= 1 && value <= 16) r.max = value;
    if (s.kind === 'ntfy') r.ntfy = on ? newTopic() : '';
    if (s.kind === 'idleHours' && value >= 0.5 && value <= 48) r.power.idleHours = value;
    if (s.kind === 'repos') {
      const list = (v: unknown, ok: (x: unknown) => boolean) => (Array.isArray(v) ? [...new Set(v.filter(ok) as string[])].slice(0, 50) : []);
      r.allowed = list(s.allowed, isSlug);
      r.denied = list(s.denied, isOwner);
      r.orgs = list(s.orgs, isOwner);
    }
    this.o.save();
    if (r.enabled) this.start();
    else this.halt();
    this.push();
    return this.view();
  }

  // ---------- tokens of the remote workers, by scope ----------

  /** A token a remote worker of this scope gets in memory (null: removed). Checked here, kept in the keychain. */
  async setSecret(raw: unknown): Promise<RemoteView> {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const scope = o.scope === 'org' ? 'org' : o.scope === 'personal' ? 'personal' : null;
    if (!scope || !isRemoteSecret(o.name) || (o.value !== null && !isSecretValue(o.value))) throw new Error('invalid');
    // An organisation's GitHub access is its App's token, made at each launch: never a token of the user's.
    if (scope === 'org' && o.name === 'GH_TOKEN') throw new Error('invalid');
    // The user's: fine-grained only, limited to the repos they chose.
    if (o.name === 'GH_TOKEN' && o.value !== null && !isPersonalGithubToken(o.value)) throw new Error('invalid');
    await this.o.secrets.set(`remote:${scope}:${o.name}`, o.value as string | null);
    return this.view();
  }

  /** The organisation's GitHub App: its id and organisation (settings), its private key (keychain). */
  async setApp(raw: unknown): Promise<RemoteView> {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    if (!/^\d{1,12}$/.test(id) || !isOwner(o.org) || !/^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]{100,8000}-----END (RSA )?PRIVATE KEY-----$/.test(key)) throw new Error('invalid');
    // Kept only if GitHub gives a token with it.
    await installationToken(id, key, o.org);
    await this.o.secrets.set('githubAppKey', key);
    this.r.app = { id, org: o.org };
    if (!this.r.orgs.includes(o.org)) this.r.orgs.push(o.org);
    this.o.save();
    return this.view();
  }

  private appToken: { org: string; token: string; expiresAt: number } | null = null;

  async secretsFor(slug: string): Promise<Record<string, string> | 'org' | 'token'> {
    const scope: SecretScope = scopeOf(slug, this.r.orgs);
    // The user's repo: their fine-grained token from the keychain, or no remote worker (never a token of this PC's).
    if (scope === 'personal') return personalSecrets((name) => this.o.secrets.get(`remote:personal:${name}`));
    const out: Record<string, string> = {};
    for (const name of REMOTE_SECRETS) {
      const v = this.o.secrets.get(`remote:org:${name}`);
      if (v) out[name] = v;
    }
    // An organisation's repo: its App's one-hour token, or no remote worker for it.
    const { id, org } = this.r.app;
    const key = this.o.secrets.get('githubAppKey');
    if (!id || !key || org.toLowerCase() !== slug.split('/')[0].toLowerCase()) return 'org';
    if (!this.appToken || this.appToken.org !== org || this.appToken.expiresAt - Date.now() < 50 * 60_000) {
      try {
        this.appToken = { org, ...(await installationToken(id, key, org)) };
      } catch {
        return 'org';
      }
    }
    out.GH_TOKEN = this.appToken.token;
    return out;
  }

  /**
   * Keys the user handed over before this version ran (OVH, GitHub), kept encrypted for this Windows account in
   * %LOCALAPPDATA%\\aibox-vps: moved into the app's keychain once, then deleted.
   */
  private async importHanded(): Promise<void> {
    if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return;
    const dir = join(process.env.LOCALAPPDATA, 'aibox-vps');
    const read = (name: string) =>
      new Promise<string>((done) => {
        const file = join(dir, `${name}.dpapi`);
        if (!existsSync(file)) return done('');
        const ps = `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${file.replace(/'/g, "''")}'), $null, 'CurrentUser'))`;
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 }, (err, out) => done(err ? '' : String(out).trim()));
      });
    const gh = await read('gh-personal');
    if (isPersonalGithubToken(gh)) {
      await this.o.secrets.set('remote:personal:GH_TOKEN', gh);
      rmSync(join(dir, 'gh-personal.dpapi'), { force: true });
    }
    const ovh = await read('ovh');
    if (ovh) {
      try {
        const o = JSON.parse(ovh) as Record<string, unknown>;
        await this.setOvh(o);
        rmSync(join(dir, 'ovh.dpapi'), { force: true });
      } catch {
        // Kept for the next start: a key OVH refuses now may be accepted once the network is back.
      }
    }
  }

  testNotification(): Promise<boolean> {
    return sendNtfy(this.r.ntfy, 'AI Box : notification de test.');
  }

  // ---------- power ----------

  private keys() {
    const appKey = this.o.secrets.get('ovhAppKey');
    const appSecret = this.o.secrets.get('ovhAppSecret');
    const consumerKey = this.o.secrets.get('ovhConsumerKey');
    return appKey && appSecret && consumerKey ? { appKey, appSecret, consumerKey } : null;
  }

  private control(): PowerControl {
    const keys = this.keys();
    return this.r.power.kind === 'ovh' && keys ? ovhPower(this.r.power, keys) : alwaysOn;
  }

  /**
   * OVHcloud Public Cloud: the instance's ids and the application's keys; a consumer key limited to that instance is
   * asked, and OVH's page opens for the user to validate it.
   */
  async setOvh(raw: unknown): Promise<RemoteView> {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = /^[a-z0-9-]{8,64}$/i;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const [project, instance, appKey, appSecret] = [str(o.project), str(o.instance), str(o.appKey), str(o.appSecret)];
    if (!id.test(project) || !id.test(instance) || !/^[A-Za-z0-9]{8,64}$/.test(appKey) || !/^[A-Za-z0-9]{16,64}$/.test(appSecret)) throw new Error('invalid');
    const power = { ...this.r.power, kind: 'ovh' as const, project, instance };
    // A token made at createToken comes with its consumer key: kept once it really reads the instance.
    const given = str(o.consumerKey);
    if (/^[A-Za-z0-9]{16,64}$/.test(given)) {
      if ((await ovhPower(power, { appKey, appSecret, consumerKey: given }).state()) === 'unknown') throw new Error('not-validated');
      for (const [k, v] of [['ovhAppKey', appKey], ['ovhAppSecret', appSecret], ['ovhConsumerKey', given]] as const) await this.o.secrets.set(k, v);
      this.r.power = power;
      this.o.save();
      this.start();
      return this.view();
    }
    const { validationUrl, consumerKey } = await askConsumerKey(appKey, power);
    await this.o.secrets.set('ovhAppKey', appKey);
    await this.o.secrets.set('ovhAppSecret', appSecret);
    this.pendingCk = consumerKey;
    this.r.power = { ...power, kind: 'always' };
    this.o.save();
    this.o.openExternal(validationUrl);
    return this.view();
  }

  /** After the validation on OVH's page: the key is kept only if it really reads the instance. */
  async confirmOvh(): Promise<RemoteView> {
    if (!this.pendingCk) return this.view();
    const keys = { appKey: this.o.secrets.get('ovhAppKey'), appSecret: this.o.secrets.get('ovhAppSecret'), consumerKey: this.pendingCk };
    const state = await ovhPower({ ...this.r.power, kind: 'ovh' }, keys).state();
    if (state === 'unknown') throw new Error('not-validated');
    await this.o.secrets.set('ovhConsumerKey', this.pendingCk);
    this.pendingCk = '';
    this.r.power.kind = 'ovh';
    this.power = state;
    this.o.save();
    this.start();
    return this.view();
  }

  async forgetOvh(): Promise<RemoteView> {
    for (const k of ['ovhAppKey', 'ovhAppSecret', 'ovhConsumerKey'] as const) await this.o.secrets.set(k, null);
    this.r.power.kind = 'always';
    this.pendingCk = '';
    this.o.save();
    return this.view();
  }

  state(): AwayView['server'] {
    if (this.r.power.kind !== 'ovh') return '';
    if (this.power === 'on') return this.mgr?.remoteBusy() ? 'busy' : 'ready';
    return this.power;
  }

  /** Switched on and answering SSH, or why not. A real answer of the server ends the wait, never a timer alone. */
  async wake(): Promise<string | null> {
    // Always on: nothing to switch, and the request that follows says itself whether the server answers.
    if (this.r.power.kind !== 'ovh') return null;
    if (this.power === 'on' && this.mgr?.remoteBusy()) return null;
    // A shelve still under way ends first; an unshelve OVH drops is asked again while time is left.
    const r = await switchOn(this.control(), {
      timeoutMs: WAKE_MS,
      answer: () => remoteStatus(this.r),
      seen: (s) => {
        if (s === this.power) return;
        this.power = s;
        this.push();
      },
    });
    if ('why' in r) return r.why === 'off' ? 'off' : 'unreachable';
    this.power = 'on';
    this.lastBusy = Date.now();
    this.push();
    return r.answer.signedIn ? null : 'login';
  }

  idle(): void {
    if (this.r.power.kind !== 'ovh' || this.mgr?.remoteBusy()) return;
    void this.switchOff();
  }

  private async switchOff(): Promise<void> {
    try {
      this.power = 'stopping';
      this.push();
      await this.control().stop();
      this.power = await this.control().state();
    } catch {
      this.power = 'unknown';
    }
    this.push();
  }

  // ---------- watching ----------

  /** Remote workers on: the guard (power) and the automatic step-away (lock, idle). Called again after a change. */
  start(): void {
    if (!this.r.enabled) return this.halt();
    const first = !this.started;
    this.started = true;
    // Once per run: the keys handed over, and the turns left alone on the server while the app was closed.
    if (first) void this.importHanded().then(() => this.push());
    if (first) void this.mgr?.checkDetached();
    if (this.r.power.kind === 'ovh' && !this.guard) {
      this.guard = setInterval(() => void this.checkGuard(), GUARD_MS);
      void this.control()
        .state()
        .then((s) => {
          this.power = s;
          this.push();
        });
    }
    if (this.r.autoAway && !this.idleWatch) this.idleWatch = setInterval(() => this.checkIdle(), 60_000);
    if (!this.r.autoAway && this.idleWatch) {
      clearInterval(this.idleWatch);
      this.idleWatch = null;
    }
  }

  private halt(): void {
    if (this.guard) clearInterval(this.guard);
    if (this.idleWatch) clearInterval(this.idleWatch);
    this.guard = null;
    this.idleWatch = null;
  }

  /** Off after its idle delay without a remote worker: a forgotten server does not run all month. */
  private async checkGuard(): Promise<void> {
    if (this.mgr?.remoteBusy()) {
      this.lastBusy = Date.now();
      return;
    }
    this.power = await this.control().state();
    if (this.power === 'on' && Date.now() - this.lastBusy > this.r.power.idleHours * 3_600_000) await this.switchOff();
    this.push();
  }

  private checkIdle(): void {
    if (this.o.idleSeconds() >= IDLE_AWAY_S) this.autoAway();
  }

  /** The screen locked (or the PC sat idle) while workers are at work: the user is leaving. */
  autoAway(): void {
    if (!this.r.enabled || !this.r.autoAway || !this.mgr || this.mgr.awayPhase() !== null || this.mgr.awayCandidates() === 0) return;
    void this.stepAway(true);
  }

  async stepAway(auto: boolean): Promise<void> {
    if (!this.mgr) return;
    const release = this.o.keepAwake();
    try {
      await this.mgr.stepAway(auto);
    } finally {
      release();
    }
  }

  async comeBack(): Promise<void> {
    if (!this.mgr) return;
    const release = this.o.keepAwake();
    try {
      await this.mgr.comeBack();
    } finally {
      release();
    }
  }

  /** The PC woke up: the turns left alone on the server are looked at now. */
  resumed(): void {
    if (this.r.enabled) void this.mgr?.checkDetached();
  }
}

export const scriptsDir = (here: string) => join(here, '..', 'scripts', 'vps');
