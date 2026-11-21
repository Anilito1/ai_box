// The simulated voice: a few soft notes picked from a number, as a WAV file.

const RATE = 16000;

export function wav(seed: number, seconds = 2.4): Uint8Array {
  const count = Math.floor(RATE * seconds);
  const out = Buffer.alloc(44 + count * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + count * 2, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(count * 2, 40);
  const scale = [261.6, 293.7, 329.6, 392, 440, 523.3];
  const notes = 6;
  const per = count / notes;
  for (let i = 0; i < count; i++) {
    const note = Math.floor(i / per);
    const freq = scale[(seed >>> (note * 3)) % scale.length];
    const at = (i % per) / per;
    // Each note fades in and out: no click between two of them.
    const level = Math.sin(Math.PI * at) ** 2 * 0.3;
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * level * 32767), 44 + i * 2);
  }
  return out;
}
