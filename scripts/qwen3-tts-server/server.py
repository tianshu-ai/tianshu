#!/usr/bin/env python3
"""Qwen3-TTS MLX FastAPI server — streaming PCM chunks.

Drop-in replacement on the same /inference_sft endpoint so Tianshu
needs zero API changes (same as Kokoro/CosyVoice before it).

Qwen3-TTS 0.6B MLX on M3 Ultra: RTF ~0.3x, first chunk ~2-3s.
Much better voice quality than Kokoro 82M.

Usage:
    conda activate qwen-tts
    python server.py --port 50000 --voice vivian

Endpoint:
    POST /inference_sft
      Form fields: tts_text (str), spk_id (str, optional voice override)
      Response: streaming audio/pcm, 24kHz int16 mono
"""

import argparse
import logging
import time
import os
import glob
import tempfile
import numpy as np
from fastapi import FastAPI, Form
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import soundfile as sf

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
model = None
default_voice = "vivian"
model_id = ""

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


def generate_pcm(tts_text: str, voice: str):
    """Generate audio via mlx_audio, yield int16 PCM bytes."""
    from mlx_audio.tts.generate import generate_audio

    t0 = time.time()

    # mlx_audio writes to file, we use a tmpdir and read back
    with tempfile.TemporaryDirectory() as tmpdir:
        generate_audio(
            text=tts_text,
            model=model_id,
            voice=voice,
            output_path=tmpdir,
            file_prefix="tts",
            audio_format="wav",
            save=True,
            play=False,
            verbose=False,
        )

        # Find generated wav
        files = sorted(glob.glob(os.path.join(tmpdir, "tts_*.wav")))
        if not files:
            log.warning("No audio file generated for voice=%s", voice)
            return

        audio_data, sr = sf.read(files[0], dtype="float32")
        
    # Convert to int16 PCM
    pcm = (audio_data * 32767).astype(np.int16).tobytes()
    audio_dur = len(audio_data) / sr
    wall = time.time() - t0

    log.info(
        "generated: %.2fs audio in %.3fs wall, RTF=%.3f (voice=%s)",
        audio_dur, wall, wall / audio_dur if audio_dur > 0 else 0, voice,
    )

    # Yield in chunks for streaming
    chunk_size = 4096
    for i in range(0, len(pcm), chunk_size):
        yield pcm[i:i + chunk_size]


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
        generate_pcm(tts_text, voice),
        media_type="audio/pcm",
    )


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": model_id,
        "default_voice": default_voice,
        "available_voices": AVAILABLE_VOICES,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=50000)
    parser.add_argument("--voice", type=str, default="vivian",
                        help="Default voice (serena/vivian/uncle_fu/ryan/aiden/...)")
    parser.add_argument("--model", type=str,
                        default="mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
                        help="MLX model id from HuggingFace")
    args = parser.parse_args()
    default_voice = args.voice
    model_id = args.model

    # Warm up: pre-load model by generating a tiny clip
    log.info("Loading Qwen3-TTS MLX model: %s", model_id)
    from mlx_audio.tts.generate import generate_audio
    with tempfile.TemporaryDirectory() as tmpdir:
        generate_audio(
            text="测试",
            model=model_id,
            voice=default_voice,
            output_path=tmpdir,
            file_prefix="warmup",
            audio_format="wav",
            save=True,
            play=False,
            verbose=False,
        )
    log.info("Model warm, default voice: %s", default_voice)

    uvicorn.run(app, host="0.0.0.0", port=args.port)
