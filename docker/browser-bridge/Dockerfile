# browser-bridge — Local Bridge node with a full browser stack.
#
# The agent interacts with Chrome/Playwright through bridge exec,
# the same way it runs shell commands on any bridge-connected machine.
#
# Build:  docker build -t tianshu82/browser-bridge .
# Run:    docker run -d --name browser-bridge \
#           -e TIANSHU_SERVER=https://your-tianshu:3456 \
#           -e TIANSHU_TOKEN=<pair-token> \
#           tianshu82/browser-bridge

FROM mcr.microsoft.com/playwright:v1.52.0-noble

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl wget jq git zip unzip \
    imagemagick ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Python packages commonly needed by agents
RUN pip3 install --break-system-packages \
    requests beautifulsoup4 pandas \
    playwright

# Playwright browsers are already in the base image (Chromium, Firefox, WebKit).
# Install Playwright Python browsers binding.
RUN python3 -m playwright install-deps 2>/dev/null || true

# Playwright MCP server (for optional direct MCP usage)
RUN npm i -g @playwright/mcp@latest

# Tianshu Local Bridge
RUN npm i -g @tianshu-ai/local-bridge@latest

# Working directory for agent tasks
WORKDIR /workspace

# Entrypoint: start local bridge.
# TIANSHU_SERVER and TIANSHU_TOKEN must be provided via env.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
