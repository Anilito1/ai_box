// Runs in the audio thread: turns the microphone's float samples into 16-bit PCM blocks of 100 ms for the main thread.
// The context is created at 16 kHz, so the browser has resampled already.

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

const BLOCK = 1600;

class PcmCapture extends AudioWorkletProcessor {
  private block = new Int16Array(BLOCK);
  private filled = 0;

  constructor() {
    super();
    // "flush": the rest of the last block, shorter than the others, goes out now.
    this.port.onmessage = () => this.send(true);
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      const s = Math.max(-1, Math.min(1, sample));
      this.block[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === BLOCK) this.send(false);
    }
    return true;
  }

  private send(partial: boolean): void {
    if (this.filled === 0) return;
    const pcm = partial ? this.block.slice(0, this.filled) : this.block;
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.block = new Int16Array(BLOCK);
    this.filled = 0;
  }
}

registerProcessor('pcm-capture', PcmCapture);
