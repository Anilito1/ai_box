import type { ChatItem, SessionView } from '../shared/types';
import { clawdStage } from './clawd/load';
import type { StageView } from './clawd/stage';
import { hash, Mind, signalsOf, type MindEvent } from './clawd/state';
import { h, statusDot, statusLabel } from './dom';
import { t } from './i18n';
import { mascotPicture, type MascotId } from './mascot';

const NS = 'http://www.w3.org/2000/svg';

// Fallback when WebGL is unavailable: Clawd traced from the Claude Code mascot (640×640 source): [x, y, width, height].
type Box = [number, number, number, number];
const BODY: Box = [80, 133, 480, 322];
const ARM_L: Box = [0, 292, 80, 83];
const ARM_R: Box = [560, 292, 80, 83];
const EYE_L: Box = [160, 216, 40, 76];
const EYE_R: Box = [440, 216, 40, 76];
const LEGS: Box[] = [
  [120, 455, 40, 78],
  [200, 455, 40, 78],
  [400, 455, 40, 78],
  [480, 455, 40, 78],
];

// Each worker draws one value per axis from its id: 16 × 4 × 4 × 8 looks, each at its own pace.
const MOTIONS = ['hop', 'wobble', 'jelly', 'float', 'flip', 'shake', 'dance', 'spin', 'pulse', 'swing', 'moonwalk', 'heartbeat', 'tilt', 'orbit', 'peek', 'stretch'];
const EYES = ['blink', 'look', 'wink', 'roll'];
const LIMBS = ['walk', 'wave', 'flap', 'still'];
/** Body colours, all blues: a worker keeps the one its id draws; the master wears the hub's deep navy. */
const SHADES = ['#5a7de8', '#4c8dff', '#3b6fd8', '#6f8ff0', '#2f80ed', '#5b9bf5', '#4361ee', '#7aa2ff'];
const MASTER_SHADE = '#3654c9';

const shadeOf = (s: SessionView) => (s.role === 'master' ? MASTER_SHADE : SHADES[(hash(s.id) >>> 8) % SHADES.length]);

function rect(cls: string, [x, y, width, height]: Box): SVGRectElement {
  const r = document.createElementNS(NS, 'rect');
  r.setAttribute('class', cls);
  r.setAttribute('x', String(x));
  r.setAttribute('y', String(y));
  r.setAttribute('width', String(width));
  r.setAttribute('height', String(height));
  return r;
}

function group(cls: string, ...children: SVGElement[]): SVGGElement {
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', cls);
  g.append(...children);
  return g;
}

function clawd(s: SessionView): SVGSVGElement {
  const n = hash(s.id);
  const pick = (list: string[], shift: number) => list[(n >>> shift) % list.length];
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 133 640 400');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `clawd m-${pick(MOTIONS, 0)} e-${pick(EYES, 4)} l-${pick(LIMBS, 6)}`);
  svg.style.setProperty('--cw', shadeOf(s));
  svg.style.setProperty('--cw-speed', `${(0.8 + ((n >>> 11) % 9) / 10).toFixed(1)}s`);
  svg.style.setProperty('--cw-delay', `-${(n >>> 15) % 1000}ms`);
  const legs = group('cw-legs', ...LEGS.map((box, i) => rect(`cw-leg cw-leg-${i % 2 ? 'b' : 'a'}`, box)));
  svg.append(
    group(
      'cw-root',
      legs,
      rect('cw-arm cw-arm-l', ARM_L),
      rect('cw-arm cw-arm-r', ARM_R),
      rect('cw-body', BODY),
      rect('cw-eye cw-eye-l', EYE_L),
      rect('cw-eye cw-eye-r', EYE_R),
    ),
  );
  return svg;
}

/** A session's flat mascot: the SVG Clawd, else the still picture of its provider's. */
const flatMascot = (s: SessionView, mascot: MascotId) => (mascot === 'clawd' ? clawd(s) : mascotPicture(mascot, 'clawd mascot-pic'));

/** Models up on the 3D stage: their new mascots go straight to it, without the flat placeholder. */
const drawable = new Set<MascotId>();

// One mind per session, shared by its views (sidebar card and open conversation), so both act alike.
const minds = new Map<string, Mind>();

function mindOf(id: string): Mind {
  let mind = minds.get(id);
  if (!mind) minds.set(id, (mind = new Mind(id)));
  return mind;
}

/** Something happened to a session: its mascot reacts. */
export function clawdEvent(id: string, kind: MindEvent): void {
  const mind = minds.get(id);
  if (!mind) return;
  mind.event(kind, Date.now());
  void clawdStage().then((stage) => stage?.wake());
}

export function forgetClawd(id: string): void {
  minds.delete(id);
}

// Most workers busy at once during the current wave of work.
let waveBusy = 0;
const inFlight = (s: SessionView) => s.status === 'busy' || s.status === 'attention' || s.status === 'starting';

/** When a wave of parallel work ends (nothing busy, waiting or starting any more), every idle worker dances. */
export function noteFleet(sessions: SessionView[]): void {
  const workers = sessions.filter((s) => s.role === 'worker');
  if (workers.some(inFlight)) {
    waveBusy = Math.max(waveBusy, workers.filter((s) => s.status === 'busy').length);
    return;
  }
  if (waveBusy >= 2) for (const s of workers) if (s.status === 'idle') clawdEvent(s.id, 'party');
  waveBusy = 0;
}

/** A session's mascot, its provider's: 3D on the shared stage, or flat when WebGL is unavailable. */
export class Avatar {
  readonly root = h('span', 'avatar');
  private readonly canvas = h('canvas', 'clawd-3d');
  private readonly badge: HTMLSpanElement | null = null;
  private view: StageView | null = null;
  private flat: SVGSVGElement | HTMLImageElement | null = null;
  private session: SessionView | null = null;
  private mascot: MascotId = 'clawd';
  private lastClick = 0;

  private readonly large: boolean;

  /** `card`: sidebar size, with a status badge. `stage`: the large one atop an open conversation. */
  constructor(size: 'card' | 'stage') {
    this.large = size === 'stage';
    this.root.classList.add(`avatar-${size}`);
    this.root.append(this.canvas);
    if (size === 'card') {
      this.badge = h('span', 'dot avatar-badge');
      this.root.append(this.badge);
    }
    this.root.addEventListener('click', (e) => this.poke(e));
  }

  update(s: SessionView, last: ChatItem | undefined, mascot: MascotId, workersBusy = 0): void {
    if (s.id !== this.session?.id || mascot !== this.mascot) this.follow(s, mascot);
    this.session = s;
    mindOf(s.id).update(signalsOf(s, last, workersBusy), Date.now());
    this.view?.wake();
    const live = s.status === 'busy' || (s.status !== 'exited' && s.background.length > 0);
    this.root.classList.toggle('live', live);
    this.root.classList.toggle('waiting', s.status === 'attention');
    this.root.classList.toggle('off', s.status === 'exited');
    if (this.badge) this.badge.className = `${statusDot(s)} avatar-badge`;
    const status = statusLabel(s);
    const title = s.background.length > 0 && s.status !== 'busy' ? t('avatar.background', { status }) : status;
    // Written when it changes only: renders come 25 times a second while a reply streams (the tooltip watches it).
    if (title !== this.root.title && title !== this.root.dataset.tip) this.root.title = title;
  }

  dispose(): void {
    this.view?.dispose();
    this.view = null;
    this.session = null;
  }

  private follow(s: SessionView, mascot: MascotId): void {
    this.view?.dispose();
    this.view = null;
    this.flat?.remove();
    this.flat = null;
    this.mascot = mascot;
    this.canvas.hidden = false;
    // Until its model is on the 3D stage (a moment after the first paint), the flat mascot holds the place, still.
    if (!drawable.has(mascot)) {
      this.root.classList.remove('drawn');
      this.flat = flatMascot(s, mascot);
      this.flat.classList.add('still');
      this.root.prepend(this.flat);
    }
    void clawdStage().then(async (stage) => {
      const model = await stage?.model(mascot);
      if (this.session?.id !== s.id || this.mascot !== mascot) return; // Switched to another session or provider meanwhile.
      if (!stage || !model) return this.fallback();
      drawable.add(mascot);
      this.view = stage.attach(this.canvas, mindOf(s.id), model, shadeOf(s), this.large, () => this.fallback());
      this.root.classList.add('drawn'); // The 3D mascot fades in over the flat one, which then leaves.
      const placeholder = this.flat;
      if (placeholder) {
        window.setTimeout(() => {
          if (this.flat !== placeholder || !this.view) return;
          placeholder.remove();
          this.flat = null;
        }, 450);
      }
    });
  }

  private fallback(): void {
    this.view?.dispose();
    this.view = null;
    this.canvas.hidden = true;
    this.root.classList.remove('drawn');
    if (this.session && !this.flat) {
      this.flat = flatMascot(this.session, this.mascot);
      this.root.prepend(this.flat);
    }
    this.flat?.classList.remove('still'); // No WebGL: the flat mascot stands in, and the SVG Clawd moves.
  }

  private poke(e: MouseEvent): void {
    if (!this.session) return;
    // A burst of clicks pokes the mascot without opening and closing the conversation each time.
    if (e.timeStamp - this.lastClick < 600) e.stopPropagation();
    this.lastClick = e.timeStamp;
    clawdEvent(this.session.id, 'poke');
  }
}
