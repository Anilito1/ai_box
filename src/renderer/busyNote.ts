import type { HubApi } from '../shared/types';
import { h } from './dom';
import { tn } from './i18n';

/**
 * The line beside a restart button: how many sessions at work the restart interrupts (they resume afterwards).
 * Hidden when none, and until the count arrives.
 */
export function busyNote(hub: HubApi, className: string): HTMLElement {
  const note = h('div', className);
  note.hidden = true;
  void hub
    .busySessions()
    .then((n) => {
      if (n > 0) Object.assign(note, { textContent: tn('update.modal.atWork', n), hidden: false });
    })
    .catch(() => undefined);
  return note;
}
