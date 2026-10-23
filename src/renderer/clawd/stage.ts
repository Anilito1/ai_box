import {
  AnimationMixer,
  DirectionalLight,
  LoopOnce,
  LoopRepeat,
  Mesh,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  SkinnedMesh,
  WebGLRenderer,
  type AnimationAction,
  type AnimationClip,
  type MeshStandardMaterial,
  type Object3D,
  type Skeleton,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import glb from '../../../assets/clawd.glb';
import { CALM, CLIPS, type Clip, type Hat, type Mind, type Pose } from './state';

// One WebGL context for every mascot (Chromium caps a page near 16): each view is rendered in turn into the shared
// offscreen canvas, then copied into its own 2D canvas. Scrolling, clipping and hiding stay with the DOM.

const BASE_FADE_S = 0.25;
const SHOT_FADE_S = 0.1;
const OVERLAY_FADE_S = 0.3;
const FPS = 30;
const CALM_FPS = 15;
const HAT_BONES: Record<Hat, string> = {
  crown: 'prop_crown',
  pumpkin: 'prop_hat_pumpkin',
  santa: 'prop_hat_santa',
  party: 'prop_party_hat',
  nightcap: 'prop_nightcap',
};
/** Frame of a loop shown on a still Clawd: a moment that reads well (a Z in the air, stars around the head). */
const STILL_AT: Partial<Record<Clip, number>> = { sleep_loop: 1.4, ko_loop: 0.3 };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

class Stage {
  readonly scene = new Scene();
  readonly views = new Set<StageView>();
  readonly clips = new Map<string, AnimationClip>();
  readonly rig: Object3D;
  readonly camera: PerspectiveCamera;
  reduced = reducedMotion.matches;
  private raf = 0;
  private lost = false;

  constructor(
    readonly renderer: WebGLRenderer,
    gltf: GLTF,
  ) {
    renderer.setPixelRatio(1); // Views size themselves in device pixels.
    renderer.setScissorTest(true);
    renderer.setClearColor(0x000000, 0);
    const pmrem = new PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.75;
    pmrem.dispose();
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(-2, 4, 5);
    this.scene.add(key);

    const rig = gltf.scene.getObjectByName('Clawd_Rig');
    const camera = gltf.cameras[0];
    if (!rig || !(camera instanceof PerspectiveCamera)) throw new Error('clawd.glb: Clawd_Rig or cam_card missing');
    this.rig = rig;
    this.camera = camera;
    camera.removeFromParent(); // A root camera has its world matrix refreshed at each render.
    for (const clip of gltf.animations) this.clips.set(clip.name, clip);
    const missing = Object.keys(CLIPS).filter((name) => !this.clips.has(name));
    if (missing.length > 0) console.warn(`clawd.glb: clips missing: ${missing.join(', ')}`);

    renderer.domElement.addEventListener('webglcontextlost', () => {
      this.lost = true;
      cancelAnimationFrame(this.raf);
      loading = Promise.resolve(null); // Mascots created from now on go straight to the SVG.
      for (const view of [...this.views]) view.onLost();
    });
    reducedMotion.addEventListener('change', () => {
      this.reduced = reducedMotion.matches;
      this.wake();
    });
  }

  attach(canvas: HTMLCanvasElement, mind: Mind, color: string, onLost: () => void): StageView {
    const view = new StageView(this, canvas, mind, color, onLost);
    this.views.add(view);
    this.wake();
    return view;
  }

  /** Runs frames while a visible view moves; a change (snapshot, event, resize) calls it again. */
  wake(): void {
    if (!this.raf && !this.lost) this.raf = requestAnimationFrame(this.frame);
  }

  /** The shared canvas only grows, so switching between view sizes never reallocates it. */
  fit(width: number, height: number): void {
    const canvas = this.renderer.domElement;
    if (canvas.width < width || canvas.height < height) this.renderer.setSize(Math.max(canvas.width, width), Math.max(canvas.height, height), false);
  }

  private readonly frame = (t: number): void => {
    this.raf = 0;
    const now = Date.now();
    let again = false;
    for (const view of this.views) if (view.frame(now, t)) again = true;
    if (again) this.wake();
  };
}

export type { Stage };

/** One mascot on screen: its own copy of the rig, animation mixer and tinted body. */
export class StageView {
  private readonly root: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly actions = new Map<Clip, AnimationAction>();
  private readonly bones = new Map<string, Object3D>();
  private skeleton: Skeleton | null = null;
  private tint: MeshStandardMaterial | null = null;
  private readonly visibility: IntersectionObserver;
  private readonly resize: ResizeObserver;
  private current: AnimationAction | null = null;
  private serial = -1;
  private sweating = false;
  private blinked = 0;
  private hat: Hat | null = null;
  private blueprint = false;
  private visible = false;
  /** Key of the still frame on the canvas; empty while animating. */
  private drawn = '';
  private nextAt = 0;
  private last = 0;

  constructor(
    private readonly stage: Stage,
    private readonly canvas: HTMLCanvasElement,
    private readonly mind: Mind,
    color: string,
    readonly onLost: () => void,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.root = clone(stage.rig);
    this.root.visible = false;
    stage.scene.add(this.root);
    this.root.traverse((o) => {
      this.bones.set(o.name, o);
      if (!(o instanceof Mesh)) return;
      o.frustumCulled = false; // Jumps and thrown props leave the bind-pose bounds.
      // Every part shares one skin: one skeleton updated once per render instead of one per primitive.
      if (o instanceof SkinnedMesh) o.skeleton = this.skeleton ??= o.skeleton;
      const material = o.material as MeshStandardMaterial;
      if (material.name !== 'mat_body') return;
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
      stage.wake();
    });
    this.resize.observe(canvas, { box: 'device-pixel-content-box' });
  }

  wake(): void {
    this.stage.wake();
  }

  dispose(): void {
    this.visibility.disconnect();
    this.resize.disconnect();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.stage.scene.remove(this.root);
    this.skeleton?.dispose();
    this.tint?.dispose();
    this.stage.views.delete(this);
  }

  /** Advances and draws this view if due; true while it needs more frames. */
  frame(now: number, t: number): boolean {
    if (!this.visible || this.canvas.width === 0 || this.canvas.height === 0) return false;
    const pose = this.mind.pose(now);
    this.dress(pose);
    // Closed, or reduced motion: one frame per change, of the base loop.
    if (pose.still || this.stage.reduced) {
      const clip = pose.still ? pose.clip : pose.base;
      const key = `${clip}|${pose.hat}|${pose.blueprint}|${this.canvas.width}x${this.canvas.height}`;
      if (key !== this.drawn) {
        this.pin(clip);
        this.draw();
        this.drawn = key;
      }
      return false;
    }
    this.drawn = '';
    if (pose.serial !== this.serial) {
      this.serial = pose.serial;
      this.start(pose);
    }
    this.overlay(pose.sweat);
    const blinks = this.mind.blinks(now);
    if (blinks !== this.blinked) {
      this.blinked = blinks;
      // Not clamped: once over it lets go of the eyes, or it would flatten the next expression.
      this.play(this.action('eyes_blink'), 1, false);
    }
    if (t < this.nextAt) return true;
    // A few ms early, so a 60 Hz display does not skip every other frame.
    this.nextAt = t + 1000 / (CALM.has(pose.clip) ? CALM_FPS : FPS) - 4;
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    this.mixer.update(dt);
    this.release();
    this.draw();
    return true;
  }

  private action(clip: Clip): AnimationAction {
    let action = this.actions.get(clip);
    if (!action) {
      const source = this.stage.clips.get(clip) ?? this.stage.clips.get('idle_breathe');
      if (!source) throw new Error(`clawd.glb: no clip ${clip}`);
      action = this.mixer.clipAction(source);
      this.actions.set(clip, action);
    }
    return action;
  }

  /** From the base loop to a one-shot (or back), crossfaded; loops start at the worker's own phase. */
  private start(pose: Pose): void {
    const next = this.action(pose.clip);
    const once = pose.reps !== Infinity;
    const prev = this.current;
    this.play(next, pose.reps);
    if (!once) next.time = this.mind.phase * next.getClip().duration;
    if (prev && prev !== next) prev.crossFadeTo(next, once ? SHOT_FADE_S : BASE_FADE_S, false);
    this.current = next;
  }

  /** By default a one-shot holds its last frame until the base takes over. */
  private play(action: AnimationAction, reps: number, clamp = reps !== Infinity): void {
    action.reset();
    action.setLoop(reps === 1 ? LoopOnce : LoopRepeat, reps);
    action.clampWhenFinished = clamp;
    action.timeScale = this.mind.speed;
    action.play();
  }

  /** The sweat drop runs over whatever plays. */
  private overlay(on: boolean): void {
    if (on === this.sweating) return;
    this.sweating = on;
    const sweat = this.action('sweat_overlay');
    if (on) {
      this.play(sweat, Infinity);
      sweat.fadeIn(OVERLAY_FADE_S);
    } else {
      sweat.fadeOut(OVERLAY_FADE_S);
    }
  }

  /** Hats and the blueprint are static props: their bones are only scaled in or out. */
  private dress(pose: Pose): void {
    if (pose.hat !== this.hat) {
      if (this.hat) this.bones.get(HAT_BONES[this.hat])?.scale.setScalar(0);
      if (pose.hat) this.bones.get(HAT_BONES[pose.hat])?.scale.setScalar(1);
      this.hat = pose.hat;
    }
    if (pose.blueprint !== this.blueprint) {
      this.bones.get('prop_blueprint')?.scale.setScalar(pose.blueprint ? 1 : 0);
      this.blueprint = pose.blueprint;
    }
  }

  /** Freezes the pose on one frame of `clip`; the next animated pose crossfades from it. */
  private pin(clip: Clip): void {
    this.mixer.stopAllAction();
    this.sweating = false;
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
    const { renderer, scene, camera } = this.stage;
    const { width, height } = this.canvas;
    this.stage.fit(width, height);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    this.root.visible = true;
    renderer.render(scene, camera);
    this.root.visible = false;
    // The viewport sits at the bottom-left of the shared canvas; 2D coordinates start at the top.
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.drawImage(renderer.domElement, 0, renderer.domElement.height - height, width, height, 0, 0, width, height);
  }
}

let loading: Promise<Stage | null> | null = null;

/** The shared stage, or null when WebGL or the model is unavailable (the avatars then keep their SVG). */
export function clawdStage(): Promise<Stage | null> {
  return (loading ??= (async () => {
    try {
      const gltf = await new GLTFLoader().parseAsync(glb.slice().buffer, '');
      return new Stage(new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }), gltf);
    } catch (err) {
      console.warn('Clawd 3D unavailable, SVG mascots instead:', err);
      return null;
    }
  })());
}
