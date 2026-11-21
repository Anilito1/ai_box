// A playable MP4 from RGB frames, written by hand: no encoder to install for the simulated video.
//
// H.264 lets a macroblock carry its pixels as they are (type I_PCM: no prediction, no transform, no entropy coding).
// A stream made only of such blocks, every picture a key frame, is a few header bits and the raw samples. It is as
// large as raw video, which is fine for a three-second sample, and every H.264 decoder plays it.

class Bits {
  readonly bytes: number[] = [];
  private current = 0;
  private count = 0;

  bit(b: number): void {
    this.current = (this.current << 1) | (b & 1);
    if (++this.count === 8) {
      this.bytes.push(this.current);
      this.current = 0;
      this.count = 0;
    }
  }
  /** `length` bits, the highest first. */
  u(length: number, value: number): void {
    for (let i = length - 1; i >= 0; i--) this.bit((value >>> i) & 1);
  }
  /** Exp-Golomb, the code H.264's headers are written in. */
  ue(value: number): void {
    const length = 32 - Math.clz32(value + 1);
    this.u(length - 1, 0);
    this.u(length, value + 1);
  }
  se(value: number): void {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }
  /** Zero bits up to the next byte. */
  align(): void {
    while (this.count) this.bit(0);
  }
  /** The bit that ends a unit, then the padding. */
  end(): void {
    this.bit(1);
    this.align();
  }
}

/** A NAL unit: its header byte, then the payload with the bytes that would look like a start code kept apart. */
function nal(header: number, payload: ArrayLike<number>): Uint8Array {
  const out = [header];
  let zeros = 0;
  for (let i = 0; i < payload.length; i++) {
    const b = payload[i];
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

const PROFILE = 66; // Baseline
const LEVEL = 30;

function sps(mbWidth: number, mbHeight: number): Uint8Array {
  const b = new Bits();
  b.u(8, PROFILE);
  b.u(8, 0xc0); // constraint_set0 and 1: also a valid Main stream
  b.u(8, LEVEL);
  b.ue(0); // seq_parameter_set_id
  b.ue(0); // log2_max_frame_num_minus4: frame_num on 4 bits
  b.ue(2); // pic_order_cnt_type 2: shown in the order they are decoded, nothing to write per picture
  b.ue(1); // max_num_ref_frames
  b.bit(0); // gaps_in_frame_num_value_allowed_flag
  b.ue(mbWidth - 1);
  b.ue(mbHeight - 1);
  b.bit(1); // frame_mbs_only_flag
  b.bit(0); // direct_8x8_inference_flag
  b.bit(0); // frame_cropping_flag
  b.bit(0); // vui_parameters_present_flag
  b.end();
  return nal(0x67, b.bytes);
}

function pps(): Uint8Array {
  const b = new Bits();
  b.ue(0); // pic_parameter_set_id
  b.ue(0); // seq_parameter_set_id
  b.bit(0); // entropy_coding_mode_flag: CAVLC
  b.bit(0); // bottom_field_pic_order_in_frame_present_flag
  b.ue(0); // num_slice_groups_minus1
  b.ue(0); // num_ref_idx_l0_default_active_minus1
  b.ue(0); // num_ref_idx_l1_default_active_minus1
  b.bit(0); // weighted_pred_flag
  b.u(2, 0); // weighted_bipred_idc
  b.se(0); // pic_init_qp_minus26
  b.se(0); // pic_init_qs_minus26
  b.se(0); // chroma_qp_index_offset
  b.bit(1); // deblocking_filter_control_present_flag: each slice switches the filter off
  b.bit(0); // constrained_intra_pred_flag
  b.bit(0); // redundant_pic_cnt_present_flag
  b.end();
  return nal(0x68, b.bytes);
}

const clamp = (v: number, low: number, high: number) => (v < low ? low : v > high ? high : Math.round(v));

/** One picture as a key frame whose every macroblock carries its samples raw. */
function frame(rgb: Uint8Array, width: number, height: number, index: number): Uint8Array {
  // BT.601, limited range: no sample is ever 0, so the raw bytes never look like a start code.
  const luma = new Uint8Array(width * height);
  const cb = new Uint8Array((width / 2) * (height / 2));
  const cr = new Uint8Array(cb.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      luma[y * width + x] = clamp(16 + 0.257 * rgb[at] + 0.504 * rgb[at + 1] + 0.098 * rgb[at + 2], 16, 235);
    }
  }
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const at = ((y + dy) * width + x + dx) * 3;
        r += rgb[at] / 4;
        g += rgb[at + 1] / 4;
        b += rgb[at + 2] / 4;
      }
      const at = (y / 2) * (width / 2) + x / 2;
      cb[at] = clamp(128 - 0.148 * r - 0.291 * g + 0.439 * b, 16, 240);
      cr[at] = clamp(128 + 0.439 * r - 0.368 * g - 0.071 * b, 16, 240);
    }
  }

  const b = new Bits();
  b.ue(0); // first_mb_in_slice
  b.ue(7); // slice_type: I, and every slice of the picture is
  b.ue(0); // pic_parameter_set_id
  b.u(4, 0); // frame_num: 0 for a key frame
  b.ue(index % 2); // idr_pic_id: differs from the key frame before
  b.bit(0); // no_output_of_prior_pics_flag
  b.bit(0); // long_term_reference_flag
  b.se(0); // slice_qp_delta
  b.ue(1); // disable_deblocking_filter_idc: off
  for (let my = 0; my < height / 16; my++) {
    for (let mx = 0; mx < width / 16; mx++) {
      b.ue(25); // mb_type: I_PCM
      b.align();
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) b.bytes.push(luma[(my * 16 + y) * width + mx * 16 + x]);
      for (const plane of [cb, cr]) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b.bytes.push(plane[(my * 8 + y) * (width / 2) + mx * 8 + x]);
    }
  }
  b.end();
  return nal(0x65, b.bytes);
}

const u32 = (n: number) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u16 = (n: number) => Uint8Array.of((n >>> 8) & 255, n & 255);
const zeros = (n: number) => new Uint8Array(n);
const text = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));
const join = (parts: Uint8Array[]): Uint8Array => Uint8Array.from(Buffer.concat(parts));
const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
  const body = join(parts);
  return join([u32(8 + body.length), text(type), body]);
};
/** A "full" box: a version byte and three bytes of flags before its fields. */
const full = (type: string, flags: number, ...parts: Uint8Array[]) => box(type, u32(flags), ...parts);
const MATRIX = join([u32(0x10000), zeros(12), u32(0x10000), zeros(12), u32(0x40000000)]);

/**
 * An MP4 file of the frames (RGB bytes, `width` and `height` multiples of 16), `fps` pictures a second.
 * The index comes before the pictures, so a player starts without reading the whole file.
 */
export function mp4(frames: Uint8Array[], width: number, height: number, fps: number): Uint8Array {
  if (width % 16 || height % 16) throw new Error('width and height must be multiples of 16');
  const setSps = sps(width / 16, height / 16);
  const setPps = pps();
  // In an MP4 each unit is preceded by its length rather than by a start code.
  const samples = frames.map((rgb, i) => {
    const unit = frame(rgb, width, height, i);
    return join([u32(unit.length), unit]);
  });
  const scale = 1000;
  const delta = Math.round(scale / fps);
  const duration = delta * frames.length;

  const moov = (dataAt: number) =>
    box(
      'moov',
      full('mvhd', 0, zeros(8), u32(scale), u32(duration), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2)),
      box(
        'trak',
        full('tkhd', 3, zeros(8), u32(1), zeros(4), u32(duration), zeros(8), zeros(8), MATRIX, u32(width << 16), u32(height << 16)),
        box(
          'mdia',
          full('mdhd', 0, zeros(8), u32(scale), u32(duration), u16(0x55c4), zeros(2)),
          full('hdlr', 0, zeros(4), text('vide'), zeros(12), text('VideoHandler\0')),
          box(
            'minf',
            full('vmhd', 1, zeros(8)),
            box('dinf', full('dref', 0, u32(1), full('url ', 1))),
            box(
              'stbl',
              full(
                'stsd',
                0,
                u32(1),
                box(
                  'avc1',
                  zeros(6),
                  u16(1),
                  zeros(16),
                  u16(width),
                  u16(height),
                  u32(0x480000),
                  u32(0x480000),
                  zeros(4),
                  u16(1),
                  zeros(32),
                  u16(24),
                  u16(0xffff),
                  box('avcC', Uint8Array.of(1, PROFILE, 0xc0, LEVEL, 0xff, 0xe1), u16(setSps.length), setSps, Uint8Array.of(1), u16(setPps.length), setPps),
                ),
              ),
              full('stts', 0, u32(1), u32(frames.length), u32(delta)),
              full('stsc', 0, u32(1), u32(1), u32(frames.length), u32(1)),
              full('stsz', 0, u32(0), u32(frames.length), ...samples.map((s) => u32(s.length))),
              full('stco', 0, u32(1), u32(dataAt)),
            ),
          ),
        ),
      ),
    );

  const ftyp = box('ftyp', text('isom'), u32(0x200), text('isomiso2avc1mp41'));
  // The index holds the address of the pictures, which depends on its own size: written once to measure it.
  const dataAt = ftyp.length + moov(0).length + 8;
  return join([ftyp, moov(dataAt), box('mdat', ...samples)]);
}
