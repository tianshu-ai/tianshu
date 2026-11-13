/**
 * Browser-side Moss-Live voice client.
 * 
 * Captures microphone audio → PCM 16kHz mono → sends via WebSocket.
 * Receives audio from server → plays via AudioContext.
 * Displays transcripts and delegation status.
 */

// ── Audio capture ──

const SAMPLE_RATE = 16000; // Moss-Live expects 16kHz input
const PLAYBACK_RATE = 48000; // Moss-Live sends 48kHz output

export interface MossLiveClient {
  connect(): Promise<void>;
  disconnect(): void;
  setMicEnabled(enabled: boolean): void;
  onTranscript?: (type: "input" | "output", text: string, done: boolean) => void;
  onDelegation?: (objective: string, status: "created" | "progress" | "completed" | "failed", text?: string) => void;
  onStateChange?: (state: "connecting" | "connected" | "configuring" | "ready" | "disconnected" | "error") => void;
}

export function createMossLiveClient(wsUrl: string): MossLiveClient {
  let ws: WebSocket | null = null;
  let audioCtx: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let micEnabled = false;
  let state: string = "disconnected";

  const client: MossLiveClient = {
    async connect() {
      setState("connecting");
      
      // Open WebSocket to tianshu server proxy
      ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setState("connected");
        // Server handles attach_session + session.update
        // We just wait for session_attached confirmation
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Binary: audio from Moss-Live → play
          playAudio(event.data);
        } else {
          // Text: JSON event
          try {
            const msg = JSON.parse(event.data);
            handleEvent(msg);
          } catch { /* ignore */ }
        }
      };

      ws.onerror = (err) => {
        console.error("[moss-live-client] ws error:", err);
        setState("error");
      };

      ws.onclose = () => {
        setState("disconnected");
        stopMic();
      };
    },

    disconnect() {
      stopMic();
      ws?.close();
      ws = null;
      audioCtx?.close();
      audioCtx = null;
    },

    setMicEnabled(enabled: boolean) {
      micEnabled = enabled;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          action: "mic_state",
          mic: { enabled },
        }));
      }
      if (enabled) {
        startMic();
      } else {
        stopMic();
      }
    },
  };

  function setState(s: string) {
    state = s;
    client.onStateChange?.(s as any);
  }

  function handleEvent(msg: Record<string, unknown>) {
    const action = msg.action as string;
    const data = msg.data as Record<string, unknown> | undefined;

    switch (action) {
      case "session_attached":
        setState("configuring");
        break;

      case "session.updated":
        if (data?.error === "") {
          setState("ready");
        }
        break;

      // User speech transcripts
      case "input.transcript.updated":
        client.onTranscript?.("input", data?.text as string || "", false);
        break;
      case "input.transcript.done":
        client.onTranscript?.("input", data?.text as string || "", true);
        break;

      // Model response transcripts
      case "output.transcript.updated":
        client.onTranscript?.("output", data?.text as string || "", false);
        break;
      case "output.transcript.done":
        client.onTranscript?.("output", data?.text as string || "", true);
        break;

      // Delegation events
      case "session.delegation.created": {
        const delegation = data?.delegation as Record<string, unknown>;
        client.onDelegation?.(delegation?.objective as string, "created");
        break;
      }
      case "session.commentary.appended": {
        // Progress/result from tianshu agent
        break;
      }

      // Audio events
      case "response.audio.started":
        // Prepare for audio playback
        break;
      case "response.audio.done":
        // Send playback.completed when done
        break;
      case "response.audio.stop":
        // Stop playback
        break;

      case "error":
        console.error("[moss-live-client] error:", data);
        break;
    }
  }

  // ── Microphone capture ──

  async function startMic() {
    if (mediaStream) return;

    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    // Use ScriptProcessorNode for PCM capture (AudioWorklet is better
    // but requires a separate file; this works for the spike)
    const source = audioCtx.createMediaStreamSource(mediaStream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (!micEnabled || ws?.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      // Convert Float32 → Int16 PCM
      const pcm = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      ws.send(pcm.buffer);
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);
  }

  function stopMic() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  // ── Audio playback ──

  let playbackQueue: ArrayBuffer[] = [];
  let isPlaying = false;

  function playAudio(buffer: ArrayBuffer) {
    playbackQueue.push(buffer);
    if (!isPlaying) drainPlayback();
  }

  async function drainPlayback() {
    if (!audioCtx) {
      audioCtx = new AudioContext({ sampleRate: PLAYBACK_RATE });
    }
    isPlaying = true;

    while (playbackQueue.length > 0) {
      const buf = playbackQueue.shift()!;
      // Convert Int16 PCM → Float32
      const int16 = new Int16Array(buf);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 0x8000;
      }

      const audioBuffer = audioCtx.createBuffer(1, float32.length, PLAYBACK_RATE);
      audioBuffer.copyToChannel(float32, 0);

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.start();

      // Wait for this chunk to finish
      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
      });
    }

    isPlaying = false;
  }

  return client;
}
