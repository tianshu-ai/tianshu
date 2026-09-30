#!/usr/bin/env python3
"""Qwen3-TTS FastAPI server — cross-platform (MLX on Apple Silicon, PyTorch on Linux/CUDA).

Auto-detects the runtime:
  - Apple Silicon (macOS arm64): uses mlx_audio for streaming generation
  - Linux / CUDA: uses qwen-tts (official PyTorch package)
  - CPU fallback: uses qwen-tts with float32

Both backends expose the same HTTP API so the tianshu server doesn't
need to know which one is running.

Supports two model variants:
  - CustomVoice: preset speakers (vivian, serena, ryan, etc.)
  - Base: voice cloning via ref_audio + ref_text

Custom voice files (*.wav) in the voices/ directory next to this script
are auto-registered as cloneable voices. Use their filename (without
extension) as the voice name.

Usage:
    python server.py --port 50000 --voice yujie
    python server.py --port 50000 --voice vivian --backend mlx
    python server.py --port 50000 --voice yujie --backend pytorch

Endpoint:
    POST /inference_sft
      Form fields: tts_text (str), spk_id (str, optional voice override)
      Response: streaming audio/pcm, 24kHz int16 mono
"""

import argparse
import asyncio
import glob
import logging
import os
import platform
import sys
import time

import numpy as np
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

# ─── Globals set in __main__ ─────────────────────────────────

backend = ""           # "mlx" or "pytorch"
model = None           # pre-loaded model instance (backend-specific)
model_type = ""        # "custom_voice" or "base"
default_voice = "vivian"
model_id = ""
sample_rate = 24000

# ─── Voice registry ──────────────────────────────────────────

PRESET_VOICES = [
    "serena", "vivian", "uncle_fu", "ryan", "aiden",
    "ono_anna", "sohee", "eric", "dylan",
]

custom_voices: dict[str, str] = {}

SPK_ALIAS = {
    "中文女": "huopo", "中文男": "nansheng", "英文女": "jenny",
    "英文男": "guy", "御姐": "yujie", "播音": "boyin",
    "温柔": "nansheng", "活泼": "huopo",
    "zh-cn-xiaoxiaoneural": "yujie", "zh-cn-xiaoyineural": "huopo",
    "zh-cn-yunxineural": "nansheng", "zh-cn-yunjianneural": "boyin",
    "zh-cn-yunxianeural": "nansheng", "en-us-jennyneural": "jenny",
    "en-us-guyneural": "guy", "en-us-arianeural": "jenny",
    "en-us-davisneural": "guy",
    "zf_xiaobei": "huopo", "zf_xiaoxiao": "yujie",
    "zm_yunxi": "nansheng", "zm_yunyang": "nansheng",
    "zm_yunjian": "boyin", "zf_xiaoni": "huopo",
    "zf_xiaoni": "huopo", "zf_xiaoyi": "huopo",
    "zm_yunxia": "nansheng",
}


def _load_custom_voices():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    voices_dir = os.path.join(script_dir, "voices")
    if not os.path.isdir(voices_dir):
        return
    for wav_path in sorted(glob.glob(os.path.join(voices_dir, "*.wav"))):
        name = os.path.splitext(os.path.basename(wav_path))[0]
        if name.endswith("_ref"):
            name = name[:-4]
        custom_voices[name] = wav_path
        log.info("Registered custom voice: %s → %s", name, wav_path)


def _resolve_voice(raw_spk_id: str) -> tuple[str, str | None]:
    lowered = raw_spk_id.strip().lower() if raw_spk_id else ""
    voice = SPK_ALIAS.get(lowered, raw_spk_id) if lowered else default_voice
    if voice in custom_voices:
        return voice, custom_voices[voice]
    if voice in PRESET_VOICES and model_type == "custom_voice":
        return voice, None
    if default_voice in custom_voices:
        return default_voice, custom_voices[default_voice]
    return default_voice, None


# ─── Backend: MLX (Apple Silicon) ────────────────────────────

def load_model_mlx(mid: str):
    global model, model_type, sample_rate
    log.info("Loading MLX model: %s", mid)
    from mlx_audio.tts import load_model as mlx_load
    model = mlx_load(model_path=mid)
    sample_rate = model.sample_rate
    model_type = getattr(model.config, "tts_model_type", "base")
    log.info("MLX model loaded: type=%s, sr=%d", model_type, sample_rate)


async def generate_pcm_mlx(tts_text: str, voice: str, ref_audio: str | None):
    import mlx.core as mx  # noqa: F811
    t0 = time.time()
    first_chunk_time = None
    total_bytes = 0
    chunk_count = 0

    gen_kwargs = dict(text=tts_text, verbose=False, stream=True, streaming_interval=2.0)
    if ref_audio:
        gen_kwargs["ref_audio"] = ref_audio
    else:
        gen_kwargs["voice"] = voice

    try:
        for result in model.generate(**gen_kwargs):
            audio_np = np.array(result.audio, dtype=np.float32).flatten()
            pcm = (audio_np * 32767).clip(-32768, 32767).astype(np.int16).tobytes()
            if first_chunk_time is None:
                first_chunk_time = time.time() - t0
            total_bytes += len(pcm)
            chunk_count += 1
            yield pcm
            await asyncio.sleep(0)
    except Exception as e:
        log.error("MLX generate failed: %s", e)
        return

    wall = time.time() - t0
    audio_dur = total_bytes / (sample_rate * 2)
    log.info(
        "MLX streamed: %.1fs audio in %.3fs (first=%.3fs, %d chunks, RTF=%.3f, voice=%s)",
        audio_dur, wall, first_chunk_time or 0, chunk_count,
        wall / audio_dur if audio_dur > 0 else 0, voice,
    )


def warmup_mlx():
    import mlx.core as mx  # noqa: F811
    voice, ref_audio = _resolve_voice(default_voice)
    kw = dict(text="测试", verbose=False)
    if ref_audio:
        kw["ref_audio"] = ref_audio
    else:
        kw["voice"] = voice
    for _ in model.generate(**kw):
        pass
    mx.clear_cache()


# ─── Backend: PyTorch (Linux / CUDA) ─────────────────────────

def load_model_pytorch(mid: str):
    global model, model_type, sample_rate
    import torch
    from qwen_tts import Qwen3TTSModel

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32

    load_kwargs = dict(device_map=device, dtype=dtype)
    # Use flash_attention_2 if available on CUDA
    if torch.cuda.is_available():
        try:
            import flash_attn  # noqa: F401
            load_kwargs["attn_implementation"] = "flash_attention_2"
            log.info("FlashAttention 2 available, using it")
        except ImportError:
            log.info("FlashAttention 2 not found, using default attention")

    log.info("Loading PyTorch model: %s (device=%s, dtype=%s)", mid, device, dtype)
    model = Qwen3TTSModel.from_pretrained(mid, **load_kwargs)
    sample_rate = 24000  # Qwen3-TTS always 24kHz

    # Detect model type from model class or config
    cls_name = type(model).__name__.lower()
    if "customvoice" in cls_name:
        model_type = "custom_voice"
    elif "voicedesign" in cls_name:
        model_type = "voice_design"
    else:
        model_type = "base"

    log.info("PyTorch model loaded: type=%s, device=%s", model_type, device)


async def generate_pcm_pytorch(tts_text: str, voice: str, ref_audio: str | None):
    """Generate audio with PyTorch backend.

    The official qwen-tts package doesn't support streaming, so we
    generate the full audio then yield it in chunks for consistent API.
    """
    t0 = time.time()

    try:
        if ref_audio:
            # Base model: voice cloning
            wavs, sr = model.generate_voice_clone(
                text=tts_text,
                ref_audio=ref_audio,
            )
        elif model_type == "custom_voice":
            # CustomVoice model: preset speaker
            wavs, sr = model.generate_custom_voice(
                text=tts_text,
                speaker=voice.capitalize(),
                language="Auto",
            )
        else:
            # Base model without ref audio — use ref_audio from default voice
            _, fallback_ref = _resolve_voice(default_voice)
            if fallback_ref:
                wavs, sr = model.generate_voice_clone(
                    text=tts_text,
                    ref_audio=fallback_ref,
                )
            else:
                log.error("No ref audio and not a custom_voice model")
                return

        audio_np = np.array(wavs[0], dtype=np.float32).flatten()
        pcm = (audio_np * 32767).clip(-32768, 32767).astype(np.int16).tobytes()

        wall = time.time() - t0
        audio_dur = len(pcm) / (sample_rate * 2)
        log.info(
            "PyTorch generated: %.1fs audio in %.3fs (RTF=%.3f, voice=%s)",
            audio_dur, wall, wall / audio_dur if audio_dur > 0 else 0, voice,
        )

        # Yield in ~0.5s chunks for streaming response
        chunk_size = sample_rate  # 0.5s of int16 = 24000 samples = 48000 bytes
        for i in range(0, len(pcm), chunk_size):
            yield pcm[i:i + chunk_size]
            await asyncio.sleep(0)

    except Exception as e:
        log.error("PyTorch generate failed: %s", e)
        return


def warmup_pytorch():
    voice, ref_audio = _resolve_voice(default_voice)
    try:
        if ref_audio:
            model.generate_voice_clone(text="test", ref_audio=ref_audio)
        elif model_type == "custom_voice":
            model.generate_custom_voice(
                text="test", speaker=voice.capitalize(), language="Auto",
            )
        log.info("PyTorch warmup done")
    except Exception as e:
        log.warning("PyTorch warmup failed (non-fatal): %s", e)


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
        "request: %d chars, voice=%s, ref=%s, backend=%s (raw=%s)",
        len(tts_text), voice, "yes" if ref_audio else "no", backend, raw,
    )

    if backend == "mlx":
        gen = generate_pcm_mlx(tts_text, voice, ref_audio)
    else:
        gen = generate_pcm_pytorch(tts_text, voice, ref_audio)

    return StreamingResponse(gen, media_type="audio/pcm")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": model_id,
        "model_type": model_type,
        "backend": backend,
        "default_voice": default_voice,
        "preset_voices": PRESET_VOICES if model_type == "custom_voice" else [],
        "custom_voices": list(custom_voices.keys()),
        "sample_rate": sample_rate,
        "streaming": backend == "mlx",  # true streaming only on MLX
    }


# ─── Auto-detect backend ─────────────────────────────────────

DEFAULT_MODELS = {
    "mlx": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
    "pytorch": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
}

def detect_backend() -> str:
    """Auto-detect the best backend for this platform."""
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        try:
            import mlx.core  # noqa: F401
            return "mlx"
        except ImportError:
            pass
    # Fallback to PyTorch
    try:
        import torch  # noqa: F401
        return "pytorch"
    except ImportError:
        pass
    log.error("No backend available. Install mlx-audio (Mac) or qwen-tts (Linux).")
    sys.exit(1)


# ─── Main ────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=50000)
    parser.add_argument("--voice", type=str, default="yujie",
                        help="Default voice name (preset or custom ref-audio)")
    parser.add_argument("--model", type=str, default="",
                        help="Model id (HuggingFace). Auto-selected per backend if empty.")
    parser.add_argument("--backend", type=str, default="auto",
                        choices=["auto", "mlx", "pytorch"],
                        help="Force a specific backend (default: auto-detect)")
    args = parser.parse_args()
    default_voice = args.voice

    # Detect or use specified backend
    backend = args.backend if args.backend != "auto" else detect_backend()
    log.info("Backend: %s", backend)

    # Model ID: use explicit --model, or auto-select per backend
    model_id = args.model or DEFAULT_MODELS.get(backend, DEFAULT_MODELS["pytorch"])

    # Load custom ref-audio voices
    _load_custom_voices()

    # Load model
    if backend == "mlx":
        load_model_mlx(model_id)
    else:
        load_model_pytorch(model_id)

    if custom_voices:
        log.info("Custom voices: %s", ", ".join(custom_voices.keys()))

    # Warmup
    log.info("Warming up...")
    if backend == "mlx":
        warmup_mlx()
    else:
        warmup_pytorch()
    log.info("Ready. Default voice: %s, backend: %s", default_voice, backend)

    uvicorn.run(app, host="0.0.0.0", port=args.port)
