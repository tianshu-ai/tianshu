// AudioWorklet processor that ships mic input to the main thread in
// ~250 ms Float32 chunks, WITHOUT resampling.
//
// Yu, 2026-09-19: this worklet used to do linear-interpolation
// resampling to 16 kHz because AudioContext was created at the
// platform's native rate (44.1/48 kHz). That's what caused the
// "你你你你你" repeated-token bug — the resampler produced
// slightly-off-cadence samples that sherpa's streaming zipformer
// interpreted as multiple identical utterances.
//
// The fix (mirroring sherpa's official WASM demo, app-asr.js) is to
// force `new AudioContext({ sampleRate: 16000 })` on the main thread
// and let the browser do the resampling in native code. This worklet
// then just batches whatever it receives and postMessages it. No
// arithmetic on samples means no chance to introduce artefacts.
//
// Design notes:
// - AudioWorklet runs on the audio thread; no fetch/console/etc.
// - We accumulate 128-sample render quanta into a 4000-sample chunk
//   (~250 ms at 16 kHz) and postMessage that. Transfer the backing
//   buffer to avoid a copy.
// - If the platform delivers channel-0 stereo, we take channel 0 only.
// - Input rate is trusted to be 16 kHz because the main thread
//   requested AudioContext({sampleRate: 16000}) — the browser resamples
//   the mic stream into the context rate before we see it.

const CHUNK_SAMPLES = 4000; // ~250 ms at 16 kHz

class AsrProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(CHUNK_SAMPLES);
    this._len = 0;
    this._stopped = false;
    this.port.onmessage = (ev) => {
      if (ev.data === 'stop') this._stopped = true;
    };
  }

  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;

    // Copy incoming samples into the buffer. If we cross the chunk
    // boundary mid-quantum, split it — ship the completed chunk and
    // start the next one with the leftover.
    let inOff = 0;
    while (inOff < ch0.length) {
      const room = CHUNK_SAMPLES - this._len;
      const take = Math.min(room, ch0.length - inOff);
      this._buf.set(ch0.subarray(inOff, inOff + take), this._len);
      this._len += take;
      inOff += take;

      if (this._len === CHUNK_SAMPLES) {
        // Ship a full chunk. Transfer the backing buffer to avoid a
        // copy — but that detaches this._buf, so allocate a fresh
        // one for the next chunk.
        const out = this._buf;
        this._buf = new Float32Array(CHUNK_SAMPLES);
        this._len = 0;
        this.port.postMessage({ samples: out }, [out.buffer]);
      }
    }

    return true;
  }
}

registerProcessor('asr-processor', AsrProcessor);
