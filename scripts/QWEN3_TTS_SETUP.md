# Qwen3-TTS 本地部署指南 (Mac Apple Silicon)

Qwen3-TTS 是阿里通义开源的语音合成模型 (Apache 2.0)。本文档说明如何在
Mac Apple Silicon 上用 MLX 框架部署 Qwen3-TTS，作为 Tianshu 的本地 TTS 后端。

## 为什么选 Qwen3-TTS

| 指标 | Qwen3-TTS 0.6B MLX | CosyVoice 300M | Kokoro 82M | Edge TTS |
|---|---|---|---|---|
| RTF (M3 Ultra) | **~0.3x** | 6-9x | 0.4x | 云端 |
| 首包延迟 | **~2s** | ~9s | ~2s | ~1.8s |
| 音质 | ★★★★☆ | ★★★★★ | ★★★☆☆ | ★★★★☆ |
| 离线 | ✅ | ✅ | ✅ | ❌ |
| 声音种类 | 9 预设 | 7 预设 | 8 预设 | 13+ |
| 语言 | 中英日韩等 10 语 | 中英日韩粤 | 中英日 | 中英日粤台 |
| 模型大小 | ~800MB (8bit) | ~3GB | ~311MB | - |
| RAM 占用 | ~3GB | ~10GB | ~1GB | - |

**结论**：Qwen3-TTS 在速度和音质之间取得了最佳平衡。CosyVoice 音质最好但
CPU 上太慢（RTF 6x），Kokoro 够快但声音是微软 Edge TTS 的翻版。

## 前置条件

- macOS 14+ (Sonoma 或更新)
- Apple Silicon Mac (M1/M2/M3/M4)
- ~4GB 磁盘空间（Python 环境 + 模型缓存）

> ❗ macOS 自带的 Python 3.9 **太旧**。`mlx-audio` 需要 Python ≥ 3.10 才支持
> `qwen3_tts` 模型类型。如果 `python3 --version` 显示 < 3.10，先装一个：
> `brew install python@3.11` 或用 pyenv/mise/asdf 等。

## 安装步骤

### 1. 创建 Python 环境

两种方式任选：

**方案 A — venv（推荐，无额外依赖）**

```bash
python3.11 -m venv ~/qwen-tts-venv
source ~/qwen-tts-venv/bin/activate
```

**方案 B — conda**

```bash
conda create -n qwen-tts python=3.11 -y
conda activate qwen-tts
```

### 2. 安装依赖

```bash
pip install mlx mlx-audio sounddevice soundfile numpy fastapi uvicorn python-multipart
```

关键包：
- `mlx` + `mlx-audio`：Apple Silicon 原生推理框架，直接用 GPU/ANE
- `fastapi` + `uvicorn`：HTTP server，提供 `/inference_sft` 接口给 Tianshu

### 3. 预下载模型（可选，首次启动会自动下载）

```bash
python -c "
from mlx_audio.tts.generate import generate_audio
import tempfile, os
with tempfile.TemporaryDirectory() as d:
    generate_audio(
        text='测试',
        model='mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit',
        voice='vivian',
        output_path=d, file_prefix='test', audio_format='wav',
        save=True, play=False, verbose=False,
    )
print('Model downloaded and verified.')
"
```

模型缓存在 `~/.cache/huggingface/hub/models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit/`。

## 启动 TTS Server

server 脚本位于 tianshu 仓库的 `scripts/qwen3-tts-server/server.py`。

```bash
conda activate qwen-tts
python scripts/qwen3-tts-server/server.py \
  --port 50000 \
  --voice vivian
```

启动参数：
- `--port 50000`：监听端口，与 Tianshu 的 `TTS_URL` 环境变量对应
- `--voice vivian`：默认声音（客户端不指定时使用）

首次启动约 30 秒（下载模型 + 编译 MLX graph），后续约 5 秒。

### 验证

```bash
curl -s -X POST http://localhost:50000/inference_sft \
  -F 'tts_text=你好测试' \
  -F 'spk_id=vivian' \
  --output /tmp/test.pcm \
  -w 'HTTP %{http_code}, %{size_download} bytes, %{time_total}s\n'
```

应返回 HTTP 200，文件大小 > 0。

### 健康检查

```bash
curl http://localhost:50000/health
# {"status":"ok","model":"mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit","default_voice":"vivian","available_voices":["serena","vivian","uncle_fu","ryan","aiden","ono_anna","sohee","eric","dylan"]}
```

## 可用声音

| Voice ID | 语言 | 性别 | 备注 |
|---|---|---|---|
| `vivian` | 中文 | 女 | 推荐默认 |
| `uncle_fu` | 中文 | 男 | |
| `serena` | 英文 | 女 | |
| `ryan` | 英文 | 男 | |
| `aiden` | 英文 | 男 | |
| `eric` | 英文 | 男 | |
| `dylan` | 英文 | 男 | |
| `ono_anna` | 日文 | 女 | |
| `sohee` | 韩文 | 女 | |

## 配置 Tianshu

在 Tianshu 的 launchd plist 或 `.env` 中设置：

```
TTS_PROVIDER=qwentts
TTS_URL=http://localhost:50000
```

或者在 Tianshu 的 **Settings → 语音合成** 页面直接切换到 "Qwen3-TTS (本地)"。

## API 接口

### POST /inference_sft

与 CosyVoice 兼容的 multipart/form-data 接口。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tts_text` | string | ✅ | 要合成的文本 |
| `spk_id` | string | ❌ | 声音 ID，不传则用默认 |

**Response**: `audio/pcm`，24kHz int16 mono，streaming chunked。

### GET /health

返回 server 状态、模型信息和可用声音列表。

## 性能参考 (M3 Ultra)

| 文本长度 | 音频时长 | 合成耗时 | RTF |
|---|---|---|---|
| 4 字 | ~1.4s | ~1.7s | 1.2x (含 warmup) |
| 20 字 | ~8s | ~3s | 0.37x |
| 40 字 | ~10s | ~3.3s | 0.33x |

RTF < 1 意味着合成速度快于播放速度，适合 streaming。

## 升级到 1.7B 模型

如果需要更好的音质（代价是更多 RAM 和稍慢速度）：

```bash
python scripts/qwen3-tts-server/server.py \
  --port 50000 \
  --voice vivian \
  --model mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit
```

1.7B 模型需约 6GB RAM，RTF 约 0.5x（M3 Ultra）。

## 故障排除

### Server 启动失败：No module named 'mlx'

确保激活了 conda 环境：`conda activate qwen-tts`

### 首次请求很慢

正常。MLX 需要在首次推理时编译 Metal shader graph，后续请求快得多。

### 内存不足

0.6B 8bit 模型仅需 ~3GB RAM。如果仍然不足，检查是否有其他大模型在占用内存。

### 中文乱码 / 声音异常

确认 `spk_id` 是合法的声音 ID（见上表），不是 CosyVoice 的 `中文女` 等旧 ID。
server 内置了兼容映射，但建议直接用新 ID。
