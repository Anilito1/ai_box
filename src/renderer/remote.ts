import { encode } from 'uqr';
import type { HubApi, RemoteView, SessionView } from '../shared/types';
import { copyButton, h, icon, ICONS } from './dom';
import { t } from './i18n';

const SVG = 'http://www.w3.org/2000/svg';

/** The QR code of a link as one SVG path: no markup is ever made from text. */
export function qrCode(text: string): SVGSVGElement {
  const { data, size } = encode(text, { ecc: 'M', border: 2 });
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'remote-qr');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('remote.qr'));
  const back = document.createElementNS(SVG, 'rect');
  back.setAttribute('width', String(size));
  back.setAttribute('height', String(size));
  back.setAttribute('fill', '#fff');
  const dots = document.createElementNS(SVG, 'path');
  let d = '';
  data.forEach((row, y) => row.forEach((dark, x) => (d += dark ? `M${x} ${y}h1v1h-1z` : '')));
  dots.setAttribute('d', d);
  dots.setAttribute('fill', '#000');
  svg.append(back, dots);
  return svg;
}

/** What Remote Control is doing, in a few words: what the program said, never a guess. */
export function remoteLabel(r: RemoteView): string {
  if (r.state === 'on') return t(r.connected ? 'remote.connected' : 'remote.ready');
  return t(`remote.${r.state}`);
}

/** Its tone: live once connected, waiting while it gets there or comes back. */
const toneOf = (r: RemoteView) => (r.state === 'on' && r.connected ? 'on' : r.state === 'reconnecting' ? 'warn' : 'wait');

/**
 * The Remote Control of the composer's session: a chip in the composer bar while it is on, and its panel (the link,
 * its QR code for the Claude app, its state, the permissions it is driven with, the button that turns it off).
 */
export class RemoteControl {
  readonly chip = h('button', 'cbtn cbtn-remote');
  readonly panel = h('div', 'remote-panel');
  private session: SessionView | null = null;
  private key = '';
  /** Asked open as it is being turned on: it opens once the session says so. */
  private wanted = false;

  constructor(private readonly hub: HubApi) {
    this.chip.hidden = true;
    this.panel.hidden = true;
    this.chip.title = t('remote.chipTip');
    this.chip.setAttribute('aria-haspopup', 'dialog');
    this.chip.addEventListener('click', () => (this.panel.hidden ? this.open() : this.close()));
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', t('remote.title'));
    this.panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.close();
    });
  }

  open(): void {
    this.wanted = !this.session?.remote;
    if (this.wanted) return;
    this.panel.hidden = false;
    this.chip.setAttribute('aria-expanded', 'true');
  }

  close(): void {
    this.panel.hidden = true;
    this.chip.setAttribute('aria-expanded', 'false');
  }

  /** Redrawn only when what it shows changed: a snapshot comes at every turn of every session. */
  update(s: SessionView | null, switched: boolean): void {
    this.session = s;
    // Shown for the session that asked: it closes when another one comes in the composer.
    if (switched) {
      this.wanted = false;
      this.close();
    }
    const r = s?.remote ?? null;
    if (!r) this.close();
    const key = JSON.stringify([s?.id, r, s?.mode]);
    if (key === this.key) return;
    this.key = key;
    this.chip.hidden = !r;
    if (!s || !r) return this.panel.replaceChildren();
    this.chip.className = `cbtn cbtn-remote ${toneOf(r)}`;
    this.chip.replaceChildren(icon(ICONS.phone), h('span', '', t('remote.chip')), h('span', `remote-dot ${toneOf(r)}`));
    this.draw(s, r);
    if (this.wanted) this.open();
  }

  private draw(s: SessionView, r: RemoteView): void {
    const head = h('div', 'remote-head');
    const close = h('button', 'icon-btn');
    close.title = t('remote.hide');
    close.setAttribute('aria-label', close.title);
    close.append(icon(ICONS.remove));
    close.addEventListener('click', () => this.close());
    head.append(h('span', `remote-dot ${toneOf(r)}`), h('span', 'remote-title', t('remote.title')), h('span', 'remote-state', remoteLabel(r)), h('span', 'spacer'), close);

    const body = h('div', 'remote-body');
    const text = h('div', 'remote-text');
    if (r.url) {
      body.append(qrCode(r.url));
      const link = h('div', 'remote-link');
      const shown = h('span', 'remote-url', r.url.replace(/^https:\/\//, ''));
      shown.title = r.url;
      const openBtn = h('button', 'btn small');
      openBtn.append(icon(ICONS.external), h('span', '', t('remote.open')));
      openBtn.addEventListener('click', () => this.hub.openExternal(r.url));
      link.append(shown, copyButton(() => r.url, t('remote.copy')), openBtn);
      text.append(h('p', 'remote-hint', t('remote.hint')), link);
    } else {
      text.append(h('p', 'remote-hint', t('remote.waiting')));
    }
    const bypass = s.mode === 'bypassPermissions';
    text.append(h('p', bypass ? 'remote-mode danger' : 'remote-mode', bypass ? t('remote.bypass') : t('remote.mode', { mode: t(`mode.${s.mode ?? 'default'}`) })));
    const stop = h('button', 'btn small danger', t(r.state === 'stopping' ? 'remote.stopping' : 'remote.stop'));
    stop.disabled = r.state === 'stopping';
    stop.addEventListener('click', () => this.hub.setRemote(s.id, false));
    text.append(stop);
    body.append(text);
    this.panel.replaceChildren(head, body);
  }
}
