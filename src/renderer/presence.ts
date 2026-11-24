// Whether anyone watches the hub. Out of focus (another app, another workspace, a locked screen), what only moves to
// look alive holds still until the focus comes back: the mascots, the spinner, the SVG mascots' CSS loops (`html.away`).
// Linux compositors tell a window nothing about being hidden, so the focus is the only signal every system gives. It
// comes from main: a page shown without ever being activated (started on another workspace) believes it has it.

interface Battery extends EventTarget {
  readonly charging: boolean;
}

type Listener = () => void;
const listeners = new Set<Listener>();

export const presence = { focused: document.hasFocus(), onBattery: false };

function changed(): void {
  document.documentElement.classList.toggle('away', !presence.focused);
  for (const listener of listeners) listener();
}

export function onPresence(listener: Listener): void {
  listeners.add(listener);
}

window.hub.onFocus((focused) => {
  presence.focused = focused;
  changed();
});
document.documentElement.classList.toggle('away', !presence.focused);

const battery = (navigator as Navigator & { getBattery?: () => Promise<Battery> }).getBattery?.();
battery?.then(
  (b) => {
    const read = () => {
      if (presence.onBattery === !b.charging) return;
      presence.onBattery = !b.charging;
      changed();
    };
    b.addEventListener('chargingchange', read);
    read();
  },
  () => undefined,
);
