// The simulated models' pictures: a small landscape drawn from a number, the same from one run to the next.
// `t` moves it (the sun crosses, the hills slide): the frames of a simulated video are the simulated image, animated.

/** A number from a text: the same prompt always gives the same picture. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rgb = [number, number, number];

function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The colour of a seed's sky, one of eight (red, orange, gold, green, turquoise, blue, violet, pink): what a simulated reader "sees". */
export const skyOf = (seed: number): number => Math.floor((random(seed)() * 360) / 45) % 8;

/** The picture as RGB bytes, row by row. `t` runs from 0 to 1 over a video. */
export function paint(seed: number, width: number, height: number, t = 0): Uint8Array {
  const rnd = random(seed);
  const hue = rnd() * 360;
  const top = hsl(hue, 0.55, 0.2);
  const bottom = hsl((hue + 40) % 360, 0.75, 0.62);
  const sun = { x: 0.18 + 0.3 * rnd() + 0.34 * t, y: 0.24 + 0.14 * rnd() - 0.06 * t, r: 0.08 + 0.04 * rnd(), color: hsl((hue + 60) % 360, 0.95, 0.82) };
  const hills = [0, 1, 2].map((i) => ({
    base: 0.56 + 0.13 * i,
    amp: 0.04 + 0.05 * rnd(),
    freq: 1.2 + 2.6 * rnd(),
    phase: rnd() * Math.PI * 2 + t * (i + 1) * 1.6,
    color: hsl((hue + 150 + 25 * i) % 360, 0.38, 0.3 - 0.08 * i),
  }));
  const aspect = width / height;
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      let c = mix(top, bottom, Math.min(1, v * 1.5));
      const d = Math.hypot((u - sun.x) * aspect, v - sun.y);
      if (d < sun.r) c = sun.color;
      else c = mix(c, sun.color, Math.max(0, 0.55 - (d - sun.r) * 2.4) * 0.6);
      for (const h of hills) {
        const line = h.base + h.amp * Math.sin(h.freq * Math.PI * 2 * u + h.phase) + h.amp * 0.4 * Math.sin(h.freq * 5.4 * Math.PI * u + h.phase * 1.7);
        if (v > line) c = mix(h.color, [0, 0, 0], Math.min(0.5, (v - line) * 0.9));
      }
      const at = (y * width + x) * 3;
      out[at] = c[0];
      out[at + 1] = c[1];
      out[at + 2] = c[2];
    }
  }
  return out;
}
