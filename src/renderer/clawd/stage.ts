import {
  AnimationMixer,
  BackSide,
  BoxGeometry,
  DirectionalLight,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  SkinnedMesh,
  WebGLRenderer,
  type AnimationAction,
  type AnimationClip,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  type Skeleton,
  type Texture,
  type WebGLRenderTarget,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import glb from '../../../assets/clawd.glb';
import type { MascotId } from '../mascot';
import { CALM, CLIPS, FIDGETS, REST, type Clip, type Hat, type Mind, type Pose } from './state';

declare global {
  interface Window {
    /** The models besides Clawd, each set by its own file (build.mjs) once loaded. */
    hubMascots?: Partial<Record<MascotId, Uint8Array>>;
  }
}

// One WebGL context for every mascot (Chromium caps a page near 16): each view is rendered in turn into the shared
// offscreen canvas, then handed to its own canvas as an ImageBitmap, a GPU copy (drawImage into a small 2D canvas
// would read the pixels back to the CPU). Scrolling, clipping and hiding stay with the DOM.
//
// Every frame put on a canvas costs the same whatever draws it, so frames are only drawn while something moves:
// - at work, 24 fps for the large mascot of the open conversation (the rig's own rate), 16 for the sidebar cards,
//   12 for calm loops (waiting on a background task, the master conducting) or with the hub in the background;
// - at rest, a still pose, livened now and then by a blink or a fidget at 12 fps (never with the hub in the
//   background);
// - a closed session is drawn once; a hidden or minimized hub draws nothing.

const BASE_FADE_S = 0.25;
const SHOT_FADE_S = 0.1;
const OVERLAY_FADE_S = 0.3;
const LARGE_FPS = 24;
const CARD_FPS = 16;
const SLOW_FPS = 12;
/** Timers fire a little late: a frame this close to due is drawn now. */
const TIMER_SLACK_MS = 4;
/** A resting view still checks its mind this often (drowsiness, a fidget due), without drawing. */
const REST_CHECK_MS = 1000;
const HAT_BONES: Record<Hat, string> = {
  crown: 'prop_crown',
  pumpkin: 'prop_hat_pumpkin',
  santa: 'prop_hat_santa',
  party: 'prop_party_hat',
  nightcap: 'prop_nightcap',
};
/** Frame of a loop shown on a still Clawd: a moment that reads well (a Z in the air, stars around the head). */
const STILL_AT: Partial<Record<Clip, number>> = { sleep_loop: 1.4, ko_loop: 0.3 };
/** The sweat drop on a still Clawd, halfway down its temple. */
const SWEAT_STILL_AT = 0.6;
/** The material a worker's own shade goes on; none for a mascot whose colours are its provider's (a gradient). */
const RECOLOR: Record<MascotId, string | null> = { clawd: 'mat_body', codex: 'mat_body', gemini: null, deepseek: null };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** One mascot's model, shared by all its views. */
export interface Model {
  readonly rig: Object3D;
  readonly camera: PerspectiveCamera;
  readonly clips: Map<string, AnimationClip>;
  /** Clips that set the face the blink closes to another value (an expression): a blink over them would show both. */
  readonly expressions: Set<string>;
  readonly recolor: string | null;
}

class Stage {
  readonly scene = new Scene();
  readonly views = new Set<StageView>();
  private readonly models = new Map<MascotId, Promise<Model | null>>();
  reduced = reducedMotion.matches;
  /** The hub window is in the background: no fidgets nor blinks, work at the slow pace. */
  quiet = !document.hasFocus();
  private timer = 0;
  private timerAt = Infinity;
  private lost = false;

  constructor(
    readonly renderer: WebGLRenderer,
    environment: Texture,
  ) {
    this.scene.environment = environment;
    this.scene.environmentIntensity = 0.75;
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(-2, 4, 5);
    this.scene.add(key);

    renderer.domElement.addEventListener('webglcontextlost', () => {
      this.lost = true;
      this.stop();
      loading = Promise.resolve(null); // Mascots created from now on go straight to the SVG.
      for (const view of [...this.views]) view.onLost();
    });
    reducedMotion.addEventListener('change', () => {
      this.reduced = reducedMotion.matches;
      this.wake();
    });
    const focus = (focused: boolean) => () => {
      this.quiet = !focused;
      this.wake();
    };
    window.addEventListener('focus', focus(true));
    window.addEventListener('blur', focus(false));
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.wake()));
  }

  /** `large`: the mascot atop an open conversation, animated at the full rate. */
  attach(canvas: HTMLCanvasElement, mind: Mind, model: Model, color: string, large: boolean, onLost: () => void): StageView {
    const view = new StageView(this, canvas, mind, model, color, large ? LARGE_FPS : CARD_FPS, onLost);
    this.views.add(view);
    this.wake();
    return view;
  }

  /** A mascot's model, loaded the first time a session wears it; null when it cannot be (the avatar keeps its picture). */
  model(id: MascotId): Promise<Model | null> {
    let model = this.models.get(id);
    if (!model) this.models.set(id, (model = this.load(id)));
    return model;
  }

  private async load(id: MascotId): Promise<Model | null> {
    try {
      const gltf = await new GLTFLoader().parseAsync((await modelBytes(id)).slice().buffer, '');
      const model = modelOf(id, gltf);
      await breathe();
      // Its shaders compile in the GPU process while the page keeps running (KHR_parallel_shader_compile), instead of
      // freezing it on the first frame.
      await this.renderer.compileAsync(model.rig, model.camera, this.scene);
      return model;
    } catch (err) {
      console.warn(`Mascot ${id} unavailable:`, err);
      return null;
    }
  }

  /** Something changed (snapshot, event, resize, focus): look at every view now. */
  wake(): void {
    this.schedule(0);
  }

  /** The shared canvas only grows, so switching between view sizes never reallocates it. */
  fit(width: number, height: number): void {
    const canvas = this.renderer.domElement;
    if (canvas.width < width || canvas.height < height) this.renderer.setSize(Math.max(canvas.width, width), Math.max(canvas.height, height), false);
  }

  /** At most one timer, at the earliest time a view needs to run. */
  private schedule(delay: number): void {
    if (this.lost || document.hidden) return;
    const at = performance.now() + delay;
    if (this.timer && this.timerAt <= at) return;
    window.clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = window.setTimeout(this.tick, delay);
  }

  private stop(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.timerAt = Infinity;
  }

  private readonly tick = (): void => {
    this.timer = 0;
    this.timerAt = Infinity;
    const now = Date.now();
    const t = performance.now();
    let next = Infinity;
    for (const view of this.views) next = Math.min(next, view.frame(now, t));
    if (next !== Infinity) this.schedule(Math.max(0, next - performance.now()));
  };
}

export type { Stage };

/** One mascot on screen: its own copy of the rig, animation mixer and tinted body. */
export class StageView {
  private readonly root: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly ctx: ImageBitmapRenderingContext;
  private readonly actions = new Map<Clip, AnimationAction>();
  private readonly bones = new Map<string, Object3D>();
  private skeleton: Skeleton | null = null;
  private tint: MeshStandardMaterial | null = null;
  private readonly visibility: IntersectionObserver;
  private readonly resize: ResizeObserver;
  private current: AnimationAction | null = null;
  private serial = -1;
  private sweat: 'off' | 'moving' | 'still' = 'off';
  private blinked = 0;
  private hat: Hat | null = null;
  private blueprint = false;
  private visible = false;
  private disposed = false;
  /** The canvas needs a frame even at rest: first draw, new size, a hat changed. */
  private dirty = true;
  /** Key of the still frame on the canvas; empty while animating. */
  private drawn = '';
  /** Frames are drawn until then even at rest: a crossfade or a blink is finishing. */
  private settleUntil = 0;
  private nextAt = 0;
  private last = 0;
  /** Latest frame sent: a bitmap that resolves after a newer one is dropped. */
  private sent = 0;

  constructor(
    private readonly stage: Stage,
    private readonly canvas: HTMLCanvasElement,
    private readonly mind: Mind,
    private readonly model: Model,
    color: string,
    private readonly fps: number,
    readonly onLost: () => void,
  ) {
    const ctx = canvas.getContext('bitmaprenderer');
    if (!ctx) throw new Error('bitmaprenderer canvas unavailable');
    this.ctx = ctx;
    this.root = clone(model.rig);
    this.root.visible = false;
    stage.scene.add(this.root);
    this.root.traverse((o) => {
      this.bones.set(o.name, o);
      if (!(o instanceof Mesh)) return;
      o.frustumCulled = false; // Jumps and thrown props leave the bind-pose bounds.
      // Every part shares one skin: one skeleton updated once per render instead of one per primitive.
      if (o instanceof SkinnedMesh) o.skeleton = this.skeleton ??= o.skeleton;
      const material = o.material as MeshStandardMaterial;
      if (material.name !== model.recolor) return;
      this.tint ??= material.clone();
      this.tint.color.set(color);
      o.material = this.tint;
    });
    this.mixer = new AnimationMixer(this.root);

    this.visibility = new IntersectionObserver((entries) => {
      this.visible = entries[entries.length - 1].isIntersecting; // The latest of a batch wins.
      if (this.visible) stage.wake();
    });
    this.visibility.observe(canvas);
    this.resize = new ResizeObserver(([entry]) => {
      const box = entry.devicePixelContentBoxSize?.[0];
      const width = Math.round(box?.inlineSize ?? entry.contentRect.width * devicePixelRatio);
      const height = Math.round(box?.blockSize ?? entry.contentRect.height * devicePixelRatio);
      if (width === canvas.width && height === canvas.height) return;
      canvas.width = width;
      canvas.height = height;
      this.drawn = '';
      this.dirty = true;
      stage.wake();
    });
    this.resize.observe(canvas, { box: 'device-pixel-content-box' });
  }

  wake(): void {
    this.stage.wake();
  }

  dispose(): void {
    this.disposed = true;
    this.visibility.disconnect();
    this.resize.disconnect();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.stage.scene.remove(this.root);
    this.skeleton?.dispose();
    this.tint?.dispose();
    this.stage.views.delete(this);
  }

  /** Advances and draws this view if due; returns when it next needs to run (performance clock), Infinity if never. */
  frame(now: number, t: number): number {
    if (!this.visible || this.canvas.width === 0 || this.canvas.height === 0) return Infinity;
    const quiet = this.stage.quiet;
    const pose = this.mind.pose(now, quiet);
    const dressed = this.dress(pose);
    // Closed, or reduced motion: one frame per change, of the base loop.
    if (pose.still || this.stage.reduced) {
      const clip = pose.still ? pose.clip : pose.base;
      const key = `${clip}|${pose.hat}|${pose.blueprint}|${this.canvas.width}x${this.canvas.height}`;
      if (key !== this.drawn) {
        this.pin(clip);
        this.draw();
        this.drawn = key;
      }
      return Infinity;
    }
    this.drawn = '';
    if (this.dirty || dressed) {
      this.dirty = false;
      this.settle(t, 0);
      this.nextAt = 0;
    }
    // A Clawd at rest holds a still pose; one-shots, blinks and work loops move.
    const resting = REST.has(pose.clip);
    if (pose.serial !== this.serial) {
      this.serial = pose.serial;
      this.start(pose, resting, t);
    }
    this.overlay(pose.sweat, resting, t);
    const blinks = this.mind.blinks(now, quiet);
    if (blinks !== this.blinked) {
      this.blinked = blinks;
      if (!this.model.expressions.has(pose.clip)) {
        // Not clamped: once over it lets go of the eyes, or it would flatten the next expression.
        this.play(this.action('eyes_blink'), 1, false);
        this.settle(t, CLIPS.eyes_blink.duration / this.mind.speed);
      }
    }
    if (resting && t >= this.settleUntil) {
      // Coming to rest: one last frame with the move run to its end, even if the timer fired late or the view was
      // off screen meanwhile; then the next move starts from here, not from a long dt.
      if (this.last) {
        this.mixer.update((t - this.last) / 1000);
        this.release();
        this.draw();
        this.last = 0;
      }
      return t + Math.max(0, Math.min(REST_CHECK_MS, this.mind.nextChange(now) - now));
    }
    if (t < this.nextAt - TIMER_SLACK_MS) return this.nextAt;
    // Frames fall on a grid per rate, so views at the same pace share the timer's wake-ups (12 fps is every other
    // 24 fps frame). Blinks and fidgets of a resting Clawd go slow; reactions (a celebration, a push) keep the full rate.
    const slow = quiet || CALM.has(pose.clip) || REST.has(pose.clip) || FIDGETS.has(pose.clip);
    const step = 1000 / (slow ? SLOW_FPS : this.fps);
    this.nextAt = (Math.floor(t / step) + 1) * step;
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    this.mixer.update(dt);
    this.release();
    this.draw();
    return this.nextAt;
  }

  private action(clip: Clip): AnimationAction {
    let action = this.actions.get(clip);
    if (!action) {
      const source = this.model.clips.get(clip) ?? this.model.clips.get('idle_breathe');
      if (!source) throw new Error(`mascot model: no clip ${clip}`);
      action = this.mixer.clipAction(source);
      this.actions.set(clip, action);
    }
    return action;
  }

  /** Keeps drawing for `seconds` (plus a frame), so a move at rest ends on screen. */
  private settle(t: number, seconds: number): void {
    this.settleUntil = Math.max(this.settleUntil, t + seconds * 1000 + 1000 / SLOW_FPS);
  }

  /** From the base loop to a one-shot (or back), crossfaded; loops start at the worker's own phase, rest poses hold. */
  private start(pose: Pose, resting: boolean, t: number): void {
    const next = this.action(pose.clip);
    const once = pose.reps !== Infinity;
    const prev = this.current;
    this.play(next, pose.reps);
    if (resting) {
      next.time = STILL_AT[pose.clip] ?? 0;
      next.paused = true;
    } else if (!once) {
      next.time = this.mind.phase * next.getClip().duration;
    }
    const fade = once ? SHOT_FADE_S : BASE_FADE_S;
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    this.current = next;
    this.settle(t, fade);
  }

  /** By default a one-shot holds its last frame until the base takes over. */
  private play(action: AnimationAction, reps: number, clamp = reps !== Infinity): void {
    action.reset();
    action.setLoop(reps === 1 ? LoopOnce : LoopRepeat, reps);
    action.clampWhenFinished = clamp;
    action.timeScale = this.mind.speed;
    action.play();
  }

  /** The sweat drop runs over whatever plays; on a Clawd at rest it stays put on its temple. */
  private overlay(on: boolean, resting: boolean, t: number): void {
    const want = !on ? 'off' : resting ? 'still' : 'moving';
    if (want === this.sweat) return;
    const sweat = this.action('sweat_overlay');
    if (want === 'off') {
      sweat.fadeOut(OVERLAY_FADE_S);
    } else {
      if (this.sweat === 'off') {
        this.play(sweat, Infinity);
        sweat.fadeIn(OVERLAY_FADE_S);
      }
      sweat.paused = want === 'still';
      if (want === 'still') sweat.time = SWEAT_STILL_AT;
    }
    this.sweat = want;
    this.settle(t, OVERLAY_FADE_S);
  }

  /** Hats and the blueprint are static props: their bones are only scaled in or out. True when one changed. */
  private dress(pose: Pose): boolean {
    const changed = pose.hat !== this.hat || pose.blueprint !== this.blueprint;
    if (pose.hat !== this.hat) {
      if (this.hat) this.bones.get(HAT_BONES[this.hat])?.scale.setScalar(0);
      if (pose.hat) this.bones.get(HAT_BONES[pose.hat])?.scale.setScalar(1);
      this.hat = pose.hat;
    }
    if (pose.blueprint !== this.blueprint) {
      this.bones.get('prop_blueprint')?.scale.setScalar(pose.blueprint ? 1 : 0);
      this.blueprint = pose.blueprint;
    }
    return changed;
  }

  /** Freezes the pose on one frame of `clip`; the next animated pose crossfades from it. */
  private pin(clip: Clip): void {
    this.mixer.stopAllAction();
    this.sweat = 'off';
    const action = this.action(clip);
    action.reset();
    action.time = STILL_AT[clip] ?? 0;
    action.paused = true;
    action.play();
    this.mixer.update(0);
    this.current = action;
    this.serial = -1;
    this.last = 0;
  }

  /** Stops what has faded out or finished, so the mixer only walks live actions. */
  private release(): void {
    for (const action of this.actions.values()) {
      if (action !== this.current && !action.enabled && action.isScheduled()) action.stop();
    }
  }

  private draw(): void {
    const { renderer, scene } = this.stage;
    const { camera } = this.model;
    const { width, height } = this.canvas;
    this.stage.fit(width, height);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    this.root.visible = true;
    renderer.render(scene, camera);
    this.root.visible = false;
    // The viewport sits at the bottom-left of the shared canvas; bitmap coordinates start at the top. The snapshot
    // is taken now, before the next view draws over the shared canvas.
    const source = renderer.domElement;
    const frame = ++this.sent;
    createImageBitmap(source, 0, source.height - height, width, height).then(
      (bitmap) => {
        if (this.disposed || frame !== this.sent) bitmap.close();
        else this.ctx.transferFromImageBitmap(bitmap);
      },
      () => undefined, // Context lost meanwhile: that handler switches the mascots to SVG; this frame just goes.
    );
  }
}

let loading: Promise<Stage | null> | null = null;

/** Lets the hub handle input between the steps of setting up the stage. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** PMREMGenerator internals reached below (three is pinned to 0.186.x). */
interface PmremInternals {
  _setSize(size: number): void;
  _allocateTargets(): WebGLRenderTarget;
  _blurMaterial: Material;
  _ggxMaterial: Material;
  _lodMeshes: Mesh[];
}

/**
 * The room light reflected on the mascot, prefiltered. Its shaders (a 256-sample GGX loop the D3D compiler unrolls)
 * would freeze the page for most of a second if compiled on first use: they are compiled in the GPU process first,
 * against the same render target, while the page keeps running.
 */
async function roomLight(renderer: WebGLRenderer): Promise<Texture> {
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  try {
    await precompile(renderer, pmrem, room);
  } catch (err) {
    console.warn('Clawd: room light compiled on first use instead:', err); // three changed these internals.
  }
  const texture = pmrem.fromScene(room, 0.04).texture;
  pmrem.dispose();
  return texture;
}

async function precompile(renderer: WebGLRenderer, pmrem: PMREMGenerator, room: Scene): Promise<void> {
  const internals = pmrem as unknown as PmremInternals;
  const camera = new OrthographicCamera();
  internals._setSize(256); // fromScene's default size: it reuses these materials.
  const target = internals._allocateTargets();
  // The same programs fromScene will ask for: its plane geometry, its background box, its target's colour space.
  const plane = internals._lodMeshes[0].geometry;
  const background = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ side: BackSide, depthWrite: false, depthTest: false }));
  renderer.setRenderTarget(target);
  const compiling = [room, background, new Mesh(plane, internals._blurMaterial), new Mesh(plane, internals._ggxMaterial)].map((object) => renderer.compileAsync(object, camera));
  renderer.setRenderTarget(null);
  await Promise.all(compiling);
  target.dispose();
  background.geometry.dispose();
  background.material.dispose();
}

/** Clawd comes with the stage; every other model in its own file, fetched the first time a session wears it. */
function modelBytes(id: MascotId): Promise<Uint8Array> {
  if (id === 'clawd') return Promise.resolve(glb);
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = `mascot-${id}.js`;
    el.addEventListener('load', () => {
      const bytes = window.hubMascots?.[id];
      if (bytes) resolve(bytes);
      else reject(new Error(`mascot-${id}.js set no model`));
    });
    el.addEventListener('error', () => reject(new Error(`mascot-${id}.js unavailable`)));
    document.head.append(el);
  });
}

function modelOf(id: MascotId, gltf: GLTF): Model {
  const rig = gltf.scene.children.find((o) => o.name.endsWith('_Rig'));
  const camera = gltf.cameras[0];
  if (!rig || !(camera instanceof PerspectiveCamera)) throw new Error(`${id}.glb: rig or cam_card missing`);
  camera.removeFromParent(); // A root camera has its world matrix refreshed at each render.
  const clips = new Map(gltf.animations.map((clip) => [clip.name, clip]));
  const missing = Object.keys(CLIPS).filter((name) => !clips.has(name));
  if (missing.length > 0) console.warn(`${id}.glb: clips missing: ${missing.join(', ')}`);
  return { rig, camera, clips, expressions: expressions(clips), recolor: RECOLOR[id] };
}

function expressions(clips: Map<string, AnimationClip>): Set<string> {
  const blink = clips.get('eyes_blink')?.tracks ?? [];
  const found = new Set<string>();
  for (const [name, clip] of clips) {
    for (const closing of blink) {
      const size = closing.getValueSize();
      const track = clip.tracks.find((t) => t.name === closing.name);
      // The face open, as the blink starts from it.
      if (track?.values.some((v, i) => Math.abs(v - closing.values[i % size]) > 1e-3)) found.add(name);
    }
  }
  return found;
}

/** The shared stage, or null when WebGL or Clawd's model is unavailable (the avatars then keep their SVG). */
export function clawdStage(): Promise<Stage | null> {
  return (loading ??= (async () => {
    let renderer: WebGLRenderer | null = null;
    try {
      renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
      renderer.setPixelRatio(1); // Views size themselves in device pixels.
      renderer.setScissorTest(true);
      renderer.setClearColor(0x000000, 0);
      const stage = new Stage(renderer, await roomLight(renderer));
      await breathe();
      if (!(await stage.model('clawd'))) throw new Error('clawd.glb unusable');
      return stage;
    } catch (err) {
      console.warn('Clawd 3D unavailable, SVG mascots instead:', err);
      renderer?.dispose(); // Its WebGL context goes too: nothing will draw with it.
      renderer?.forceContextLoss();
      return null;
    }
  })());
}
