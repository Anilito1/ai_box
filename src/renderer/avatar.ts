import { STATUS_LABEL, type SessionView } from '../shared/types';
import { h } from './dom';

const NS = 'http://www.w3.org/2000/svg';

// Clawd, traced from the Claude Code mascot (640×640 source): [x, y, width, height].
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
const SHADES = ['#5a7de8', '#4c8dff', '#3b6fd8', '#6f8ff0', '#2f80ed', '#5b9bf5', '#4361ee', '#7aa2ff'];

/** FNV-1a: stable across launches, so a worker keeps its look. */
function hash(seed: string): number {
  let n = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) n = Math.imul(n ^ seed.charCodeAt(i), 0x01000193);
  return n >>> 0;
}

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

function clawd(seed: string): SVGSVGElement {
  const n = hash(seed);
  const pick = (list: string[], shift: number) => list[(n >>> shift) % list.length];
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 133 640 400');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `clawd m-${pick(MOTIONS, 0)} e-${pick(EYES, 4)} l-${pick(LIMBS, 6)}`);
  svg.style.setProperty('--cw', pick(SHADES, 8));
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

/** A worker's mascot with a status badge: it moves while the worker works, dozes once stopped. */
export class Avatar {
  readonly root = h('span', 'avatar');
  private readonly badge = h('span', 'dot avatar-badge');

  constructor(seed: string) {
    this.root.append(clawd(seed), this.badge);
  }

  update(s: SessionView): void {
    const live = s.status === 'busy' || (s.status !== 'exited' && s.background.length > 0);
    this.root.classList.toggle('live', live);
    this.root.classList.toggle('waiting', s.status === 'attention');
    this.root.classList.toggle('off', s.status === 'exited');
    this.badge.className = `dot avatar-badge s-${s.status}`;
    this.root.title = s.background.length > 0 && s.status !== 'busy' ? `${STATUS_LABEL[s.status]} · tâche de fond` : STATUS_LABEL[s.status];
  }
}
