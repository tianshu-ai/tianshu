# browser-bridge

Docker image: Local Bridge + Chrome + Playwright + Python + shell tools.

Agent 通过 bridge exec 操控浏览器，跟操控 shell 一样。

## Quick Start

```bash
# Build
docker build -t tianshu82/browser-bridge docker/browser-bridge/

# Run (pair token from tianshu Settings → Local Bridge)
docker run -d --name browser-bridge \
  -e TIANSHU_SERVER=https://your-tianshu:3456 \
  -e TIANSHU_TOKEN=<pair-token> \
  -e BRIDGE_NAME=browser \
  tianshu82/browser-bridge
```

## What's Inside

- **Chromium** (via Playwright base image)
- **Playwright** (Node.js + Python bindings)
- **@playwright/mcp** (Playwright MCP server, optional)
- **@tianshu-ai/local-bridge** (connects back to tianshu)
- **Python 3** + requests, beautifulsoup4, pandas
- **Tools**: curl, wget, jq, git, ffmpeg, imagemagick

## How the Agent Uses It

The agent runs commands through bridge exec, same as any Local Bridge node:

```python
# Navigate and extract text
playwright navigate https://example.com
playwright snapshot

# Or use Python + Playwright for complex tasks
python3 -c "
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('https://example.com')
    print(page.content())
    browser.close()
"
```

## Environment Variables

| Var | Required | Description |
|-----|----------|-------------|
| `TIANSHU_SERVER` | Yes | Tianshu server URL |
| `TIANSHU_TOKEN` | Yes | Bridge pair token |
| `BRIDGE_NAME` | No | Display name in tianshu (default: hostname) |
