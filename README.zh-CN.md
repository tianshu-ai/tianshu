<div align="center">

# 天枢 · Tianshu

**一个开源的 AI Agent 平台，自带 sidecar 浏览器。Build in public。**

[![CI](https://github.com/tianshu-ai/tianshu/actions/workflows/ci.yml/badge.svg)](https://github.com/tianshu-ai/tianshu/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-orange)](./CONTRIBUTING.md)

⭐ *天枢，北斗第一星，主导方向。*

[English](./README.md) · [愿景](#愿景) · [为什么](#为什么) · [快速开始](#快速开始) · [路线图](#路线图) · [开发日志](#开发日志) · [贡献](./CONTRIBUTING.md)

</div>

---

## 🚧 状态: Day 0

仓库建立于 **2026-06-03**。我们故意提前公开 —— 计划 build in public，每周
更新一次开发日志（[DEV_LOG](./docs/DEV_LOG.md)），同步分发到下面列出的
内容渠道。

如果你在第一天就 Star 了，谢谢。一周后回来看看，应该就有可跑的东西了。

## 愿景

天枢是一个可自部署、多租户的 **AI Agent 平台**，底层运行时基于
[`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core)。
我们的取舍：

- 🌐 **每个租户配一个真实的 Chromium sidecar** —— Playwright + noVNC。
  Agent 真的在浏览、点击、输入；你在侧边面板看着它干。
- 📦 **每个租户配一个真实的 Linux 沙箱** —— 每次 `exec` 都隔离运行。
  跑挂、fork bomb、写满磁盘都不影响宿主。
- 📁 **每个租户配一份真实的工作区文件系统** —— Agent 读写文件，你在
  UI 里预览，跨 session 持久化。
- 🤖 **后台 Worker，不只是"工具"** —— 把任务分发给一组并行的 agent，
  在看板上看每个任务的耗时，卡住就介入。
- 🏢 **从第 1 行起就是多租户** —— 每条记录都带 `tenantId`，sidecar、
  workspace、worker pool 全部按租户隔离。

闭源版本已经在维护者的日常环境中跑了几个月。这个仓库是从零重写的开源版。

## 为什么

> "如果 Agent 真的能在真实浏览器、真实 shell、真实文件上干活 —— 而你
> 还能看着它干 —— 会怎么样？"

大多数"AI 聊天"平台都是 chat completions 接口的壳。天枢从另一端起步：
agent runtime 是真实软件，sidecar 是真实浏览器，sandbox 是真实容器。
聊天 UI 只是表层，不是产品本身。

更长的动机阐述见首发文章/视频：

- 📝 dev.to · *Three things AI agents keep getting wrong (and why I'm
  rebuilding the platform from scratch)*
  → <https://dev.to/tianshu_ai/three-things-ai-agents-keep-getting-wrong-and-why-im-rebuilding-the-platform-from-scratch-42p6>
- 🎥 YouTube · *Building an AI agent platform in public*
  → <https://youtu.be/Xw7c3JrlUVo>
- 📺 B站中文版（即将发布）

## 快速开始

> ⚠️ Day 0 —— 你只能拿到一个 health 接口和一个 hello-world 页面。
> 真东西（agent runtime、浏览器 sidecar、任务看板）会在接下来几周里
> 一个 PR 一个 PR 地接进来。

```bash
git clone https://github.com/tianshu-ai/tianshu.git
cd tianshu

cp .env.example .env

npm install
npm run dev
```

这会启动：

- **Server**: <http://localhost:3110>（Express + WebSocket，热重载）
- **Web**: <http://localhost:5183>（Vite，HMR）

Web 端会代理 `/api` 和 `/ws` 到 server。打开 <http://localhost:5183>
能看到健康检查 JSON 即可。

> 注：默认端口是 `3110 / 5183`（不是常见的 `3100 / 5173`），故意避开闭源前身项目，
> 然后两者可以在同一台开发机上同时跑。需要老端口设 `PORT=` / 改 vite
> 配置即可。

## 路线图

最先要落地的五件事：

- [ ] **租户模型** —— 全链路 `tenantId`，dev-mode JWT
- [ ] **接通 Agent 运行时** —— pi-agent-core 走 WebSocket 流式输出
- [ ] **浏览器 sidecar** —— Docker 里的 Playwright + noVNC
- [ ] **Microsandbox** —— 每租户一个 Linux 隔离环境
- [ ] **任务看板** —— 后台 worker 以看板卡片形式呈现

进度跟踪：[GitHub Issues](https://github.com/tianshu-ai/tianshu/issues)。

## 不是什么

- ❌ 不是 ChatGPT 的替代品 —— 那是 LibreChat / Open WebUI 的领域。
- ❌ 不是低代码工作流编辑器 —— 那是 Dify 的形态。
- ❌ 不是托管 SaaS —— 没有计费、没有 SSO、没有 SLA。给团队自己跑。
- ❌ 不是 LLM 开发框架 —— 它是个**应用**；运行时基于 pi-agent-core。

## 开发日志

每周一篇开发日志，按你顺手的渠道关注：

| 渠道 | 语言 | 形式 |
| --- | --- | --- |
| [dev.to/tianshu_ai](https://dev.to/tianshu_ai) | English | 长文 |
| [YouTube @Tianshu-AI](https://www.youtube.com/@Tianshu-AI) | English | 长视频 |
| 哔哩哔哩 天枢AI *（即将发布）* | 中文 | 长视频 |
| X / Twitter *（即将发布）* | English | build-in-public thread |
| 小红书 / 抖音 *（即将发布）* | 中文 | 短视频/图文 |

## 贡献

PR、Issue、Discussion 都欢迎 —— 即使是 day 0。开发环境和代码风格见
[CONTRIBUTING.md](./CONTRIBUTING.md)。

安全问题请走 [SECURITY.md](./SECURITY.md)，**不要**在公开 Issue 提报。

## 协议

[Apache License 2.0](./LICENSE) © 2026 Yu Yu and Tianshu contributors.

底层依赖 [pi-agent-core](https://github.com/badlogic/pi-mono)（MIT），
作者 [@badlogic](https://github.com/badlogic)。
