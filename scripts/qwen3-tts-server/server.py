#!/usr/bin/env python3
"""Qwen3-TTS MLX FastAPI server — true streaming PCM chunks.

Uses model.generate(stream=True) to yield audio chunks as they are
generated, so the first PCM bytes arrive in ~1-2s regardless of text
length.

Usage:
    conda activate qwen-tts   # or venv with mlx-audio ≥ 0.5
    python server.py --port 50000 --voice vivian

Endpoint:
    POST /inference_sft
      Form fields: tts_text (str), spk_id (str, optional voice override)
      Response: streaming audio/pcm, 24kHz int16 mono
"""

import argparse
import logging
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
default_voice = "vivian"
model_id = ""
sample_rate = 24000   # will be updated from model after load

# Map legacy CosyVoice/Kokoro spk_ids → Qwen3-TTS voice names
SPK_ALIAS = {
    "中文女": "vivian",
    "中文男": "uncle_fu",
    "英文女": "serena",
    "英文男": "ryan",
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

AVAILABLE_VOICES = ["serena", "vivian", "uncle_fu", "ryan", "aiden",
                    "ono_anna", "sohee", "eric", "dylan"]


def generate_pcm_streaming(tts_text: str, voice: str):
    """Generate audio via model.generate(stream=True), yield int16 PCM
    bytes as soon as each chunk is ready."""
    t0 = time.time()
    first_chunk_time = None
    total_bytes = 0
    chunk_count = 0

    results = model.generate(
        text=tts_text,
        voice=voice,
        verbose=False,
        stream=True,
        streaming_interval=2.0,  # yield every ~2s of audio
    )

    for result in results:
        # result.audio is an mx.array of float samples
        audio_np = np.array(result.audio, dtype=np.float32).flatten()
        pcm = (audio_np * 32767).clip(-32768, 32767).astype(np.int16).tobytes()

        if first_chunk_time is None:
            first_chunk_time = time.time() - t0

        total_bytes += len(pcm)
        chunk_count += 1
        yield pcm

    wall = time.time() - t0
    audio_dur = total_bytes / (sample_rate * 2)  # 2 bytes per int16 sample
    log.info(
        "streamed: %.1fs audio in %.3fs wall (first chunk %.3fs), "
        "%d chunks, RTF=%.3f, voice=%s",
        audio_dur, wall, first_chunk_time or 0, chunk_count,
        wall / audio_dur if audio_dur > 0 else 0, voice,
    )


@app.get("/inference_sft")
@app.post("/inference_sft")
async def inference_sft(
    tts_text: str = Form(),
    spk_id: str = Form(default=""),
):
    raw = spk_id.strip()
    voice = SPK_ALIAS.get(raw, raw) if raw else default_voice
    if voice not in AVAILABLE_VOICES:
        voice = default_voice
    log.info("request: %d chars, voice=%s (raw spk_id=%s)", len(tts_text), voice, raw)
    return StreamingResponse(
        generate_pcm_streaming(tts_text, voice),
        media_type="audio/pcm",
    )


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": model_id,
        "default_voice": default_voice,
        "available_voices": AVAILABLE_VOICES,
        "sample_rate": sample_rate,
        "streaming": True,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=50000)
    parser.add_argument("--voice", type=str, default="vivian",
                        help="Default voice (serena/vivian/uncle_fu/ryan/aiden/...)")
    parser.add_argument("--model", type=str,
                        default="mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16",
                        help="MLX model id from HuggingFace")
    args = parser.parse_args()
    default_voice = args.voice
    model_id = args.model

    # Pre-load model into memory (instead of lazy-loading per request)
    log.info("Loading Qwen3-TTS MLX model: %s", model_id)
    from mlx_audio.tts import load_model
    model = load_model(model_path=model_id)
    sample_rate = model.sample_rate
    log.info("Model loaded, sample_rate=%d", sample_rate)

    # Warm up: generate a tiny clip to JIT-compile compute graphs
    log.info("Warming up...")
    for result in model.generate(text="测试", voice=default_voice, verbose=False):
        pass
    mx.clear_cache()
    log.info("Warm, default voice: %s, streaming mode ON", default_voice)

    uvicorn.run(app, host="0.0.0.0", port=args.port)
