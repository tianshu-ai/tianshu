# Changelog

All notable changes to this project will be documented in this file.

See [Conventional Commits](https://www.conventionalcommits.org) and
[release-please](https://github.com/googleapis/release-please) for how
this file is automatically maintained.

## [0.3.0](https://github.com/tianshu-ai/tianshu/compare/v0.2.0...v0.3.0) (2026-06-14)


### Features

* **admin:** /admin shell + microsandbox sandbox-admin page (ADR-0004 N+4) ([#67](https://github.com/tianshu-ai/tianshu/issues/67)) ([c0b864f](https://github.com/tianshu-ai/tianshu/commit/c0b864f2b88a231eb34862e6df7ec3a69bc09350))
* auto-compact via harness + worker sidebar UI cleanup ([#85](https://github.com/tianshu-ai/tianshu/issues/85)) ([6bfcadd](https://github.com/tianshu-ai/tianshu/commit/6bfcadd689ff79030d7da8285d680f8ef1dd9151))
* **chat:** agent tool loop with fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)b, server side) ([#43](https://github.com/tianshu-ai/tianshu/issues/43)) ([424bfaf](https://github.com/tianshu-ai/tianshu/commit/424bfaf1ff17e9c036ed15cd6c51f4a0ea9d9bb6))
* **chat:** assistant message meta line (model / token usage / context %) ([#57](https://github.com/tianshu-ai/tianshu/issues/57)) ([156ed73](https://github.com/tianshu-ai/tianshu/commit/156ed73c338f15bcad24463b713102be42dcdc5a))
* **chat:** auto-compact conversation history at 50% context window ([#56](https://github.com/tianshu-ai/tianshu/issues/56)) ([c24e728](https://github.com/tianshu-ai/tianshu/commit/c24e728281b6881fff7393d419bf8b87081658c4))
* **chat:** auto-compress oversize images before sending to vision providers ([#55](https://github.com/tianshu-ai/tianshu/issues/55)) ([31b715f](https://github.com/tianshu-ai/tianshu/commit/31b715f7dc71ae130a6ddba46ccc7ba3a48854d0))
* **chat:** chat handler + worker on pi-agent-core's AgentHarness (N+6.4) ([#81](https://github.com/tianshu-ai/tianshu/issues/81)) ([5cea697](https://github.com/tianshu-ai/tianshu/commit/5cea697d74e9f5346bce152af26ae4b8ff58dd61))
* **chat:** inject workspace scaffold into agent prompt; move projects to user level ([#46](https://github.com/tianshu-ai/tianshu/issues/46)) ([#47](https://github.com/tianshu-ai/tianshu/issues/47)) ([761cd92](https://github.com/tianshu-ai/tianshu/commit/761cd9217f722079d89a8ff1863ba7a35f9dd4e1))
* **chat:** minimal end-to-end chat over WebSocket (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)) ([#25](https://github.com/tianshu-ai/tianshu/issues/25)) ([348f214](https://github.com/tianshu-ai/tianshu/commit/348f214f153bfa1c7763704f6daf92016293c9d4))
* **chat:** multimodal user messages — attachments as first-class content ([#52](https://github.com/tianshu-ai/tianshu/issues/52)) ([a74689a](https://github.com/tianshu-ai/tianshu/commit/a74689ae9573c7153b85e258a923d6ecc7470820))
* **chat:** persist tool turns + render them inline (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)c) ([#44](https://github.com/tianshu-ai/tianshu/issues/44)) ([8b2f96f](https://github.com/tianshu-ai/tianshu/commit/8b2f96f572b73cedf89104836e46af8d586743bc))
* **files:** move fs agent tools into the files plugin (ADR-0004 N+3.5) ([#62](https://github.com/tianshu-ai/tianshu/issues/62)) ([49ab627](https://github.com/tianshu-ai/tianshu/commit/49ab6272fe8155b2c135c23789e315b4b0fd7526))
* **files:** workspace:// URI scheme for tool→UI file references ([#86](https://github.com/tianshu-ai/tianshu/issues/86)) ([77e7fb7](https://github.com/tianshu-ai/tianshu/commit/77e7fb7181c0cdd6c3f517a46d6924c37b4dcb8e))
* **microsandbox:** browser sidecar scaffold + 3 agent tools + admin Browser page (ADR-0004 N+5.1) ([#68](https://github.com/tianshu-ai/tianshu/issues/68)) ([74e17a7](https://github.com/tianshu-ai/tianshu/commit/74e17a7d98068f2c48dfdf0a2036eb0c565a96b5))
* **microsandbox:** builtin plugin scaffold + nullable runner (ADR-0004 N+2) ([#60](https://github.com/tianshu-ai/tianshu/issues/60)) ([babdf6d](https://github.com/tianshu-ai/tianshu/commit/babdf6d8cd1beb67d5c1df36a94a1fa3e2604706))
* **microsandbox:** eager warm-up on plugin activation ([#64](https://github.com/tianshu-ai/tianshu/issues/64)) ([43a8424](https://github.com/tianshu-ai/tianshu/commit/43a842478e0a1d1bf1084129b530327874f34d41))
* **microsandbox:** live browser stack — port forward + auto supervisord + Playwright MCP wired (ADR-0004 N+5.3) ([#70](https://github.com/tianshu-ai/tianshu/issues/70)) ([fb671c2](https://github.com/tianshu-ai/tianshu/commit/fb671c247e36966e79103c973e9f4ba5ff6bf8ef))
* **microsandbox:** Sandboxfile templates + Browser template (CloakBrowser + Playwright MCP + noVNC) (ADR-0004 N+5.2) ([#69](https://github.com/tianshu-ai/tianshu/issues/69)) ([00ed8f1](https://github.com/tianshu-ai/tianshu/commit/00ed8f1432c06e9d58dfd5721422f451f55fcd6f))
* **n5-4:** direct MCP mount via SDK, dynamic browser viewport, MCP servers admin ([#76](https://github.com/tianshu-ai/tianshu/issues/76)) ([6eb310f](https://github.com/tianshu-ai/tianshu/commit/6eb310ff51718ae4c6a86750577830bdcc18de93))
* **plugins/files:** scope to per-user home + tighten top-bar icons ([#40](https://github.com/tianshu-ai/tianshu/issues/40)) ([e8be301](https://github.com/tianshu-ai/tianshu/commit/e8be30150c785a534438d24686ae2d6b7e09f317))
* **plugins/files:** styled panel matching the closed-source repo ([#38](https://github.com/tianshu-ai/tianshu/issues/38)) ([22c1b01](https://github.com/tianshu-ai/tianshu/commit/22c1b017c6ed42d3a9deb9c377eabcb42b8c9544))
* **plugins:** capability registry, requires/provides, sandbox surface (ADR-0004 N+1) ([#59](https://github.com/tianshu-ai/tianshu/issues/59)) ([ba751c7](https://github.com/tianshu-ai/tianshu/commit/ba751c7b9b6fa97fd4d946a0d65e38476107810a))
* **plugins:** catalog client + Plugin Manager Catalog tab (P1) ([#34](https://github.com/tianshu-ai/tianshu/issues/34)) ([4376d67](https://github.com/tianshu-ai/tianshu/commit/4376d672becc941f86779ee895e54c99054e5e18))
* **plugins:** composer file uploads + composerActions SDK contribution ([#48](https://github.com/tianshu-ai/tianshu/issues/48)) ([#49](https://github.com/tianshu-ai/tianshu/issues/49)) ([0bea614](https://github.com/tianshu-ai/tianshu/commit/0bea61476f5e74e393f68f6460d29b8b4aeb0a00))
* **plugins:** contributes.tools[] \u2014 plugins own their agent tools (ADR-0004 N+3) ([#61](https://github.com/tianshu-ai/tianshu/issues/61)) ([db56329](https://github.com/tianshu-ai/tianshu/commit/db56329bc7d6044f2674bb4a3b254e02af7f3111))
* **plugins:** files plugin (workspace browser, server side) ([#35](https://github.com/tianshu-ai/tianshu/issues/35)) ([b2ec9a3](https://github.com/tianshu-ai/tianshu/commit/b2ec9a312c4805aeb546e750d0dacb76e72ed6bb))
* **plugins:** plugin runtime + Plugin Manager UI (PR [#31](https://github.com/tianshu-ai/tianshu/issues/31)) ([#32](https://github.com/tianshu-ai/tianshu/issues/32)) ([9405d57](https://github.com/tianshu-ai/tianshu/commit/9405d57ad9e1785c95856c048bbb3320edb67da0))
* **server:** agent fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)a) ([#42](https://github.com/tianshu-ai/tianshu/issues/42)) ([791819a](https://github.com/tianshu-ai/tianshu/commit/791819ac2ea51883b4263fcee559689a400ec141))
* **skills:** drop load_skill meta-tool; manage skills via filesystem ([#98](https://github.com/tianshu-ai/tianshu/issues/98)) ([b352c74](https://github.com/tianshu-ai/tianshu/commit/b352c749b0bc8f19d753e478ed70b0f6acbd16fc))
* **skills:** mirror host & plugin SKILL.md into tenant config so one tool reads them all ([#104](https://github.com/tianshu-ai/tianshu/issues/104)) ([bc5c890](https://github.com/tianshu-ai/tianshu/commit/bc5c8900dbf4c07577cdab6d742c344917425832))
* **skills:** on-demand prompt fragments via plugin-contributed skills (ADR-0004 N+4) ([#63](https://github.com/tianshu-ai/tianshu/issues/63)) ([ec6cf6f](https://github.com/tianshu-ai/tianshu/commit/ec6cf6ffdb0258625b484fe1c7c53834756a15ea))
* **skills:** tenant-scoped skill discovery + main agent skill-creator ([#97](https://github.com/tianshu-ai/tianshu/issues/97)) ([98e0480](https://github.com/tianshu-ai/tianshu/commit/98e0480bfed24f05642c951eb543e9f542ad4ff8))
* **tenant:** infrastructure layer (PR [#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([4b6e7ae](https://github.com/tianshu-ai/tianshu/commit/4b6e7ae62da101c7998cf8e7dfe9b8b58cc969a3))
* **ui:** model selector pill in composer (PR [#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([5a835ff](https://github.com/tianshu-ai/tianshu/commit/5a835ff99b0b74c135e7c02cdebe895079d1b53c))
* **ui:** refine chat layout to match closed-source repo (PR [#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([#27](https://github.com/tianshu-ai/tianshu/issues/27)) ([090c6eb](https://github.com/tianshu-ai/tianshu/commit/090c6eb47e6b02c6d0c0c6dcaabb4debe06c47f0))
* **ui:** tianshu-style chat UI (PR [#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([#26](https://github.com/tianshu-ai/tianshu/issues/26)) ([086fce7](https://github.com/tianshu-ai/tianshu/commit/086fce7fe55d29131ccce9cf7da48750aa2c74ef))
* **web:** collapsible tool-call rows (closed-source UI parity) ([#45](https://github.com/tianshu-ai/tianshu/issues/45)) ([78c1fb7](https://github.com/tianshu-ai/tianshu/commit/78c1fb7a2c87b7377827d2fa308b6c0db2bf35c1))
* **web:** manifest-driven top bar + right panel (PR [#33](https://github.com/tianshu-ai/tianshu/issues/33)) ([#36](https://github.com/tianshu-ai/tianshu/issues/36)) ([ba488fb](https://github.com/tianshu-ai/tianshu/commit/ba488fbff6a4c68e88f131d8d7fa34a2b59556aa))
* **web:** right-panel tab bar + resize handle (closed-source parity) ([#41](https://github.com/tianshu-ai/tianshu/issues/41)) ([25f1c98](https://github.com/tianshu-ai/tianshu/commit/25f1c984a25865911b65d8ab2c66331bac089f7a))
* **workboard,server,web:** execution dialog + session inbox + history pagination + concurrency fixes ([#94](https://github.com/tianshu-ai/tianshu/issues/94)) ([d79e665](https://github.com/tianshu-ai/tianshu/commit/d79e665eb97f10bc49b3f361090c74fa6bab4f40))
* **workboard:** batch task_create + task_delete ([#93](https://github.com/tianshu-ai/tianshu/issues/93)) ([759226e](https://github.com/tianshu-ai/tianshu/commit/759226e128d183c2292cad4f7cef90fb3380aa52))
* **workboard:** drop worker_agents table; UI read-only; REST mutation routes removed (PR-C) ([#101](https://github.com/tianshu-ai/tianshu/issues/101)) ([cba6701](https://github.com/tianshu-ai/tianshu/commit/cba67011824ced8e34e885250f231cc8d9866b5c))
* **workboard:** fs-only worker config + intervention model + skill / context plumbing ([#102](https://github.com/tianshu-ai/tianshu/issues/102)) ([f4e571e](https://github.com/tianshu-ai/tianshu/commit/f4e571e7546981b0cae0dabc2d32b44c9bdbd2be))
* **workboard:** host.modelCatalog capability + model_list tool for the main agent ([#107](https://github.com/tianshu-ai/tianshu/issues/107)) ([fb2d9ef](https://github.com/tianshu-ai/tianshu/commit/fb2d9ef98167ba68630476cdec3095ad664dd140))
* **workboard:** hot-reload pool when worker bundles change on disk ([#103](https://github.com/tianshu-ai/tianshu/issues/103)) ([2008527](https://github.com/tianshu-ai/tianshu/commit/2008527ccc542a9c19c1cb2c39edda2fc72248a2))
* **workboard:** kanban + worker pool plugin (ADR-0002 §6) ([#78](https://github.com/tianshu-ai/tianshu/issues/78)) ([0fac44a](https://github.com/tianshu-ai/tianshu/commit/0fac44af8afdf8f4d11620405c12d8ce4b34a041))
* **workboard:** LLM worker kind via host.agentLoop capability (N+6.3) ([#80](https://github.com/tianshu-ai/tianshu/issues/80)) ([cd53fac](https://github.com/tianshu-ai/tianshu/commit/cd53fac940ab7241ed2a9b03a5f5985352b21514))
* **workboard:** main agent can list available LLM models via  ([#106](https://github.com/tianshu-ai/tianshu/issues/106)) ([3e7a008](https://github.com/tianshu-ai/tianshu/commit/3e7a00811a21e3c1f43d9e25af277a3c1f1f86df))
* **workboard:** one-shot DB-&gt;fs migration; widen tenant_config_write boundary; retire worker_agent_* tools (PR-B) ([#100](https://github.com/tianshu-ai/tianshu/issues/100)) ([0ff0249](https://github.com/tianshu-ai/tianshu/commit/0ff0249b9a3310ee6c8e7eed192c6263e94f06fa))
* **workboard:** orchestrator tools for managing worker agents ([#96](https://github.com/tianshu-ai/tianshu/issues/96)) ([5f2d314](https://github.com/tianshu-ai/tianshu/commit/5f2d314e00e9c1272c372773c49a2720fb2a46b9))
* **workboard:** plugin-contributed agent seeds, fs-backed worker layout (PR-A) ([#99](https://github.com/tianshu-ai/tianshu/issues/99)) ([65b3b11](https://github.com/tianshu-ai/tianshu/commit/65b3b111b662e5015a550f3cfb528ef389e5cab6))
* **workboard:** retry/publish buttons on label chips ([#91](https://github.com/tianshu-ai/tianshu/issues/91)) ([6a0531e](https://github.com/tianshu-ai/tianshu/commit/6a0531ef586883e10b844e7edd51cd8f563f6d7b))
* **workboard:** task execution history (REST + agent tool) ([#92](https://github.com/tianshu-ai/tianshu/issues/92)) ([3949e14](https://github.com/tianshu-ai/tianshu/commit/3949e14a038164a29096c6b711d9c5e8193fdeca))
* **workboard:** tool/skill catalog capabilities + worker agent ChipPicker ([#95](https://github.com/tianshu-ai/tianshu/issues/95)) ([aa1126a](https://github.com/tianshu-ai/tianshu/commit/aa1126aed6115786f2facafb0826846624e238cd))
* **worker-agents:** host table + REST + plugin seed + admin UI (ADR-0002 §7.1, N+6.2) ([#79](https://github.com/tianshu-ai/tianshu/issues/79)) ([a8b7378](https://github.com/tianshu-ai/tianshu/commit/a8b7378a80e4609f73eeef4f6e1ed1759ceb6255))


### Bug Fixes

* **adapter:** detect stream-truncated tool calls and surface a useful error ([#105](https://github.com/tianshu-ai/tianshu/issues/105)) ([2e95618](https://github.com/tianshu-ai/tianshu/commit/2e95618d78a4a536b2ab108095605e185baac6ec))
* **chat:** assistant messages with mixed text + tool calls render in author order ([#65](https://github.com/tianshu-ai/tianshu/issues/65)) ([ccedf35](https://github.com/tianshu-ai/tianshu/commit/ccedf3554072f8be8c912b596b764adabb7d81c5))
* **chat:** session storage chain + bridge pi tool_execution events (N+6.4 follow-up) ([#83](https://github.com/tianshu-ai/tianshu/issues/83)) ([0446273](https://github.com/tianshu-ai/tianshu/commit/04462730378ccf0037b121ed8361f918c2838740))
* **plugins:** mount contributed routes under /api/p/&lt;id&gt;/... ([#37](https://github.com/tianshu-ai/tianshu/issues/37)) ([3484ace](https://github.com/tianshu-ai/tianshu/commit/3484aceb51bc19d6900c91770e46dc9d91c3194f))
* **ui:** de-dupe ws handlers + message renders (StrictMode) ([#28](https://github.com/tianshu-ai/tianshu/issues/28)) ([0b8b5bc](https://github.com/tianshu-ai/tianshu/commit/0b8b5bcb3c163cfa277fa23ae32243bd8280de4d))
* **workboard:** nudge on done patches + fallback polling timer ([#89](https://github.com/tianshu-ai/tianshu/issues/89)) ([b959cd2](https://github.com/tianshu-ai/tianshu/commit/b959cd23efb24c2d16e7f229063ae14939d99143))
* **worker:** drop MAX_TURNS cap; deny task management tools in LLM workers ([#87](https://github.com/tianshu-ai/tianshu/issues/87)) ([4c00b41](https://github.com/tianshu-ai/tianshu/commit/4c00b418c2331b76dd039dd5fd732c4459ef5d0d))


### Documentation

* ADR-0001 multi-tenant architecture ([#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([e5d1cc7](https://github.com/tianshu-ai/tianshu/commit/e5d1cc794783ccd045b6081d9c0c9145fa24f2d9))
* ADR-0002 orchestrator + workers, with config layering ([#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([6d5fff6](https://github.com/tianshu-ai/tianshu/commit/6d5fff6cac433e6134463b169103f20594cf7fd5))
* ADR-0003 plugin system (UI panels, sidebar sections, API routes) ([#30](https://github.com/tianshu-ai/tianshu/issues/30)) ([4386ccd](https://github.com/tianshu-ai/tianshu/commit/4386ccddcc8158b286559af894f0f532b1816724))
* ADR-0004 plugin capabilities & sandbox contract ([#58](https://github.com/tianshu-ai/tianshu/issues/58)) ([b6a84f4](https://github.com/tianshu-ai/tianshu/commit/b6a84f46e732ae483640d5efd3247db078192312))


### Refactor

* **chat:** storage owns image base64 + drop legacy helpers + migration 004 ([#84](https://github.com/tianshu-ai/tianshu/issues/84)) ([2a1fa58](https://github.com/tianshu-ai/tianshu/commit/2a1fa580b06b2288b2ff499fbd57613ceb429f69))
* **workboard:** rename todo→ready, retry-on-failure, drop aborted state ([#88](https://github.com/tianshu-ai/tianshu/issues/88)) ([67a8cbb](https://github.com/tianshu-ai/tianshu/commit/67a8cbb77cdf962b198bc5cf1f64518392972095))
* **workboard:** stalled is a label, not a status (3 columns total) ([#90](https://github.com/tianshu-ai/tianshu/issues/90)) ([0c80ae9](https://github.com/tianshu-ai/tianshu/commit/0c80ae97242added8d289b950c56d700f96e8c57))

## [0.2.0](https://github.com/tianshu-ai/tianshu/compare/v0.1.0...v0.2.0) (2026-06-03)


### Features

* day-0 scaffolding ([786a0bd](https://github.com/tianshu-ai/tianshu/commit/786a0bdfb1bdf6cdd5e9e3abd2a03677da7c63b6))

## [Unreleased]

- Initial day-0 scaffolding (Express + WS server, React + Vite web).
