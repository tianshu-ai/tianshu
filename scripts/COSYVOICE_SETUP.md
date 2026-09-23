# CosyVoice 2 本地部署 checklist

`feat/voice-conversation-mode` 分支的 `/api/tts` 依赖一个本地
CosyVoice FastAPI server。这份文档教你把 CosyVoice 跑起来。

**目标机器**：Mac Studio M3 Ultra（Apple Silicon）
**耗时**：15-30 分钟（首次，主要下载）
**磁盘**：约 5 GB

---

## 第一步：装 conda（如果没有）

### 为什么

CosyVoice 依赖 Python 3.10 + 一堆特定版本包。用 conda 建独立环境，
不污染系统 Python。

### 验证有没有装

```bash
which conda
```

- 出 `/opt/homebrew/anaconda3/bin/conda` 之类路径 → **跳到第二步**
- 出 `conda not found` → 继续装

### 装 miniconda（Apple Silicon 版）

```bash
mkdir -p ~/miniconda3
curl https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-arm64.sh \
  -o ~/miniconda3/miniconda.sh
bash ~/miniconda3/miniconda.sh -b -u -p ~/miniconda3
rm ~/miniconda3/miniconda.sh
~/miniconda3/bin/conda init zsh
```

**关掉当前终端重开**，然后：

```bash
conda --version
# 应出 conda 24.x 之类版本
```

---

## 第二步：clone CosyVoice 仓库

```bash
mkdir -p ~/git
cd ~/git
git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git
cd CosyVoice
git submodule update --init --recursive
```

### 验证

```bash
ls third_party/Matcha-TTS/matcha
# 应该有 py 文件；如果目录空，重跑 git submodule update
```

---

## 第三步：建 Python 环境 + 装依赖

```bash
cd ~/git/CosyVoice
conda create -n cosyvoice -y python=3.10
conda activate cosyvoice
pip install -r requirements.txt \
  -i https://mirrors.aliyun.com/pypi/simple/ \
  --trusted-host=mirrors.aliyun.com
brew install sox
```

### 如果装 `pynini` 或 `WeTextProcessing` 报错

已知问题，跳过它们（用 wetext 替代）：

```bash
pip install -r requirements.txt --no-deps
pip install torch torchaudio numpy scipy librosa soundfile modelscope \
  fastapi uvicorn "hyperpyyaml==1.2.2" onnxruntime lightning gdown \
  transformers==4.44.0 openai-whisper wetext
```

### 验证

```bash
python -c "import cosyvoice; print('ok')"
```

出 `ok` = 就绪。**报错就贴给 tianshu agent**。

---

## 第四步：下模型（~1GB，5-10 分钟）

```bash
cd ~/git/CosyVoice
mkdir -p pretrained_models
python <<'EOF'
from modelscope import snapshot_download
snapshot_download(
    'iic/CosyVoice-300M-SFT',
    local_dir='pretrained_models/CosyVoice-300M-SFT',
)
EOF
```

### 验证

```bash
ls -lh pretrained_models/CosyVoice-300M-SFT/
# 应该看到 llm.pt / flow.pt / hift.pt 等文件
```

---

## 第五步：启动 FastAPI server

**关键**：这个终端**一直保持开着** —— CosyVoice server 前台运行，
Ctrl+C 就停。

```bash
cd ~/git/CosyVoice
conda activate cosyvoice
cd runtime/python/fastapi
python3 server.py \
  --port 50000 \
  --model_dir ../../../pretrained_models/CosyVoice-300M-SFT
```

### 期待看到（大约 30-60 秒后）

```
INFO:     Started server process [xxxxx]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:50000 (Press CTRL+C to quit)
```

**看到这行 = CosyVoice 就绪。**

### 最常见报错

- `ModuleNotFoundError: matcha` → submodule 没 init，回第二步
- `torch.mps not available` → macOS 版本太老，需 macOS 12.3+
- `port 50000 already in use` → `lsof -i:50000` 看谁占了

---

## 第六步：验证 CosyVoice 自己 work

**新开一个终端**（原来的保持 CosyVoice server 运行）：

```bash
curl -X POST http://localhost:50000/inference_sft \
  -F "tts_text=你好，我是天枢" \
  -F "spk_id=中文女" \
  --output /tmp/tts-test.pcm

brew install ffmpeg  # 如果没装
ffmpeg -f s16le -ar 24000 -ac 1 -i /tmp/tts-test.pcm /tmp/tts-test.wav -y
afplay /tmp/tts-test.wav
```

**听到"你好，我是天枢"** = CosyVoice 完全就绪，可以开始跟 tianshu 联调。

---

## 第七步：联调 tianshu → CosyVoice

CosyVoice server 保持运行，tianshu server 已在 5173 监听。

```bash
cd /Users/i070219/git/MY_OSS/tianshu
git checkout feat/voice-conversation-mode
git pull origin feat/voice-conversation-mode
# tsx watch 自动重启
```

**tianshu server log 应该出现**：

```
[tts] mounted /api/tts upstream=http://localhost:50000
```

### 用 curl 验证 tianshu → CosyVoice 全链路

从 browser devtools **Application → Cookies** 复制 `tianshu_sid` 的值：

```bash
TIANSHU_SID="你复制的cookie值"

curl -X POST "http://localhost:5173/api/tts" \
  -H "Content-Type: application/json" \
  -H "Cookie: tianshu_sid=$TIANSHU_SID" \
  -d '{"text": "你好，我是天枢", "voice": "中文女"}' \
  --output /tmp/tianshu-tts.wav

afplay /tmp/tianshu-tts.wav
```

**听到"你好，我是天枢"** = **全链路通了**。

---

## 分支状态

**当前分支**：`feat/voice-conversation-mode`

**已完成 commit**：
- `26fe688` scaffold TTS proxy + client hooks
- `656daf4` align /api/tts with CosyVoice server.py

**未完成**（下次 session 做）：
- 顶部 header 语音模式 toggle 按钮
- MessageBubble 语音模式下自动 speak 助手回复
- Settings 面板加 TTS 配置字段

---

## Troubleshooting

### CosyVoice server 起来了，但 tianshu `/api/tts` 返回 503

**症状**：curl 返回 `{"error":"tts upstream unreachable"}`

**排查**：
1. CosyVoice server 那个终端还开着吗？看有没有 uvicorn log 输出
2. `lsof -i:50000` 看 50000 端口是不是 CosyVoice 占的
3. 直接 `curl -X POST http://localhost:50000/inference_sft -F "tts_text=测试" -F "spk_id=中文女" --output /tmp/x.pcm`——直接调 CosyVoice 应该工作

### CosyVoice 起来了，curl 直接调也能拿到 PCM，但 `/api/tts` 返回 422

**症状**：说明 form-data 到不了 CosyVoice，或字段名不对

**排查**：把 tianshu server log 里 `[tts] forwarding: ...` 完整贴给 tianshu agent

### 听到的声音有杂音 / 音调怪

**可能**：CosyVoice2-0.5B 的采样率不是 24000（模型不同）

**修法**：在 `packages/server/src/boot/routes-tts.ts` 里改 `TTS_SAMPLE_RATE`

---

*Last updated: 2026-09-19 by tianshu agent*
