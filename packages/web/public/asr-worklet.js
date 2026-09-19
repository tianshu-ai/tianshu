// AudioWorklet processor that converts mic input to 16kHz mono Float32
// PCM chunks and posts them to the main thread via `port.postMessage`.
//
// The main thread creates an AudioContext at the platform's native rate
// (usually 48 kHz on macOS) and connects a MediaStreamSource → this
// worklet. On each 128-sample render quantum we accumulate audio into a
// downsample buffer; once we have enough source samples to produce ~250 ms
// at 16 kHz (4000 output samples), we resample, ship as a Float32Array,
// and reset.
//
// Design notes:
// - AudioWorklet runs on the audio thread; no fetch/console/etc.
// - Simple linear-interpolation resampling is good enough for ASR
//   (sherpa's zipformer models tolerate it fine — verified in the spike).
// - We ship raw Float32 (no int16 quantisation) because the WS handler
//   feeds Float32 straight into sherpa.acceptWaveform().

const TARGET_RATE = 16000;
const CHUNK_MS = 250; // send every 250 ms
const OUT_SAMPLES_PER_CHUNK = (TARGET_RATE * CHUNK_MS) / 1000; // 4000

class AsrProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Source-rate ring buffer; sized to hold enough for one output chunk.
    this._srcRate = sampleRate; // AudioWorklet global — the AudioContext rate
    this._ratio = this._srcRate / TARGET_RATE;
    // Rough max we'd need for one output chunk, +1 for interpolation safety.
    this._srcNeeded = Math.ceil(OUT_SAMPLES_PER_CHUNK * this._ratio) + 1;
    this._srcBuf = new Float32Array(this._srcNeeded * 2); // extra headroom
    this._srcLen = 0;
    // Fractional index tracked across chunks so we don't skip samples on
    // boundaries.
    this._srcPos = 0;
    this._stopped = false;
    this.port.onmessage = (ev) => {
      if (ev.data === 'stop') this._stopped = true;
    };
  }

  process(inputs) {
    if (this._stopped) return false; // detach worklet
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0]; // mono; if stereo we take channel 0
    if (!ch0 || ch0.length === 0) return true;

    // Append to source buffer
    if (this._srcLen + ch0.length > this._srcBuf.length) {
      // Grow — shouldn't normally happen with 128-sample quanta
      const grown = new Float32Array(this._srcBuf.length * 2);
      grown.set(this._srcBuf.subarray(0, this._srcLen));
      this._srcBuf = grown;
    }
    this._srcBuf.set(ch0, this._srcLen);
    this._srcLen += ch0.length;

    // Produce as many output chunks as we have source samples for.
    while (true) {
      // How many source samples we need for one full output chunk starting
      // at this._srcPos.
      const need = Math.ceil((OUT_SAMPLES_PER_CHUNK - 1) * this._ratio) + 2;
      if (this._srcLen - Math.floor(this._srcPos) < need) break;

      const out = new Float32Array(OUT_SAMPLES_PER_CHUNK);
      for (let i = 0; i < OUT_SAMPLES_PER_CHUNK; i++) {
        const srcIdx = this._srcPos + i * this._ratio;
        const i0 = Math.floor(srcIdx);
        const i1 = i0 + 1;
        const frac = srcIdx - i0;
        const s0 = this._srcBuf[i0] ?? 0;
        const s1 = this._srcBuf[i1] ?? s0;
        out[i] = s0 * (1 - frac) + s1 * frac;
      }
      // Yu, 2026-09-19: silence gate. Sherpa's streaming recognizer
      // does not tolerate long stretches of near-zero audio — it
      // reprocesses the last hypothesis token forever, producing
      // "走走走走停停停停你停你停" runaway output when mic is on but user
      // is quiet. Compute chunk RMS; if it's below a talking-noise-
      // floor threshold, drop the chunk on the floor instead of
      // shipping it. 0.005 was tuned by ear against Yu's mic setup;
      // whispered speech still crosses it, tabletop keystrokes and
      // room silence don't. If this proves too aggressive we can
      // switch to a proper VAD (webrtc's or sherpa's own) later.
      let sumSq = 0;
      for (let i = 0; i < out.length; i++) sumSq += out[i] * out[i];
      const rms = Math.sqrt(sumSq / out.length);
      if (rms >= 0.005) {
        // Ship to main thread. Transfer the underlying buffer to avoid a copy.
        this.port.postMessage({ samples: out }, [out.buffer]);
      }
      // If gated, we still advance the cursor below so the buffer stays
      // in sync — we just skip the send. Silent audio doesn't need to
      // be replayed later, we're not archiving.
      void 0; // marker for the edit — no-op

      // Advance the source cursor by the fractional amount consumed.
      this._srcPos += OUT_SAMPLES_PER_CHUNK * this._ratio;
    }

    // Compact the source buffer periodically so it doesn't grow unbounded.
    // Drop everything before the current fractional cursor, keep the
    // remainder + fractional offset.
    const dropWholeSamples = Math.floor(this._srcPos);
    if (dropWholeSamples > 1024) {
      this._srcBuf.copyWithin(0, dropWholeSamples, this._srcLen);
      this._srcLen -= dropWholeSamples;
      this._srcPos -= dropWholeSamples;
    }

    return true;
  }
}

registerProcessor('asr-processor', AsrProcessor);
