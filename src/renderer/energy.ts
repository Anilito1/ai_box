import { BATTERY_FLOORS, type EnergySettings, type EnergyView } from '../shared/energy';
import type { HubApi, SettingsPatch } from '../shared/types';
import { h } from './dom';
import { LANG, t, type Key } from './i18n';

// Settings › Energy: what keeps the PC awake now, the switches (while workers work, lid closed), the battery guard,
// a hold of the user's own, and why a capability is missing on this PC.

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

    el.append(
      this.toggle(t('energy.whileWorking'), t('energy.whileWorking.hint'), s.whileWorking, false, (on) => save({ energy: { whileWorking: on } })),
      this.toggle(t('energy.lidClosed'), t('energy.lidClosed.hint'), s.lidClosed && caps.lidClosedAwake, !caps.lidClosedAwake, (on) => save({ energy: { lidClosed: on } })),
    );

    const floor = h('div', 'setup-field');
    floor.append(h('div', 'setup-label', t('energy.floor')), h('div', 'setup-hint', t('energy.floor.hint')));
    const select = h('select', 'setup-select');
    select.setAttribute('aria-label', t('energy.floor'));
    for (const n of [...new Set([...BATTERY_FLOORS, s.batteryFloor])].sort((a, b) => a - b)) select.append(new Option(t('energy.floor.n', { n }), String(n)));
    select.value = String(s.batteryFloor);
    select.disabled = !caps.battery;
    select.addEventListener('change', () => save({ energy: { batteryFloor: Number(select.value) } }));
    floor.append(select);
    el.append(floor);

    const manual = h('div', 'setup-field');
    manual.append(h('div', 'setup-label', t('energy.manual')), h('div', 'setup-hint', t('energy.manual.hint')));
    const row = h('div', 'setup-row');
    const keep = (label: string, minutes: number | null) => {
      const b = h('button', 'btn ghost small', label);
      b.addEventListener('click', () => void this.hub.energyKeepAwake(minutes).then((nv) => ((this.view = nv), redraw())));
      return b;
    };
    if (v.reasons.includes('manual')) row.append(keep(t('energy.manual.stop'), 0));
    else row.append(keep(t('energy.manual.hour'), 60), keep(t('energy.manual.always'), null));
    if (caps.displayOff) {
      const off = h('button', 'btn ghost small', t('energy.displayOff'));
      off.addEventListener('click', () => void this.hub.energyDisplayOff());
      row.append(off);
    }
    manual.append(row);
    el.append(manual);

    for (const note of caps.notes) el.append(h('p', 'setup-hint', note));
  }

  /** Kept awake or not, why, until when; the battery; the guard or a refusal. */
  private status(v: EnergyView): HTMLElement {
    const status = h('div', `setup-status ${v.guard || v.error ? 'warn' : v.awake ? 'ok' : ''}`);
    status.append(h('b', '', t(v.awake ? (v.lidClosed ? 'energy.state.lid' : 'energy.state.awake') : 'energy.state.idle')));
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

  private toggle(title: string, hint: string, checked: boolean, disabled: boolean, change: (on: boolean) => void): HTMLElement {
    const field = h('div', 'setup-field');
    const label = h('label', 'setup-toggle');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.disabled = disabled;
    box.addEventListener('change', () => change(box.checked));
    const text = h('span', 'setup-choice-text');
    text.append(h('span', 'setup-choice-title', title));
    label.append(box, text);
    field.append(label, h('div', 'setup-hint', hint));
    return field;
  }
}
