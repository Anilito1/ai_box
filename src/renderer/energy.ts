import { BATTERY_FLOORS, type EnergySettings, type EnergyView } from '../shared/energy';
import type { HubApi, SettingsPatch } from '../shared/types';
import { h, icon, ICONS } from './dom';
import { LANG, t, type Key } from './i18n';

// Settings › Energy: what keeps the PC awake now, the switches (while workers work, lid closed), the battery guard,
// a hold of the user's own, and why a capability is missing on this PC, beside its switch.

/** The status bar's word for the energy state: kept awake (lid closed or not), or let go by the battery guard. */
export function energyBadge(v: EnergyView | null): { text: string; tone: 'ok' | 'warn'; title: string } | null {
  if (!v) return null;
  if (v.guard) return { text: t('sb.energy.guard'), tone: 'warn', title: [t('energy.state.guard'), t('energy.guard'), t('sb.energy.hint')].join('\n') };
  if (!v.awake) return null;
  const why = v.reasons.map((r) => t(`energy.why.${r}` as Key)).join(', ');
  const text = t(v.lidClosed ? 'sb.energy.lid' : 'sb.energy.awake');
  return { text, tone: 'ok', title: [t(v.lidClosed ? 'energy.state.lid' : 'energy.state.awake'), why, t('sb.energy.hint')].filter(Boolean).join('\n') };
}

export class EnergySection {
  private view: EnergyView | null = null;
  private redraw: () => void = () => {};

  constructor(private readonly hub: HubApi) {
    hub.onEnergy((v) => {
      this.view = v;
      this.redraw();
    });
  }

  render(el: HTMLElement, s: EnergySettings, save: (patch: SettingsPatch) => void, redraw: () => void): void {
    this.redraw = redraw;
    if (!this.view) {
      void this.hub.energyState().then((v) => {
        this.view = v;
        redraw();
      });
      el.append(h('p', 'setup-hint', t('energy.loading')));
      return;
    }
    const v = this.view;
    const caps = v.caps;
    if (!caps?.holdAwake) {
      el.append(h('div', 'setup-status warn', t('energy.unsupported')));
      for (const note of caps?.notes ?? []) el.append(h('p', 'setup-hint', note));
      return;
    }
    el.append(this.status(v));
    const why = caps.why ?? {};

    el.append(
      this.toggle(t('energy.whileWorking'), t('energy.whileWorking.hint'), s.whileWorking, null, (on) => save({ energy: { whileWorking: on } })),
      this.toggle(
        t('energy.lidClosed'),
        t('energy.lidClosed.hint'),
        s.lidClosed && caps.lidClosedAwake,
        caps.lidClosedAwake ? null : (why.lidClosedAwake ?? t('energy.lidUnavailable')),
        (on) => save({ energy: { lidClosed: on } }),
      ),
    );

    const floor = h('div', `setup-field${caps.battery ? '' : ' energy-off'}`);
    floor.append(h('div', 'setup-label', t('energy.floor')), h('div', 'setup-hint', t('energy.floor.hint')));
    const select = h('select', 'setup-select');
    select.setAttribute('aria-label', t('energy.floor'));
    for (const n of [...new Set([...BATTERY_FLOORS, s.batteryFloor])].sort((a, b) => a - b)) select.append(new Option(t('energy.floor.n', { n }), String(n)));
    select.value = String(s.batteryFloor);
    select.disabled = !caps.battery;
    select.addEventListener('change', () => save({ energy: { batteryFloor: Number(select.value) } }));
    floor.append(select);
    if (!caps.battery) floor.append(this.why(why.battery ?? t('energy.noBattery')));
    el.append(floor);

    const manual = h('div', 'setup-field');
    manual.append(h('div', 'setup-label', t('energy.manual')), h('div', 'setup-hint', t('energy.manual.hint')));
    const row = h('div', 'setup-row');
    const keep = (label: string, minutes: number | null) => {
      const b = h('button', 'btn small', label);
      b.addEventListener('click', () => void this.hub.energyKeepAwake(minutes).then((nv) => ((this.view = nv), redraw())));
      return b;
    };
    if (v.reasons.includes('manual')) row.append(keep(t('energy.manual.stop'), 0));
    else row.append(keep(t('energy.manual.hour'), 60), keep(t('energy.manual.always'), null));
    if (caps.displayOff) {
      const off = h('button', 'btn small', t('energy.displayOff'));
      off.addEventListener('click', () => void this.hub.energyDisplayOff());
      row.append(off);
    }
    manual.append(row);
    el.append(manual);

    // What is not said beside a switch (the radios left alone, a platform's own notes).
    const shown = new Set(Object.values(why));
    for (const note of caps.notes) if (!shown.has(note)) el.append(h('p', 'setup-hint', note));
  }

  /** Kept awake or not, why, until when; the battery; the guard or a refusal. */
  private status(v: EnergyView): HTMLElement {
    const status = h('div', `setup-status ${v.guard || v.error ? 'warn' : v.awake ? 'ok' : ''}`);
    const title = v.guard ? 'energy.state.guard' : v.awake ? (v.lidClosed ? 'energy.state.lid' : 'energy.state.awake') : 'energy.state.idle';
    status.append(h('b', '', t(title)));
    if (v.awake) {
      const why = v.reasons.map((r) => t(`energy.why.${r}` as Key));
      if (v.reasons.includes('manual') && v.until !== null) why.push(t('energy.until', { time: new Date(v.until).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' }) }));
      if (why.length) status.append(h('span', 'setup-status-detail', why.join(' · ')));
    }
    const b = v.battery;
    if (b?.present && b.percent !== null) status.append(h('span', 'setup-status-detail', `${t('energy.battery', { n: b.percent })} · ${t(b.source === 'ac' ? 'energy.battery.ac' : 'energy.battery.dc')}`));
    if (v.guard) status.append(h('span', 'setup-status-problem', t('energy.guard')));
    else if (v.error) status.append(h('span', 'setup-status-problem', t('energy.error', { error: v.error })));
    return status;
  }

  /** A switch card, its hint inside it; `off`: why this PC cannot have it, said in the card. */
  private toggle(title: string, hint: string, checked: boolean, off: string | null, change: (on: boolean) => void): HTMLElement {
    const label = h('label', `setup-toggle energy-toggle${off ? ' energy-off' : ''}`);
    const box = h('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.disabled = off !== null;
    box.addEventListener('change', () => change(box.checked));
    const text = h('span', 'setup-choice-text');
    text.append(h('span', 'setup-choice-title', title), h('span', 'setup-choice-hint', hint));
    if (off) text.append(this.why(off));
    label.append(box, text);
    const field = h('div', 'setup-field');
    field.append(label);
    return field;
  }

  private why(text: string): HTMLElement {
    const line = h('span', 'energy-why');
    line.append(icon(ICONS.info), h('span', '', text));
    return line;
  }
}
