import type { HubApi } from '../shared/types';
import { h } from './dom';
import type { NewsBotAction, NewsBotStatus } from '../shared/newsBot';
/** Small console; no token fields or remote publication action. */
export function openNewsBot(hub: HubApi): void {
  const dialog = document.createElement('dialog'); dialog.className = 'newsbot-dialog';
  const title = h('h2', '', 'Actualité gaming · local'); const output = h('pre'); output.setAttribute('aria-live', 'polite');
  const controls = h('div'); let latest: NewsBotStatus | undefined;
  const scheduler = h('input'); scheduler.type = 'checkbox'; scheduler.id = 'newsbot-scheduler';
  const schedulerLabel = h('label', '', 'Planifier les essais locaux'); schedulerLabel.htmlFor = scheduler.id;
  const interval = h('input'); interval.type = 'number'; interval.min = '1'; interval.max = '1440'; interval.value = '5'; interval.id = 'newsbot-interval';
  const intervalLabel = h('label', '', 'Intervalle (minutes)'); intervalLabel.htmlFor = interval.id;
  const display = (state: NewsBotStatus) => {
    latest = state; scheduler.checked = state.config.scheduler; interval.value = String(state.config.intervalMs / 60_000);
    output.textContent = JSON.stringify(state, null, 2);
  };
  const saveSchedule = async () => {
    if (!latest) return;
    const minutes = Number(interval.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { output.textContent = 'Choisir un intervalle entre 1 et 1440 minutes.'; return; }
    try { display(await hub.newsBot('configure', { ...latest.config, scheduler: scheduler.checked, intervalMs: minutes * 60_000 })); }
    catch { output.textContent = 'Configuration refusée.'; }
  };
  scheduler.onchange = () => { void saveSchedule(); }; interval.onchange = () => { void saveSchedule(); };
  const schedule = h('div', 'newsbot-schedule'); schedule.append(scheduler, schedulerLabel, intervalLabel, interval);
  const show = async (action: NewsBotAction) => {
    try { display(await hub.newsBot(action)); }
    catch { output.textContent = 'Opération locale indisponible.'; }
  };
  for (const [label, action] of [['État', 'state'], ['Démarrer', 'start'], ['Arrêter', 'stop'], ['Essai hors ligne', 'dry-run']] as const) {
    const button = h('button', '', label); button.onclick = () => { void show(action); }; controls.append(button);
  }
  const enabled = h('button', '', 'Activer / désactiver le socle');
  enabled.onclick = async () => { if (!latest) return; try { display(await hub.newsBot('configure', { ...latest.config, enabled: !latest.config.enabled })); } catch { output.textContent = 'Configuration refusée.'; } };
  controls.append(enabled);
  const close = h('button', '', 'Fermer'); close.onclick = () => dialog.close(); controls.append(close);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(title, h('p', '', 'Fixtures uniquement. Réseau et publications désactivés. Enregistrer une configuration arrête le service ; démarrer le relance.'), schedule, controls, output); document.body.append(dialog); dialog.showModal(); void show('state');
}
