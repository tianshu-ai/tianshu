# Moss-Live Voice Mode Spike

验证 Moss-Live 1.0 的委派模式跟 tianshu agent 的集成。

## 架构

```
Browser (mic/speaker)
    ↕ WebSocket (audio + events)
Tianshu Server (proxy)
    ↕ WebSocket  
Moss-Live API (wss://api.mosi.cn/v1/realtime)
    ↕ delegation events
Tianshu Agent (tool execution)
```

## 流程

1. 用户在 tianshu UI 点"语音模式"
2. 前端通过 tianshu server 建立到 Moss-Live 的 WebSocket
3. server 作为中继：转发音频 + 拦截 delegation 事件
4. 收到 `session.delegation.created` → 把 objective 发给 agent
5. agent 执行工具 → 通过 `session.commentary.append` 回报结果
6. Moss-Live 把结果语音播报给用户

## API Key

需要 MOSS_API_KEY 环境变量或 config 里配置。
