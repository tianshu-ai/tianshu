#!/usr/bin/env python3
"""Qwen3-TTS MLX FastAPI server — true streaming PCM chunks.

Uses model.generate(stream=True) to yield audio chunks as they are
generated, so the first PCM bytes arrive in ~1-2s regardless of text
length.

Supports two model variants:
  - CustomVoice: preset speakers (vivian, serena, ryan, etc.)
  - Base: voice cloning via ref_audio + ref_text

Custom voice files (*.wav) in the voices/ directory next to this script
are auto-registered as cloneable voices. Use their filename (without
extension) as the voice name.

Usage:
    python server.py --port 50000 --voice vivian
    python server.py --port 50000 --voice yujie  # uses voices/yujie_ref.wav

Endpoint:
    POST /inference_sft
      Form fields: tts_text (str), spk_id (str, optional voice override)
      Response: streaming audio/pcm, 24kHz int16 mono
"""

import argparse
import logging
import os
import glob
import time
import numpy as np
import mlx.core as mx
from fastapi import FastAPI, Form
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("qwen3-tts-server")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Globals set in __main__
model = None          # pre-loaded mlx_audio Model instance
model_type = ""       # "custom_voice" or "base"
default_voice = "vivian"
model_id = ""
sample_rate = 24000   # will be updated from model after load

# ─── Voice registry ──────────────────────────────────────────

# Preset voices available on CustomVoice models
PRESET_VOICES = [
    "serena", "vivian", "uncle_fu", "ryan", "aiden",
    "ono_anna", "sohee", "eric", "dylan",
]

# Custom ref-audio voices loaded from voices/ directory.
# key: voice name, value: absolute path to wav file.
# Populated at startup by _load_custom_voices().
custom_voices: dict[str, str] = {}

# Map legacy CosyVoice/Kokoro spk_ids → voice names
SPK_ALIAS = {
    "中文女": "vivian",
    "中文男": "uncle_fu",
    "英文女": "serena",
    "英文男": "ryan",
    "御姐": "yujie",
    # Kokoro voice names
    "zf_xiaobei": "vivian",
    "zf_xiaoxiao": "serena",
    "zm_yunxi": "ryan",
    "zm_yunyang": "aiden",
    "zm_yunjian": "uncle_fu",
    "zf_xiaoni": "vivian",
    "zf_xiaoyi": "serena",
    "zm_yunxia": "eric",
}


def _load_custom_voices():
    """Scan voices/ directory for wav files and register them."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    voices_dir = os.path.join(script_dir, "voices")
    if not os.path.isdir(voices_dir):
        return
    for wav_path in sorted(glob.glob(os.path.join(voices_dir, "*.wav"))):
        name = os.path.splitext(os.path.basename(wav_path))[0]
        # Strip _ref suffix for cleaner names: yujie_ref.wav → yujie
        if name.endswith("_ref"):
            name = name[:-4]
        custom_voices[name] = wav_path
        log.info("Registered custom voice: %s → %s", name, wav_path)


def _resolve_voice(raw_spk_id: str) -> tuple[str, str | None]:
    """Resolve a spk_id to (voice_name, ref_audio_path_or_None).

    Returns:
      - For preset voices: (voice_name, None)
      - For custom ref-audio voices: (voice_name, path_to_wav)
      - For unknown voices: falls back to default_voice
    """
    voice = SPK_ALIAS.get(raw_spk_id, raw_spk_id) if raw_spk_id else default_voice

    # Check custom ref-audio voices first
    if voice in custom_voices:
        return voice, custom_voices[voice]

    # Check preset voices (CustomVoice model only)
    if voice in PRESET_VOICES and model_type == "custom_voice":
        return voice, None

    # Fallback
    if default_voice in custom_voices:
        return default_voice, custom_voices[default_voice]
    return default_voice, None


# ─── Streaming generation ────────────────────────────────────

def generate_pcm_streaming(tts_text: str, voice: str, ref_audio: str | None = None):
    """Generate audio via model.generate(stream=True), yield int16 PCM
    bytes as soon as each chunk is ready."""
    t0 = time.time()
    first_chunk_time = None
    total_bytes = 0
    chunk_count = 0

    gen_kwargs = dict(
        text=tts_text,
        verbose=False,
        stream=True,
        streaming_interval=2.0,
    )

    if ref_audio:
        # Base model: voice cloning via ref_audio
        gen_kwargs["ref_audio"] = ref_audio
        # ref_text is auto-transcribed by mlx_audio if not provided
    else:
        # CustomVoice model: preset speaker
        gen_kwargs["voice"] = voice

    results = model.generate(**gen_kwargs)

    for result in results:
        audio_np = np.array(result.audio, dtype=np.float32).flatten()
        pcm = (audio_np * 32767).clip(-32768, 32767).astype(np.int16).tobytes()

        if first_chunk_time is None:
            first_chunk_time = time.time() - t0

        total_bytes += len(pcm)
        chunk_count += 1
        yield pcm

    wall = time.time() - t0
    audio_dur = total_bytes / (sample_rate * 2)
    mode = "clone" if ref_audio else "preset"
    log.info(
        "streamed: %.1fs audio in %.3fs wall (first chunk %.3fs), "
        "%d chunks, RTF=%.3f, voice=%s (%s)",
        audio_dur, wall, first_chunk_time or 0, chunk_count,
        wall / audio_dur if audio_dur > 0 else 0, voice, mode,
    )


# ─── API endpoints ───────────────────────────────────────────

@app.get("/inference_sft")
@app.post("/inference_sft")
async def inference_sft(
    tts_text: str = Form(),
    spk_id: str = Form(default=""),
):
    raw = spk_id.strip()
    voice, ref_audio = _resolve_voice(raw)
    log.info(
        "request: %d chars, voice=%s, ref=%s (raw spk_id=%s)",
        len(tts_text), voice, "yes" if ref_audio else "no", raw,
    )
    return StreamingResponse(
        generate_pcm_streaming(tts_text, voice, ref_audio),
        media_type="audio/pcm",
    )


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": model_id,
        "model_type": model_type,
        "default_voice": default_voice,
        "preset_voices": PRESET_VOICES if model_type == "custom_voice" else [],
        "custom_voices": list(custom_voices.keys()),
        "sample_rate": sample_rate,
        "streaming": True,
    }


# ─── Main ────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=50000)
    parser.add_argument("--voice", type=str, default="yujie",
                        help="Default voice name (preset or custom ref-audio)")
    parser.add_argument("--model", type=str,
                        default="mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
                        help="MLX model id from HuggingFace")
    args = parser.parse_args()
    default_voice = args.voice
    model_id = args.model

    # Load custom ref-audio voices from voices/ directory
    _load_custom_voices()

    # Pre-load model into memory
    log.info("Loading Qwen3-TTS MLX model: %s", model_id)
    from mlx_audio.tts import load_model
    model = load_model(model_path=model_id)
    sample_rate = model.sample_rate

    # Detect model type
    model_type = getattr(model.config, "tts_model_type", "base")
    log.info("Model loaded: type=%s, sample_rate=%d", model_type, sample_rate)

    if custom_voices:
        log.info("Custom voices: %s", ", ".join(custom_voices.keys()))

    # Warm up: generate a tiny clip to JIT-compile compute graphs
    log.info("Warming up...")
    voice, ref_audio = _resolve_voice(default_voice)
    warmup_kwargs = dict(text="测试", verbose=False)
    if ref_audio:
        warmup_kwargs["ref_audio"] = ref_audio
    else:
        warmup_kwargs["voice"] = voice
    for result in model.generate(**warmup_kwargs):
        pass
    mx.clear_cache()
    log.info("Warm, default voice: %s, streaming mode ON", default_voice)

    uvicorn.run(app, host="0.0.0.0", port=args.port)
