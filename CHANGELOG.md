# Changelog

All notable changes to this project will be documented in this file.

See [Conventional Commits](https://www.conventionalcommits.org) and
[release-please](https://github.com/googleapis/release-please) for how
this file is automatically maintained.

## [0.114.0](https://github.com/tianshu-ai/tianshu/compare/v0.113.0...v0.114.0) (2026-10-25)


### Features

* **server:** default 5-minute timeout for all tool calls ([48528ae](https://github.com/tianshu-ai/tianshu/commit/48528aeb58d15fbe154dcf0180690090918f4a19))
* **server:** streaming stall timeout in model-retry (default 30s) ([c36ba2a](https://github.com/tianshu-ai/tianshu/commit/c36ba2a424064d67544ff5d0f308e76d44aa3bae))

## [0.113.0](https://github.com/tianshu-ai/tianshu/compare/v0.112.0...v0.113.0) (2026-10-25)


### Features

* /recompact session chain picker UI ([6123429](https://github.com/tianshu-ai/tianshu/commit/61234297b1900c35b922efd973a89320b71b3bcc))
* **i18n:** translate slash commands and recompact picker ([4e3ac3a](https://github.com/tianshu-ai/tianshu/commit/4e3ac3ac8c073346870f52917f4b81a004c5efb8))
* **web:** slash command autocomplete popup ([951b866](https://github.com/tianshu-ai/tianshu/commit/951b8666fa04fe39205c877c03d6f83eb5487ac7))


### Bug Fixes

* **i18n:** translate ...more/...less and compact summary divider ([7c2fb82](https://github.com/tianshu-ai/tianshu/commit/7c2fb824962f20beb9145c49f498388f7ed83740))
* **i18n:** translate messenger agent card ...more → …展开 ([e43b792](https://github.com/tianshu-ai/tianshu/commit/e43b79235c75685ff93f494b99c4648e6835ef75))
* recompact picker shows message time range ([b1ad29b](https://github.com/tianshu-ai/tianshu/commit/b1ad29b2a9f27d37febf9f65215877f2f8a4326e))
* **server:** /recompact sends history_compacted to reset client state ([c3d8d3c](https://github.com/tianshu-ai/tianshu/commit/c3d8d3c718fb0eb27a0e0c700e31b1e6e491fd2d))
* **server:** compact transcript overflow + /recompact command ([b642c56](https://github.com/tianshu-ai/tianshu/commit/b642c56b4c607286e292dca5cc5c93d09bc41ea1))
* **server:** recompact updates direct child only, preserves message order ([aa6ca6e](https://github.com/tianshu-ai/tianshu/commit/aa6ca6eb8d18378afbf74ca9b2d3abf15724a56b))
* **server:** send stream_end on WS reconnect when turn already completed ([07c738a](https://github.com/tianshu-ai/tianshu/commit/07c738a1ab9de47ac563f52b2c337ccf1dae1f6a))
* **web:** recompact closes picker and shows compacting state ([9502d17](https://github.com/tianshu-ai/tianshu/commit/9502d17c8848edb6529ec849936554f113638ba4))
* **web:** recompact picker full composer width ([9366908](https://github.com/tianshu-ai/tianshu/commit/936690854aad0273246bb80d288de92e4d03c5fd))
* **web:** recompact picker scroll when expanded ([4592408](https://github.com/tianshu-ai/tianshu/commit/4592408a8046f99c57f83c594fb34997432923a7))
* **web:** recompact picker use ←→ for expand/collapse ([b806f55](https://github.com/tianshu-ai/tianshu/commit/b806f5502071a26544310223288d9a993be7f9ea))
* **web:** recompact picker viewport overflow ([97a500c](https://github.com/tianshu-ai/tianshu/commit/97a500cc7e673e5bea9607df8d2a201892c1d01e))
* **web:** render markdown in recompact summary preview ([b8b82b8](https://github.com/tianshu-ai/tianshu/commit/b8b82b851927c33766f9dfc2f56ece287d2a47c0))
* **web:** respect toolDisplayMode during streaming turn ([d2bd23a](https://github.com/tianshu-ai/tianshu/commit/d2bd23a5d7c8cd159bac2423ac0b286f69293a7d))
* **web:** respect toolDisplayMode in all 4 streaming tool-call hiding paths ([92dfd1c](https://github.com/tianshu-ai/tianshu/commit/92dfd1c7114c1bafdff5a3c9b1c33aa7b35e4f68))
* **web:** translate and markdown-render compact summary divider ([f01329d](https://github.com/tianshu-ai/tianshu/commit/f01329dacce69c6df367dafd5e73546d222e37ec))


### Refactor

* **server:** recompact uses loadAgentHistoryForSession ([d4fd6db](https://github.com/tianshu-ai/tianshu/commit/d4fd6dbada373ddcef364ede7de35755afcd6d4d))
* **web:** recompact picker as composer-anchored popup ([29406be](https://github.com/tianshu-ai/tianshu/commit/29406be108da8b4ce93f53c134343dd4c318367d))

## [0.112.0](https://github.com/tianshu-ai/tianshu/compare/v0.111.0...v0.112.0) (2026-10-24)


### Features

* add /api/admin/diagnostics/unanswered endpoint for maintenance mode ([c732457](https://github.com/tianshu-ai/tianshu/commit/c732457709a2b9767da233dab09f4441f0e784a3))
* add pin support to nested task rows in worker sidebar ([a4641e4](https://github.com/tianshu-ai/tianshu/commit/a4641e478828332a67b95601aacc891da599037e))
* doctor warns when deprecated top-level defaultModel is still set ([bf69e88](https://github.com/tianshu-ai/tianshu/commit/bf69e887b1df30f1f0404220cc0f8ddc09ae8690))
* merge worker list + task list — busy workers show nested tasks, idle toggleable ([c0ba23b](https://github.com/tianshu-ai/tianshu/commit/c0ba23bf6a4b3d5e291195d20351049bd2107b95))
* remove task mode (rocket button) from chat input ([79c4d4e](https://github.com/tianshu-ai/tianshu/commit/79c4d4ed870844886ac4e3d7b632aa2d06e4bba1))
* session diagnostics detail view + actions in maintenance mode ([545919d](https://github.com/tianshu-ai/tianshu/commit/545919d4fc3c59d472293978a88118022099b315))
* unanswered sessions diagnostic panel in maintenance mode ([905d133](https://github.com/tianshu-ai/tianshu/commit/905d133a4083b6baba1f7cccf92f8d32aef46957))
* worker chip shows '1 busy · 3 tasks' with task count from MiniTaskList ([151ad99](https://github.com/tianshu-ai/tianshu/commit/151ad994235de6d692c92a7ea3f92f7276b9f865))
* worker list defaults to busy-only with toggle, persisted to localStorage ([a9da304](https://github.com/tianshu-ai/tianshu/commit/a9da3044f9889aaf0f599cd958d430cbd09ad22f))
* worker row shows task count (e.g. 'busy · 3 tasks') ([3ae397a](https://github.com/tianshu-ai/tianshu/commit/3ae397a4bea16fa799c24444eeb0c18a7c8622ae))


### Bug Fixes

* align AtMentionPopup task status icons with panel ListView (w-3.5) ([3955936](https://github.com/tianshu-ai/tianshu/commit/3955936c863eb41b1934fa88734122ed49413f38))
* badge clipped by header — use translate positioning + overflow-visible ([27aac23](https://github.com/tianshu-ai/tianshu/commit/27aac23b4359ea931df2459fc39afb60084c1715))
* badge shows in_progress task count instead of busy worker count ([b02fa3f](https://github.com/tianshu-ai/tianshu/commit/b02fa3f3dd3baf1dc390aa7023e49fbb8c9ca838))
* loosen AtMentionPopup item spacing (gap-2, py-2.5) ([8062bf2](https://github.com/tianshu-ai/tianshu/commit/8062bf2353ff0b2b40551f3f76cf8e27e23593cc))
* task pin icon always visible, placed on left side ([9b4dcad](https://github.com/tianshu-ai/tianshu/commit/9b4dcad21ed9b6794bd7bff18bae005011f20466))
* task pin state now reactive via pinnedIds subscription ([7545cb9](https://github.com/tianshu-ai/tianshu/commit/7545cb917cabcb55d754addc9931a87d7e167b76))
* task status icons match workboard panel style (no emoji) ([1d1c524](https://github.com/tianshu-ai/tianshu/commit/1d1c524d26fb90f9c9b50bec1b620a00672f0e1e))

## [0.111.0](https://github.com/tianshu-ai/tianshu/compare/v0.110.0...v0.111.0) (2026-10-24)


### Features

* ds_panel tool supports body and headers for REST sources ([f74f367](https://github.com/tianshu-ai/tianshu/commit/f74f367c7ee370e0cf6e9678c8349fd17b77d3cb))
* REST API method selector, body editor, headers in datasource panel ([9054a12](https://github.com/tianshu-ai/tianshu/commit/9054a123a7352ba4014d26e5301652cc403bf1ad))


### Bug Fixes

* ds_panel_fill parses METHOD+path into REST UI fields ([a23bca1](https://github.com/tianshu-ai/tianshu/commit/a23bca1714b73fb58523629acf137e186e82502b))
* restore selectedSource definition in datasource client ([7181062](https://github.com/tianshu-ai/tianshu/commit/718106227120420ab3efd51fa30484e22ed648e3))

## [0.110.0](https://github.com/tianshu-ai/tianshu/compare/v0.109.0...v0.110.0) (2026-10-24)


### Features

* @ mention system in composer for pinning items ([4893aff](https://github.com/tianshu-ai/tianshu/commit/4893aff7806435b570801491dabb9f18ec65ba5c))
* add Datasource provider to @ mention popup ([2de335d](https://github.com/tianshu-ai/tianshu/commit/2de335d1086493325aa3e0cab56e257eb20c048b))
* add pin button to sidebar worker rows ([1dbdda5](https://github.com/tianshu-ai/tianshu/commit/1dbdda503f6624e70c25f2b82baf06c4ffa79452))
* add Worker provider to @ mention popup ([9cee281](https://github.com/tianshu-ai/tianshu/commit/9cee2819ad17efce2d756897817ce3924fa4e666))
* board list returns title from HTML, shown in @ mention ([7cd1627](https://github.com/tianshu-ai/tianshu/commit/7cd1627d9b859741b54c824f52f16d091f32896d))
* hide tool calls during current streaming turn ([9516861](https://github.com/tianshu-ai/tianshu/commit/9516861d6367c949b78f0d78d19a18b7ac7a7fc0))
* live countdown timer on in-progress tasks in mini list ([ce6f48f](https://github.com/tianshu-ai/tianshu/commit/ce6f48f28b684cd8e0d13263465a0114c1c8d635))
* mini task list in sidebar showing in-progress tasks ([81ca69b](https://github.com/tianshu-ai/tianshu/commit/81ca69bfb7f8ee7e0985f826d85b83f145381a48))
* MiniCountdown shows next nudge check countdown after budget exceeded ([23fa098](https://github.com/tianshu-ai/tianshu/commit/23fa09839033b38101cf43a0a904b93b66346438))
* pin button on board panel header + Board provider in @ mention ([375a5e6](https://github.com/tianshu-ai/tianshu/commit/375a5e6acd2c36b0bcb1723d7ae8e6a2c6dd40f6))
* pin button on list view task rows too ([e432e12](https://github.com/tianshu-ai/tianshu/commit/e432e12bd4343999bc9c68feecd29058af57ca5c))
* pin button on messenger contacts + Contact provider in @ mention ([341457c](https://github.com/tianshu-ai/tianshu/commit/341457cd6dff4c141a666221c5f17818295302a4))
* pin button on panel task cards, shared state with sidebar ([a610453](https://github.com/tianshu-ai/tianshu/commit/a610453a7ca458455ab6ded6e1377be77227d6b1))
* pinned context system - pin tasks to composer for contextual chat ([626fc8c](https://github.com/tianshu-ai/tianshu/commit/626fc8cf369849cff72f472f6ac20a12a112b58c))
* reactive pin state on task rows + auto-clear on send ([b3e1483](https://github.com/tianshu-ai/tianshu/commit/b3e14838313ababb94b996ca6884c12e1bfca894))
* render pinned context as visual chips in chat history ([5510777](https://github.com/tianshu-ai/tianshu/commit/5510777c144bd6fe5cb6847b94d0b7f39a06cc68))
* separate pin button on task rows in mini task list ([bbe8753](https://github.com/tianshu-ai/tianshu/commit/bbe87532beea097bc92f028e6080e740f9f21453))
* show humanized tool name in agent work status ([356f3d0](https://github.com/tianshu-ai/tianshu/commit/356f3d05fc9269f1c2ebc1cbea4ea9e7d0ae9b70))
* show worker + relative time in @ mention task list ([c6fa9b6](https://github.com/tianshu-ai/tianshu/commit/c6fa9b619eb0e63ca48eaca97dce21edab3f0673))
* show worker description in @ mention worker list ([bcaee2f](https://github.com/tianshu-ai/tianshu/commit/bcaee2fcd2b371d31551857e70adda1aafdc2e70))
* show worker name on in-progress tasks in mini task list ([0906752](https://github.com/tianshu-ai/tianshu/commit/0906752c58e373627b63deebe18fc3ffc8f9e5be))
* **ui:** polish top bar, bubbles, input, sidebar ([5a53ba5](https://github.com/tianshu-ai/tianshu/commit/5a53ba5dce066704144218075d298517bf9dd73c))
* **ui:** streaming progress bar + agent work status indicator ([f9e2cef](https://github.com/tianshu-ai/tianshu/commit/f9e2cef548714119d0477a12273af4f62e448d28))


### Bug Fixes

* always show 2-stage provider→item selection in @ mention ([cfe5e7d](https://github.com/tianshu-ai/tianshu/commit/cfe5e7d785c750b707c467b9aec18ec1a55a3bd3))
* always show pin button on panel task cards, no hover-to-reveal ([002c096](https://github.com/tianshu-ai/tianshu/commit/002c09646620bb1241db42e9c32212490d723c5b))
* consistent pin button style across messenger/sidebar ([cbaa493](https://github.com/tianshu-ai/tianshu/commit/cbaa493729c1f7410d9d0c73552371b0464017ca))
* consolidate streaming indicator - remove top bar, integrate animation into status above input ([df9c2f5](https://github.com/tianshu-ai/tianshu/commit/df9c2f51fc9b34984894e800a70a4a9c05122ba8))
* edit-resend UI shows pinned context as chips, not raw text ([40678db](https://github.com/tianshu-ai/tianshu/commit/40678dbb2d10bc20caaf29da9707e1c945b0d5d3))
* hardcode solid dark bg for @ mention popup ([8ffa7fa](https://github.com/tianshu-ai/tianshu/commit/8ffa7fa0537fb29e8a72bbca5221e71cdcc56012))
* hide ctx% in compact mode (not useful for regular users) ([f73ed23](https://github.com/tianshu-ai/tianshu/commit/f73ed231d0c84b5a5562aa81c02b27f0e96fc023))
* hide tool calls in all rendering paths during current streaming turn ([5cd3807](https://github.com/tianshu-ai/tianshu/commit/5cd380786679b6b619e715873533983df8182ff6))
* hide tool-call-only messages entirely during current streaming turn ([f1407de](https://github.com/tianshu-ai/tianshu/commit/f1407de7baf33deeef3dd60ba5704e71792cd22c))
* include pinned context in follow_up queue messages + clear after send ([fb6f274](https://github.com/tianshu-ai/tianshu/commit/fb6f27460f8374561c28f6b12b13a7d68511c9ba))
* larger status indicator card ([8bcba4d](https://github.com/tianshu-ai/tianshu/commit/8bcba4dd605b165d7b0a363e7f845a2bd29acd41))
* move hooks before early returns in PluginTopBarButtons ([7931711](https://github.com/tianshu-ai/tianshu/commit/7931711a42c8eff614e9e4a464361a8ef8e524bb))
* move pin button to left side of list view task rows ([0917617](https://github.com/tianshu-ai/tianshu/commit/09176177bcc72ad2b4ae67d36cb3af1250377b3b))
* move pin button to left side of messenger contact rows ([ac5d6db](https://github.com/tianshu-ai/tianshu/commit/ac5d6db6671cc3fbd0878ba857f92454234f203a))
* move PinnedContextChips inside ChatInput border ([07c120b](https://github.com/tianshu-ai/tianshu/commit/07c120b7507d684345afd0927c78ba325075eeac))
* refocus textarea after closing @ mention popup with Esc ([71f72ca](https://github.com/tianshu-ai/tianshu/commit/71f72ca8e78cf57245a82eae5b361838d2878556))
* reliable pinned context stripping with [/pinned] end tag ([73c1480](https://github.com/tianshu-ai/tianshu/commit/73c1480eed1135eded731cd2895f57244ed55ba2))
* scroll highlighted item into view in @ mention popup ([6f436ca](https://github.com/tianshu-ai/tianshu/commit/6f436ca7831bbe6ea8697f31ae244a12ee752903))
* slim pinned context - only task_id, agent queries details itself ([84ba561](https://github.com/tianshu-ai/tianshu/commit/84ba561d8c54a2a997492bb88162f5a737bc75e9))
* slow down streaming bar animation, remove duplicate stop button ([28d00ac](https://github.com/tianshu-ai/tianshu/commit/28d00acd4ab134ae24ca180d0b0cddab106d33e0))
* solid background for @ mention popup, no transparency ([4d18260](https://github.com/tianshu-ai/tianshu/commit/4d1826030bbf2b7120e00d923068363517545512))
* worker sidebar row - whole row clickable, pin icon always visible ([1a5010c](https://github.com/tianshu-ai/tianshu/commit/1a5010c48bc019ce55b6a55442ed364d370fc9db))

## [0.109.0](https://github.com/tianshu-ai/tianshu/compare/v0.108.0...v0.109.0) (2026-10-24)


### Features

* **agent-loop:** nudge agent before declaring no_completion ([07e72e3](https://github.com/tianshu-ai/tianshu/commit/07e72e307eb52a5ced10aaa743b52f4b611bdfc2))
* badge on PanelTabBar too (visible when panel is open) ([123cb47](https://github.com/tianshu-ai/tianshu/commit/123cb47a3d26545f39beb6b608c2024726317c6c))
* lucide file-type icons for workspace:// links in markdown ([789ab87](https://github.com/tianshu-ai/tianshu/commit/789ab8768c5f61dfa440232469996f734c93ed49))
* separate host and plugin icons in top bar with divider ([7a92950](https://github.com/tianshu-ai/tianshu/commit/7a92950e4081f608b74b26f42c629f4e3849b9a9))
* taskboard list view, file icons, badge, notification improvements ([45edd26](https://github.com/tianshu-ai/tianshu/commit/45edd26431461cf4528d4b60045c61d7d242ae95))
* use workspace:// protocol for file links in notifications ([32cd25c](https://github.com/tianshu-ai/tianshu/commit/32cd25cad2c5f4d4a4944ca4c8ee9285aae618ca))
* VS Code style file icons for workspace links (react-icons/vsc) ([16a4209](https://github.com/tianshu-ai/tianshu/commit/16a420965e6657049520fd6d2bf096834f5f07c1))
* **web:** intercept /api/p/files/raw links to open in FileOpenDialog modal ([534dca4](https://github.com/tianshu-ai/tianshu/commit/534dca4b6b8016111bcd274a7a0591d8614a13f9))
* **workboard:** add Board/List view toggle to right panel ([189bf4d](https://github.com/tianshu-ai/tianshu/commit/189bf4d6f437667a9327d892257e1b3b420bdb45))
* **workboard:** algorithmic phase colors for progress bar ([5de6218](https://github.com/tianshu-ai/tianshu/commit/5de6218684ede63675b67c7629487034c1e6df5c))
* **workboard:** badge on top bar icon showing in-progress task count ([ef38fc6](https://github.com/tianshu-ai/tianshu/commit/ef38fc67347d398aa898c4e5f988cf16c6406bdd))
* **workboard:** ChatTranscript UiPrimitive replaces custom ExecutionDialog rendering ([ee6e83c](https://github.com/tianshu-ai/tianshu/commit/ee6e83cd416f2c674b902eca52dad5ddaea4f3f8))
* **workboard:** compact progress bar with multi-segment backoff + text inside ([cb2f432](https://github.com/tianshu-ai/tianshu/commit/cb2f432e97a2ebc241740561ce81775b09f9a382))
* **workboard:** complete supervision wiring ([10ce1a6](https://github.com/tianshu-ai/tianshu/commit/10ce1a63d52815e5b00461439c27d4ee1c926c87))
* **workboard:** default view mode to list ([0097a14](https://github.com/tianshu-ai/tianshu/commit/0097a145346f657af5ff5331b1fefed0a8e1cea3))
* **workboard:** dynamic backoff intervals scaled to task budget ([e70bf02](https://github.com/tianshu-ai/tianshu/commit/e70bf02fff0036eed2832b7987dc316fc26b934a))
* **workboard:** file-type emoji icons in task notifications ([e9805a7](https://github.com/tianshu-ai/tianshu/commit/e9805a7c0a7c809475492902fe95d3e5e45b57b2))
* **workboard:** flat list with multi-select status filter dropdown ([058345d](https://github.com/tianshu-ai/tianshu/commit/058345d2e2db818c1cade28cb218d5d1657efbc4))
* **workboard:** Linear-style list view with Board/List toggle ([1c4de31](https://github.com/tianshu-ai/tianshu/commit/1c4de3189a3acef1e9dc9651eb61afd889d7dcbb))
* **workboard:** list row expand shows task details, click transcript icon opens dialog ([9834faf](https://github.com/tianshu-ai/tianshu/commit/9834faf3fac9aa316f0f53dc31077b9e5b928ee6))
* **workboard:** multi-phase colored progress bar ([38ccced](https://github.com/tianshu-ai/tianshu/commit/38cccedec132e35cc0c55a4bec29f23281290c8e))
* **workboard:** multi-select project filter dropdown in list view ([24a4dcf](https://github.com/tianshu-ai/tianshu/commit/24a4dcfd6433240cca9a5fd194e987b447c22458))
* **workboard:** multi-select worker filter dropdown in list view ([5c3eb59](https://github.com/tianshu-ai/tianshu/commit/5c3eb5932c7bf3125b2753e8f3c7c117a1d45b5b))
* **workboard:** show result files in list view expanded details ([77f0259](https://github.com/tianshu-ai/tianshu/commit/77f0259aa281b18ec60b6e67188ecf8f93948a3d))
* **workboard:** show worker name in list row second line ([3d5b7ac](https://github.com/tianshu-ai/tianshu/commit/3d5b7ac7c5b4774a5d9ae1c63022bee99fbcf741))
* **workboard:** structured markdown task notifications ([adf1796](https://github.com/tianshu-ai/tianshu/commit/adf1796c6d828051cbfc192cbdab4dd6f0271bed))
* **workboard:** task notification files as clickable links via /api/p/files/raw ([7f91677](https://github.com/tianshu-ai/tianshu/commit/7f91677b235448bd2e8dd632553417465de2802d))
* **workboard:** task progress bar UI for in_progress cards ([c45ff9c](https://github.com/tianshu-ai/tianshu/commit/c45ff9cc4bc2fb8e768eeec90eacb11518768f3b))
* **workboard:** task progress bar UI for in_progress cards ([c176f25](https://github.com/tianshu-ai/tianshu/commit/c176f25ca6c5a0cd03b8bfd329f6a0ae82516f58))
* **workboard:** transcript button in expanded details + persist view mode ([ca1264f](https://github.com/tianshu-ai/tianshu/commit/ca1264fad51e72595486e0bb2c310e3d8491c531))
* **workboard:** worker supervision mode ([609c32d](https://github.com/tianshu-ai/tianshu/commit/609c32d4c630c0fb5ff642e856541f033298492c))


### Bug Fixes

* badge visible in PanelTabBar (hidden only on active tab) + red color for readability ([7589569](https://github.com/tianshu-ai/tianshu/commit/75895693968d148d7bdee16dec8f0948d7eeaa2e))
* hide badge when panel is open ([e2d0331](https://github.com/tianshu-ai/tianshu/commit/e2d0331a24038432a162046c63870b1372d4d56e))
* hide separator when panel is open ([db59505](https://github.com/tianshu-ai/tianshu/commit/db595059e3121a678b3b54bedb6b06ee51da602c))
* register TaskCheckStatusTool and TaskSetNextCheckTool in manifest ([c5b5ac4](https://github.com/tianshu-ai/tianshu/commit/c5b5ac418bd363753ceb999e5433db11fa31fdae))
* strip leading emoji from workspace link text + clean lucide-only icons for new notifications ([eaf0535](https://github.com/tianshu-ai/tianshu/commit/eaf0535c92188b7d217ebbb5d1803a6e27335958))
* taskboard icon (ListTodo) + global badge listener in plugin-store ([d3888b6](https://github.com/tianshu-ai/tianshu/commit/d3888b6a7f2a8c636d01a5eb0ca4d53d51012115))
* **workboard:** archive worker session when task terminates ([cd48931](https://github.com/tianshu-ai/tianshu/commit/cd48931d0da5c3f0eaf4352b6f36e59697a86d71))
* **workboard:** backoff starts at 2x after budget expires ([a20c212](https://github.com/tianshu-ai/tianshu/commit/a20c212788b84038840ebc39b23abbfbe5b810a1))
* **workboard:** base backoff interval = budget, not 50% ([df57dda](https://github.com/tianshu-ai/tianshu/commit/df57ddaccf4dbafa9ff8e073c321514b51e0583c))
* **workboard:** cleaner notification format - double newlines, no blockquote ([5dde3f2](https://github.com/tianshu-ai/tianshu/commit/5dde3f2bb2f9954eb864a99071cdaf810d6e6342))
* **workboard:** compact progress bar for list view - bar + elapsed only ([8a1c7fe](https://github.com/tianshu-ai/tianshu/commit/8a1c7fe361fb2f0b32a9f286812d06d348a762b7))
* **workboard:** deny board_act + supervision tools in worker sessions ([5f08560](https://github.com/tianshu-ai/tianshu/commit/5f08560cf9d1c3d37052d19bd0cef7633fb4567a))
* **workboard:** dropdown bg-gray-900 instead of transparent bg-bg-base ([b55fa11](https://github.com/tianshu-ai/tianshu/commit/b55fa119e7f2b1b6d95fa5d500740141d4737bff))
* **workboard:** exponential backoff for supervision check intervals ([5050a13](https://github.com/tianshu-ai/tianshu/commit/5050a13aef0c2cdb383564216df8d6a930d4a45c))
* **workboard:** file chip hover now brightens instead of dimming ([df3e327](https://github.com/tianshu-ai/tianshu/commit/df3e327221460eee356fe0b6a371da157adac4a0))
* **workboard:** hide ProjectChips in list view mode ([0826cac](https://github.com/tianshu-ai/tianshu/commit/0826cac1caf0581487e6f45ada510d2667f1e7b4))
* **workboard:** include estimatedDurationMs + nextCheckAt in API response ([e21c900](https://github.com/tianshu-ai/tianshu/commit/e21c9009941075e25ae666cf7f54457196d10bec))
* **workboard:** list view reuses kanban's TaskProgressBar directly ([f046def](https://github.com/tianshu-ai/tianshu/commit/f046def77e3f009ca7b124320e87c1be0e584941))
* **workboard:** list view uses full TaskProgressBar instead of simplified mini bar ([843a4d2](https://github.com/tianshu-ai/tianshu/commit/843a4d249465609baacfbd6e40a3991e900bceb2))
* **workboard:** move spinning animation from group header to item row ([0ff2211](https://github.com/tianshu-ai/tianshu/commit/0ff22115b59aa752f849aa85b9b0fe9c82e7c370))
* **workboard:** nudge preserves original startedAt for continuous elapsed time ([79fbce0](https://github.com/tianshu-ai/tianshu/commit/79fbce0b5174e7d84f6d6a768c5b2939729309f0))
* **workboard:** persist list filter selection to localStorage ([1dcf22c](https://github.com/tianshu-ai/tianshu/commit/1dcf22ccc92f402a514df053397b89682c345ee7))
* **workboard:** progress bar full width on its own line below status text ([d2623f3](https://github.com/tianshu-ai/tianshu/commit/d2623f3285016b032485cd171789f12e9ca95ceb))
* **workboard:** progress bar text contrast across all 3 themes ([5b0b12b](https://github.com/tianshu-ai/tianshu/commit/5b0b12b99ca2605ec3f186e0375f69eedf1cd864))
* **workboard:** progress bar total shows cumulative budget including overshoot intervals ([6894f7e](https://github.com/tianshu-ai/tianshu/commit/6894f7e8086515728b6f9ff3a6bb1712518a0af1))
* **workboard:** remove bell countdown and worker name from compact progress bar ([8deaf66](https://github.com/tianshu-ai/tianshu/commit/8deaf66e50c660317a221f67bc61b63b3a266675))
* **workboard:** rename 'All Tasks' to 'All Status' in filter dropdown ([3d73b7b](https://github.com/tianshu-ai/tianshu/commit/3d73b7b318a07cb56ce34ce431216543908bbf7f))
* **workboard:** replace all hardcoded gray colors with theme variables ([aad6517](https://github.com/tianshu-ai/tianshu/commit/aad6517c572d4b1e03efa98547a424c551cc3c3f))
* **workboard:** task_continue rejects in_progress tasks + worker_check text clarifies tool choice ([7777be9](https://github.com/tianshu-ai/tianshu/commit/7777be91187f6e8935236bc3cfbdcf183c1c57af))
* **workboard:** waitForFollowup replaces drainFollowups ([99b5fce](https://github.com/tianshu-ai/tianshu/commit/99b5fcea363192877d85e713432765cfac79bb30))
* **workboard:** wider progress bar + show elapsed/total in compact bar ([cb0f9fb](https://github.com/tianshu-ai/tianshu/commit/cb0f9fbf41102a6b4dd535d07fb8479446c819a7))


### Documentation

* **datasource:** add board.ds() timing guard to system prompt ([9bfab03](https://github.com/tianshu-ai/tianshu/commit/9bfab031df07edec96cb5079ac7453d74fa99df3))


### Refactor

* **workboard:** continuation_hint column replaces description hijacking ([6bc9f73](https://github.com/tianshu-ai/tianshu/commit/6bc9f73dba02734e18a0e664c8bf6129c47a8326))
* **workboard:** merge task_continue + task_send_followup → task_nudge ([374427c](https://github.com/tianshu-ai/tianshu/commit/374427c0b2c694e09704e6ba63f1637954eb834c))
* **workboard:** nudge via abort+re-run instead of followup queue ([0878476](https://github.com/tianshu-ai/tianshu/commit/0878476eb517b10698f82dc11bb3535ea9e51d58))
* **workboard:** rename task_continue → task_nudge everywhere ([a26d72a](https://github.com/tianshu-ai/tianshu/commit/a26d72a458de23cac6b47e624f5e0c18ac1204cf))

## [0.108.0](https://github.com/tianshu-ai/tianshu/compare/v0.107.3...v0.108.0) (2026-10-23)


### Features

* **bubble:** add A2aInboundCard for agent messages via message queue ([93ec52d](https://github.com/tianshu-ai/tianshu/commit/93ec52d4a8cba5c6159d20a741b0d23147a59ae6))
* **message-queue:** add messengerSource to WireMessage for wechat card rendering ([d92b74c](https://github.com/tianshu-ai/tianshu/commit/d92b74cc4e558bf5a4975dcc7e3412502eaee576))
* **message-queue:** route wechat inbound messages through webchat queue ([29b315a](https://github.com/tianshu-ai/tianshu/commit/29b315a8697fcecf4eaf8894971bda645d1bbd6b))
* **message-queue:** wire idle drain callback for external enqueue ([2688278](https://github.com/tianshu-ai/tianshu/commit/2688278f68e623d9b095f9b88a5d49d84778b36f))
* **messenger:** route a2a inbound messages through message queue ([ac0c525](https://github.com/tianshu-ai/tianshu/commit/ac0c52552b03fd9a99f11f151dc9771e07a4526f))
* **queue-ui:** add type badge icon to messenger queue cards ([869df70](https://github.com/tianshu-ai/tianshu/commit/869df702e2bedfebc3009f3e165fc85a59bfa1c1))
* **queue-ui:** hide edit/delete buttons for messenger messages ([8d4f489](https://github.com/tianshu-ai/tianshu/commit/8d4f48922ca7db270d6c2d1611fbcd002c0d4091))
* **queue-ui:** unified messenger card for wechat and a2a ([d65ce32](https://github.com/tianshu-ai/tianshu/commit/d65ce32deb5aa0eabb17a62bc61e6dbb22118427))
* **queue-ui:** wechat messages show messenger-style card with avatar ([19e9578](https://github.com/tianshu-ai/tianshu/commit/19e9578f4a0f3d18635a3eec0ba966feaf0c8ac0))
* wechat/a2a message queue with messenger-style UI cards ([7a87295](https://github.com/tianshu-ai/tianshu/commit/7a872959bfec4af63e6c346a43554f5b98c57661))


### Bug Fixes

* destructure isCurrentTurn in GroupedBlocks ([474efa5](https://github.com/tianshu-ai/tianshu/commit/474efa5fe539a6637c123935f64f01f3cb361296))
* **handler:** drainQueue loops user-typed messages, skips external ([4965584](https://github.com/tianshu-ai/tianshu/commit/4965584ca6316b0495e41d753ee9c6ea7aed7ec5))
* **handler:** drainQueue only auto-processes user-typed messages ([68d472d](https://github.com/tianshu-ai/tianshu/commit/68d472d34a41577e64a450b13667b611311cb8c9))
* **handler:** drainQueue processes only one entry per cycle ([7841bbc](https://github.com/tianshu-ai/tianshu/commit/7841bbc143756feb38b28b9d42923bc49131d18d))
* **handler:** remove duplicate drainUserQueue from trackRun finally ([682e247](https://github.com/tianshu-ai/tianshu/commit/682e2478eca2dce263d6da69071c00ee894ebff2))
* **handler:** restore sequential drain for all queue entries ([4b4c94d](https://github.com/tianshu-ai/tianshu/commit/4b4c94dea6bb11a5f90065444eabd960911870b5))
* **handler:** use buildQueuePromptContent in drainQueue ([cf29017](https://github.com/tianshu-ai/tianshu/commit/cf29017dba311675567558789cb9a08fdaa4b9af))
* **message-queue:** background drain via runPrompt, no WS dependency ([a491d39](https://github.com/tianshu-ai/tianshu/commit/a491d395f0eb99cd8cf5c5734afd0bd6c1fb4881))
* **message-queue:** backgroundDrain loops all entries sequentially ([a392c3c](https://github.com/tianshu-ai/tianshu/commit/a392c3c56e34967533e2beef11eec628e233a343))
* **message-queue:** don't drain queue while a turn is active ([d5daafb](https://github.com/tianshu-ai/tianshu/commit/d5daafbcd9a0985abde7e3624d1252dd42f1bee9))
* **message-queue:** drain inbox pending before runPrompt to prevent duplicate ([d1b5601](https://github.com/tianshu-ai/tianshu/commit/d1b56016a53a3cc71380c1ebabc4c864b1e29011))
* **message-queue:** embed inbox-events tag for wechat-style UI rendering ([c2adfac](https://github.com/tianshu-ai/tianshu/commit/c2adfac1a06a6b77e4dcf0aa81c3c9c81d05036d))
* **message-queue:** move instruction inside messenger-source tag ([aff4fed](https://github.com/tianshu-ai/tianshu/commit/aff4fed24bc7ad1455531bd3d4831e0e418a825e))
* **message-queue:** pass session + registerSessionAbort in backgroundDrain ([78db901](https://github.com/tianshu-ai/tianshu/commit/78db901afee70050b690c05f3bcb7319b8f65bea))
* **message-queue:** pass source.instruction to agent prompt + add instruction field to QueueMessageSource ([608157c](https://github.com/tianshu-ai/tianshu/commit/608157cbb34bb2fedc7c500899742f283b48e13f))
* **message-queue:** prevent duplicate drain via isDrainingInBackground guard ([b80b3da](https://github.com/tianshu-ai/tianshu/commit/b80b3dac8a18d7fa17051a0a96881adff50167b7))
* **message-queue:** process only one entry per drain cycle ([bbe4d69](https://github.com/tianshu-ai/tianshu/commit/bbe4d69b629d4113e360e9c15e868ffa6db322cb))
* **message-queue:** revert to HTML comment tag for messengerSource ([b83bb77](https://github.com/tianshu-ai/tianshu/commit/b83bb774b5f488516c9c77ff3379bfd8c7f41f3d))
* **message-queue:** revert to simple backgroundDrain without registerSessionAbort ([13cee27](https://github.com/tianshu-ai/tianshu/commit/13cee279b694c1b923d4410de19002dcf666c4bc))
* **message-queue:** trigger agent via inbox instead of drain callback ([26b0146](https://github.com/tianshu-ai/tianshu/commit/26b0146dc854373c432da68c12ee7c842266bbb5))
* **messenger:** fallback userId from sessions when contact has no user_id ([c9576f3](https://github.com/tianshu-ai/tianshu/commit/c9576f368a3325a3cb8793ea91b320b9993a9cde))
* **messenger:** remove instruction text from queue message content ([c695e13](https://github.com/tianshu-ai/tianshu/commit/c695e1329dde756898622c2eb528154ee311029c))
* rebuild messenger plugin dist + inbox enqueue trace logging ([d065c0e](https://github.com/tianshu-ai/tianshu/commit/d065c0e0e45934089270645507d20a0663bfac8c))
* resolve TS error in GroupedBlocks isLastMsg check ([5ee3d1e](https://github.com/tianshu-ai/tianshu/commit/5ee3d1e48fe100f04a410e3c665ef81a787d3825))
* **scroll:** auto-scroll during streaming via ResizeObserver ([198a9f8](https://github.com/tianshu-ai/tianshu/commit/198a9f8efe5140d023c6cf760ce21d43da53a75b))
* **scroll:** bump scrollGeneration on tool_call_pending ([b25e1ae](https://github.com/tianshu-ai/tianshu/commit/b25e1ae333746096dc05056ef373585153c0189f))
* **scroll:** compensate scroll position when queue shrinks ([0782290](https://github.com/tianshu-ai/tianshu/commit/07822909f21c7b25a69533a10c58ef9eb9293d24))
* **scroll:** compensate scroll position when tool groups collapse ([f243682](https://github.com/tianshu-ai/tianshu/commit/f243682383fd3aa30ca43d77dcee791156ab623a))
* **scroll:** correct height compensation timing in ToolCallGroup ([9e7ceea](https://github.com/tianshu-ai/tianshu/commit/9e7ceea0be90ce800440182fb93e52baf5912485))
* **scroll:** live-check distance in ResizeObserver instead of stale ref ([042e645](https://github.com/tianshu-ai/tianshu/commit/042e64562b7e0e370f8d8646ff6a7ace33459d34))
* **scroll:** only suppress compact for the currently streaming message ([0ab9531](https://github.com/tianshu-ai/tianshu/commit/0ab9531e6c2367ac6ded447ba3e8081e641feb80))
* **scroll:** remove global isStreaming from block renderer compact check ([671628a](https://github.com/tianshu-ai/tianshu/commit/671628a770aa9bf476486cfaee2845df666c5229))
* **scroll:** use instant scroll for auto-scroll on new messages ([d085dc2](https://github.com/tianshu-ai/tianshu/commit/d085dc2871d239376781cee73138b1940e6ce09c))
* **tool-compact:** keep all current-turn tool calls visible during streaming ([23be862](https://github.com/tianshu-ai/tianshu/commit/23be8629233a3242586c2dbbc6abffaee42239f8))
* **tool-compact:** keep current turn tools visible, compact only history ([a4102ec](https://github.com/tianshu-ai/tianshu/commit/a4102ec35a7c62b98c74023c0800d0d501cd2404))
* **tool-compact:** pass isCurrentTurn prop to GroupedBlocks ([4ecfaec](https://github.com/tianshu-ai/tianshu/commit/4ecfaeccb211c8e0e801b6bb07e63b1b5462d625))
* **web:** remove optimistic insert from queue_update handler ([de8de86](https://github.com/tianshu-ai/tianshu/commit/de8de865f77edf821a6e5e5fabd392d77a7c7e11))
* **web:** skip optimistic insert for external queue messages (wechat/a2a) ([9ad3249](https://github.com/tianshu-ai/tianshu/commit/9ad32491adfdbfa8c47b42398f7005ba14416904))


### Refactor

* **message-queue:** use structured JSON messengerSource instead of HTML comment tags ([9a5a015](https://github.com/tianshu-ai/tianshu/commit/9a5a015a669a66c1fe1a9d3e9325877dfd7a9d75))

## [0.107.3](https://github.com/tianshu-ai/tianshu/compare/v0.107.2...v0.107.3) (2026-10-23)


### Bug Fixes

* add send dedup guard in wechat adapter (30s window) ([0fbb862](https://github.com/tianshu-ai/tianshu/commit/0fbb862176f417ce8be3ff4432ec7a26c5f7be19))
* dedup wechat poll messages + fix syncBuf empty-string check ([8a972ab](https://github.com/tianshu-ai/tianshu/commit/8a972ab11580fe9e231b90c91aa8df5d3f011896))
* disable per-turn auto-recovery to prevent duplicate tool calls ([c87caaa](https://github.com/tianshu-ai/tianshu/commit/c87caaa23d79b71c6b58fdfee7aec81f99c1947e))
* disable recover-interrupted to prevent duplicate wechat replies ([5144f96](https://github.com/tianshu-ai/tianshu/commit/5144f960bd9f0d3e1c3658c2f02d3470c387e976))
* re-enable auto-recovery (per-turn + boot) ([a4b528d](https://github.com/tianshu-ai/tianshu/commit/a4b528d125b18b5f3e6348db21c5041d04fcf4ce))
* wechat poll syncBuf empty-string check causing duplicate messages ([e92d678](https://github.com/tianshu-ai/tianshu/commit/e92d67885dcbe9511161ba7fe6602626dac78492))


### Reverts

* remove send dedup guard, keep debug log ([6f657d9](https://github.com/tianshu-ai/tianshu/commit/6f657d9f0a9d07d253c058973e90753350e2ac9b))

## [0.107.2](https://github.com/tianshu-ai/tianshu/compare/v0.107.1...v0.107.2) (2026-10-22)


### Bug Fixes

* use log instead of turnLog in entry_added debug trace ([eadf4b7](https://github.com/tianshu-ai/tianshu/commit/eadf4b7d24aed19e5d35204736a028740a24f76d))

## [0.107.1](https://github.com/tianshu-ai/tianshu/compare/v0.107.0...v0.107.1) (2026-10-22)


### Bug Fixes

* **cron,workboard:** filter kind='user' when resolving webchat session ([5c0251a](https://github.com/tianshu-ai/tianshu/commit/5c0251aa3856b609ecb0fdaf8d7d60e647e50a4a))
* **messenger:** filter channel_id IS NULL when resolving webchat session ([8a75005](https://github.com/tianshu-ai/tianshu/commit/8a75005f6afff427a98613e6fcb40ca7ee55dbd3))

## [0.107.0](https://github.com/tianshu-ai/tianshu/compare/v0.106.1...v0.107.0) (2026-10-22)


### Features

* message queue — pending messages wait for turn completion ([5f93b4d](https://github.com/tianshu-ai/tianshu/commit/5f93b4dba772c2a8a196de3907f01b4b36ac4e76))
* **queue:** drag-and-drop reorder support ([7927874](https://github.com/tianshu-ai/tianshu/commit/7927874cc23819e6f7545ec43a52a7b9127d9aa0))
* **queue:** optimistic insert on drain via queue_update diff ([aad03c5](https://github.com/tianshu-ai/tianshu/commit/aad03c5c0f5c53296e79fabfc1af2f38a86d927a))
* **queue:** redesign UI — card style with grip/play/edit/delete icons ([11013ca](https://github.com/tianshu-ai/tianshu/commit/11013cac1109814bbc3d25142e3314c248dd2179))
* **ws:** broadcast stream/message events to all tabs via broadcastToUser ([a9df5d2](https://github.com/tianshu-ai/tianshu/commit/a9df5d2bb9c25a2e1ea47ed78456de3edda8f467))


### Bug Fixes

* await previous turn settlement before starting follow-up ([f5974fc](https://github.com/tianshu-ai/tianshu/commit/f5974fc042ba05cf05da1f4bcbf36b056198f33f))
* **bridge:** distinguish graceful unregister from socket drop ([ef29400](https://github.com/tianshu-ai/tianshu/commit/ef2940004ed35f6ac9fed813894a11b444434c97))
* **bridge:** exclude ghost connections from forUser(), add null-socket guard in call() ([c82f6a2](https://github.com/tianshu-ai/tianshu/commit/c82f6a26bd07b8bbc1d6406b175f4bdbdc284295))
* follow_up runPrompt missing pluginRegistry and homeDir ([f98877f](https://github.com/tianshu-ai/tianshu/commit/f98877f51d3c79b7bd8ebc1e3504991f5d913936))
* **queue:** broadcast queue_update to all tabs via broadcastToUser ([1860825](https://github.com/tianshu-ai/tianshu/commit/1860825c16e938ee943ae4b3b5e0c31dcd99d64e))
* **queue:** don't optimistic-insert queued messages into chat ([f742d74](https://github.com/tianshu-ai/tianshu/commit/f742d74e9d3063bd1c2f63e218fa0552b55d0579))
* **queue:** move queue to module-level per-user map, survive WS reconnect ([19a23bf](https://github.com/tianshu-ai/tianshu/commit/19a23bfa0a628add0ff1295928faba743a14ed06))
* **queue:** optimistic insert when sending queued message now ([004096f](https://github.com/tianshu-ai/tianshu/commit/004096f75c46b53c95fd0eeb1fd085334abc1c81))
* **queue:** push queue on WS connect, not on hello ([ed2e5ac](https://github.com/tianshu-ai/tianshu/commit/ed2e5ac5188762ea9824e616896c8f9d1d763de4))
* **queue:** push queue state on WS hello/reconnect ([70f1c7b](https://github.com/tianshu-ai/tianshu/commit/70f1c7bb11d79f26f70bce534b4a96301534c809))
* **ws:** register aborter in session-level abort registry for cross-tab stop ([b6f6a30](https://github.com/tianshu-ai/tianshu/commit/b6f6a3063720a7b3421d739e205be62f23449edc))
* **ws:** register sendDirect with broadcastToUser to prevent infinite recursion ([92b65b2](https://github.com/tianshu-ai/tianshu/commit/92b65b2e7e2ce6a4ed5cbc5d23d958cebc9c8d4c))
* **ws:** use sendDirect for connection-init messages (queue_update, stream_start, tool_catalog_changed) ([155c143](https://github.com/tianshu-ai/tianshu/commit/155c1438551ee38396b4f05d66dba8c9be0ec433))
* **ws:** use server messageId in history_truncated for cross-tab sync ([21fcd8d](https://github.com/tianshu-ai/tianshu/commit/21fcd8de8a0236cad616efa7e52e02fce39f38c4))


### Refactor

* **queue:** move queue inside composer, match OpenClaw layout ([c514b2a](https://github.com/tianshu-ai/tianshu/commit/c514b2a260af703f9f0308e5168d72ba6fdcf8a0))

## [0.106.1](https://github.com/tianshu-ai/tianshu/compare/v0.106.0...v0.106.1) (2026-10-21)


### Bug Fixes

* add pino to top-level dependencies ([c684f4d](https://github.com/tianshu-ai/tianshu/commit/c684f4dbe27ea3ba1bae0452433127402b8ddc1c))

## [0.106.0](https://github.com/tianshu-ai/tianshu/compare/v0.105.0...v0.106.0) (2026-10-21)


### Features

* auto-resume interrupted turns + bridge retry + stop button support ([c3a679e](https://github.com/tianshu-ai/tianshu/commit/c3a679ed35b021a442e07cfaaa7a2e524b62e06c))
* auto-resume interrupted turns on WS reconnect ([03b1280](https://github.com/tianshu-ai/tianshu/commit/03b12804e9e75fd06c00fc7665ab7df0c604fc20))
* **bridge:** exponential backoff retry for bridge tool calls ([1cfea72](https://github.com/tianshu-ai/tianshu/commit/1cfea72fc14eb585b2c51efb95f8ba6b064acdaf))
* **bridge:** persist bridge registrations - tenant-scoped with userId ([76a7696](https://github.com/tianshu-ai/tianshu/commit/76a76963f0e9ab53b9773609472d2b5b2760ec12))
* **bridge:** persist bridge registrations across server restarts ([ffb9752](https://github.com/tianshu-ai/tianshu/commit/ffb9752fa2dd58c9b27f7a0bd0d72c3f25c31e92))
* server-side auto-recovery of interrupted agent turns ([81bd2da](https://github.com/tianshu-ai/tianshu/commit/81bd2dadfd5663d67c5cb44d5b8875564607ad5c))
* startup recovery via session inbox + detect assistant with pending toolCalls ([9f10107](https://github.com/tianshu-ai/tianshu/commit/9f101077a7cc386726a8c059a63722becb9ea92b))
* structured logging with pino + correlation ID ([#627](https://github.com/tianshu-ai/tianshu/issues/627)) ([8ffcd94](https://github.com/tianshu-ai/tianshu/commit/8ffcd9445c53ef9c82a32b2ccde4e8b9ba230890))


### Bug Fixes

* allow stop button to cancel inbox-triggered (recovery) turns ([60304cd](https://github.com/tianshu-ai/tianshu/commit/60304cd27891ba010eeec67691f7f50c5ab60339))
* auto-resume handles zombie lane ops (not just dangling user msgs) ([3b399c2](https://github.com/tianshu-ai/tianshu/commit/3b399c2ed2277c0bf068ab8ce68db3f9fd7f7859))
* bridge retry should not retry application errors ([71c6f6b](https://github.com/tianshu-ai/tianshu/commit/71c6f6b5a8f3eeabbd7226884d7bffb397d2ab77))
* **bridge:** add exponential backoff retry to BridgeSandboxRunner ([f29a298](https://github.com/tianshu-ai/tianshu/commit/f29a298418af8e76f89c8e8b9827d676f89e5fb4))
* **bridge:** extend retry backoff to ~30s max (1s,2s,4s,8s,16s) ([0007851](https://github.com/tianshu-ai/tianshu/commit/0007851ceff02eca6ab628d5ee05886dc3eb5602))
* **bridge:** fix require in ESM + log persist errors ([14bec78](https://github.com/tianshu-ai/tianshu/commit/14bec78a3fbd5281a61ac6791432a7f9dddebaab))
* **bridge:** skip redundant persist writes on heartbeat re-register ([11e4b03](https://github.com/tianshu-ai/tianshu/commit/11e4b03dc3066d97f406ea9562547f0ad3f3ee79))
* dangling_user recovery also uses directive prompt + hide notification from user ([70aa697](https://github.com/tianshu-ai/tianshu/commit/70aa6978afa17d669dd41d5258aa0dcecd4d4e9f))
* detect interrupted turns where last msg is tool result or assistant with pending toolCalls ([8dd5d00](https://github.com/tianshu-ai/tianshu/commit/8dd5d00069a851e2eb0fb5180db76953739703a1))
* hide internal recovery system_note messages entirely ([98b063a](https://github.com/tianshu-ai/tianshu/commit/98b063a6c43d8e5d83405523ac23aa1b7c2ae147))
* hide internal system_note notifications in frontend ([c773cdb](https://github.com/tianshu-ai/tianshu/commit/c773cdbd22c3fdbfa4f9815dc36e6fd5303afd09))
* make recovery prompt directive — auto-continue without asking user ([5df5cbd](https://github.com/tianshu-ai/tianshu/commit/5df5cbd0696fae3bda78e8bc7edec0bbdb236338))
* **recovery:** also delete assistant messages with pending tool calls ([f7c10ef](https://github.com/tianshu-ai/tianshu/commit/f7c10efdc3747177cb14c9c1d18418a82b7f660e))
* **recovery:** delete orphaned tool result before recovery turn ([606a233](https://github.com/tianshu-ai/tianshu/commit/606a233a8daa2f1b6d83fc11f393508d54c03a89))
* **recovery:** don't delete successful tool results ([e5b95fc](https://github.com/tianshu-ai/tianshu/commit/e5b95fc63d20e8826c3e471f0aeebddd3d320fdc))
* **recovery:** skip user-stopped sessions on restart ([5ba3e55](https://github.com/tianshu-ai/tianshu/commit/5ba3e55fa08aa2c2e4b4d5e2c97402ef0a87f602))
* strengthen auto-recovery in system prompt and recovery note ([3ef24a2](https://github.com/tianshu-ai/tianshu/commit/3ef24a205d36028145b5959d78a95e1e97813973))

## [0.105.0](https://github.com/tianshu-ai/tianshu/compare/v0.104.1...v0.105.0) (2026-10-21)


### Features

* 'Jump to latest' button when viewing history_around slice ([2c8ea42](https://github.com/tianshu-ai/tianshu/commit/2c8ea42b7955bea127e4d91ce906798a6ce62963))
* load more messages when scrolling down in history_around view ([5fcd011](https://github.com/tianshu-ai/tianshu/commit/5fcd011387e790ceceffaa1f7e74fcb186aa69f6))
* search jump to message loads surrounding context ([5f61e8c](https://github.com/tianshu-ai/tianshu/commit/5f61e8cf5e3e8c0ec982e732a0f77c77c3a1a824))
* universal scroll-to-bottom button (right corner circle) ([0553f0f](https://github.com/tianshu-ai/tianshu/commit/0553f0f1137625ee3f88b635ccddf3e83a229082))


### Bug Fixes

* include tool messages in history_around and history_more_after ([950a3b3](https://github.com/tianshu-ai/tianshu/commit/950a3b31b887b69a3c76a2c6eeb3d93bcc91ed13))
* match 'Load more' button style to 'Load earlier messages' ([267ba2e](https://github.com/tianshu-ai/tianshu/commit/267ba2e87c697a55dc855bed908e6338b521130c))
* scroll-to-bottom button fixed position at right corner ([21b5f25](https://github.com/tianshu-ai/tianshu/commit/21b5f25598f6140933978e9c4fa21a83decc1672))
* show scroll-to-bottom button when hasMoreAfter is true ([dc3bf1e](https://github.com/tianshu-ai/tianshu/commit/dc3bf1e2572cddae58812deea499f44af5b0e8c2))

## [0.104.1](https://github.com/tianshu-ai/tianshu/compare/v0.104.0...v0.104.1) (2026-10-20)


### Bug Fixes

* **ui:** gradual dissolve with 5-stop keyframes ([e8dcf2b](https://github.com/tianshu-ai/tianshu/commit/e8dcf2b579cf88509ef58e58403ee8b4304f45b4))
* **ui:** inline keyframe dissolve instead of variants ([2eb763c](https://github.com/tianshu-ai/tianshu/commit/2eb763c54c7c21cbfb085f97de96a25e17870154))
* **ui:** reduce dissolve blur from 14px to 5px ([14069fb](https://github.com/tianshu-ai/tianshu/commit/14069fb279041e7e5f0387179e7ad7256b175365))
* **ui:** revert to working dissolve animation (183f1cfe) ([a8ca27e](https://github.com/tianshu-ai/tianshu/commit/a8ca27e34c08cac083c10b20818b7523a90cbacf))

## [0.104.0](https://github.com/tianshu-ai/tianshu/compare/v0.103.1...v0.104.0) (2026-10-20)


### Features

* **ui:** compact mode delays fold until turn completes ([5a44a21](https://github.com/tianshu-ai/tianshu/commit/5a44a21afd68e92c4529cea75ecf803778b0eb20))
* **ui:** dissolve animation for compact tool call fold ([ee4ef44](https://github.com/tianshu-ai/tianshu/commit/ee4ef44600f1a3a8f8ab749024f5b92f52466035))
* **ui:** refined dissolve animation — slower, more layered ([4fe8c6a](https://github.com/tianshu-ai/tianshu/commit/4fe8c6af193c9a6af375ebf0b8382c7f13fcfe2d))
* **ui:** slower phased dissolve animation for tool calls ([839b6af](https://github.com/tianshu-ai/tianshu/commit/839b6afb69da37e68890a9e562ab092163b0caf4))
* **ui:** use motion (framer-motion) for tool call dissolve animation ([d5a8fee](https://github.com/tianshu-ai/tianshu/commit/d5a8fee192eb5d66d409b69273bb9267d6174309))


### Bug Fixes

* local truncate on edit_resend instead of full history reload ([eb09e31](https://github.com/tianshu-ai/tianshu/commit/eb09e312fa1e286bc9e4e7db1f7613633935d507))
* scroll to bottom after history reload (edit_resend) ([42dd04c](https://github.com/tianshu-ai/tianshu/commit/42dd04ce304268dc7df2337458acff900526268d))
* use motion animate instead of AnimatePresence for dissolve ([183f1cf](https://github.com/tianshu-ai/tianshu/commit/183f1cfed50a4f16e28648cfe2768574b1a4f753))

## [0.103.1](https://github.com/tianshu-ai/tianshu/compare/v0.103.0...v0.103.1) (2026-10-20)


### Bug Fixes

* disable composer while awaiting response after WS reconnect ([db0bc17](https://github.com/tianshu-ai/tianshu/commit/db0bc17ef6663ec52d8c9ad5e0022e74132a822a))
* don't clear awaiting state on synthetic empty stream_end ([6a33df8](https://github.com/tianshu-ai/tianshu/commit/6a33df8d6d4a7f371970b39e36eaf472896d535f))
* emit synthetic stream_start after connected event via microtask ([90707f2](https://github.com/tianshu-ai/tianshu/commit/90707f223b6f1ef18f52e2ab49d76370a2ffb04c))
* keep streaming state alive across connected/history_truncated ([dc1ecdc](https://github.com/tianshu-ai/tianshu/commit/dc1ecdccebc8cc311f957584bce9f925a3daf913))
* markMessageInterrupted breaks JSON content in DB ([b523d09](https://github.com/tianshu-ai/tianshu/commit/b523d09d2df968bcf1a4ccb7c657c685474115b4))
* preserve _awaitingResponse across history_truncated (edit_resend) ([1f68d31](https://github.com/tianshu-ai/tianshu/commit/1f68d3119a4775450418c81367879b6b5bdea070))
* preserve streaming placeholder across history reload ([d4b8986](https://github.com/tianshu-ai/tianshu/commit/d4b89863946cd5b3bb659e83c8d555bf7fe989bc))
* re-push stream_start on WS reconnect when agent is running ([cfd1221](https://github.com/tianshu-ai/tianshu/commit/cfd1221e5410104fbbc18c0bd6c8f4377c7b2163))
* recognize edit_resend in outgoing queue flush ([77ee8ac](https://github.com/tianshu-ai/tianshu/commit/77ee8acd136d127982833a33e34a520cb89855c9))
* remove [interrupted] marker from aborted messages ([22c1aa7](https://github.com/tianshu-ai/tianshu/commit/22c1aa7029d79eff03641a0fe69bf727bf270d91))
* show retry state when sending prompt while WS disconnected ([467086e](https://github.com/tianshu-ai/tianshu/commit/467086e136826ae7f72fe659446e1019e9181a54))
* synthesize stream_start when flushing queued prompt on reconnect ([94e45d3](https://github.com/tianshu-ai/tianshu/commit/94e45d36993ea6bcb0cc7d38b9ac06b0dcc99e94))
* WS reconnect reliability + streaming state preservation ([60ddbdd](https://github.com/tianshu-ai/tianshu/commit/60ddbdd6b7f7b1938340ef993f5564304233eb90))

## [0.103.0](https://github.com/tianshu-ai/tianshu/compare/v0.102.1...v0.103.0) (2026-10-20)


### Features

* version mismatch auto-reload + server version in WS connected ([b1d1743](https://github.com/tianshu-ai/tianshu/commit/b1d17435faa17703ccb99b0aca23c74f8cf536f1))


### Bug Fixes

* prevent infinite reload loop on version mismatch ([3719e56](https://github.com/tianshu-ai/tianshu/commit/3719e564bfe718a751a54e948543001902624fa5))
* set proper cache headers for SPA hosting ([1828cb1](https://github.com/tianshu-ai/tianshu/commit/1828cb153ea90922a685b692d5d62c20487b0da1))

## [0.102.1](https://github.com/tianshu-ai/tianshu/compare/v0.102.0...v0.102.1) (2026-10-20)


### Bug Fixes

* **web:** don't hide send_message cards in compact tool display mode ([dd43089](https://github.com/tianshu-ai/tianshu/commit/dd430898bc0dd4a98629f2b524a4a9c1bdb65f43))

## [0.102.0](https://github.com/tianshu-ai/tianshu/compare/v0.101.0...v0.102.0) (2026-10-20)


### Features

* **ui:** compact tool display mode — hide completed tool calls ([#618](https://github.com/tianshu-ai/tianshu/issues/618)) ([1054433](https://github.com/tianshu-ai/tianshu/commit/105443332e2adaf037926ad6b9d90bf3de210e38))

## [0.101.0](https://github.com/tianshu-ai/tianshu/compare/v0.100.0...v0.101.0) (2026-10-20)


### Features

* **streaming:** early tool call rendering with tool_call_pending event ([#616](https://github.com/tianshu-ai/tianshu/issues/616)) ([9b717a0](https://github.com/tianshu-ai/tianshu/commit/9b717a09472debfd53a64bf5bf4d0e0d915e223b))

## [0.100.0](https://github.com/tianshu-ai/tianshu/compare/v0.99.0...v0.100.0) (2026-10-20)


### Features

* **cron:** fallback to webchat when channel session not found ([6c1720b](https://github.com/tianshu-ai/tianshu/commit/6c1720beaaec6e12f92fa2d3aabf51a86346cda6))
* **messenger:** channel fallback + update tool schema in system prompt ([6868d5d](https://github.com/tianshu-ai/tianshu/commit/6868d5d5b324270f82ff5be6f6ea966c76e3ca9a))
* **messenger:** convert voice WAV→silk before sending as file ([f041302](https://github.com/tianshu-ai/tianshu/commit/f04130274d8d723ef319f9e0496094a0120e53ec))
* **messenger:** send voice as native WeChat voice bubble (silk encoding) ([28424c5](https://github.com/tianshu-ai/tianshu/commit/28424c561bd6e4cdb0c9cff67256fbc59c321540))
* **web:** show file link in SendMessageCard for file attachments ([25f6465](https://github.com/tianshu-ai/tianshu/commit/25f6465b8449e3fdd580c25b5c4a5940cef5eff3))
* **workboard:** channel fallback for task completion notifications ([684c775](https://github.com/tianshu-ai/tianshu/commit/684c775e8a0aa0013539b6d507008db616b7a828))


### Bug Fixes

* **cron:** cleaner fallback message - agent forwards silently ([9327d46](https://github.com/tianshu-ai/tianshu/commit/9327d46c8992e12951a23ea173db5d6c587ea45e))
* **cron:** instruct agent to use send_message on channel fallback ([ae5a086](https://github.com/tianshu-ai/tianshu/commit/ae5a086ef2c7a6f73c5d656b4fd8678356c5f9a4))
* **cron:** translate fallback message to Chinese ([3aa3014](https://github.com/tianshu-ai/tianshu/commit/3aa301488d8cce53974f2f2ee6fe7ee8791d332f))
* **messenger:** convert voice WAV→MP3 via ffmpeg before sending ([d1ee495](https://github.com/tianshu-ai/tianshu/commit/d1ee495dca687f0f88ad7c79a8f8bb628a124124))
* **messenger:** iLink doesn't support VOICE msg type - fall back to file ([c19574c](https://github.com/tianshu-ai/tianshu/commit/c19574c839d7c88cb8bd3c1790594e3d8e618347))
* **web:** add left padding for minimap position rail ([13e2193](https://github.com/tianshu-ai/tianshu/commit/13e2193925ab7c77e4ecf2b8a084bff0995ffa50))
* **web:** adjust minimap rail position left:-28 with pl-8 container ([73c15a0](https://github.com/tianshu-ai/tianshu/commit/73c15a08d8fe68ea019415033c87f5da8b961ec3))
* **web:** pl-10 left padding on scroll container for minimap clearance ([212a3fb](https://github.com/tianshu-ai/tianshu/commit/212a3fbb4ed1b936e7b5b0b4a3f7b5489aa6a551))

## [0.99.0](https://github.com/tianshu-ai/tianshu/compare/v0.98.0...v0.99.0) (2026-10-19)


### Features

* **chat:** add chat history search ([#612](https://github.com/tianshu-ai/tianshu/issues/612)) ([feb1477](https://github.com/tianshu-ai/tianshu/commit/feb147752e0037187af1d9683787c4498ac022fc))
* **chat:** add Chat/Task mode toggle in composer ([93d1f2e](https://github.com/tianshu-ai/tianshu/commit/93d1f2e2806acfcb01bc6c46436f708743b1b899))
* **chat:** add minimap navigation rail ([#613](https://github.com/tianshu-ai/tianshu/issues/613)) ([fb32142](https://github.com/tianshu-ai/tianshu/commit/fb32142592ea9e41b20fdaa92c06228f34198401))
* **chat:** correct turn numbering with server-side turnsBefore ([b1f7fc7](https://github.com/tianshu-ai/tianshu/commit/b1f7fc79e37f9832b6302806e2fc3575a5ddee78))
* **chat:** position rail hover preview + move ticks closer to edge ([c7a64be](https://github.com/tianshu-ai/tianshu/commit/c7a64befe90aa893f8cbce0d9a8dc0e204b1700b))
* **chat:** show turn numbers on position rail ([9d5aec8](https://github.com/tianshu-ai/tianshu/commit/9d5aec8c4867187410792ed0e2f789cea6c37692))
* **messenger:** redesign message history UI with search, pagination, and improved layout ([#611](https://github.com/tianshu-ai/tianshu/issues/611)) ([bddcd67](https://github.com/tianshu-ai/tianshu/commit/bddcd67d8579ba31295d714f29543405c2a6012f))
* WeChat bidirectional messaging via messenger plugin ([#614](https://github.com/tianshu-ai/tianshu/issues/614)) ([77789fc](https://github.com/tianshu-ai/tianshu/commit/77789fcf46ddc3bc56ea601eefe7e2ac79806019))


### Bug Fixes

* **chat:** clean system-note tags from preview, show System label ([5089b5f](https://github.com/tianshu-ai/tianshu/commit/5089b5ffec7770c3518616fa98ca6af0110a4f5a))
* **chat:** minimap ticks now use actual DOM positions ([51bb959](https://github.com/tianshu-ai/tianshu/commit/51bb959aef2d6c259a857148f91d275ed9a25c2d))
* **chat:** move position rail ticks further left ([093e5ac](https://github.com/tianshu-ai/tianshu/commit/093e5ac91cd56c3fd0ed93f687b3a103d025b155))
* **chat:** move turn number from tick to preview card ([4597674](https://github.com/tianshu-ai/tianshu/commit/4597674f9b9ccdb57b37f86cc1bb90724f3cbbff))
* **chat:** position rail never scrolls independently — compress ticks to fit ([363545e](https://github.com/tianshu-ai/tianshu/commit/363545ead2a539e666e0a4e9263fb7c42915cd92))
* **chat:** position rail preview renders system note / inbox event text ([8e55e87](https://github.com/tianshu-ai/tianshu/commit/8e55e876daf3210a22ec66bd75d650485e60185c))
* **chat:** redesign task mode toggle — banner above input ([36bdd2b](https://github.com/tianshu-ai/tianshu/commit/36bdd2b7b65e5cdcb91a12915e2c3246ffa58846))
* **chat:** remove tooltip from position rail ticks (preview replaces it) ([1f78582](https://github.com/tianshu-ai/tianshu/commit/1f78582e5a208082a271cb259ccf530296e38316))
* **chat:** switch placeholder text based on chat/task mode ([5ff4264](https://github.com/tianshu-ai/tianshu/commit/5ff426467afdc4e8405f787b8f559352943fd114))
* **chat:** task mode delegates to workboard workers ([e0ceeca](https://github.com/tianshu-ai/tianshu/commit/e0ceeca72f5000b50ffeef338d259d832fa5f37e))
* **messenger:** read localBase lazily so TIANSHU_PORT/PROTO are available ([78b4ed0](https://github.com/tianshu-ai/tianshu/commit/78b4ed0c071e15c8e73a4de7f6ca9e498fff9ab7))
* **messenger:** relay-client uses actual server port and protocol ([aa33de5](https://github.com/tianshu-ai/tianshu/commit/aa33de5bc7ca0d26fd13403a520945fb63014206))
* **messenger:** use NODE_TLS_REJECT_UNAUTHORIZED instead of undici require ([74179c3](https://github.com/tianshu-ai/tianshu/commit/74179c359f647160d5cef063fe9e6b819196813c))
* **web:** position rail preview - check resolvedBlocks text and tool names ([6c0a231](https://github.com/tianshu-ai/tianshu/commit/6c0a231de294a8c98535253d1da9649527dbd613))
* **web:** position rail preview for tool-only assistant messages ([c455590](https://github.com/tianshu-ai/tianshu/commit/c455590fa0a12a6405a2ea9c25df7b552dda9ae8))


### Refactor

* **chat:** position rail shows 2 ticks per turn (start + end) ([43a07c3](https://github.com/tianshu-ai/tianshu/commit/43a07c35777bf473c1c60111a2ccf857270dbe1c))
* **chat:** rewrite position rail based on OpenClaw design ([d9d5ba2](https://github.com/tianshu-ai/tianshu/commit/d9d5ba26c865df1f8687d45664e2928c5ce23d3d))

## [0.98.0](https://github.com/tianshu-ai/tianshu/compare/v0.97.0...v0.98.0) (2026-10-19)


### Features

* **messenger:** multi-agent relay registration per user ([3dc8514](https://github.com/tianshu-ai/tianshu/commit/3dc851419fe83dd84cb8e933a3f7514e6e2832bf))


### Bug Fixes

* always generate a local id for outbound records. ([28ec63a](https://github.com/tianshu-ai/tianshu/commit/28ec63a38549eb2923c0cfb18c7d0c2f0cfbe6e3))
* **messenger:** discover filter uses userId - only exclude self, not same-tenant peers ([29033eb](https://github.com/tianshu-ai/tianshu/commit/29033eb1d8bdf76f25c1a49c84347f5bcc3e2873))
* **messenger:** fallback outbound lookup by peer info in onPairAccepted ([19fc11c](https://github.com/tianshu-ai/tianshu/commit/19fc11cdb5742baa7e1c76861c52483cdb79280c))
* **messenger:** fix TS errors - remove stale relayDiscoverable ref, fix updateCard signature ([ec39706](https://github.com/tianshu-ai/tianshu/commit/ec39706015901ac5db52a0a174eeacc21a45d2fe))
* **messenger:** onPairAccepted/Rejected lookup uses out_ prefix for outbound id ([7bd5397](https://github.com/tianshu-ai/tianshu/commit/7bd539732eee3ac383a31e893ec671fe5211a24f))
* **messenger:** onPairCompleted lookup by relay_request_id + peer info fallback ([7d08974](https://github.com/tianshu-ai/tianshu/commit/7d089747256a84a49f63e603c0c6de18a5324c59))
* **messenger:** outbound pair request uses own id, not relay requestId ([28ec63a](https://github.com/tianshu-ai/tianshu/commit/28ec63a38549eb2923c0cfb18c7d0c2f0cfbe6e3))
* **messenger:** pass target userId in pair request ([48b562f](https://github.com/tianshu-ai/tianshu/commit/48b562fac4eca78e32ecbc0de1337757aecf0739))
* **messenger:** pass targetUserId in pair accept/complete for per-user routing ([4f5f8cf](https://github.com/tianshu-ai/tianshu/commit/4f5f8cfcbaa7bd8a045d1e96ff489e23126df63a))
* **messenger:** route inbound pair_request to targetUserId ([633125f](https://github.com/tianshu-ai/tianshu/commit/633125f60f6e38a03d38ee4c6bdcd78fb3871ac1))
* **messenger:** show offline agents in discover, friendly error messages ([31c8f02](https://github.com/tianshu-ai/tianshu/commit/31c8f02394d11e4e6cdb4253eacfe4728eb0cd43))
* **messenger:** type annotation for db.prepare().run() result ([c88a09e](https://github.com/tianshu-ai/tianshu/commit/c88a09eb57b894a7b0640c8cdbd1d63f5793ca32))
* **messenger:** use deterministic out_ prefix for outbound pair request id ([11d569d](https://github.com/tianshu-ai/tianshu/commit/11d569dfa95fe017315d5fefaf7cdd15de8bc440))
* **messenger:** use relay_request_id in acceptPair/rejectPair relay messages ([b1efca0](https://github.com/tianshu-ai/tianshu/commit/b1efca07ed7f1802c4d21c4811129d3e46af8208))
* **web-search:** preserve Parallel excerpts and publication dates ([0fb553e](https://github.com/tianshu-ai/tianshu/commit/0fb553ecd7412acd97ef75f03d964e5f71664e72)), closes [#600](https://github.com/tianshu-ai/tianshu/issues/600)
* **web:** bump react-dom to 19.3.1 to match react version ([9897353](https://github.com/tianshu-ai/tianshu/commit/9897353a37b83f688412158f4d2dd860129db8d8))


### Refactor

* **messenger:** robust pair request data model with relay_request_id ([02b2738](https://github.com/tianshu-ai/tianshu/commit/02b27385312ff1ef76ba180c8a0b80a741bd44d5))
* **messenger:** upsert inbound pair requests instead of skip ([d8d7af0](https://github.com/tianshu-ai/tianshu/commit/d8d7af0cfca140e04558f1007f9b04247702a665))

## [0.97.0](https://github.com/tianshu-ai/tianshu/compare/v0.96.1...v0.97.0) (2026-10-18)


### Features

* browser-bridge Docker image (Local Bridge + Chrome + Playwright + Python) ([f140645](https://github.com/tianshu-ai/tianshu/commit/f14064503b4b9ba182f89bb4121f1a3b034a7f93))
* **messenger:** pass userId to relay for per-user registration ([22e0a94](https://github.com/tianshu-ai/tianshu/commit/22e0a9475e94554e45841299118566c084914362))
* **messenger:** sync agent card updates to relay server ([4d08eba](https://github.com/tianshu-ai/tianshu/commit/4d08ebaf61d9d9dca8d1c8387dd04fac4c713dc3))
* relay card sync + per-user registration ([758114b](https://github.com/tianshu-ai/tianshu/commit/758114bc8df146d13fee8b0a8063381a93e89b53))
* user-level MCP server registration ([e9609ae](https://github.com/tianshu-ai/tianshu/commit/e9609ae4848ff860194362dac8165eb13edb7967))


### Bug Fixes

* add provider to updateCard type signature ([847749f](https://github.com/tianshu-ai/tianshu/commit/847749f2a97dd857cb9a2a8681fa6d0e917e85ba))
* exec tool always available - don't hide when sandbox is in error state ([fac741f](https://github.com/tianshu-ai/tianshu/commit/fac741f51c4a2a2bf968047e0ba03ce570ae1ee6))
* **messenger:** handle _a2a_card_update silently in JSON-RPC path ([5a32b32](https://github.com/tianshu-ai/tianshu/commit/5a32b32e032c051ef71d5226f14877d5660f8448))
* **messenger:** pass version/provider/skills from agent card to relay ([500085c](https://github.com/tianshu-ai/tianshu/commit/500085c66595d92e3067ed272f597ce4c064c0c5))
* **messenger:** sync agent card to global row + relay on PUT ([e389e94](https://github.com/tianshu-ai/tianshu/commit/e389e945ef9e1bc306a671b84bc64d3a4096eabf))
* **messenger:** sync card to relay when agent uses update_agent_card tool ([02b79b9](https://github.com/tianshu-ai/tianshu/commit/02b79b97ca970a5601277dd8a5a48382a2a03524))
* openshell gateway.toml compat with v0.1.4 - move guest_tls to [openshell.gateway], add version=2 ([38cae6d](https://github.com/tianshu-ai/tianshu/commit/38cae6d431dbb874b68ca9ae115683bc25ce70e6))
* openshell gateway.toml v2 schema - only guest_tls_ca in [openshell.gateway] ([0e22bf5](https://github.com/tianshu-ai/tianshu/commit/0e22bf579df7652495e6534ea3f24fceed72138e))
* remove --drivers flag from gateway spawn (auto-detect, compat with newer openshell-gateway) ([a1b81fb](https://github.com/tianshu-ai/tianshu/commit/a1b81fb2ad882bc75f64a2e15b2f48e793102804))
* use host.docker.internal instead of host.openshell.internal in gateway toml ([81fb393](https://github.com/tianshu-ai/tianshu/commit/81fb39301e9ecd0bafe4d816eba1dae53f8dde9d))


### Documentation

* openshell setup notes - explicit binary paths, per-tenant port assignment ([e9b95fe](https://github.com/tianshu-ai/tianshu/commit/e9b95feb4f7d1b7344fa62fbb84ec4903753720f))

## [0.96.1](https://github.com/tianshu-ai/tianshu/compare/v0.96.0...v0.96.1) (2026-10-16)


### Bug Fixes

* translate Pair Agent button and modal title ([cd3a35b](https://github.com/tianshu-ai/tianshu/commit/cd3a35b752628fffad495d87da246b26b4e3d566))
* workboard config dialog hardcode opaque bg instead of CSS var ([0212a6f](https://github.com/tianshu-ai/tianshu/commit/0212a6fa76fe792d9d89ecff94c1497920050b39))
* workboard config dialog uses inline opaque background with fallback ([b424009](https://github.com/tianshu-ai/tianshu/commit/b424009b502bed0e629a7dad7a65a8eef2e08256))
* workboard config dialog uses opaque bg-bg-surface instead of transparent bg-bg-base ([1c42258](https://github.com/tianshu-ai/tianshu/commit/1c4225890712fb3346f9a426b8a9655ee681a3d8))

## [0.96.0](https://github.com/tianshu-ai/tianshu/compare/v0.95.0...v0.96.0) (2026-10-16)


### Features

* A2A add flow fetches peer agent card, no manual name ([210c972](https://github.com/tianshu-ai/tianshu/commit/210c9723d190ad0a91246da91abbf4f255dac6c5))
* A2A disconnect notification — delete notifies peer, peer auto-disables ([e6e71f8](https://github.com/tianshu-ai/tianshu/commit/e6e71f89bf701c029060e01f9af09dc3afa88f50))
* A2A messaging + Agent Card for Messenger plugin ([#596](https://github.com/tianshu-ai/tianshu/issues/596)) ([7ae7210](https://github.com/tianshu-ai/tianshu/commit/7ae721028aa5d1987b8cf6fffe03baf1d5d51064))
* A2aMessengerAdapter sends standard JSON-RPC message/send ([d5f0670](https://github.com/tianshu-ai/tianshu/commit/d5f06703cdcb5913d8faa28053e8614eff8496cd))
* Agent Relay — async pairing, discovery, and cross-agent messaging via Bluetooth relay ([9b9073f](https://github.com/tianshu-ai/tianshu/commit/9b9073f400bd1567bc2da9e3c658de45d9f0f854))
* async A2A - poll tasks/get for working/submitted status ([56188d8](https://github.com/tianshu-ai/tianshu/commit/56188d80333e05157c870d6682cf8b2bc05d3bc9))
* avatar type badge + better empty state ([de0ef9b](https://github.com/tianshu-ai/tianshu/commit/de0ef9bb12ccca558c41c715d0661f4b67e0950e))
* detailed A2A JSON-RPC debug logging with full payloads ([45fcc82](https://github.com/tianshu-ai/tianshu/commit/45fcc827f2984acaf8a283c173c86d536ed8d543))
* display provider, version, skills on agent card in panel ([5bc0b08](https://github.com/tianshu-ai/tianshu/commit/5bc0b088fdb522512b494d109ac519990ab86420))
* extend agent card to standard A2A format ([467439e](https://github.com/tianshu-ai/tianshu/commit/467439e7cc911fdcbb71d19ab46899a00737daa3))
* extract A2A reply from JSON-RPC response and display it ([4df94b9](https://github.com/tianshu-ai/tianshu/commit/4df94b900d26f6a8cde9cdba051b1ae4c1ca0f3c))
* fire-and-forget A2A send - reply via background callback ([1f8b812](https://github.com/tianshu-ai/tianshu/commit/1f8b812b446691f402cb7f7c2855f479dc36f52a))
* long-lived scoped token for ongoing A2A communication ([8c851b1](https://github.com/tianshu-ai/tianshu/commit/8c851b184cf8aa4732d77469b3b133d93a1ad971))
* message history modal — larger size + allow maximize ([e5ebeb2](https://github.com/tianshu-ai/tianshu/commit/e5ebeb24d6b29ea58cdfdde5c42f2af71629bcb9))
* messenger panel redesign + A2A peerId routing + disconnect flow ([577102c](https://github.com/tianshu-ai/tianshu/commit/577102c713fb849d3bae2c4b169c465c1fbb813d))
* one-time pairing token — consumed on handshake success ([9ed675d](https://github.com/tianshu-ai/tianshu/commit/9ed675db7aa1430da03c535930cf3cd459b93e50))
* peer_disconnected contacts cannot be manually toggled, auto-recover on re-pair ([fe15282](https://github.com/tianshu-ai/tianshu/commit/fe15282f017a3bcec2aa22bbcc14bc7e5298b7cf))
* push A2A sync reply as incoming message bubble via notifyA2a ([c8ccb38](https://github.com/tianshu-ai/tianshu/commit/c8ccb38a78c3b2a1a2962e73b448333e8f2ee910))
* render markdown in messenger history inbound bubbles ([572faee](https://github.com/tianshu-ai/tianshu/commit/572faeeea5c40748f9eec460b60fe2eda756d505))
* scoped tokens — restrict plugin route access per token ([a0ff3c8](https://github.com/tianshu-ai/tianshu/commit/a0ff3c8c107903f664e4f5f27a9f392f2fe0fb0e))
* send handshake as standard JSON-RPC message/send ([5cba074](https://github.com/tianshu-ai/tianshu/commit/5cba0745f78f289754d74812e687c3441935aaed))
* SSE streaming for async A2A - non-blocking send ([c6416df](https://github.com/tianshu-ai/tianshu/commit/c6416df14991ff4f908cb91336bb9b4482c59504))
* stable peerId = sha256(endpoint + tenantId + userId) for contact dedup ([2d9acf0](https://github.com/tianshu-ai/tianshu/commit/2d9acf00f845eb0d6451b777832567924291b5e8))
* standard A2A protocol support - JSON-RPC, async send, SSE streaming ([b55f730](https://github.com/tianshu-ai/tianshu/commit/b55f7307601f03e40c5d5e38d4e57ec90d4fcec2))
* standard A2A protocol support (v1.0) ([5eeee1d](https://github.com/tianshu-ai/tianshu/commit/5eeee1d74e17d6a9176a0801b62246b9686ca59e))
* support standard A2A protocol for adding agents ([12bdb0b](https://github.com/tianshu-ai/tianshu/commit/12bdb0bbdc594b01402b7ebf36aec3106e32a58b))
* token→contact mapping for precise A2A message routing ([1d94d97](https://github.com/tianshu-ai/tianshu/commit/1d94d977378c50acd877ac29383ddbe141037395))
* update_agent_card tool + UI prompt for standard A2A fields ([33fe27c](https://github.com/tianshu-ai/tianshu/commit/33fe27c63c785dfbbf4b37e4ec6371463b9732e0))
* WeChat/Telegram-style contact list ([2d9fc2d](https://github.com/tianshu-ai/tianshu/commit/2d9fc2d9829c4cfc2ef91abd557d32abd3d4b3ad))


### Bug Fixes

* A2A add button uses Bot icon + accent color, matches WeChat button style ([9cbff54](https://github.com/tianshu-ai/tianshu/commit/9cbff54ab72f15ce9e7892f8fcc76fbb617a78f3))
* A2A message card theme adaptation + markdown rendering ([88126df](https://github.com/tianshu-ai/tianshu/commit/88126dfe9e69bf4ea010701f75744968b7a1ab02))
* A2aMessageCard use accent tokens + fix markdown spacing ([e6a27bf](https://github.com/tianshu-ai/tianshu/commit/e6a27bf990a37994bbb578e36a5db6977ee1294f))
* add left accent border to A2A message cards ([c81fd16](https://github.com/tianshu-ai/tianshu/commit/c81fd163ff360b9515ca2e1dcae87a172db8cee8))
* add Send icon to plugin icon whitelist ([648dc01](https://github.com/tianshu-ai/tianshu/commit/648dc01c264498b24b984261cc64652324a9df6f))
* agent-card GET fallback to any card when user-specific not found ([5509f4e](https://github.com/tianshu-ai/tianshu/commit/5509f4edec30c6be511fd6c978252f2eb83fc225))
* Bearer header secret masking corruption - use string concat ([c30ea60](https://github.com/tianshu-ai/tianshu/commit/c30ea608e06da94bc5c2b0ffebbeac5c7a12dadd))
* broadcast messenger_changed on send/receive for real-time list update ([9285831](https://github.com/tianshu-ai/tianshu/commit/928583173716aa5b0c36ca9a3a40e32e7e3d193b))
* communication token no practical expiry (100y), security by scope only ([c538c92](https://github.com/tianshu-ai/tianshu/commit/c538c92323aeead4ba41627a1cf1d1f954840733))
* context menu uses theme-aware bg color on classical theme ([a69b80f](https://github.com/tianshu-ai/tianshu/commit/a69b80f23a0fb36317a20f1d0e144be63a565f94))
* dropdown solid bg + rename A2A→Agent + Sparkles icon ([828ba08](https://github.com/tianshu-ai/tianshu/commit/828ba08078a4de74ac31f313d2016925cd9c5995))
* ensure sent message timestamp &lt; reply timestamp in history ([eb8b836](https://github.com/tianshu-ai/tianshu/commit/eb8b8368819b630e2acbe9b5def8e39de09a9190))
* exchange communication token during handshake, replace pairing apiKey ([dac7789](https://github.com/tianshu-ai/tianshu/commit/dac7789a27ba4e7e93aae33888fdf36924614b75))
* expose channels in schedule tool description for task type jobs ([f417641](https://github.com/tianshu-ai/tianshu/commit/f4176414eda4726b910bfb81b83f76b2a8a62685))
* extend A2A fetch timeout to 5min for slow agents ([4aa5a6d](https://github.com/tianshu-ai/tianshu/commit/4aa5a6d72fb5cd1c5a64f5615803c522b6550a90))
* extract A2A reply from artifacts (PSS agent compat) ([1c60f50](https://github.com/tianshu-ai/tianshu/commit/1c60f5064f1717d69a441a2be5a955cb65f94063))
* fallback extract inbox events from text when structured field missing ([9c1fbfc](https://github.com/tianshu-ai/tianshu/commit/9c1fbfc5acc2f3c9ad6e7811b1ae70f18911e790))
* fetch peer agent card with bearer token auth ([8d080b4](https://github.com/tianshu-ai/tianshu/commit/8d080b4206b31493c14478f06f93e2d40886a408))
* fetch peer card via server-side proxy to avoid CORS ([684960f](https://github.com/tianshu-ai/tianshu/commit/684960fb42109b524080c1c3c51627bf4352eb20))
* fetchPeerCard returns full A2A fields + remove endpoint from card UI ([5c583bc](https://github.com/tianshu-ai/tianshu/commit/5c583bc31756db3d6d6fd5aabc79bfa721b887c1))
* fire-and-forget handshake to avoid same-process tenant deadlock ([8bb2a7f](https://github.com/tianshu-ai/tianshu/commit/8bb2a7fd56d3bfbd3a6424f6911439714540b378))
* handle JSON-RPC handshake directly instead of fall-through ([322446c](https://github.com/tianshu-ai/tianshu/commit/322446cae496a85003dbcca0afc73d012de78755))
* hardcode dark bg for contact menu to debug transparency ([b9fdc06](https://github.com/tianshu-ai/tianshu/commit/b9fdc0601245543ae11bc6c8e679d974106114d3))
* i18n for pair agent UI + show target channel for task type cron jobs ([d33d9ee](https://github.com/tianshu-ai/tianshu/commit/d33d9ee16403bc171f3843b1ff47a4b13f436d6b))
* let CSS truncate handle message preview ellipsis instead of JS slice ([c5f0d80](https://github.com/tianshu-ai/tianshu/commit/c5f0d800c7da912a6ce64c361c022af85746c628))
* message history chat bg fills entire modal body (h-full) ([f3e0507](https://github.com/tianshu-ai/tianshu/commit/f3e05071f809e60623f4883fcecd2e65f0a3afb0))
* message history container flex-1 instead of fixed h-96 ([6ca2001](https://github.com/tianshu-ai/tianshu/commit/6ca2001d9be90e88a26a0462ce489bf6730fbc18))
* mint JWT with real userId, remove plaintext uid from URL ([85ed517](https://github.com/tianshu-ai/tianshu/commit/85ed5179aa69d15e66f0eec1ed6488b41faa40b7))
* notify correct user — filter sessions by user_id ([e2cb855](https://github.com/tianshu-ai/tianshu/commit/e2cb8556ef89597679cb05a12fd2a843fd528d95))
* nullify FK references before cascade-deleting channel binding sessions ([ef0284b](https://github.com/tianshu-ai/tianshu/commit/ef0284b9f8f50a5871acd038a0d5eb2773ea507a))
* pairing URL carries userId, _a2a_get_card returns that user's card ([b370169](https://github.com/tianshu-ai/tianshu/commit/b3701691a7f18aa85aa5988e6841847197dded9b))
* pass agentName to A2aMessengerAdapter + improve contact matching ([dcbc798](https://github.com/tianshu-ai/tianshu/commit/dcbc798799389fed940c3800ba743007228c50aa))
* pass userId to notifyA2a in JSON-RPC receive path ([56ea689](https://github.com/tianshu-ai/tianshu/commit/56ea689e6b80ed82e90e2dfeb4bec1bc88857efd))
* remove agent-card fallback, fetch peer card via _a2a_get_card ([e52409c](https://github.com/tianshu-ai/tianshu/commit/e52409cb5b3279f3da3a04c32482c00e4dc9513a))
* replace Google Fonts with loli.net mirror for China access ([2123c0d](https://github.com/tianshu-ai/tianshu/commit/2123c0db198e5f8f1a6002743e86f25835d51f42))
* resolve localhost endpoints to LAN IP for cross-machine A2A ([b4f16f1](https://github.com/tianshu-ai/tianshu/commit/b4f16f1ee6722d172254abe7ff148f48cad1fd4a))
* restore Bearer ${cfg.apiKey} template literal (was corrupted to literal ***) ([bafd769](https://github.com/tianshu-ai/tianshu/commit/bafd769860263dfa43e647e2b9e0795c3a71bd4b))
* scope a2aReceive contact search by JWT userId ([829ab21](https://github.com/tianshu-ai/tianshu/commit/829ab21832a41a1ab7042d0500f8d5adce2eb93e))
* send_message card uses accent tokens + MarkdownBlock for consistency ([96e0f5d](https://github.com/tianshu-ai/tianshu/commit/96e0f5d34a655808aa4a952e635bd239974a3d13))
* stop propagation on contact menu backdrop to prevent history popup ([78b405e](https://github.com/tianshu-ai/tianshu/commit/78b405e2ebcff5eca382bd9b056e01e629e0a1df))
* store handshake grant token in comm_tokens + fix token=*** corruption ([c9cc317](https://github.com/tianshu-ai/tianshu/commit/c9cc31726d595e66cc5b4967508aa80272e5bc50))
* true fire-and-forget - don't await fetch at all ([dace315](https://github.com/tianshu-ai/tianshu/commit/dace3153a0fc227af4be36ed67a758c3247bd43f))
* use A2A v1.0 standard path /.well-known/agent-card.json + legacy fallback ([74738f4](https://github.com/tianshu-ai/tianshu/commit/74738f4b7ba41ee5c73a5cf6cc05e4e726588bc3))
* use bg-surface (opaque) for all popover/dropdown backgrounds ([b72857f](https://github.com/tianshu-ai/tianshu/commit/b72857f4146b4eb566f59a4cec8ff42c5d1e3842))
* use comm token mapping to identify A2A sender (not senderName) ([9999c15](https://github.com/tianshu-ai/tianshu/commit/9999c151f810e9fffc057191d3b85520e7c0c650))
* use correct column names for messenger_messages INSERT (text not body) ([d9c128c](https://github.com/tianshu-ai/tianshu/commit/d9c128c6cd6d8d5e2ad25091e08b2d2c92439e66))
* use inline style for contact menu background (Tailwind v4 var issue) ([9c57b63](https://github.com/tianshu-ai/tianshu/commit/9c57b63023db42e494094b1339fce4d56380e5e6))
* use lowercase 'user' role per A2A spec (Python SDK compat) ([65802d3](https://github.com/tianshu-ai/tianshu/commit/65802d39f3a3b067f7f5f19e4c939485aae23c0b))


### Refactor

* clean A2A adapter - raw fetch with proper reply extraction ([1a6b8cb](https://github.com/tianshu-ai/tianshu/commit/1a6b8cb341310bb56f36ae6d90b4021467859b44))
* host.bridgeToken → host.tokenMint (generic scoped token capability) ([38e99b0](https://github.com/tianshu-ai/tianshu/commit/38e99b040e4e5be19e00249213b99cde00c25861))
* redesign messenger panel — Telegram-style polish ([2e41156](https://github.com/tianshu-ai/tianshu/commit/2e4115692e5066337d743844ac48b5e535fe657b))
* scope all messenger data to user level (user_id) ([3a1647e](https://github.com/tianshu-ai/tianshu/commit/3a1647eaac71eccb020e62f5235a1189d60ab2f3))
* SDK for both request construction and response parsing ([fe7f0a0](https://github.com/tianshu-ai/tianshu/commit/fe7f0a0d9047db06ed5272be42f9c914d8290fe6))
* use @a2a-js/sdk Task/Message.fromJSON for response parsing ([816f192](https://github.com/tianshu-ai/tianshu/commit/816f192a81c45e04366a592a23d951ab57d53d05))

## [0.95.0](https://github.com/tianshu-ai/tianshu/compare/v0.94.0...v0.95.0) (2026-10-14)


### Features

* **messenger:** add rebind flow for token-expired wechat contacts ([f8c0cb4](https://github.com/tianshu-ai/tianshu/commit/f8c0cb4d90dda86654539d27e89bee33e7444099))
* **messenger:** auto-disable wechat contact on stale token ([121dff3](https://github.com/tianshu-ai/tianshu/commit/121dff388eda2dfd8a2a31f18692b0d644c3c142))
* **messenger:** rebind flow with activating phase matching add flow ([fcee088](https://github.com/tianshu-ai/tianshu/commit/fcee08816da7c1f6ab65412d03365c8c6f9bb0a6))
* **messenger:** show token-expired badge on auto-disabled contacts ([c0c9f67](https://github.com/tianshu-ai/tianshu/commit/c0c9f67d11d530ea6b4fb23069d7571bbff438aa))
* **workboard:** add notify_channels for multi-channel task completion delivery ([9725d99](https://github.com/tianshu-ai/tianshu/commit/9725d99591b2d1ac7a685da24c48e28687ff5707))


### Bug Fixes

* **messenger:** register rebind route in manifest and fix client URL ([61ffd88](https://github.com/tianshu-ai/tianshu/commit/61ffd88c1780ee7d5bf6c28dcbaca21233771c0d))
* **messenger:** remind user to send message after rebind ([d94120f](https://github.com/tianshu-ai/tianshu/commit/d94120f0c5e04b2926731f854237ef2790af5fb0))
* **messenger:** use QrCanvas for rebind QR display ([d4ae08a](https://github.com/tianshu-ai/tianshu/commit/d4ae08a4c5285dbcce69050c855ca1e4285ce13c))
* **workboard:** clean up task detail card UI ([8387113](https://github.com/tianshu-ai/tianshu/commit/8387113db84cc49ad8ef71e004afb87fca598018))
* **workboard:** default notifyChannels to webchat in UI and REST create ([f792bc3](https://github.com/tianshu-ai/tianshu/commit/f792bc3ca016cab6e41d17be986a55101c3e60cc))
* **workboard:** improve notifyChannels badge contrast for light theme ([0623d58](https://github.com/tianshu-ai/tianshu/commit/0623d5843e85d73205fb69645551ea45b2780f86))
* **workboard:** include notifyChannels in taskJson API response ([b57d084](https://github.com/tianshu-ai/tianshu/commit/b57d084e2610a89a7ed3a1a1bdd3728a5210acb4))
* **workboard:** inline channel icon with task title text ([1affaf9](https://github.com/tianshu-ai/tianshu/commit/1affaf943efe85aa11d425eba5dadc13beb1477d))
* **workboard:** move channel icon to left of task title ([bcfd023](https://github.com/tianshu-ai/tianshu/commit/bcfd0236ff5460c504c95524835a68e5b0ea15a6))
* **workboard:** remove duplicate notifyChannels in taskJson ([132f65f](https://github.com/tianshu-ai/tianshu/commit/132f65f3d0e155a02e06273ea822dd288ac6a8bb))
* **workboard:** replace text badges with channel icons on task cards ([3eb7519](https://github.com/tianshu-ai/tianshu/commit/3eb7519984c3ce0297128849fc8eb969d0466186))
* **workboard:** simplify channel icon to pure inline SVG ([60ba508](https://github.com/tianshu-ai/tianshu/commit/60ba508d3ef24cca67503c217f441cc0f1191d5b))

## [0.94.0](https://github.com/tianshu-ai/tianshu/compare/v0.93.1...v0.94.0) (2026-10-14)


### Features

* **cron:** multi-channel delivery for scheduled messages ([#593](https://github.com/tianshu-ai/tianshu/issues/593)) ([18c8bbf](https://github.com/tianshu-ai/tianshu/commit/18c8bbfb4a39500dcb3260f902da08bfa13bf188))
* messenger plugin — outbound WeChat notifications ([#594](https://github.com/tianshu-ai/tianshu/issues/594)) ([edf2f49](https://github.com/tianshu-ai/tianshu/commit/edf2f49c2fbbe7149f7a5c967b18eb82a84e01d0))
* notify agent on contact changes via sessionInbox ([8dd53b5](https://github.com/tianshu-ai/tianshu/commit/8dd53b586dc5df5e715183307972f38525dae75f))


### Bug Fixes

* **messenger:** add notifyAgent to QR login create path ([cf944ea](https://github.com/tianshu-ai/tianshu/commit/cf944eae9756f89e5c38e294a099ef82e107eef4))
* **messenger:** find session without channel_id filter ([4269971](https://github.com/tianshu-ai/tianshu/commit/4269971b0d50f331bf2a5835d09f4f538eee026e))
* **messenger:** fix syntax error from extra brace ([89f9361](https://github.com/tianshu-ai/tianshu/commit/89f9361450473de6cbb56addb2ba0f9caf03d20e))
* **messenger:** fix TS error in activate catch block ([ab3137a](https://github.com/tianshu-ai/tianshu/commit/ab3137a3d17306416bd0519e1c31e574bf7bb893))
* **messenger:** notify before activate to prevent exception swallowing ([bb62395](https://github.com/tianshu-ai/tianshu/commit/bb6239536e5ee1b0478ccdd51220e8f9d869d12d))
* **messenger:** simplify activate catch block for TS compat ([7a876c5](https://github.com/tianshu-ai/tianshu/commit/7a876c51ce6ae5ebc14669ae2267ed079dee6f79))
* **server:** idle-runner persists messages to wrong session ([#591](https://github.com/tianshu-ai/tianshu/issues/591)) ([1b67671](https://github.com/tianshu-ai/tianshu/commit/1b6767110fda7459803b9dca508f3098717506cd))
* topological sort in run-builtin-script for cross-plugin deps ([ca3596e](https://github.com/tianshu-ai/tianshu/commit/ca3596eb8a446d3f977738496fd5293bcb555f91))
* **web:** spurious notification on server restart + add viewingChannelId ([a046820](https://github.com/tianshu-ai/tianshu/commit/a04682088880e0c79c41466a17fbee11bface435))
* **web:** unify webchat row style with channel session rows ([e7467cd](https://github.com/tianshu-ai/tianshu/commit/e7467cd20cb5b4983eca8598821fef462b7d2ee4))
* **web:** use lucide icons for channel rows in sidebar ([3407d56](https://github.com/tianshu-ai/tianshu/commit/3407d56264320d19972cac9a65ac44d51a7c39f3))

## [0.93.1](https://github.com/tianshu-ai/tianshu/compare/v0.93.0...v0.93.1) (2026-10-12)


### Bug Fixes

* **deps:** update runtime dependencies ([60c19c7](https://github.com/tianshu-ai/tianshu/commit/60c19c7ab08bd39be70bd99705942355663f668a))

## [0.93.0](https://github.com/tianshu-ai/tianshu/compare/v0.92.0...v0.93.0) (2026-10-12)


### Features

* **web:** browser desktop notifications + tab title flash on reply complete ([#589](https://github.com/tianshu-ai/tianshu/issues/589)) ([76b708e](https://github.com/tianshu-ai/tianshu/commit/76b708ea24c548c776998ebeada9683d69af0406))


### Bug Fixes

* **server:** update compact.test.ts for MIN_MESSAGES_TO_COMPACT=10 and 3000-char tool result limit ([dfed3c4](https://github.com/tianshu-ai/tianshu/commit/dfed3c4f6372d8c48d4bb617571825b02d241e78))

## [0.92.0](https://github.com/tianshu-ai/tianshu/compare/v0.91.0...v0.92.0) (2026-10-11)


### Features

* compaction model picker in Settings UI ([460e974](https://github.com/tianshu-ai/tianshu/commit/460e97470957e12aceb826c9e16031b2a19025dc))
* **server/web:** follow_up ack + automatic upgrade to prompt on failure ([65f9dd2](https://github.com/tianshu-ai/tianshu/commit/65f9dd258818fcd90ec3766817e99b61083878f3))
* **server:** configurable compaction model via models.compaction.model ([cfe9e5b](https://github.com/tianshu-ai/tianshu/commit/cfe9e5bd484f45e59c52d065f1dd077e57e8baa3))
* **server:** follow_up aborts current turn and restarts as new prompt ([cd798e7](https://github.com/tianshu-ai/tianshu/commit/cd798e78fb0286ec9314a2019bc308644777eaa4))
* **server:** force refresh summaries with recall-anchored format ([985f869](https://github.com/tianshu-ai/tianshu/commit/985f8695bd2744474b682e14b313bd1ead33a4ea))
* **server:** improve compact summary quality ([d932dd5](https://github.com/tianshu-ai/tianshu/commit/d932dd5dfb9b9f22fd9f1474d204a8732431fcb4))
* **server:** recall links in every compact summary section ([e7345e2](https://github.com/tianshu-ai/tianshu/commit/e7345e2773eff981c6585de3384f07d73749ba4c))
* **server:** recall-aware compact summaries with turn anchors ([8bca74f](https://github.com/tianshu-ai/tianshu/commit/8bca74fbece091c3d56ac56d48acc07950690694))
* **server:** sequential segment summarisation with cross-segment context ([c65cb43](https://github.com/tianshu-ai/tianshu/commit/c65cb43af8eefffed3f9cfbb8d420a3ba0c20e84))
* **server:** setup agent uses DB turn_number for recall_range links ([afd8f4b](https://github.com/tianshu-ai/tianshu/commit/afd8f4ba506aa2a082d214f309ad7b022b598f6e))
* **server:** structured compact summary format — Decisions/TODOs/Constraints/Recall ([c4be406](https://github.com/tianshu-ai/tianshu/commit/c4be406680b7ff03ca053f8c02bf823afcf498c4))
* **skills:** template variable support for plugin skills ([11be454](https://github.com/tianshu-ai/tianshu/commit/11be454695568047cda4f467c5d8e279f30e23e0))


### Bug Fixes

* correct prepare&lt;&gt; type params for fork_tail INSERT (TS2554) ([2df83a5](https://github.com/tianshu-ai/tianshu/commit/2df83a5e5a7415ef5485ecae2b405d00ee92dd72))
* **server:** /compact respects models.compaction.model + add diagnostic logs ([b3f9d9a](https://github.com/tianshu-ai/tianshu/commit/b3f9d9abec03d368d846d6028f3800ff440a649a))
* **server:** compact fork ordering — summary before tail, tail marked fork_tail ([e698c1b](https://github.com/tianshu-ai/tianshu/commit/e698c1b38df7f2f78ec3b880cef0d158dc04b784))
* **server:** compact tail respects turn boundaries and config keepRecentTokens ([32a93dc](https://github.com/tianshu-ai/tianshu/commit/32a93dcf30b95a8882c033a77f88bd424c2c411c))
* **server:** compact.ts summary before tail ordering in all fork paths ([8bc846c](https://github.com/tianshu-ai/tianshu/commit/8bc846c6d7f51854ef50138ba1d3b5f57478dc42))
* **server:** don't persist empty failed/aborted assistant messages ([be048c0](https://github.com/tianshu-ai/tianshu/commit/be048c0755d33e24113b6618db718985f625e691))
* **server:** dynamic keepTail based on token budget instead of fixed 100 ([40f7876](https://github.com/tianshu-ai/tianshu/commit/40f7876bf5a09d33e8dcca84e5b615bf0bac05e5))
* **server:** fork phase reads compaction config for model/keepRecentTokens ([91af598](https://github.com/tianshu-ai/tianshu/commit/91af5985725710b3750976dce35fb4f414b2b6bb))
* **server:** planCompact fallback when only user msg is at position 0 ([10a0cf6](https://github.com/tianshu-ai/tianshu/commit/10a0cf6a52dd7d66f361f62b9a3fb7917850c83d))
* **server:** prevent re-compacting freshly forked sessions ([3a05fef](https://github.com/tianshu-ai/tianshu/commit/3a05fef9b835345a193786ac8be46b100b9de6bd))
* **server:** repair zombie operations from interrupted tool calls ([fa032b8](https://github.com/tianshu-ai/tianshu/commit/fa032b814c022d78fd39cf5003f1328a55c521f9))
* **server:** strip empty assistant msgs + orphaned toolResults before provider call ([00a0a42](https://github.com/tianshu-ai/tianshu/commit/00a0a4268f4cdc0f9e3a8f5adf6133ed9576d86a))
* **server:** use fresh timestamps for fork summary + tail messages ([b8f1fec](https://github.com/tianshu-ai/tianshu/commit/b8f1fec051cd7bbe589a48cfa355131e8a35e756))
* **server:** worker agent-loop passes compactionSettings to tryAutoCompact ([71bb3d3](https://github.com/tianshu-ai/tianshu/commit/71bb3d34ae14ddbdbd5437f8283cebde9ad4d38a))
* **web:** ContextRing use totalTokens-output for context % with prompt caching ([d86e3a8](https://github.com/tianshu-ai/tianshu/commit/d86e3a818d11d4320eaf32efe4ee7caf23c0e529))
* **web:** Modal panel use opaque bg-bg-surface instead of transparent bg-bg-elevated ([5c1e6b4](https://github.com/tianshu-ai/tianshu/commit/5c1e6b4b0764028a2dcbc2452a7100af9a85615c))
* **web:** opaque bubble backgrounds in ExecutionDialog for all themes ([d8b3148](https://github.com/tianshu-ai/tianshu/commit/d8b3148e1f4d9e18c1b6555de08695a6f2a6577e))
* **web:** remove hardcoded dark bg from ContextRing popover ([1cb7836](https://github.com/tianshu-ai/tianshu/commit/1cb783657c81b0d58449eea197f18b422493344e))
* **web:** scroll to bottom after edit/resend ([888a01b](https://github.com/tianshu-ai/tianshu/commit/888a01b043df35c0010072e46c62835d8d34f51b))


### Documentation

* **workboard:** add opencode + claude-code to worker-creator skill ([310c45c](https://github.com/tianshu-ai/tianshu/commit/310c45c5e8b615ad2990bb03ce2376d070a52002))
* **workboard:** clarify echo kind is dev/test only ([ac202a2](https://github.com/tianshu-ai/tianshu/commit/ac202a2503680880e25453d4dc31662c196bd5be))
* **workboard:** clarify modelId semantics per worker kind ([74a2ca3](https://github.com/tianshu-ai/tianshu/commit/74a2ca3c4d7057efa2827e401cc1064de83cd876))


### Refactor

* **server:** cross-chain summarisation — fill model context from all sessions ([ff8baaa](https://github.com/tianshu-ai/tianshu/commit/ff8baaa425995f5b69aac15de2fbfb4cd12ac9de))

## [0.91.0](https://github.com/tianshu-ai/tianshu/compare/v0.90.1...v0.91.0) (2026-10-10)


### Features

* remove opencode worker and proxy infrastructure ([#579](https://github.com/tianshu-ai/tianshu/issues/579)) ([4c504e4](https://github.com/tianshu-ai/tianshu/commit/4c504e4fdae7c8306e53eb8b69f41d6d5d6703df))


### Bug Fixes

* handle empty toolCallId and OpenAI-format orphan errors ([1cd3d0c](https://github.com/tianshu-ai/tianshu/commit/1cd3d0c551a69f1e44901e04309fb9b86c2a0236))

## [0.90.1](https://github.com/tianshu-ai/tianshu/compare/v0.90.0...v0.90.1) (2026-10-09)


### Bug Fixes

* compact kept tail copies by turn boundary, not message count ([ba4954d](https://github.com/tianshu-ai/tianshu/commit/ba4954deaaf56a4de57abda137332f7b091222c1))
* drop orphan toolResult by matching tool_call ids ([06cc8f6](https://github.com/tianshu-ai/tianshu/commit/06cc8f62707283431bd235877375c439b71cc324))

## [0.90.0](https://github.com/tianshu-ai/tianshu/compare/v0.89.0...v0.90.0) (2026-10-09)


### Features

* ContextRing shows auto-compact threshold marker ([89d782b](https://github.com/tianshu-ai/tianshu/commit/89d782b38ef8a16357e7bcdda4767e28ac74f146))


### Bug Fixes

* ContextRing uses totalTokens instead of input tokens ([fb1c9dd](https://github.com/tianshu-ai/tianshu/commit/fb1c9dddd20e7ce3bb829acf94a50030c2a4f68e))
* fork_tail messages visible to pi harness + agent context ([ef71dec](https://github.com/tianshu-ai/tianshu/commit/ef71dec67691d173f90e687fdabc589b82f17bd9))
* lower default triggerPercent from 80 to 60 ([e044da1](https://github.com/tianshu-ai/tianshu/commit/e044da158da3244ce493116dd60d5b9ae15eeaa6))
* setup agent system prompt includes triggerPercent for compaction ([f5f8630](https://github.com/tianshu-ai/tianshu/commit/f5f8630e0bd319a7cfbb1a6cc3323b33c3163569))

## [0.89.0](https://github.com/tianshu-ai/tianshu/compare/v0.88.0...v0.89.0) (2026-10-09)


### Features

* follow-up messages during active agent turn ([309186a](https://github.com/tianshu-ai/tianshu/commit/309186a3dc711e32b67ab3e97d7787dae3357baa))
* workboard execution dialog — worker name + main UI tool call style ([5cafee1](https://github.com/tianshu-ai/tianshu/commit/5cafee116ff8bafb7bffbd88c1dfe87df1378538))
* workboard execution dialog matches main chat UI style ([cd97076](https://github.com/tianshu-ai/tianshu/commit/cd970765c7daeb7489700d510a216e0436e3e23f))
* workboard ExecutionTurn uses MarkdownBlock for assistant text ([a9917bc](https://github.com/tianshu-ai/tianshu/commit/a9917bc5783f49b459aa1a6f7e6902ad972b573a))


### Bug Fixes

* compact button sends "prompt" not "user_message" ([956b88d](https://github.com/tianshu-ai/tianshu/commit/956b88dfc36bbd9915788e053565cc440fc7e11f))
* compact button uses sendPrompt for proper UI feedback ([1c552f0](https://github.com/tianshu-ai/tianshu/commit/1c552f0dd90c4701ef919cace139ee5debfb3398))
* compact divider detects user role + passes modelId + hides ack ([aad00c2](https://github.com/tianshu-ai/tianshu/commit/aad00c25d3060b1c5589acde890bfbd730adfeb6))
* compact fork — summary as assistant role, no ack, preserve created_at ([af46dea](https://github.com/tianshu-ai/tianshu/commit/af46deaeb2413874a32a64e6b958bd9cd48f056f))
* compacting blocks input with overlay + disabled textarea ([8f90667](https://github.com/tianshu-ai/tianshu/commit/8f906678b2b66db0df27f7eb877ff3af960fd1dc))
* ContextRing hooks order — move all hooks before early return ([ef32227](https://github.com/tianshu-ai/tianshu/commit/ef3222795df4e70fc4edea50b9f802a112e69c3c))
* dedup fork tail — active session wins, compacted copy hidden ([7aacbb6](https://github.com/tianshu-ai/tianshu/commit/7aacbb6049cb602347aed3b59fb2f5c8c67de05e))
* dedup fork tail messages by role+content across sessions ([31e54d6](https://github.com/tianshu-ai/tianshu/commit/31e54d6da97a68bc56de7d456aff6db3f888ba07))
* follow-up duplicate messages + JSON user bubble ([48a7293](https://github.com/tianshu-ai/tianshu/commit/48a7293962319c5f9b786786ab4478bd855d8983))
* follow-up send button replaces stop button ([60c6e12](https://github.com/tianshu-ai/tianshu/commit/60c6e12f9506da17ad79461980597bf502487656))
* manual /compact uses forkWithSummary for session fork ([25bc133](https://github.com/tianshu-ai/tianshu/commit/25bc1333e3c70b2998406ecc09fb62fe01517539))
* mark fork-tail messages with entry_type=fork_tail, skip in queries ([b7e3c68](https://github.com/tianshu-ai/tianshu/commit/b7e3c683d9807e7b1dde2ffd5995f978621b90d0))
* persist compact summary as visible message for divider ([1a90004](https://github.com/tianshu-ai/tianshu/commit/1a900042f55094325a23ed4bfe89526c5be33b04))
* prevent compact summary from being merged into previous turn ([d51220d](https://github.com/tianshu-ai/tianshu/commit/d51220d911463e9c925108886f5edb82d7435306))
* reset isCompacting on WS reconnect (tenant switch) ([2d3229f](https://github.com/tianshu-ai/tianshu/commit/2d3229fb422c20bbfc2cf6a2fcaba3dde236be5b))
* runManualCompact uses compactSession instead of pi lane.compact ([72d45d7](https://github.com/tianshu-ai/tianshu/commit/72d45d7f044cd93d51e670c9108c2b4922061af5))
* stop copying kept tail on fork — no more duplicates ([3fbdc80](https://github.com/tianshu-ai/tianshu/commit/3fbdc80da4b1cbec1f3b90b97270b0fc1ca74aeb))
* workboard execution Bot icon matches sidebar style ([5509e84](https://github.com/tianshu-ai/tianshu/commit/5509e843f8c3bffb685afb25d0092f19be9ddf2d))
* workboard execution uses Bot icon instead of tianshu avatar ([779ad5f](https://github.com/tianshu-ai/tianshu/commit/779ad5f74937b874a0c5fd9fd357c180804c20f1))
* workboard execution uses sidebar kindEmoji icon ([5561a93](https://github.com/tianshu-ai/tianshu/commit/5561a93a2b54c011968f646d80aafe1550b9c3a1))

## [0.88.0](https://github.com/tianshu-ai/tianshu/compare/v0.87.1...v0.88.0) (2026-10-09)


### Features

* auto-select fast model for compact summarisation ([7b46620](https://github.com/tianshu-ai/tianshu/commit/7b46620e30d7caf74b25a4153d96acff047c6665))
* compact_session reverse phase — undo fork and restore session ([e00b5cf](https://github.com/tianshu-ai/tianshu/commit/e00b5cfdc68f6a6af72409b8698e356e99d57875))
* context usage ring in ChatInput ([4915c5f](https://github.com/tianshu-ai/tianshu/commit/4915c5f22e01fb9db8e781885db978c6fd560936))
* doctor session health check + compact_session setup tool ([e1606b7](https://github.com/tianshu-ai/tianshu/commit/e1606b7c4b10d56103c9d1325db8c9bfd9e8f24a))
* dynamic segment size based on model context window ([ab8e998](https://github.com/tianshu-ai/tianshu/commit/ab8e998ef1861d4789017107c7e173a1ebe0905a))
* hide edit button on compacted session messages ([293e93b](https://github.com/tianshu-ai/tianshu/commit/293e93b31b6053cb5776317bf0529c1bbfa8fa6f))
* multi-level session splitting for oversized compaction ([d5ec71a](https://github.com/tianshu-ai/tianshu/commit/d5ec71a79fe51861651fa637c5c4b0db6b877272))
* parallel segment summarisation (5 concurrent) ([917ffb1](https://github.com/tianshu-ai/tianshu/commit/917ffb1c254501b4c9a0cabd0ff00d8d0b48677b))
* publish-next CI job + promote workflow ([8473b7f](https://github.com/tianshu-ai/tianshu/commit/8473b7f8e97a4b48ef8c58eeef1bdc20f3d4f2e0))
* render compact summary as divider line in chat UI ([e75cb73](https://github.com/tianshu-ai/tianshu/commit/e75cb73b26f869c4db55d5ebc3bd8e711778e888))
* render compaction markers as divider lines in chat UI ([86f8d30](https://github.com/tianshu-ai/tianshu/commit/86f8d303dc6547b7cfe571e96cc90500d592680a))
* segment summarise checkpoint/resume support ([79a3e98](https://github.com/tianshu-ai/tianshu/commit/79a3e98d4b1ae3c9f70e6f127152f408d9473e56))
* two-phase compact — instant fork + async LLM summary ([3daac1a](https://github.com/tianshu-ai/tianshu/commit/3daac1ac374f72756c4483e9936dfa11f271f333))


### Bug Fixes

* agent-loop test mock targets pi-compat barrel, not pi-agent-core ([962f59b](https://github.com/tianshu-ai/tianshu/commit/962f59b664d35e8740ad8ace3e2dccf746dfbf81))
* cap initial message loading to prevent context overflow ([569d15a](https://github.com/tianshu-ai/tianshu/commit/569d15a83516b2322236891c0e3f17b476dbb0ce))
* compact_session summarise uses resolveTenantConfig for model lookup ([f61ca3e](https://github.com/tianshu-ai/tianshu/commit/f61ca3e2935854c213e2506779c5cf88be0f0467))
* config_write uses deep merge to prevent dropping nested keys ([aa3180a](https://github.com/tianshu-ai/tianshu/commit/aa3180a743950b5f0ca5cbd29c74e5168a0c3b77))
* context ring uses fg-muted color matching model selector ([8dcc741](https://github.com/tianshu-ai/tianshu/commit/8dcc741b0b58088ab143839a5639d505e16f8afb))
* correct summarisedCount — use retainedTail length from compact result ([9156f6e](https://github.com/tianshu-ai/tianshu/commit/9156f6e0d9a395b1e21e1b0c8be1eb92957a25ae))
* deduplicate fork-copied messages in history pagination ([3d4e42b](https://github.com/tianshu-ai/tianshu/commit/3d4e42be1c38429537db60342cd051e5b56e9213))
* don't write compaction entry to pi-compat storage ([da94303](https://github.com/tianshu-ai/tianshu/commit/da94303bb58bb07646e9aef1a57199f1257571f6))
* edit_resend uses the currently selected model ([d5a15f1](https://github.com/tianshu-ai/tianshu/commit/d5a15f1102492f0d730e39b081902b81766aaf23))
* emit compaction_start/end events for frontend notification ([ff17930](https://github.com/tianshu-ai/tianshu/commit/ff17930e18d56cd152ffcaf6947bcfef9913fb6c))
* empty persisted assistant rows render nothing, not typing-dots ([02e32a6](https://github.com/tianshu-ai/tianshu/commit/02e32a679225a55e3cf3312abfbcdcb8f5f4d232))
* filter out system messages from persistence and display ([b4fc43f](https://github.com/tianshu-ai/tianshu/commit/b4fc43f4895e6c24b8fd2596f3fa37c588241778))
* hide compaction markers from chat UI message queries ([66739df](https://github.com/tianshu-ai/tianshu/commit/66739df20c4892c37998f44ec8486ef930167ea2))
* history page includes compacted session messages ([66ec303](https://github.com/tianshu-ai/tianshu/commit/66ec3039bd88b211a4577d44eae3cb5d0952566a))
* i18n for context ring (en/zh/de) ([64ea90a](https://github.com/tianshu-ai/tianshu/commit/64ea90aa25a830ed272ebf389658f79985d4456e))
* implement real compact() in harness adapter ([28ccef7](https://github.com/tianshu-ai/tianshu/commit/28ccef77994675b452e31d487ba53ef8533cdcbc))
* load messages from last compaction point, not full history ([d31d982](https://github.com/tianshu-ai/tianshu/commit/d31d9820eae277b415d0f238084a525df2ba9499))
* move compactedThisSession flag to harness adapter level ([1650833](https://github.com/tianshu-ai/tianshu/commit/16508336938f0ab9f5358f73e9c5e29d5f8b5a02))
* persist compaction marker to DB for restart survival ([81c7f84](https://github.com/tianshu-ai/tianshu/commit/81c7f842e347ca00cd4afba60b1f02a899c59274))
* persist user messages and tool results to storage ([86e073e](https://github.com/tianshu-ai/tianshu/commit/86e073eeaf4a8b2881c8e6bb745b5c0e1bfe1482))
* prevent double-compact in same harness lifetime ([93fb4dd](https://github.com/tianshu-ai/tianshu/commit/93fb4ddcc7947f9eb0dd5fd4b71b07d6f92fbcce))
* reject edit_resend on compacted session messages ([cb20e1a](https://github.com/tianshu-ai/tianshu/commit/cb20e1ae60a15fc33a0798ae78ba39624e8b6672))
* remove compaction notification events from chat ([880b68a](https://github.com/tianshu-ai/tianshu/commit/880b68a4e98bcd9dc4681ed31412808e6884455a))
* remove post-compaction system_note notification ([b120f34](https://github.com/tianshu-ai/tianshu/commit/b120f34cabcbc6e1765f365f33cea99cc822a32d))
* reverse deletes child sessions leaf-first to avoid FK violations ([10ef080](https://github.com/tianshu-ai/tianshu/commit/10ef08047dbb59c0becfa13699210be57c159b76))
* revert [#9](https://github.com/tianshu-ai/tianshu/issues/9)/[#10](https://github.com/tianshu-ai/tianshu/issues/10) double-write — Agent already persists via message_end ([eda4d78](https://github.com/tianshu-ai/tianshu/commit/eda4d78486678d848ebec48fde8da74549e6d0f6))
* segment size estimation uses transcript sample, not raw content ([42d7e2d](https://github.com/tianshu-ai/tianshu/commit/42d7e2d3e337d0e1373fb0ae1a5f6ccfe86e0e75))
* segment summarise error handling — retry + partial success ([a69ae09](https://github.com/tianshu-ai/tianshu/commit/a69ae09454b3e67037b33e0c51fe3396aa284132))
* session health check uses compaction config, not hardcoded threshold ([33e09b9](https://github.com/tianshu-ai/tianshu/commit/33e09b9b2b59f4f923614f6fc0c394f3a2e35301))
* summary message uses assistant role, not user ([6075f89](https://github.com/tianshu-ai/tianshu/commit/6075f89a3389f8ac109a1d84b46102be4c8c7f17))
* use actual summarisedCount from compact result, not DB total ([f4d3d30](https://github.com/tianshu-ai/tianshu/commit/f4d3d30eb30828ba27bbdbef6ff5f5d809c1be76))
* use correct column names in session health check query ([454deff](https://github.com/tianshu-ai/tianshu/commit/454deff0f2fce39cd5ce82c789c449c954fc4e1b))
* wire toProviderMessages as convertToLlm, not transformContext ([5e0941f](https://github.com/tianshu-ai/tianshu/commit/5e0941fde3b9ff16411e739e8833da96ca10dcb7))


### Documentation

* compact_session tool warns to use fast model for summarise ([0633c6f](https://github.com/tianshu-ai/tianshu/commit/0633c6fb8df67c9421ec7558b7b6569809c520d5))


### Refactor

* restore fork-based compaction (same as v0.86.2) ([660ec4d](https://github.com/tianshu-ai/tianshu/commit/660ec4d3c429093e524c8df9ab62eae72105b5eb))

## [0.87.1](https://github.com/tianshu-ai/tianshu/compare/v0.87.0...v0.87.1) (2026-10-08)


### Bug Fixes

* wire toProviderMessages into Agent transformContext ([1c30f5f](https://github.com/tianshu-ai/tianshu/commit/1c30f5f7716b6f03da104285266d9aeb4290c961))

## [0.87.0](https://github.com/tianshu-ai/tianshu/compare/v0.86.2...v0.87.0) (2026-10-08)


### Features

* migrate to pi-agent-core 1.0 + pi-ai 1.0 ([#572](https://github.com/tianshu-ai/tianshu/issues/572)) ([f874e5b](https://github.com/tianshu-ai/tianshu/commit/f874e5b8401b3289d5afb6abe63d41ec2f91ccba))

## [0.86.2](https://github.com/tianshu-ai/tianshu/compare/v0.86.1...v0.86.2) (2026-10-08)


### Bug Fixes

* idle-runner uses session's last model + surface errors to chat UI ([8b43679](https://github.com/tianshu-ai/tianshu/commit/8b43679045d5e57f3eafe5078809362cc23c4ae0))
* **tts:** check CUDA availability before using faster-qwen3-tts ([6e55336](https://github.com/tianshu-ai/tianshu/commit/6e553369f3907cec472f2b3fe0fe9a09a65a67f1))
* **tts:** patch MimiConfig.rope_theta for transformers &gt;= 5.15 ([2c12110](https://github.com/tianshu-ai/tianshu/commit/2c121107d4cfecc65b21607f2a2413ae9c3d3d9d))

## [0.86.1](https://github.com/tianshu-ai/tianshu/compare/v0.86.0...v0.86.1) (2026-10-07)


### Bug Fixes

* **tts:** show actionable setup steps when Qwen3-TTS is offline ([5a4c39a](https://github.com/tianshu-ai/tianshu/commit/5a4c39a775ecdc42bf44ecdfc54722f39d5325d0))

## [0.86.0](https://github.com/tianshu-ai/tianshu/compare/v0.85.3...v0.86.0) (2026-10-07)


### Features

* lazy tool loading — tier/group system for on-demand tools ([dfe48b8](https://github.com/tianshu-ai/tianshu/commit/dfe48b835aa75ae1128144ae502f6663a19caf3a))

## [0.85.3](https://github.com/tianshu-ai/tianshu/compare/v0.85.2...v0.85.3) (2026-10-07)


### Bug Fixes

* **workboard:** replace poll-based prompt with push-based task lifecycle ([d460abf](https://github.com/tianshu-ai/tianshu/commit/d460abfc6a9b79a1b7b9603d74a4e8b458b8e1ca))

## [0.85.2](https://github.com/tianshu-ai/tianshu/compare/v0.85.1...v0.85.2) (2026-10-07)


### Bug Fixes

* add diagnostic logs for turn completion events ([0b15ecc](https://github.com/tianshu-ai/tianshu/commit/0b15ecce6d09a0556d15e142614967b4671d04e9))

## [0.85.1](https://github.com/tianshu-ai/tianshu/compare/v0.85.0...v0.85.1) (2026-10-07)


### Bug Fixes

* durable cancellation — use pi-agent-core's two-phase abort ([90fa2b1](https://github.com/tianshu-ai/tianshu/commit/90fa2b1d76818a69e932c65b45a70fb01ca61e6e))

## [0.85.0](https://github.com/tianshu-ai/tianshu/compare/v0.84.0...v0.85.0) (2026-10-07)


### Features

* edit & resend — truncate history from a user message and retry ([db4ee0d](https://github.com/tianshu-ai/tianshu/commit/db4ee0da6e42a83fe62ca65c58d53afb71876708))
* **plugins:** add 'unsupported' state for platform-incompatible plugins ([4faad7c](https://github.com/tianshu-ai/tianshu/commit/4faad7c07da7243d825d0f230a573a941c30d270))

## [0.84.0](https://github.com/tianshu-ai/tianshu/compare/v0.83.0...v0.84.0) (2026-10-06)


### Features

* **plugins:** platform gate — skip plugins on unsupported OSes ([ca749fa](https://github.com/tianshu-ai/tianshu/commit/ca749fa6d3966c1ad8e4962eefc96ed62bac61a4))


### Bug Fixes

* **doctor:** skip sandbox/openshell checks on Windows, add 'info' severity ([4758e02](https://github.com/tianshu-ai/tianshu/commit/4758e02c962035296a19299ac1d7795be9f4ecc7))

## [0.83.0](https://github.com/tianshu-ai/tianshu/compare/v0.82.0...v0.83.0) (2026-10-06)


### Features

* **setup:** Windows service backend via Task Scheduler ([0826055](https://github.com/tianshu-ai/tianshu/commit/0826055aa79fc03add95fc72e8f9bdb3b858073d))


### Bug Fixes

* **windows:** use fileURLToPath instead of URL.pathname for ESM dir resolve ([f2250b1](https://github.com/tianshu-ai/tianshu/commit/f2250b10f14e4c07cc63d182dcc26ef1ebd56cf6))


### Documentation

* **readme:** add Windows install notes — Local Bridge path ([68bbdbb](https://github.com/tianshu-ai/tianshu/commit/68bbdbb8bcf67af323ba8cf44704e1237a262db7))

## [0.82.0](https://github.com/tianshu-ai/tianshu/compare/v0.81.0...v0.82.0) (2026-10-06)


### Features

* **plugins:** declarative tool display formatter ([057251e](https://github.com/tianshu-ai/tianshu/commit/057251ef3302dc77cf2364eacb1422071ea90fec))
* **ui:** built-in tool display defaults for all host tools ([2a67564](https://github.com/tianshu-ai/tianshu/commit/2a6756426c274c3b67908b6984ef087bc91b3aa0))
* **ui:** collapsible long lists in TOON output — …more (N) to expand ([b29e5b8](https://github.com/tianshu-ai/tianshu/commit/b29e5b8025d37fbf3e49fe11ae5a02f1625bc31c))
* **ui:** complete TOOL_MAP coverage — all 80+ tools humanized ([caa03fa](https://github.com/tianshu-ai/tianshu/commit/caa03fa2a25b92a1988ffabed0e4ffccee3998dd))
* **ui:** complete TOOL_MAP coverage for all system tools ([2676f9c](https://github.com/tianshu-ai/tianshu/commit/2676f9c2498f402386623bad222af20231a2c89f))
* **ui:** expand array arguments in tool call inputs ([2fc84f6](https://github.com/tianshu-ai/tianshu/commit/2fc84f62f7f6d1287fec5b7a80aa4faad906064d))
* **ui:** expandable search result snippets — click '…more' to show full text ([aa5ddf7](https://github.com/tianshu-ai/tianshu/commit/aa5ddf74a78cd9ba4529a3320a2331fcbad05325))
* **ui:** file viewer renderer for read/write/edit/delete_file ([3983d80](https://github.com/tianshu-ai/tianshu/commit/3983d807ce31e009b49159e08e54a412aab0cfa4))
* **ui:** humanize toon output — translate keys, format values, hide tech fields ([d572bc9](https://github.com/tianshu-ai/tianshu/commit/d572bc9bc5d3b741d3b9c7df9a4a2b20746e8035))
* **ui:** i18n for TOON key labels — all three languages ([77333cb](https://github.com/tianshu-ai/tianshu/commit/77333cb630f3cb65f8f98d0e54bcde0fc3541ade))
* **ui:** nested TOON path handling — groups, lists, strip spec.* prefix ([885e85b](https://github.com/tianshu-ai/tianshu/commit/885e85b52c520ea0aebab170778fba59dba5120c))
* **ui:** parse TOON format into readable key-value lines ([8102039](https://github.com/tianshu-ai/tianshu/commit/8102039b0110fc17a40569b503731b2fd2c6303f))
* **ui:** recall history now mimics the conversation chat layout ([1987c72](https://github.com/tianshu-ai/tianshu/commit/1987c72935809f685b56d775ade0d52f3fa13309))
* **ui:** recall uses main-chat bubble/tool styles for visual parity ([4210c9f](https://github.com/tianshu-ai/tianshu/commit/4210c9ffd3fe9204b3c9437de7f0cfe224a01bc5))
* **ui:** semantic humanizeArgs for all tool call details ([26afdd0](https://github.com/tianshu-ai/tianshu/commit/26afdd0ae0bfaa4f7ae036a34b18b5de82da320a))
* **ui:** structured file list renderer for list_dir / sync_up / sync_down ([95988d4](https://github.com/tianshu-ai/tianshu/commit/95988d4c5db10e1539b42bc67dfc9ac3254e3b30))
* **ui:** structured recall_range/recall_near renderer with turn grouping ([76e55f1](https://github.com/tianshu-ai/tianshu/commit/76e55f12006d5de8297f8866a2d7c2b3f47f532d))
* **ui:** structured search results for web_search ([0eba3e3](https://github.com/tianshu-ai/tianshu/commit/0eba3e3f7e3eb01236781adc5a79bd5f67711c38))
* **ui:** structured TOON rendering with collapsible long text ([2afa148](https://github.com/tianshu-ai/tianshu/commit/2afa14869a66fb2c9ecd1a72bc3e52bc80bd4619))
* **ui:** wire list_dir to new 'files' format for structured file list ([bd0a3fb](https://github.com/tianshu-ai/tianshu/commit/bd0a3fbb6163882f5dede00394149f513aceb58a))
* **web:** i18n humanizeArgs — toolDetail.* keys for en/zh/de ([b2c2654](https://github.com/tianshu-ai/tianshu/commit/b2c265433b9bf6695b350cffd23ef61d6e50b0a3))


### Bug Fixes

* **server:** add 'files' to toolDisplay output format whitelist ([981daa2](https://github.com/tianshu-ai/tianshu/commit/981daa2390ab88be88c0dafd4627f4620c09926f))
* **ui:** decode base64 as UTF-8 — fixes Chinese garbled text in read_file ([006ce99](https://github.com/tianshu-ai/tianshu/commit/006ce99978694c394ebe693f07d621f65d625f7d))
* **ui:** expand full args in tool call input area, keep humanized short form only for collapsed row ([750f5ec](https://github.com/tianshu-ai/tianshu/commit/750f5ec533b9e62783b30fd3cd83e50fa69e886d))
* **ui:** humanize switch_panel — '切换到知识库面板' not '切换面板: wiki.main' ([de83516](https://github.com/tianshu-ai/tianshu/commit/de8351696321ace24316d82c7b26e5639aa39b65))
* **ui:** inferRender normalize bridge prefix — file viewer now works for bridge tools ([e7806f4](https://github.com/tianshu-ai/tianshu/commit/e7806f4497901429eff1fb30d95acc1a0222d9d7))
* **ui:** non-JSON result text now goes through formatToon ([0eb81c8](https://github.com/tianshu-ai/tianshu/commit/0eb81c8d32a96600473af7c9d40f0e8803e0b1b2))
* **ui:** parse file operation results — decode base64 text content ([fa86203](https://github.com/tianshu-ai/tianshu/commit/fa8620318b4d42d60f0bd77d3cc8452a7b0d4aa7))
* **ui:** raise formatResultText maxLen 4000→20000 ([aa356c0](https://github.com/tianshu-ai/tianshu/commit/aa356c0cdca915642f9aea835be394edc27f3800))
* **ui:** recall merges toolCall + toolResult, splits args per line ([07d8c24](https://github.com/tianshu-ai/tianshu/commit/07d8c245cd5e0ed051bf9cf49ccd75a22accfe72))
* **ui:** recall renders inbox-events marker as EventCard, not raw text ([848183d](https://github.com/tianshu-ai/tianshu/commit/848183dfe3a00fdfe80cf4250dd19973b2b6fabc))
* **ui:** remove built-in toolDisplay overrides, fix result parsing ([4e4e2ce](https://github.com/tianshu-ai/tianshu/commit/4e4e2cecc4638366d9bfe7ff5d63af155d33fd89))
* **ui:** remove formatToon truncation + hide duplicate 'origin'/'editable' fields ([94e122c](https://github.com/tianshu-ai/tianshu/commit/94e122cac6480d11812fb23de0c7cb4b95eb0d0a))
* **ui:** route {ok,text} and {ok,message} through formatToon ([8c36f33](https://github.com/tianshu-ai/tianshu/commit/8c36f33ca6e32e4f0b4116818f96982429c11207))
* **ui:** skip screenshot rendering for file-manifest tools (sync_up/sync_down) ([fde8f8f](https://github.com/tianshu-ai/tianshu/commit/fde8f8f0b770894c51af42dfe0326e713608f326))
* **ui:** strip &lt;system-note&gt; wrapper from recall user turns ([64163f6](https://github.com/tianshu-ai/tianshu/commit/64163f65385539df17c3eb2952dda2bb28a5b957))
* **ui:** strip markdown/HTML noise from search snippets ([a305d52](https://github.com/tianshu-ai/tianshu/commit/a305d522074c84e6cacfa048710994aeaf640595))
* **ui:** task_create title shown instead of … in collapsed view ([123ddbb](https://github.com/tianshu-ai/tianshu/commit/123ddbbb2b9cab42aff32d2bdcabe24c1229f885))
* **ui:** terminal newline after command — JSX literal \n → {"\n"} ([f84a5e7](https://github.com/tianshu-ai/tianshu/commit/f84a5e700604468ace4c97a7de5d99512aee8a2e))
* **ui:** whitelist screenshot rendering — only exec/browser tools show images ([91060fe](https://github.com/tianshu-ai/tianshu/commit/91060fe48b3afd88174724dc884f3809aca4ae59))
* **ui:** write_file shows content preview — decode base64 param from bridge ([bee66f8](https://github.com/tianshu-ai/tianshu/commit/bee66f8c480301ac3de344aeca86cda879f5f03f))
* **ui:** write_file shows content preview in expanded detail ([17ba263](https://github.com/tianshu-ai/tianshu/commit/17ba263c94f2e6b1f6d0de969563387545e06fd9))


### Refactor

* **ui:** render-type-aware tool call detail view ([2bedd89](https://github.com/tianshu-ai/tianshu/commit/2bedd898ca2c53c5f5b0451eca3aeaff2080a726))

## [0.81.0](https://github.com/tianshu-ai/tianshu/compare/v0.80.0...v0.81.0) (2026-10-05)


### Features

* agent-supplied _title for tool calls ([34e192f](https://github.com/tianshu-ai/tianshu/commit/34e192f5423c30161319170e851342ee0d0a1242))
* **i18n:** localize tool call humanization — en/zh/de ([b7898d4](https://github.com/tianshu-ai/tianshu/commit/b7898d47e7b723ea08cd06babf89c3f7239ae8d9))
* re-enable _title injection with JSON round-trip (safe) ([70382a0](https://github.com/tianshu-ai/tianshu/commit/70382a0fc6f0d79fcfa0d5f121fcc57750f1a2ee))
* **ui:** collapse consecutive tool calls into grouped summary ([60de41b](https://github.com/tianshu-ai/tianshu/commit/60de41b3efb822133e0cce65496f80acd03c8d68))
* **ui:** distinguish parallel vs sequential tool calls ([d8b0df7](https://github.com/tianshu-ai/tianshu/commit/d8b0df7f6c4632d4a78830a7bc65fcfaf38b10fc))
* **ui:** expandable tool call steps with args + result detail ([0b91f8c](https://github.com/tianshu-ai/tianshu/commit/0b91f8c00fef80569890298d07e18d52b78d2c3e))
* **ui:** horizontal marquee for collapsed tool-call summaries ([abea946](https://github.com/tianshu-ai/tianshu/commit/abea9462c6ce7196d2a97b3073e93dc4506965f3))
* **ui:** parse structured tool results — show stdout, not raw JSON ([1765f92](https://github.com/tianshu-ai/tianshu/commit/1765f921526eb9eca110a52d3e67f6acaf873dcd))
* **ui:** pipeline layout for tool call DAG — vertical batches with tree connectors ([f871945](https://github.com/tianshu-ai/tianshu/commit/f871945deeb7b38c5634d21cc25511c0bc889004))
* **ui:** semantic tool call summaries — replace DAG with human-readable descriptions ([34dbfe9](https://github.com/tianshu-ai/tianshu/commit/34dbfe9ba8d3601154382c8ca1dbd2a244ec91bf))
* **ui:** show both input args and output in tool step details ([b6ba92f](https://github.com/tianshu-ai/tianshu/commit/b6ba92f1b0e0ad74810bcf71babdd382810227f6))
* **ui:** show concrete details in tool call summaries ([93e3f35](https://github.com/tianshu-ai/tianshu/commit/93e3f35f4fdef4728125ec6c57f240ac10d8fa37))
* **ui:** SVG DAG visualization for tool call pipelines ([366c257](https://github.com/tianshu-ai/tianshu/commit/366c257d63ac3e7f718bc5fa26c71e4a43726843))
* **ui:** terminal-style rendering for exec tool call details ([72086c3](https://github.com/tianshu-ai/tianshu/commit/72086c36ef49627822917587cd920c20e2e0bb7c))
* **ui:** ticker carousel for collapsed tool-call summaries ([9061ea3](https://github.com/tianshu-ai/tianshu/commit/9061ea3e2b53ad8b1f7d97754529614d9175bda0))
* **ui:** tool call group shows inline tool name chips with status ([7b1b63a](https://github.com/tianshu-ai/tianshu/commit/7b1b63a59d60c4a0ad266e8ce2a892bf2e0cedd2))
* **ui:** vertical top-to-bottom DAG layout ([7462a0a](https://github.com/tianshu-ai/tianshu/commit/7462a0af74054d2dde5634953b00703b2e9385e2))


### Bug Fixes

* _title injection broke tool schemas — preserve typebox symbols ([125729c](https://github.com/tianshu-ai/tianshu/commit/125729ca5f2a44992ad19e5f91adc73d6cd34787))
* **ui:** '(6 steps)' format for collapsed summary ([cee150c](https://github.com/tianshu-ai/tianshu/commit/cee150c7160b0c2901ec59a7c3ff48dac7b1b718))
* **ui:** '(6 steps)' in collapsed summary ([749157a](https://github.com/tianshu-ai/tianshu/commit/749157ae4e101a46cb907853be41a8947629c3e7))
* **ui:** '6 steps total' not '6 steps' — count is total, not omitted ([6cf0677](https://github.com/tianshu-ai/tianshu/commit/6cf0677ebd61a437f30107f928172d59e6e8e666))
* **ui:** add ┬ connector to first batch row in tool call DAG tree ([2a1b61f](https://github.com/tianshu-ai/tianshu/commit/2a1b61f6c30ac4e3cd16c2ef0002377656543ee9))
* **ui:** clean tool call summaries — no raw shell commands ([4c10db3](https://github.com/tianshu-ai/tianshu/commit/4c10db35a700249f1c4ebf2ccdf9722b9f8a7f4d))
* **ui:** compact DAG nodes — remove arg hints, tighter layout ([6c44d79](https://github.com/tianshu-ai/tianshu/commit/6c44d79902912956508610dcdbb7f0ee510c4cb3))
* **ui:** DAG edges more visible — thicker stroke, higher opacity ([810406b](https://github.com/tianshu-ai/tianshu/commit/810406bb55ee964abfa89482ca0cee7f6f66bebf))
* **ui:** separate ellipsis and total count — '[…] … (6)' ([9697e7d](https://github.com/tianshu-ai/tianshu/commit/9697e7d3414e62934c17aa523bd328f71ea637c6))
* **ui:** show first + last 2 steps in collapsed summary ([202af2b](https://github.com/tianshu-ai/tianshu/commit/202af2b5155a9d31a32a96e91c4421484df4d17c))
* **ui:** show full tool name instead of shortened alias ([4a7d6f5](https://github.com/tianshu-ai/tianshu/commit/4a7d6f51abfef56adb3ddf6eea2b1bd2605b23a8))
* **ui:** ticker invisible — switch from em to fixed px height ([ae4ff4b](https://github.com/tianshu-ai/tianshu/commit/ae4ff4be38135a221f1191dd6ed19f7cae9bbd3c))
* use fixed 20px height matching the toolbar line height. ([ae4ff4b](https://github.com/tianshu-ai/tianshu/commit/ae4ff4be38135a221f1191dd6ed19f7cae9bbd3c))


### Reverts

* disable _title injection — broke bridge tool schemas ([881a5c0](https://github.com/tianshu-ai/tianshu/commit/881a5c0c00724f85c1136d816c46d90f5310e063))
* **ui:** remove marquee, restore static truncated summary ([4b8086c](https://github.com/tianshu-ai/tianshu/commit/4b8086ce1757147cbc224deac6075a855bcf7f9e))

## [0.80.0](https://github.com/tianshu-ai/tianshu/compare/v0.79.0...v0.80.0) (2026-10-01)


### Features

* **ui:** breathing room — borderless bubbles + wider spacing ([2d64d2d](https://github.com/tianshu-ai/tianshu/commit/2d64d2d28481d26851ad89dfdfb0c7895de3c82d))
* **ui:** collapsible sidebar workers section ([0913065](https://github.com/tianshu-ai/tianshu/commit/0913065302afa465d32f5a070b5d25ee5d0a2da0))
* **ui:** dynamic welcome starters based on active plugins ([2e1544b](https://github.com/tianshu-ai/tianshu/commit/2e1544b3e2ec54f67f2f64daaf9e12eba999f974))
* **ui:** light theme accent blue→Star Gold 700 ([23f6991](https://github.com/tianshu-ai/tianshu/commit/23f699176aba5fb514b7adba2ba2261f0810372c))
* **ui:** model picker — accent highlight + wider truncate ([9b07cd1](https://github.com/tianshu-ai/tianshu/commit/9b07cd1973f60bb14ec4c3753006d8a0252a4083))
* **ui:** sidebar gold active bar + input focus gold border ([bbd71f3](https://github.com/tianshu-ai/tianshu/commit/bbd71f36725b426f83ee7429470c85a6525d6b6d))
* **ui:** Star Gold design system + Geist font + markdown table polish ([435eced](https://github.com/tianshu-ai/tianshu/commit/435ecedaf1394c9f831c7913d5ae25fe03607351))
* **ui:** suggested follow-up chips after assistant replies ([3d06323](https://github.com/tianshu-ai/tianshu/commit/3d06323f6b6ac8f0b5f1782410bbe3969cb2a2da))
* **ui:** tool call card redesign — bordered cards with status ([766ad39](https://github.com/tianshu-ai/tianshu/commit/766ad392cf2e5f9c2b45a562ca3a29cb653d53b3))
* **ui:** top bar cleanup — lighter border, smarter tenant label ([6314d8b](https://github.com/tianshu-ai/tianshu/commit/6314d8bb8e1add97afe759096a808143fd930239))
* **ui:** welcome screen with starter prompt cards ([21aa7fd](https://github.com/tianshu-ai/tianshu/commit/21aa7fd3c7194727ee4be31d6358eb21860f2b2e))


### Bug Fixes

* **test:** clear inbox flush timers before closing DB in tests ([0c49eb7](https://github.com/tianshu-ai/tianshu/commit/0c49eb7db572a25b5a92e899c5bcfc4693cfd969))
* **ui:** force table cell padding over Tailwind Typography ([e14e66b](https://github.com/tianshu-ai/tianshu/commit/e14e66be1412ecddb821dc011c85dea730038716))
* **ui:** markdown table visible grid + more padding ([7a69325](https://github.com/tianshu-ai/tianshu/commit/7a693255361b15f98083ea1f8ff84d855b7e77d7))
* **ui:** smarter follow-up suggestions based on reply context ([c3c5d8a](https://github.com/tianshu-ai/tianshu/commit/c3c5d8ac06e10cdd375446baccee46bee6e93285))
* **ui:** table padding 20px→12px horizontal, 12→8px vertical ([4a46183](https://github.com/tianshu-ai/tianshu/commit/4a46183a61856159ef204bd853a304899774bac6))
* **ui:** tool call bg opacity 30%→70% for visible tint ([a7e77a4](https://github.com/tianshu-ai/tianshu/commit/a7e77a407659208faf8a4830aa5748246a5d42cd))
* **ui:** tool call bg use opaque bg-surface instead of transparent elevated ([e6b89b2](https://github.com/tianshu-ai/tianshu/commit/e6b89b2718ab96766adc1708c37d5378d462c5ef))
* **ui:** tool call cards borderless to match message bubbles ([31a0411](https://github.com/tianshu-ai/tianshu/commit/31a041108a02b39b697861245fd0bba5fdd46c5d))
* **ui:** WCAG AA contrast + tap targets + reduced motion + avatar ([7ac8915](https://github.com/tianshu-ai/tianshu/commit/7ac8915e9f8b5cc7f45629185bc700148ad8f3c3))
* **ui:** WCAG AA contrast for all three themes ([49e76d9](https://github.com/tianshu-ai/tianshu/commit/49e76d906145b9dc4c9f41bf9a7fe8faaae77760))
* **ui:** welcome screen — use avatar instead of emoji, plain text starters ([6ccd3c5](https://github.com/tianshu-ai/tianshu/commit/6ccd3c5c4221ccb42333082190aa8659a6c4dac9))
* **ui:** welcome setup nudge — navigate to maintenance mode instead of sending message ([4fbaba4](https://github.com/tianshu-ai/tianshu/commit/4fbaba461ea1b138e8dcd786c04d3c4085f5215b))
* **ui:** welcome starter prompts — Lucide icons instead of plain text ([f7c5563](https://github.com/tianshu-ai/tianshu/commit/f7c55634cadf66b2b0eb41fbbc8a5f94753a0685))


### Reverts

* remove suggested follow-ups feature ([c7608cf](https://github.com/tianshu-ai/tianshu/commit/c7608cfcb73d3a98ea3f436072fb7acb6a076e39))

## [0.79.0](https://github.com/tianshu-ai/tianshu/compare/v0.78.1...v0.79.0) (2026-10-01)


### Features

* **files:** drag & drop files into chat composer ([d14f7c7](https://github.com/tianshu-ai/tianshu/commit/d14f7c7a649f62c9a62c811b5d938a200ca92ffc))


### Bug Fixes

* **asr:** map "auto" to empty string for whisper language config ([a29e8f2](https://github.com/tianshu-ai/tianshu/commit/a29e8f2a33e275eacb25e87a4a105bf13514ed65))
* **ui:** bump last 9px badge to 10px in Sidebar ([593f7f6](https://github.com/tianshu-ai/tianshu/commit/593f7f6a81649199a587b5a6f8d61fee52a5b0ae))
* **ui:** bump sidebar/badge chrome from 10px to 11px per legibility audit ([a0b3f5d](https://github.com/tianshu-ai/tianshu/commit/a0b3f5d31e03685afde3b7131d216e54d55aa831))
* **ui:** eliminate fractional font sizes (8/9.5/10.5/11.5px) ([94996b0](https://github.com/tianshu-ai/tianshu/commit/94996b08bb9e59c5abda5d61258bbc0ef904da74))
* **ui:** move drag & drop from files plugin to ChatArea host layer ([9666b10](https://github.com/tianshu-ai/tianshu/commit/9666b10114f6a567a5d66f7574f4f0524ea599cf))
* **ui:** polished drag & drop overlay with animations ([83cccc0](https://github.com/tianshu-ai/tianshu/commit/83cccc0d71f926cc2049b1b742ec6c423b8ac7f2))
* **ui:** raise all text-[11px] to text-xs (12px) per legibility audit ([9b18e23](https://github.com/tianshu-ai/tianshu/commit/9b18e2382173053cbeeb463d799f78f4560b8880))
* **ui:** raise minimum font size from 9-10px to 11-12px ([cba170e](https://github.com/tianshu-ai/tianshu/commit/cba170e3c0ab59a25d8433582f23610541608d1c))
* **ui:** raise panel/admin description text from 12px to 14px (text-sm) ([0b4bf8e](https://github.com/tianshu-ai/tianshu/commit/0b4bf8ed4968a30d4b244135b35b951c523380ac))
* **ui:** raise plugin panel description/status text to text-sm (14px) ([34ee7d9](https://github.com/tianshu-ai/tianshu/commit/34ee7d9fc65606f418a97c228e6767d9e2f96de6))
* **ui:** restore blur + dashed border overlay on composer drop zone ([717fefb](https://github.com/tianshu-ai/tianshu/commit/717fefbed1c9f22fed88e23711d238833295a15f))
* **ui:** revert sidebar/badge font sizes to 10px for compact layout ([cde0402](https://github.com/tianshu-ai/tianshu/commit/cde0402948e38d5d604e87aef6db18443603a8e3))
* **ui:** scope drag & drop to composer input area only ([0b442c8](https://github.com/tianshu-ai/tianshu/commit/0b442c8d65547c5d899afb73a53317b3c5191522))


### Refactor

* **ui:** normalize text-[12px] → text-xs (semantic equivalent) ([5d5ab45](https://github.com/tianshu-ai/tianshu/commit/5d5ab459d94baafdc3a2562c912e25672ea87faa))

## [0.78.1](https://github.com/tianshu-ai/tianshu/compare/v0.78.0...v0.78.1) (2026-10-01)


### Documentation

* **setup:** update TTS section with faster-qwen3-tts backend info ([a04557b](https://github.com/tianshu-ai/tianshu/commit/a04557b8915b17a0e12e5574607f641cd3602460))

## [0.78.0](https://github.com/tianshu-ai/tianshu/compare/v0.77.0...v0.78.0) (2026-10-01)


### Features

* **tts:** use faster-qwen3-tts for CUDA Graph accelerated inference on Linux ([1d3157d](https://github.com/tianshu-ai/tianshu/commit/1d3157deb80dba28c894503184343abb5a01d2b0))


### Bug Fixes

* **tts:** let start.sh auto-detect model per platform ([3b8f3fa](https://github.com/tianshu-ai/tianshu/commit/3b8f3fa95c751047858da0eaf477e5a530cf0ce0))

## [0.77.0](https://github.com/tianshu-ai/tianshu/compare/v0.76.1...v0.77.0) (2026-10-01)


### Features

* **datasource:** extract hardcoded UI strings to i18n (en/zh/de) ([e4b1d24](https://github.com/tianshu-ai/tianshu/commit/e4b1d244e534b864bbbc00968371a77e822d3517))
* **doctor:** add complete German (de) translation tables ([a0be8b6](https://github.com/tianshu-ai/tianshu/commit/a0be8b69ae2e057ee480f02b5f98d11f60037f75))
* **i18n:** add complete German (de) locale ([253a9e6](https://github.com/tianshu-ai/tianshu/commit/253a9e6f7d09bdb6fb5dc27616fba9500047d130))
* **i18n:** add German locale for board, cron, custom-ui, datasource, files, microsandbox, openshell plugins ([bda85b5](https://github.com/tianshu-ai/tianshu/commit/bda85b5a9563b005e4fddae1d5c4ca829057c827))
* **i18n:** add German locale for custom-ui, files, openshell, wechat, reverse-mcp plugins ([e4da1e5](https://github.com/tianshu-ai/tianshu/commit/e4da1e5c6b47cfcf023173604eaad092a866c677))
* **i18n:** add German locale for wiki plugin (from parallel task) ([ca7121b](https://github.com/tianshu-ai/tianshu/commit/ca7121bbea6feb4829066e485ac5c98de8170633))
* **i18n:** add German locale for workboard, workforce-studio plugins ([2684136](https://github.com/tianshu-ai/tianshu/commit/2684136ee97a5b883efab4fab62fc22e2dda96a3))


### Bug Fixes

* **files:** add missing dateLoc in FilePreviewModal ([717a72a](https://github.com/tianshu-ai/tianshu/commit/717a72a8e55b37d0c1a707d5d0e2c92ab7f5bc69))
* **files:** default sort by modified time descending ([0a41484](https://github.com/tianshu-ai/tianshu/commit/0a41484f89f8cce055402beefb61772d221baf87))
* **i18n:** escape typographic quotes in de.json (microsandbox, reverse-mcp, wiki) ([66c243f](https://github.com/tianshu-ai/tianshu/commit/66c243fa181db558ae79228d85a8a54249c73382))
* **i18n:** extract remaining hardcoded strings in doctor, wiki plugins ([eb589af](https://github.com/tianshu-ai/tianshu/commit/eb589afc99401ef36236c71a8282eb29607cdfbe))
* restore package.json and release manifest (corrupted by conflict resolution) ([7e15f25](https://github.com/tianshu-ai/tianshu/commit/7e15f2576ef76e324108c6128d6d9fc1206e3619))
* **wiki:** add missing dateLoc in IndexingTab ([a9e8037](https://github.com/tianshu-ai/tianshu/commit/a9e803745ab4fb1aaed0bf7c4e2ab5b30e8204e8))


### Refactor

* **i18n:** unify date formatting with useDateLocale() across all plugins ([b53fc88](https://github.com/tianshu-ai/tianshu/commit/b53fc8849ccff2300e96c16a753172c9433b94e0))

## [0.76.1](https://github.com/tianshu-ai/tianshu/compare/v0.76.0...v0.76.1) (2026-09-30)


### Bug Fixes

* **doctor:** warn when auto-compaction is not configured ([8eceddc](https://github.com/tianshu-ai/tianshu/commit/8eceddc67b694a266234df5d0c0e4126dc6b1164))

## [0.76.0](https://github.com/tianshu-ai/tianshu/compare/v0.75.0...v0.76.0) (2026-09-30)


### Features

* **tts:** add German voice (Katja) to Edge TTS list ([efc0968](https://github.com/tianshu-ai/tianshu/commit/efc0968140207de15fe515c8ca261bb9b52dc86f))


### Bug Fixes

* SpeakButton reads TTS provider/voice from user preferences ([859f08a](https://github.com/tianshu-ai/tianshu/commit/859f08aca5f6344d1008626a943ffd73b23ad403))
* **tts:** abort upstream generation when client disconnects ([7ba73f5](https://github.com/tianshu-ai/tianshu/commit/7ba73f51acb4e23c6da0231199fdace0e0875a46))
* **tts:** increase health probe timeout to 10s ([1f8df59](https://github.com/tianshu-ai/tianshu/commit/1f8df59ed76fb9382b427fd40c54a7cb75e3e6ab))
* **tts:** remove background music from yujie voice sample ([9e564fd](https://github.com/tianshu-ai/tianshu/commit/9e564fd61baad5f27e4b9c4c39766b77ab3bbdb8))
* **tts:** rewrite sentence splitter for reliable chunking ([bc7d320](https://github.com/tianshu-ai/tianshu/commit/bc7d32064ae9a834eba3780da5bbc9dd3535205f))
* **tts:** run MLX inference in thread to unblock /health endpoint ([31b9ea2](https://github.com/tianshu-ai/tianshu/commit/31b9ea2b84b832e3968e3a2d5ed8ba11995d482c))
* **tts:** split long text into sentences for voice clone stability ([016def4](https://github.com/tianshu-ai/tianshu/commit/016def4b5c40ee09487c92a2c8fbceea9604eb81))
* **tts:** use bilingual preview text for Qwen3-TTS voices ([4afe88d](https://github.com/tianshu-ai/tianshu/commit/4afe88d904b7c2c713c5879346e9dfcd68869831))
* **tts:** use language-matched preview text for Edge TTS voices ([9d35a90](https://github.com/tianshu-ai/tianshu/commit/9d35a9047b199a421b8a834ec9fd02d3b8842ec5))
* **tts:** use model's native split_pattern instead of external chunking ([f3257ac](https://github.com/tianshu-ai/tianshu/commit/f3257acb5f9e733a3e9f046cafdf9e0886442182))


### Performance

* add gzip compression for all HTTP responses ([626035d](https://github.com/tianshu-ai/tianshu/commit/626035d71bf2c4924b31c29a71587451947d4862))
* **tts:** resolve HF model from local cache, skip API call on startup ([861c439](https://github.com/tianshu-ai/tianshu/commit/861c43909aed12fc43797866ce7b819983e50fa7))


### Refactor

* **tts:** centralize TTS preferences in voice store ([a120344](https://github.com/tianshu-ai/tianshu/commit/a12034446e6427fc6af8ee48a5d39d35a6da9876))

## [0.75.0](https://github.com/tianshu-ai/tianshu/compare/v0.74.1...v0.75.0) (2026-09-30)


### Features

* **tts:** cross-platform Qwen3-TTS server (MLX + PyTorch) ([124d6ba](https://github.com/tianshu-ai/tianshu/commit/124d6ba2741640eece653ccb7ec8c8a3cd99b1cd))


### Documentation

* rewrite README quick-start to use Maintenance Mode UI ([c39f6a0](https://github.com/tianshu-ai/tianshu/commit/c39f6a09c9d3f260648eec4b5a448713859b2cc4))
* **setup:** update TTS section for cross-platform support ([086dfd8](https://github.com/tianshu-ai/tianshu/commit/086dfd824cc6b66d418734ee33bca9033f62b2a9))

## [0.74.1](https://github.com/tianshu-ai/tianshu/compare/v0.74.0...v0.74.1) (2026-09-30)


### Bug Fixes

* **i18n:** remove duplicate asr.langJa/asr.langKo keys ([1346a21](https://github.com/tianshu-ai/tianshu/commit/1346a21908a8380df48d985ec6ff74e6afb99611))

## [0.74.0](https://github.com/tianshu-ai/tianshu/compare/v0.73.0...v0.74.0) (2026-09-30)


### Features

* add German, Japanese, Korean to language options ([903dc86](https://github.com/tianshu-ai/tianshu/commit/903dc865e85b6d8da1720a4ac9db584e92c22490))
* ask_user interaction buttons (frontend) ([d790ea7](https://github.com/tianshu-ai/tianshu/commit/d790ea70427b6b26692e1386d05d97e69e325726))
* ask_user tool + interaction suspend mechanism (server side) ([7c15194](https://github.com/tianshu-ai/tianshu/commit/7c15194016cfada7207ceb84ea738721a77d1e84))
* **asr:** add recognition language setting in ASR settings page ([fa96149](https://github.com/tianshu-ai/tianshu/commit/fa9614948137d3f5455128b5ee6c73e7450a815e))
* click option fills composer draft instead of auto-sending ([38ac7eb](https://github.com/tianshu-ai/tianshu/commit/38ac7eb7757f03200ee9cab921656edc55c70c79))
* enable free-form input during ask_user interactions ([928355f](https://github.com/tianshu-ai/tianshu/commit/928355f955ae335a9b71546d5d62ff893befd554))
* **setup:** use ask_user tool for guided setup questions ([2e12db5](https://github.com/tianshu-ai/tianshu/commit/2e12db56e466994e3f0760f2289c79cf4c539c33))


### Bug Fixes

* **asr:** align language options with outputLanguage (auto/zh/en only) ([f166bdc](https://github.com/tianshu-ai/tianshu/commit/f166bdcbb6b146b1e4e612bab14803ed4eef9b0d))
* **asr:** use outputLanguage config for Whisper instead of hardcoded zh ([fe82722](https://github.com/tianshu-ai/tianshu/commit/fe82722b0b8a46eddce503789f48dce1490e13a4))
* center-align interaction buttons and question text ([169cf26](https://github.com/tianshu-ai/tianshu/commit/169cf26a3e4a42d4774b0dc49d713632eeb3aefc))
* pin InteractionButtons above composer instead of in scroll area ([fa5f2de](https://github.com/tianshu-ai/tianshu/commit/fa5f2de2cd27f106a3ab229c0380365944cb0555))
* re-push pending interactions on initial WS connect, not hello ([be66bd9](https://github.com/tianshu-ai/tianshu/commit/be66bd90c683a7f7005d5ebab6718702b6130cdd))
* re-push pending interactions on WS reconnect (page refresh) ([96c957c](https://github.com/tianshu-ai/tianshu/commit/96c957c1469f1c220eb7f4c2bf75486d5e5a1bc2))
* reconnect state recovery without arbitrary timeout ([e06b03f](https://github.com/tianshu-ai/tianshu/commit/e06b03f940d26cb721612af987a0f63015a0a984))
* reset InteractionButtons state on new interaction ([d3dd743](https://github.com/tianshu-ai/tianshu/commit/d3dd7433a820be47f3e1bb5d270cfc7a7339f5c1))
* reset streaming state after server restart + reconnect ([3d84c8c](https://github.com/tianshu-ai/tianshu/commit/3d84c8ce62b84996725b082a8e3b52f04424018a))

## [0.73.0](https://github.com/tianshu-ai/tianshu/compare/v0.72.0...v0.73.0) (2026-09-30)


### Features

* **doctor:** add Chinese i18n for doctor panel ([8af92e4](https://github.com/tianshu-ai/tianshu/commit/8af92e4c40dadce044a1db2edecbc40480dcc6d5))
* **doctor:** complete Chinese translation for all check-line texts ([6173cbf](https://github.com/tianshu-ai/tianshu/commit/6173cbf26191ecc94b102339a22446a7408d0dfd))
* **setup:** guided setup wizard for fresh installs ([3836bc8](https://github.com/tianshu-ai/tianshu/commit/3836bc8c5a57ebcb9f4fd946af0f5d93d5330801))


### Bug Fixes

* **doctor:** live locale switch without page reload ([969b709](https://github.com/tianshu-ai/tianshu/commit/969b709d762fd166e1cea7696573728ad90a2350))
* **setup:** enforce markdown list format for guided setup questions ([cb5b941](https://github.com/tianshu-ai/tianshu/commit/cb5b941cc5b9ba994958f239282f70b0b0d84860))

## [0.72.0](https://github.com/tianshu-ai/tianshu/compare/v0.71.4...v0.72.0) (2026-09-30)


### Features

* **setup:** add restart_service tool + fix shell_exec ENOENT cwd ([1322e60](https://github.com/tianshu-ai/tianshu/commit/1322e600ee1d390d5f2fe90fecc4590baa1d53a4))

## [0.71.4](https://github.com/tianshu-ai/tianshu/compare/v0.71.3...v0.71.4) (2026-09-29)


### Bug Fixes

* **doctor:** also check plugin dir exists before running Sandbox check ([a7daa0b](https://github.com/tianshu-ai/tianshu/commit/a7daa0b6d2b377d05c8f647ab249f7ef6f554aa1))

## [0.71.3](https://github.com/tianshu-ai/tianshu/compare/v0.71.2...v0.71.3) (2026-09-29)


### Bug Fixes

* **doctor:** probe HTTPS when SSL is configured ([9a407b5](https://github.com/tianshu-ai/tianshu/commit/9a407b5ba9217f4a6e062a75286dd38049328561))

## [0.71.2](https://github.com/tianshu-ai/tianshu/compare/v0.71.1...v0.71.2) (2026-09-29)


### Bug Fixes

* **doctor:** fix double .service suffix in systemd unit path ([4bf0203](https://github.com/tianshu-ai/tianshu/commit/4bf02033ff0d6d50df54fa71f6a56cd831a70b5a))
* **tests:** update .env test to match removed check ([01a6aa0](https://github.com/tianshu-ai/tianshu/commit/01a6aa0387301211491ee2adc825d6fbfd9b7023))

## [0.71.1](https://github.com/tianshu-ai/tianshu/compare/v0.71.0...v0.71.1) (2026-09-29)


### Bug Fixes

* **doctor:** downgrade missing .env from warning to ok ([4247cf3](https://github.com/tianshu-ai/tianshu/commit/4247cf3fabb7b4fd106ebc4852ac787ce7c41b5f))
* **doctor:** remove .env check entirely ([889c505](https://github.com/tianshu-ai/tianshu/commit/889c50552984ffed39209139fc3d883340d971bc))
* **doctor:** skip Sandbox check when no sandbox plugin is enabled ([d648b68](https://github.com/tianshu-ai/tianshu/commit/d648b68216cff0a79f584bb61e7af7006fcb9a12))
* **tests:** update checkTenants tests for per-tenant group return type ([630b16b](https://github.com/tianshu-ai/tianshu/commit/630b16b117c7bd47fc7f2a9d46ab99a87d918e72))

## [0.71.0](https://github.com/tianshu-ai/tianshu/compare/v0.70.0...v0.71.0) (2026-09-29)


### Features

* add multi-platform sandbox image CI + fix microsandbox build 400 error ([eec6238](https://github.com/tianshu-ai/tianshu/commit/eec6238b3c49c07623156fcc8c35935e1342d729))
* **doctor:** add System Doctor plugin for maintenance mode ([4ae0285](https://github.com/tianshu-ai/tianshu/commit/4ae0285582f8661a31e5af7567b307df3614501c))
* **doctor:** pin warning/error items to chat for diagnosis ([031a7d9](https://github.com/tianshu-ai/tianshu/commit/031a7d954c1460ea5c01941fa3a289633450b168))
* **microsandbox:** support YAML literal block syntax in Sandboxfile parser ([d500e89](https://github.com/tianshu-ai/tianshu/commit/d500e89769e3af113106f0216fb41b9efdbd143b))
* **setup:** add _setup tenant for web-based Setup Agent ([e511e50](https://github.com/tianshu-ai/tianshu/commit/e511e503aa8b489550e6e0cbccd9aecdd4518465))
* **setup:** runtime context in setup agent + hide plugins in maintenance ([6be6d6d](https://github.com/tianshu-ai/tianshu/commit/6be6d6d996c0eb3b11f719e31a76141548a91f5b))


### Bug Fixes

* **auth:** allow switch-tenant to _setup system tenant ([e23871c](https://github.com/tianshu-ai/tianshu/commit/e23871ccbb5889d1f4d33acc64b2da9f68fbc158))
* **core:** allow open/exists to handle system-reserved tenant IDs ([b988654](https://github.com/tianshu-ai/tianshu/commit/b9886549b52fd670ab0158fb4f5a135090cb8099))
* **doctor:** align severity icons vertically with text line ([6e1140d](https://github.com/tianshu-ai/tianshu/commit/6e1140d8482878b3b4ae87112c453b1ffdfcd08c))
* **doctor:** downgrade probe failure to ok for local/custom endpoints ([607cf8e](https://github.com/tianshu-ai/tianshu/commit/607cf8e762b412376b1d084eb11285e442b2e43f))
* **doctor:** fix hover CSS selectors not matching ([1609258](https://github.com/tianshu-ai/tianshu/commit/1609258e22ba85dcb5c9de99344e8e2ee45d8a42))
* **doctor:** hover-to-pin interaction on severity icons ([a868a53](https://github.com/tianshu-ai/tianshu/commit/a868a5360646b588173e5de733d45a18b5873447))
* **doctor:** move fix hint to left side next to icon ([54bbfe9](https://github.com/tianshu-ai/tianshu/commit/54bbfe91a5829b98eb1aec07e096db30624a54f8))
* **doctor:** remove tooltip from actionable detail lines ([6ee4503](https://github.com/tianshu-ai/tianshu/commit/6ee450390a516709544a2c480348d9542495ba4b))
* **doctor:** remove tooltip on actionable lines ([726dadb](https://github.com/tianshu-ai/tianshu/commit/726dadbb31372986118a0f2b85218c1fc163bbf7))
* **doctor:** skip embedding models in contextWindow/maxTokens checks ([57ba52b](https://github.com/tianshu-ai/tianshu/commit/57ba52b22bd0f80091223dbfda56fbdcea96bd84))
* **doctor:** skip service checks in development checkout ([5b463e4](https://github.com/tianshu-ai/tianshu/commit/5b463e48e119e8350463aa2dc2dc1db5a653f1d1))
* **doctor:** update defaultModel check to use models.defaultModelId ([cb878b2](https://github.com/tianshu-ai/tianshu/commit/cb878b229f7bca9670caa162d828cfaf2c778eb9))
* **doctor:** whole-row hover highlight + click-to-fix UX ([990b963](https://github.com/tianshu-ai/tianshu/commit/990b9631080379c1304fd11fd5a4d2ffdf55dcc5))
* **middleware:** handle InvalidTenantIdError gracefully ([07bbb1f](https://github.com/tianshu-ai/tianshu/commit/07bbb1f8f17d460c44b866662903adf4aabce37b))
* **openshell:** replace community base image with tianshu82/opencode-sandbox ([7df71e6](https://github.com/tianshu-ai/tianshu/commit/7df71e63be2f70fdb2e7372208535f02745d3bd5))
* **plugins:** parse maintenanceOnly field from manifest ([5cedf19](https://github.com/tianshu-ai/tianshu/commit/5cedf19f2abaaba4d42eabb3a06145b3b5bd7c0e))
* **ui:** move maintenance toggle to chat area banner ([390934a](https://github.com/tianshu-ai/tianshu/commit/390934a3ec88deb62a392856022b058bdf97efb6))
* **ui:** move setup agent toggle to sidebar header ([bbc2324](https://github.com/tianshu-ai/tianshu/commit/bbc2324eaf903a35f682575ffe8f993ef16c66c2))


### Refactor

* **doctor:** split tenant checks into per-tenant groups ([422de77](https://github.com/tianshu-ai/tianshu/commit/422de7756918ffe06b04218fd580190f6fece7d3))
* **setup:** rename _setup tenant to maintenance ([680af5a](https://github.com/tianshu-ai/tianshu/commit/680af5a3d71952439dadecc959d31e4ad98b877e))

## [0.70.0](https://github.com/tianshu-ai/tianshu/compare/v0.69.3...v0.70.0) (2026-09-29)


### Features

* **asr:** add Whisper base, small, large-v3, and distil-large-v3 models ([3032a94](https://github.com/tianshu-ai/tianshu/commit/3032a94c5f8a76e9bef67783e90f398ddd5ab89c))

## [0.69.3](https://github.com/tianshu-ai/tianshu/compare/v0.69.2...v0.69.3) (2026-09-29)


### Bug Fixes

* **admin:** hide auth pages in no-auth mode ([746db16](https://github.com/tianshu-ai/tianshu/commit/746db16b5003fd0d251e4aa73752ff7c89c9ffa2))
* **auth:** allow tenant switching in no-auth mode ([8430908](https://github.com/tianshu-ai/tianshu/commit/843090837030cd3bdd4b3302820e8fcd8bf99d77))
* **auth:** filter disabled tenants from no-auth tenant list ([d1a3255](https://github.com/tianshu-ai/tianshu/commit/d1a3255c5e77f81b6c199831f3bcbbf33856f1ed))
* **auth:** force admin identity in no-auth mode ([18f3fd7](https://github.com/tianshu-ai/tianshu/commit/18f3fd7b2605e8bfb8e90e4730c6eb378225cb47))
* **board:** add allow-downloads to iframe sandbox ([1be2f4e](https://github.com/tianshu-ai/tianshu/commit/1be2f4ef71762a6e1d69555921c23654b9e28258))

## [0.69.2](https://github.com/tianshu-ai/tianshu/compare/v0.69.1...v0.69.2) (2026-09-29)


### Bug Fixes

* **doctor:** replace require with ESM import for child_process ([c268f88](https://github.com/tianshu-ai/tianshu/commit/c268f88e39b6a1f0fab1441accc1b5430a2926ee))

## [0.69.1](https://github.com/tianshu-ai/tianshu/compare/v0.69.0...v0.69.1) (2026-09-29)


### Bug Fixes

* **doctor:** derive npm path from process.execPath instead of which ([26b6bda](https://github.com/tianshu-ai/tianshu/commit/26b6bda72abb87d553f10d7167205578f98e0849))
* **doctor:** use which tianshu to resolve npm path ([b6ee05d](https://github.com/tianshu-ai/tianshu/commit/b6ee05d738277d23600bc9fc1dbd5dfd0d47423f))

## [0.69.0](https://github.com/tianshu-ai/tianshu/compare/v0.68.4...v0.69.0) (2026-09-29)


### Features

* **doctor:** check launchd/systemd service path consistency ([3e8b7f3](https://github.com/tianshu-ai/tianshu/commit/3e8b7f3177f9a24f9b16114732eae0818cb301fe))
* **web:** copy buttons for messages and code blocks ([d5387d5](https://github.com/tianshu-ai/tianshu/commit/d5387d545b47a391695b1d81bf9e54eaa7468fd5))

## [0.68.4](https://github.com/tianshu-ai/tianshu/compare/v0.68.3...v0.68.4) (2026-09-28)


### Bug Fixes

* **deps:** update runtime dependencies ([7058ed8](https://github.com/tianshu-ai/tianshu/commit/7058ed816a8c9126827c8e04e187faf84a6be442))

## [0.68.3](https://github.com/tianshu-ai/tianshu/compare/v0.68.2...v0.68.3) (2026-09-28)


### Bug Fixes

* **image:** graceful fallback when sharp cannot decode small images ([69c48cb](https://github.com/tianshu-ai/tianshu/commit/69c48cbf054060c7bbea97e244a05c8c44e72999))

## [0.68.2](https://github.com/tianshu-ai/tianshu/compare/v0.68.1...v0.68.2) (2026-09-28)


### Bug Fixes

* **image:** clamp oversized dimensions before byte-budget check ([0b17d09](https://github.com/tianshu-ai/tianshu/commit/0b17d090869621331454d1b86aa30aaa22a8099c))
* **image:** fit already-inlined images in history through dimension check ([8028b64](https://github.com/tianshu-ai/tianshu/commit/8028b64889f910d66d2a5da76af50dc3266d19c5))

## [0.68.1](https://github.com/tianshu-ai/tianshu/compare/v0.68.0...v0.68.1) (2026-09-26)


### Bug Fixes

* **chat:** extract stale lane repair to shared module + protect auto-continue ([b522f40](https://github.com/tianshu-ai/tianshu/commit/b522f4042313841bcbac663df1bda84d85ed6433))
* **chat:** skip recovery agent and stream_error on user-initiated abort ([4913530](https://github.com/tianshu-ai/tianshu/commit/49135306aa13f5af18ecc5fe16c9e2a5a96f7d71))

## [0.68.0](https://github.com/tianshu-ai/tianshu/compare/v0.67.2...v0.68.0) (2026-09-26)


### Features

* add TOON (Token-Optimised Object Notation) to plugin-sdk and adopt across tool results ([372955f](https://github.com/tianshu-ai/tianshu/commit/372955f9ba2e69e957bc9d08c2f366cd5c897fe9))
* **datasource:** add REST API driver ([c6655d6](https://github.com/tianshu-ai/tianshu/commit/c6655d6b5105efb679aa5cc5c254c6fda2727cae))
* **datasource:** auth type selector for REST API connections ([678ee8a](https://github.com/tianshu-ai/tianshu/commit/678ee8a13b524834a7e5d7a25a9606749e164149))
* **datasource:** extra headers field for REST API connections (always visible) ([625e093](https://github.com/tianshu-ai/tianshu/commit/625e093a8097e2b25c0a46500496ad0ea3d56334))
* **datasource:** OAuth2 Client Credentials auth for REST API ([21d27f6](https://github.com/tianshu-ai/tianshu/commit/21d27f6be09ad0460fb2f33271869da4e81089dc))
* **datasource:** per-request headers parameter for REST API tools ([1d85d40](https://github.com/tianshu-ai/tianshu/commit/1d85d40f3221e0c1d6c1991dd560eaf197f97cf5))


### Bug Fixes

* **chat:** extract text from content-array tool results instead of JSON-stringifying ([7de2cde](https://github.com/tianshu-ai/tianshu/commit/7de2cdeaf3f3f230e524cabb4abf63efef1b163c))
* **chat:** use toon() in agent-tool-adapter fallback instead of JSON.stringify ([cef8a9b](https://github.com/tianshu-ai/tianshu/commit/cef8a9bcc1bcbd17f7bab64f76fbb1571ad911e1))
* **datasource:** flatten nested objects in REST API responses ([4d379da](https://github.com/tianshu-ai/tianshu/commit/4d379da1b991aebdb60650d0c5824353a193f87b))
* **datasource:** make connection pool per-tenant ([c4789d8](https://github.com/tianshu-ai/tianshu/commit/c4789d8fee569644bf34aa191be430b6195e15a0))
* **datasource:** use TOON-style compact cell format to save tokens ([56fc920](https://github.com/tianshu-ai/tianshu/commit/56fc920b0eb93c07611f4f42726373fb60f05294))
* replace remaining JSON.stringify in tool/LLM-facing text with toon-style compact format ([9a643e1](https://github.com/tianshu-ai/tianshu/commit/9a643e122cee47db7ab80536aa486f0b8c6c7349))

## [0.67.2](https://github.com/tianshu-ai/tianshu/compare/v0.67.1...v0.67.2) (2026-09-25)


### Bug Fixes

* **chat:** add diagnostic logging for AgentHarness fault debugging ([dba246e](https://github.com/tianshu-ai/tianshu/commit/dba246e7eba8079dd6069ddb8c671576e3988bec))
* **chat:** remove unused repairOrphanedToolCalls ([fbee99b](https://github.com/tianshu-ai/tianshu/commit/fbee99bf76e3bd02ac4a45ffc66eb6bbab92e612))
* **chat:** repair orphaned tool calls in memory before harness restore ([472d0e0](https://github.com/tianshu-ai/tianshu/commit/472d0e0149fda50df25a7c7c310b193fe76890ac))
* **chat:** repair stale lane operation refs before harness restore ([1d1d9b0](https://github.com/tianshu-ai/tianshu/commit/1d1d9b0e556fd56cd667c851403a23bd771a8744))

## [0.67.1](https://github.com/tianshu-ai/tianshu/compare/v0.67.0...v0.67.1) (2026-09-25)


### Bug Fixes

* **chat:** catch AbortError from lane.abort() to prevent unhandledRejection ([8f9345a](https://github.com/tianshu-ai/tianshu/commit/8f9345a086c41205598d7a74a77cc4002eb06112))

## [0.67.0](https://github.com/tianshu-ai/tianshu/compare/v0.66.1...v0.67.0) (2026-09-25)


### Features

* **wiki:** inject systemPromptFragment so main agent uses wiki recall ([773e813](https://github.com/tianshu-ai/tianshu/commit/773e813b944b4ce73b74b621b25f48e5ed31283c))
* **wiki:** live audit progress log in UI ([c078a9f](https://github.com/tianshu-ai/tianshu/commit/c078a9f96bb7a04746295dd96a8c706e93beca9f))
* **wiki:** three-phase audit for cross-linking and synthesis page maintenance ([#513](https://github.com/tianshu-ai/tianshu/issues/513)) ([10f4881](https://github.com/tianshu-ai/tianshu/commit/10f488130cfcd84eb546d75956a9d1e348c5facb))
* **workboard:** add task_list_workers tool with includeDisabled param ([#512](https://github.com/tianshu-ai/tianshu/issues/512)) ([eef7f6b](https://github.com/tianshu-ai/tianshu/commit/eef7f6b8f7e128d0d929055c337c3fbaaf76da97))


### Bug Fixes

* **wiki:** add i18n keys for audit UI (en + zh) ([266ee2d](https://github.com/tianshu-ai/tianshu/commit/266ee2d703dfa1b22db691c240d43c6663fc67d2))
* **wiki:** register /audit route in manifest.json apiRoutes ([cd997b4](https://github.com/tianshu-ai/tianshu/commit/cd997b4ae45fd90939e5f79cf81727f59d08eb7b))
* **wiki:** show audit running status in UI + separate audit/record run locks ([d051c23](https://github.com/tianshu-ai/tianshu/commit/d051c239536bc10b9e687e53c0df8472e1537086))
* **wiki:** show either audit badge or button, not both ([ddfa38c](https://github.com/tianshu-ai/tianshu/commit/ddfa38c6a14e152da8d63846a95642737436d75d))
* **wiki:** tolerate baseUrl with/without /v1 for embeddings endpoint ([#510](https://github.com/tianshu-ai/tianshu/issues/510)) ([1b92231](https://github.com/tianshu-ai/tianshu/commit/1b922311a17ffd8089c6fcefc1f47bc3762f9269))

## [0.66.1](https://github.com/tianshu-ai/tianshu/compare/v0.66.0...v0.66.1) (2026-09-24)


### Bug Fixes

* **wiki:** remove ~10-day limit and extend worker timeout to 2h ([#508](https://github.com/tianshu-ai/tianshu/issues/508)) ([e5d88dc](https://github.com/tianshu-ai/tianshu/commit/e5d88dcad36c1f613669a4b0507ce96322b14edc))

## [0.66.0](https://github.com/tianshu-ai/tianshu/compare/v0.65.1...v0.66.0) (2026-09-24)


### Features

* **chat:** chain-absolute turn_number across fork boundaries ([#505](https://github.com/tianshu-ai/tianshu/issues/505)) ([0e96a1f](https://github.com/tianshu-ai/tianshu/commit/0e96a1f007064a560c999ee712a5d90fdcafb607))
* **chat:** route /compact through harness.compact() so structured summaries apply ([#503](https://github.com/tianshu-ai/tianshu/issues/503)) ([8dcdd10](https://github.com/tianshu-ai/tianshu/commit/8dcdd1004637a606815593ad4c3f95bd35f12c7c))
* **chat:** structured compaction with turn-numbered summaries ([#501](https://github.com/tianshu-ai/tianshu/issues/501)) ([63ba5fe](https://github.com/tianshu-ai/tianshu/commit/63ba5fea549c5c4a64cce50a6dc783042434aa2a))
* **wiki:** add knowledge-linking instruction to ingest prompt ([#507](https://github.com/tianshu-ai/tianshu/issues/507)) ([37af268](https://github.com/tianshu-ai/tianshu/commit/37af26824980a1c87688dbda408b905a6d055650))
* **wiki:** add turn_number index to wiki ingest transcript ([#506](https://github.com/tianshu-ai/tianshu/issues/506)) ([be1629d](https://github.com/tianshu-ai/tianshu/commit/be1629dd003e4eb3d15a676367a726cd86618869))


### Bug Fixes

* **chat:** exclude fork-seed [Conversation summary] from real user turn count ([#504](https://github.com/tianshu-ai/tianshu/issues/504)) ([0574867](https://github.com/tianshu-ai/tianshu/commit/0574867873dbd2cbd9dd0aafd389c4be969dbbaf))

## [0.65.1](https://github.com/tianshu-ai/tianshu/compare/v0.65.0...v0.65.1) (2026-09-24)


### Bug Fixes

* **chat:** document msg_empty_ sentinel contract between server + web ([4a63d7f](https://github.com/tianshu-ai/tianshu/commit/4a63d7ff7fee6471da51f5e1d2b0985cc3f83df3))

## [0.65.0](https://github.com/tianshu-ai/tianshu/compare/v0.64.0...v0.65.0) (2026-09-24)


### Features

* pi 0.85.1 migration complete — 0 TypeScript errors ([8082401](https://github.com/tianshu-ai/tianshu/commit/8082401aacb8f4319cf4cade8f3b38ba22fc548a))


### Bug Fixes

* abort stuck deferred operations before lane.prompt() ([b0da1de](https://github.com/tianshu-ai/tianshu/commit/b0da1deb56fd29142eea3ca5bced6322f51696f1))
* add progress logs to migration 015 seq backfill ([a23c0bc](https://github.com/tianshu-ai/tianshu/commit/a23c0bc400aacfbb2cc33d65db8757a85000a38a))
* align react-dom to ^19.3.0 to match react version ([0b40bdf](https://github.com/tianshu-ai/tianshu/commit/0b40bdfacd9ae8745495a32e5b329fc6926d5042))
* bridgeHarnessEventToWs uses pi 0.85 tool_{start,end} names ([d0e9e8a](https://github.com/tianshu-ai/tianshu/commit/d0e9e8a59a335d7db28aa0875574aee3eeb118c7))
* forward message_added on entry_added, not message_end ([d425f9f](https://github.com/tianshu-ai/tianshu/commit/d425f9ff5977ac343575227f4623028113cbaf23))
* group all models per provider to avoid setProvider overwrite ([a781739](https://github.com/tianshu-ai/tianshu/commit/a7817396343b8af163cbc49c94c055f0ac5a88e8))
* include provider prefix in model id to avoid cross-provider collision ([2dbf50f](https://github.com/tianshu-ai/tianshu/commit/2dbf50fe7449d3a21eabf0784c67a9356bcb7378))
* legacy-safe parse in SqliteStorage rowToEntry ([415f6a3](https://github.com/tianshu-ai/tianshu/commit/415f6a3c033feed69475f7bf4ab12f6795c787e3))
* message_update event field is 'event', not 'assistantMessageEvent' ([f00204d](https://github.com/tianshu-ai/tianshu/commit/f00204df055bfa5c7b5b43a1d8727f6675de4c6a))
* normalize toolResult row role to 'tool' in SqliteStorage ([0bddea2](https://github.com/tianshu-ai/tianshu/commit/0bddea26463dab4ca5d4e5e1001d74cb3e434cee))
* readList cursor direction for descending order ([8a26758](https://github.com/tianshu-ai/tianshu/commit/8a26758695dd5c0962e2b48c0e4ed568293e229e))
* register all configured models in pi Models registry ([062e8ab](https://github.com/tianshu-ai/tianshu/commit/062e8ab6cf76645ee14a1691a5e10f49ab39d0f6))
* sync activeToolNames before every lane.prompt() ([2949623](https://github.com/tianshu-ai/tianshu/commit/294962372d2125971f912eef10c2fb06a2bbf3ab))
* sync model identity before every lane.prompt() ([970f0b4](https://github.com/tianshu-ai/tianshu/commit/970f0b4e2fd3f8bf3aabafc802c5ee6ca5701815))
* tag WS tool_call/tool_result with sessionId ([ba25ac6](https://github.com/tianshu-ai/tianshu/commit/ba25ac61806975b1ae6e401089f13d3d928c9161))
* task_complete args come from tool_start, not tool_end ([200604a](https://github.com/tianshu-ai/tianshu/commit/200604a64d85c32cd906c1801b2a12d7b6e10fa0))


### Reverts

* drop sessionId tags on tool_call/tool_result WS events ([b8e2567](https://github.com/tianshu-ai/tianshu/commit/b8e2567a7dc5e297c95303490a456ddb2da92395))
* remove provider prefix from model.id ([e2af1fe](https://github.com/tianshu-ai/tianshu/commit/e2af1fe5e856bafac7aff8264d7f716eb929022d))

## [0.64.0](https://github.com/tianshu-ai/tianshu/compare/v0.63.1...v0.64.0) (2026-09-23)


### Features

* add image-gen plugin with Gemini backend ([5bd0976](https://github.com/tianshu-ai/tianshu/commit/5bd0976c137f21f0847da771bcaa22417f95f173))
* brand logo horizontal + transparent + light color ([29d0997](https://github.com/tianshu-ai/tianshu/commit/29d0997ec79624a7233e8db73274affd522ffda4))
* brand logo uses CSS mask to follow theme colors ([314b5e9](https://github.com/tianshu-ai/tianshu/commit/314b5e9555b0c54b1d625df289b0808a7e23baa3))
* chat images open in Lightbox modal instead of navigating ([472427a](https://github.com/tianshu-ai/tianshu/commit/472427aad765e606f8f329a46d43c4b5193970bb))
* empty imageGenModelId disables generate_image tool ([ba0ef54](https://github.com/tianshu-ai/tianshu/commit/ba0ef54dd3908377a681f5d792b1703a5844fc2e))
* generate_image as built-in host tool (no plugin needed) ([4b994b1](https://github.com/tianshu-ai/tianshu/commit/4b994b19f53f7fdf35abfeef649727775080c36f))
* generate_image saves to workspace + renders in chat UI ([8ffb422](https://github.com/tianshu-ai/tianshu/commit/8ffb422bf66623f9a0c3e11c4bbb6689ae57e3a2))
* image-gen adds Model dropdown in Settings ([2af89f1](https://github.com/tianshu-ai/tianshu/commit/2af89f10128855a1200566a079e236730b401f35))
* image-gen plugin uses resolveModel to reuse configured providers ([497b5b4](https://github.com/tianshu-ai/tianshu/commit/497b5b4081afae68eefabec957a5901eb7c752b8))
* sidebar brand mark uses Chinese calligraphy for 'Tianshu' ([966df75](https://github.com/tianshu-ai/tianshu/commit/966df75ae4a2ebc5ce59969b6bc7c22a35609c63))
* sidebar brand mark uses generated Chinese calligraphy PNG ([e9f002b](https://github.com/tianshu-ai/tianshu/commit/e9f002b7255480608a51a6fc20c371f196b8b485))
* sidebar brand mark uses Long Cang cursive + warm gradient ([92259c0](https://github.com/tianshu-ai/tianshu/commit/92259c0f560173de9f9b8a7ae6e06d5b1e152575))
* sidebar brand mark uses modern rounded Chinese + sparkle ([5f733fd](https://github.com/tianshu-ai/tianshu/commit/5f733fdb8cf4845009bc3e07e30d0ef3ab09f320))


### Bug Fixes

* image-gen configSchema use valid field kinds (string/secret) ([cfef4c0](https://github.com/tianshu-ai/tianshu/commit/cfef4c0707320856d1710e45f556f436282aea92))
* Lightbox zoom now uses discrete levels (fit / 100% / 200%) ([f5f7b23](https://github.com/tianshu-ai/tianshu/commit/f5f7b23b103170c0eacd7df237de7d9f185e0e2f))
* tighter alpha cutoff on brand logo eliminates blue bg bleed ([6bfee62](https://github.com/tianshu-ai/tianshu/commit/6bfee62b00d7688b1b8b93991277d28d723548e5))


### Refactor

* image-gen auto-discovers image-gen models from tenant config ([75d43d5](https://github.com/tianshu-ai/tianshu/commit/75d43d5347084f17d9c3c0aa4031d9e1830e7928))

## [0.63.1](https://github.com/tianshu-ai/tianshu/compare/v0.63.0...v0.63.1) (2026-09-23)


### Bug Fixes

* skip auto-recovery on 4xx client errors to prevent retry loop ([91ad74c](https://github.com/tianshu-ai/tianshu/commit/91ad74cd4424be3b85bf42488420390ef1652d80))

## [0.63.0](https://github.com/tianshu-ai/tianshu/compare/v0.62.0...v0.63.0) (2026-09-23)


### Features

* improve systemd service reliability for Linux deployments ([9f8c3c4](https://github.com/tianshu-ai/tianshu/commit/9f8c3c49f5795363efa01e8558049ab729c3bf44))


### Performance

* optimize getPathToRoot for large sessions — recursive CTE, content projection, path cache ([95908b7](https://github.com/tianshu-ai/tianshu/commit/95908b76c6b26bc56ce3e2f91dcc3c0815ecd74f))

## [0.62.0](https://github.com/tianshu-ai/tianshu/compare/v0.61.0...v0.62.0) (2026-09-21)


### Features

* inject Qwen3-TTS prosody markup hints in voice mode ([18952d1](https://github.com/tianshu-ai/tianshu/commit/18952d1e56cded9c49a568f14acbfeceb89d32f9))


### Reverts

* remove Qwen3-TTS prosody markup from voice mode prompt ([079f285](https://github.com/tianshu-ai/tianshu/commit/079f28504c523d11705c8c599b45a0036cbae191))

## [0.61.0](https://github.com/tianshu-ai/tianshu/compare/v0.60.2...v0.61.0) (2026-09-21)


### Features

* add 5 voice ref audio for Qwen3-TTS voice cloning ([13d166c](https://github.com/tianshu-ai/tianshu/commit/13d166c2c0213e7986a0a86b5a2aac5fcb1b90fc))
* add start.sh for Qwen3-TTS server + fix install.sh & server.py ([b7635af](https://github.com/tianshu-ai/tianshu/commit/b7635af546998fec58fabeb362fb2045c660843b))
* dynamic voice list for Qwen3-TTS from /health endpoint ([509b20c](https://github.com/tianshu-ai/tianshu/commit/509b20cf4784d32dc171f01961b4fb56402a7f88))


### Bug Fixes

* streaming GET path respects user-selected TTS provider ([7547f00](https://github.com/tianshu-ai/tianshu/commit/7547f00d42a0ef94fb6aa217c1c2b33bb712e1b2))

## [0.60.2](https://github.com/tianshu-ai/tianshu/compare/v0.60.1...v0.60.2) (2026-09-21)


### Bug Fixes

* remove test-key-1 fallback from resolveApiKey ([8b70b1f](https://github.com/tianshu-ai/tianshu/commit/8b70b1f84f81c05ce10f908a788ecd808d97cc07))

## [0.60.1](https://github.com/tianshu-ai/tianshu/compare/v0.60.0...v0.60.1) (2026-09-21)


### Bug Fixes

* **i18n:** add TTS nav entry to localizeCorePageLabel ([8c5aa82](https://github.com/tianshu-ai/tianshu/commit/8c5aa820a118afe93e37ddc06292722c703460ef))

## [0.60.0](https://github.com/tianshu-ai/tianshu/compare/v0.59.1...v0.60.0) (2026-09-21)


### Features

* bundle qwen3-tts server.py into tianshu repo ([d3a3afa](https://github.com/tianshu-ai/tianshu/commit/d3a3afa43a7c9c6a0e28036f5eeff22223c9ba5e))
* edge TTS also uses streaming GET playback ([ccc0dad](https://github.com/tianshu-ai/tianshu/commit/ccc0dadc4e76823928414520249b0dd8d6a5739b))
* include TTS server in npm package, teach setup agent to find it ([9a72ae0](https://github.com/tianshu-ai/tianshu/commit/9a72ae02bcc074b3aa8be3aea5a7454eb92b3806))
* one-click install.sh for Qwen3-TTS server ([6179d83](https://github.com/tianshu-ai/tianshu/commit/6179d835ec2bf6172e1b1e5a630e451136a66d7a))
* **setup:** add TTS domain knowledge to setup agent ([e1d4c2e](https://github.com/tianshu-ai/tianshu/commit/e1d4c2ed96b877c2cf68f462f74fb071c89208bd))
* streaming playback for qwentts — audio starts in ~450ms ([4b81e3e](https://github.com/tianshu-ai/tianshu/commit/4b81e3e146da092ecc4b6d41e7052970c85c3988))
* **tts:** replace CosyVoice/Kokoro with Qwen3-TTS MLX ([ce38f7d](https://github.com/tianshu-ai/tianshu/commit/ce38f7d5c857a97ad39902475642d02b63a8fc43))
* voice cloning support with yujie ref audio ([307aa1f](https://github.com/tianshu-ai/tianshu/commit/307aa1f651e64657075f4461491f270a8ae75d7c))


### Bug Fixes

* escape backticks in template string that broke TS build ([2d467d8](https://github.com/tianshu-ai/tianshu/commit/2d467d8c3275af86718b57a0d1f42d60246f8df2))
* **setup:** clarify TTS is a built-in Tianshu feature ([d6c9556](https://github.com/tianshu-ai/tianshu/commit/d6c95560463b6625ab5b40207831e1ebafff0dca))
* **setup:** resolve global config before reading defaultModelId ([fa33e2d](https://github.com/tianshu-ai/tianshu/commit/fa33e2d36b17b0d663414c3f4c4ad8c9339e63e1))
* **setup:** stop rejecting test-key-1 as sentinel in probe ([3ee38f8](https://github.com/tianshu-ai/tianshu/commit/3ee38f829c3c7a960b733c0ccad2ab01a1ad13cf))
* **wiki:** embedding diagnostics, Test Connection probe, and auto /v1 prefix ([fb38e18](https://github.com/tianshu-ai/tianshu/commit/fb38e18d62cf2215a0a81559ad53d48d29960143))


### Performance

* true streaming TTS — first chunk ~450ms regardless of text length ([b4d4152](https://github.com/tianshu-ai/tianshu/commit/b4d415292ece7ed8387dfddb33629369ba5dfa62))
* upgrade default TTS model to 1.7B-bf16 for better quality ([c502124](https://github.com/tianshu-ai/tianshu/commit/c502124755c3a0f3e5ffaf2557cebb96bee0514d))


### Documentation

* support both venv and conda for Qwen3-TTS setup ([0bde798](https://github.com/tianshu-ai/tianshu/commit/0bde798045a092384838c463598810f788ccf04c))

## [0.59.1](https://github.com/tianshu-ai/tianshu/compare/v0.59.0...v0.59.1) (2026-09-20)


### Bug Fixes

* **release:** trigger v0.59.1 publish after v0.59.0 stuck in npm stage ([e8716e4](https://github.com/tianshu-ai/tianshu/commit/e8716e480cf507ae911bfe3f618f73fa2895b68f))

## [0.59.0](https://github.com/tianshu-ai/tianshu/compare/v0.58.0...v0.59.0) (2026-09-20)


### Features

* **voice:** mode toggle shows next-mode icon (Headphones ↔ Keyboard) ([945e2c1](https://github.com/tianshu-ai/tianshu/commit/945e2c18c351acb5aae71fcf32555c8cb40733bc))

## [0.58.0](https://github.com/tianshu-ai/tianshu/compare/v0.57.0...v0.58.0) (2026-09-20)


### Features

* **voice:** add explicit exit button next to headphones badge ([f0ae52e](https://github.com/tianshu-ai/tianshu/commit/f0ae52ec6baf0c5409d1dead7cc31a4620156a74))
* **voice:** swap voice toggle icon Volume2/X → Headphones ([a3f9e12](https://github.com/tianshu-ai/tianshu/commit/a3f9e12d21e573abd593afec214499721196e629))

## [0.57.0](https://github.com/tianshu-ai/tianshu/compare/v0.56.0...v0.57.0) (2026-09-20)


### Features

* **voice:** tighter length guidance — brief + lead with conclusion ([a469d67](https://github.com/tianshu-ai/tianshu/commit/a469d6710f1571419b5aa8fbc40cf6ee4844ee33))

## [0.56.0](https://github.com/tianshu-ai/tianshu/compare/v0.55.0...v0.56.0) (2026-09-20)


### Features

* **voice:** frosted-glass panel behind currently-playing chunk ([1857a4e](https://github.com/tianshu-ai/tianshu/commit/1857a4e328af0845f67fa0c98b165d67e4f74dee))

## [0.55.0](https://github.com/tianshu-ai/tianshu/compare/v0.54.2...v0.55.0) (2026-09-20)


### Features

* **voice:** theme-aware subtitle gradient + glow via CSS vars ([271a0b4](https://github.com/tianshu-ai/tianshu/commit/271a0b4f721eba0c72e14bcaa0f90df9f47bd08a))

## [0.54.2](https://github.com/tianshu-ai/tianshu/compare/v0.54.1...v0.54.2) (2026-09-20)


### Bug Fixes

* **ci:** add .npmrc legacy-peer-deps for edge-tts ERESOLVE ([551ef44](https://github.com/tianshu-ai/tianshu/commit/551ef4484c5a7d519947a0eaf97c6704a5884a6d))

## [0.54.1](https://github.com/tianshu-ai/tianshu/compare/v0.54.0...v0.54.1) (2026-09-20)


### Bug Fixes

* **tts:** hoist @andresaya/edge-tts to root deps for npm publish ([3dbd9a3](https://github.com/tianshu-ai/tianshu/commit/3dbd9a3bfaa5ede02856a474cb6bb45a345f0611))

## [0.54.0](https://github.com/tianshu-ai/tianshu/compare/v0.53.9...v0.54.0) (2026-09-20)


### Features

* **tts:** add edge-tts provider as default (no local model needed) ([01bbc0c](https://github.com/tianshu-ai/tianshu/commit/01bbc0cc0f9f4d3c83396fb1a513d80a445818bc))
* voice conversation mode ([dc1fcd6](https://github.com/tianshu-ai/tianshu/commit/dc1fcd6e2e15df52091d367c7caa1f35768f0593))
* **voice:** Apple Music-style lyric scroll for subtitle view ([cc6fe92](https://github.com/tianshu-ai/tianshu/commit/cc6fe92c280457681ea11c73843dd81c675f2b77))
* **voice:** author-driven &lt;chunk&gt; boundaries replace regex slicing ([fe3bd4a](https://github.com/tianshu-ai/tianshu/commit/fe3bd4a2be80a8abf8ec585d70874ed1eb876b46))
* **voice:** auto-speak assistant replies when voice mode is on ([fea9574](https://github.com/tianshu-ai/tianshu/commit/fea95748bdf57d3b92739e809c81ea23d70551bf))
* **voice:** big-font 3-row subtitle view for voice mode ([4f158e6](https://github.com/tianshu-ai/tianshu/commit/4f158e67836daeae1ccd0325b5edc819c96acaba))
* **voice:** big-screen composer in voice mode ([05f594a](https://github.com/tianshu-ai/tianshu/commit/05f594a9e5679bfc67a327b70d86fa643dfc162a))
* **voice:** blank-line chunk boundaries (opus-friendly) ([ffc14d9](https://github.com/tianshu-ai/tianshu/commit/ffc14d99e2bf8e68f79ffd1056211b94aea66a5a))
* **voice:** concat all assistant chunks for cross-turn continuity ([d68a676](https://github.com/tianshu-ai/tianshu/commit/d68a676f06d90974c48fc76843d82de8b4e4fbe1))
* **voice:** filmstrip scroll effect for subtitle view ([4639fb1](https://github.com/tianshu-ai/tianshu/commit/4639fb169fd653438a45c1daf85342b7cf0baa93))
* **voice:** global keydown auto-focuses composer in voice mode ([6151611](https://github.com/tianshu-ai/tianshu/commit/6151611afdc5dbe3339a965a1482219774f3dbb9))
* **voice:** gradient text + glow filter for current subtitle row ([89e69f9](https://github.com/tianshu-ai/tianshu/commit/89e69f97958e9ac459a9f1b03171036e12d43e34))
* **voice:** interrupt playback when user sends new message ([7ab5429](https://github.com/tianshu-ai/tianshu/commit/7ab542954173993df720e2ab92c190592419fe00))
* **voice:** keep composer focused in voice mode for IME dictation ([64edccb](https://github.com/tianshu-ai/tianshu/commit/64edccb921a54ec66db3acb7aa94af55cc0b3f2d))
* **voice:** lookahead prefetch to eliminate inter-slice gaps ([175d6cb](https://github.com/tianshu-ai/tianshu/commit/175d6cbf58cc1bd6de63381eb8cfe25221ae4410))
* **voice:** per-message play button + global single-active playback ([09c7a3e](https://github.com/tianshu-ai/tianshu/commit/09c7a3ea8ea9903fcacce7bee8aed782f62586b2))
* **voice:** pin user question at top of subtitle view ([96b56a2](https://github.com/tianshu-ai/tianshu/commit/96b56a2b9bbea425d5c761d18e6892a42a9c303d))
* **voice:** prompt tianshu to narrate before every tool call ([7f08daa](https://github.com/tianshu-ai/tianshu/commit/7f08daa845967951619d30ce33b7f72d33f84cdd))
* **voice:** rewrite voice-mode fragment for fully-spoken reply style ([8f394cb](https://github.com/tianshu-ai/tianshu/commit/8f394cb50adc7c1d8b76bdc1e2ce8b04b6c3277f))
* **voice:** scaffold TTS proxy + client hooks for CosyVoice 2 ([26fe688](https://github.com/tianshu-ai/tianshu/commit/26fe6881d312a749d82087a2717195e7bb95f94b))
* **voice:** stream edge-tts via MediaSource to halve perceived delay ([8b323fc](https://github.com/tianshu-ai/tianshu/commit/8b323fc308581f69c6bdc223e664add9260fd555))
* **voice:** streaming per-sentence TTS enqueue ([0432117](https://github.com/tianshu-ai/tianshu/commit/04321176a629c578b44417d7ac5c4d1359024745))
* **voice:** switch from &lt;voice_summary&gt; opt-in to &lt;silent&gt; opt-out ([47b5dbd](https://github.com/tianshu-ai/tianshu/commit/47b5dbd73aeb12249cacf290060eb0986bf6154b))
* **voice:** TTS settings page + runtime provider switching ([b28ae62](https://github.com/tianshu-ai/tianshu/commit/b28ae622acc308c7165392e7169427b0c5b855ac))
* **voice:** voice-mode-aware system prompt + subtitle-style playback ([e2c15fe](https://github.com/tianshu-ai/tianshu/commit/e2c15fe52760703a3cf2c39541bbb78525e48ff3))


### Bug Fixes

* **tts:** align /api/tts with CosyVoice server.py actual shape ([656daf4](https://github.com/tianshu-ai/tianshu/commit/656daf4b55a4c1c939456f1b69d2c49203c4cb54))
* **voice:** abort in-flight play promise on stop() so drain loop resumes ([924f3d3](https://github.com/tianshu-ai/tianshu/commit/924f3d3c5d50762486340a725ee885bbdd49765c))
* **voice:** cache effectiveIndex to stop filmstrip scroll on new chunk ([b8c08a8](https://github.com/tianshu-ai/tianshu/commit/b8c08a8d7fce02cf8a2e8cbbf8052e743c14affc))
* **voice:** clean up subtitle layout (truncate off-center, drop halo) ([e44f458](https://github.com/tianshu-ai/tianshu/commit/e44f45881f6849d0e24f0349153d6fef000bfb3a))
* **voice:** defer blob URL revoke until next play() rebinds audio.src ([79e9d6d](https://github.com/tianshu-ai/tianshu/commit/79e9d6db9dda3f34432a3e3416ed7d50b4619800))
* **voice:** defer seed until messages array first non-empty ([50f28e1](https://github.com/tianshu-ai/tianshu/commit/50f28e196f148589dc21da8c8931368a9d3af32d))
* **voice:** don't speak pre-existing tail message on mount ([190b8ef](https://github.com/tianshu-ai/tianshu/commit/190b8efbaf2cfb5506aeecf3f494b3ee2b647954))
* **voice:** drain loop must not flush the pending queue ([8635e8c](https://github.com/tianshu-ai/tianshu/commit/8635e8cf1e2ceaf1350f00140eff5fee456974ce))
* **voice:** drop MediaSource path, use blob-only for multi-slice streaming ([141dfa6](https://github.com/tianshu-ai/tianshu/commit/141dfa6fd0280587481caa582e170027a4756aaf))
* **voice:** flush prev tail trailing region on tail-swap ([00d1331](https://github.com/tianshu-ai/tianshu/commit/00d13310eb3ee7b583c513a4e0beb5f26586f3c9))
* **voice:** guard cleanup against stale ended events from prior slice ([2ead1e4](https://github.com/tianshu-ai/tianshu/commit/2ead1e4722e572a4d85044c46a610369b3387ace))
* **voice:** guard MediaSource lifecycle against rapid speak() reentry ([68db43a](https://github.com/tianshu-ai/tianshu/commit/68db43a29b3319dc8472c5906b1cfa0a828324d3))
* **voice:** hide streamed &lt;voice_summary&gt; body from opening tag onward ([332bf14](https://github.com/tianshu-ai/tianshu/commit/332bf14aa93cb2efbeb586c06300a6a34691c0ff))
* **voice:** inherit cursor across placeholder→persistent id swap ([f17a5dc](https://github.com/tianshu-ai/tianshu/commit/f17a5dc1eec29183dce38d9271e46770c027462c))
* **voice:** keep full chunk history so subtitle indices stay stable ([99a4bd8](https://github.com/tianshu-ai/tianshu/commit/99a4bd84da003e173c445fc6989ea6143939141c))
* **voice:** keep plugin top-bar buttons in subtitle header ([b9c4def](https://github.com/tianshu-ai/tianshu/commit/b9c4def70c20a18c801727228758eae4a4db63b1))
* **voice:** lower swap threshold so short pre-tool sentences don't lose their first chunk ([55812f2](https://github.com/tianshu-ai/tianshu/commit/55812f20668aaedbe8f5c53e746b295e64b7f3fe))
* **voice:** make chunk-every-sentence explicit in system prompt ([f54ec0d](https://github.com/tianshu-ai/tianshu/commit/f54ec0d027ed8b3b17a6c39d27e2d016426b8e78))
* **voice:** make useVoiceMode a shared store (fix toggle no-op) ([a607b53](https://github.com/tianshu-ai/tianshu/commit/a607b536bf2f078cf0aae6279f70302a06ef17d0))
* **voice:** only stream-slice the last assistant message ([0b56d7d](https://github.com/tianshu-ai/tianshu/commit/0b56d7daeaf4754454c5e3762664259eef40f756))
* **voice:** preserve speechSource when coalescing assistant turns ([cfabaf8](https://github.com/tianshu-ai/tianshu/commit/cfabaf85014cb4c357dcce7c8a1b41ddd3318a32))
* **voice:** remove duplicate el.src = url in MediaSource path ([cb88550](https://github.com/tianshu-ai/tianshu/commit/cb8855058917d61587b3cbca52b7c0f0cd128159))
* **voice:** retry initial composer focus with rAF verification ([f175b57](https://github.com/tianshu-ai/tianshu/commit/f175b5760a332a71e0efeed9e0a18d94b088b34a))
* **voice:** revoke blob URL after audio detach to avoid ERR_FILE_NOT_FOUND ([d31e118](https://github.com/tianshu-ai/tianshu/commit/d31e1182c774f519b3da2097011d35bd54b5270b))
* **voice:** revoke blob URL on audio 'emptied' event, not microtask ([aebc5da](https://github.com/tianshu-ai/tianshu/commit/aebc5dad55f395ddb9e0146660397ee0bcea91af))
* **voice:** seed new tail cursor after swap-flush to avoid double play ([01a929e](https://github.com/tianshu-ai/tianshu/commit/01a929e7dd9ea24ddd84d510c474c740a370e569))
* **voice:** seed short tail as new-streaming regardless of isStreaming flag ([c622b00](https://github.com/tianshu-ai/tianshu/commit/c622b00bf95ccd36ed151b64bcc9fd858117cc3d))
* **voice:** seed streaming tail cursor to 0 to catch opening chunks ([861338e](https://github.com/tianshu-ai/tianshu/commit/861338e912985fbf975e0a8cf00402752130ec33))
* **voice:** show speak button on block-only assistant replies ([c37b64c](https://github.com/tianshu-ai/tianshu/commit/c37b64c9f3f5cfb62b74d30b469f0694c6351937))
* **voice:** slice on speechSource not m.text (chunk tags stripped) ([71f0e24](https://github.com/tianshu-ai/tianshu/commit/71f0e243aba936efbc27cd4395eb1f85875547c1))
* **voice:** speak every assistant message in multi-step replies ([6644e19](https://github.com/tianshu-ai/tianshu/commit/6644e19ce8e9a325c0eca1ff1836194fed9136e3))
* **voice:** stop filmstrip from covering composer controls ([ccc4723](https://github.com/tianshu-ai/tianshu/commit/ccc4723bedf1c52104a76514cf481bdc720dc5ce))
* **voice:** stop revoking blob URLs entirely — take 5, actually final ([b40e9cf](https://github.com/tianshu-ai/tianshu/commit/b40e9cf6c9f43bfaa2fab76e23e88a0a5f13948a))
* **voice:** stop subtitle flicker on streaming delta ([6d6212d](https://github.com/tianshu-ai/tianshu/commit/6d6212d01d31116a389df13062bea0c0f2848d35))
* **voice:** stop subtitle rows overlapping (bump row height + clamp) ([c306892](https://github.com/tianshu-ai/tianshu/commit/c306892d3a3085a7c77bf1200ef743c0bbfe634e))
* **voice:** strip emoji, image markdown, and raw URLs from TTS text ([3f7a0ef](https://github.com/tianshu-ai/tianshu/commit/3f7a0efdbcc6ed7c58525a4c3586ba4194babd21))
* **voice:** tighten currentIndex matching to stop chunk flip-flop ([79d13db](https://github.com/tianshu-ai/tianshu/commit/79d13db99189936bb5089e4ab98ea6b3d6a6dc1a))
* **voice:** tighten id-swap detection to real prefix matches only ([5d96fc8](https://github.com/tianshu-ai/tianshu/commit/5d96fc8e7d25a4703a604bdacb50900a814ebeca))
* **voice:** track last-tail across renders for id-swap cursor inheritance ([136a6ae](https://github.com/tianshu-ai/tianshu/commit/136a6aefd95ba05802d22d466814cb6236ecad0a))
* **voice:** wipe reused placeholder id's stale cursor on tail-swap ([5c1bced](https://github.com/tianshu-ai/tianshu/commit/5c1bced42876022a6844741335b31dc6eb7184ad))


### Performance

* **voice:** memoize FilmstripRow to stop full re-render on delta ([6673078](https://github.com/tianshu-ai/tianshu/commit/66730784967f3d8e1667e14ce5adf5aa8ebd65d7))


### Documentation

* **voice:** add CosyVoice local setup checklist ([867d1fd](https://github.com/tianshu-ai/tianshu/commit/867d1fdf5df2f20c40bb5791cd88e08b1fd2846f))

## [0.53.9](https://github.com/tianshu-ai/tianshu/compare/v0.53.8...v0.53.9) (2026-09-19)


### Bug Fixes

* **asr:** mount POST /api/transcribe after tenantMiddleware so auth works ([0d36463](https://github.com/tianshu-ai/tianshu/commit/0d364632b56f66aa8158fd226a370f0b933002fb))
* **voice:** send credentials on POST /api/transcribe so cookie auth works ([4ed38ff](https://github.com/tianshu-ai/tianshu/commit/4ed38ff56515fe5185b83a7da4c7294a9821424f))

## [0.53.8](https://github.com/tianshu-ai/tianshu/compare/v0.53.7...v0.53.8) (2026-09-18)


### Bug Fixes

* **observability:** time pruneOldToolResults + warn on slow or large-context sessions ([01f3dd0](https://github.com/tianshu-ai/tianshu/commit/01f3dd0eadc150323f711e90cc0c254a1e88e1b8))

## [0.53.7](https://github.com/tianshu-ai/tianshu/compare/v0.53.6...v0.53.7) (2026-09-18)


### Bug Fixes

* **idle-runner:** stop swallowing background-turn errors on webchat ([634b2ce](https://github.com/tianshu-ai/tianshu/commit/634b2ced12dab31adaaafcbfe8872cbc44e2553a))
* **inbox:** release flush lock after 60s to prevent notification stalls ([32bcc96](https://github.com/tianshu-ai/tianshu/commit/32bcc96f72d2a9d82a182355b4e1e74e922bbf28))
* **observability:** log large tool_result + abort in-flight tool state ([12a328e](https://github.com/tianshu-ai/tianshu/commit/12a328efcf60bf066fe167db097de12b9d70b632))

## [0.53.6](https://github.com/tianshu-ai/tianshu/compare/v0.53.5...v0.53.6) (2026-09-16)


### Bug Fixes

* **compact:** raise default triggerPercent from 50 to 80 in main handler ([4b82b4d](https://github.com/tianshu-ai/tianshu/commit/4b82b4d97509bd059b73074e4517b6b6ad4ef724))
* **config:** unify default-model field onto models.defaultModelId; deprecate top-level defaultModel ([a636259](https://github.com/tianshu-ai/tianshu/commit/a6362597afff8d6d2bd710ec10872552ce2eaa77))

## [0.53.5](https://github.com/tianshu-ai/tianshu/compare/v0.53.4...v0.53.5) (2026-09-16)


### Bug Fixes

* **prompt:** strengthen "never ask permission to continue" in execution bias ([96803f5](https://github.com/tianshu-ai/tianshu/commit/96803f5b98c8ae79b25ba2568dac5f10f148b2ac))

## [0.53.4](https://github.com/tianshu-ai/tianshu/compare/v0.53.3...v0.53.4) (2026-09-16)


### Bug Fixes

* **chat:** skip stopReason=error/aborted assistant rows when loading history ([b9a9de1](https://github.com/tianshu-ai/tianshu/commit/b9a9de16f7b8a68cafc622925b058e1a25e399d3))

## [0.53.3](https://github.com/tianshu-ai/tianshu/compare/v0.53.2...v0.53.3) (2026-09-16)


### Bug Fixes

* disable heartbeat log by default (opt-in via TIANSHU_HEARTBEAT_ENABLE=1) ([6fc7212](https://github.com/tianshu-ai/tianshu/commit/6fc721260a91cbfd75f2782be762fe54406bf9e0))
* reduce heartbeat interval 100ms→5s + add watchOptions to tsconfig.base ([d1194f0](https://github.com/tianshu-ai/tianshu/commit/d1194f004fa2d0715926453a9c56dffcc396c1ac))
* remove diagnostic checkpoint logs ([ab55ea9](https://github.com/tianshu-ai/tianshu/commit/ab55ea9d5da1fb52f60b66345f93ad3c170584f7))


### Reverts

* remove catch-block inbox recovery (caused infinite processing) ([e6ddd88](https://github.com/tianshu-ai/tianshu/commit/e6ddd88e82a88ea11d054440267c6d68b57e7d23))
* roll back ws 8.21.3 and happy-dom 20.14.5 upgrades ([ac63857](https://github.com/tianshu-ai/tianshu/commit/ac63857ac1ac1420ee450a439edef4e20b2752a2))

## [0.53.2](https://github.com/tianshu-ai/tianshu/compare/v0.53.1...v0.53.2) (2026-09-16)


### Bug Fixes

* silence bridge registered log (PluginLogger has no debug) ([8588596](https://github.com/tianshu-ai/tianshu/commit/85885961ec043d410818134e9783314dcc41aa24))

## [0.53.1](https://github.com/tianshu-ai/tianshu/compare/v0.53.0...v0.53.1) (2026-09-16)


### Bug Fixes

* catch-block inbox recovery for all transient errors ([c61c946](https://github.com/tianshu-ai/tianshu/commit/c61c9460f34ca795cfa72b32b49325ef37dd634f))
* downgrade bridge registered log from info to debug ([db2dda9](https://github.com/tianshu-ai/tianshu/commit/db2dda9510184d1a36075c709335dfc415c62a26))

## [0.53.0](https://github.com/tianshu-ai/tianshu/compare/v0.52.1...v0.53.0) (2026-09-15)


### Features

* **board:** serve sibling CSS/JS/image assets next to index.html ([0c594d3](https://github.com/tianshu-ai/tianshu/commit/0c594d3b810fa589aa9e22a8e6fd23f28405f821))
* log abort/error detail for debugging + remove diag logs ([cc58103](https://github.com/tianshu-ai/tianshu/commit/cc58103ddf75cbff75550347306f4c0f19c95e79))


### Bug Fixes

* **compact:** always post an inbox note after post-turn auto-compaction ([ed0dab2](https://github.com/tianshu-ai/tianshu/commit/ed0dab2bbcb3d2af04d6fd722999334d06943a3c))

## [0.52.1](https://github.com/tianshu-ai/tianshu/compare/v0.52.0...v0.52.1) (2026-09-14)


### Bug Fixes

* document why storage debug logging is gated; land as v0.52.1 ([f00b179](https://github.com/tianshu-ai/tianshu/commit/f00b179c229149da5526810cdca03d112b3b3f28))

## [0.52.0](https://github.com/tianshu-ai/tianshu/compare/v0.51.0...v0.52.0) (2026-09-14)


### Features

* auto-continue after post-turn compaction ([a743344](https://github.com/tianshu-ai/tianshu/commit/a7433442bb4399da37cf45c7a4754441b1132486))
* **log:** event-loop heartbeat every 100ms for self-locating stalls ([f1fb244](https://github.com/tianshu-ai/tianshu/commit/f1fb244d691f4c6abd29af4341bed2072493b9f7))
* **log:** timestamps, tool-call traces, TIANSHU_LOG_LEVEL, dedup bridge heartbeat ([73821ec](https://github.com/tianshu-ai/tianshu/commit/73821ecc13c7aa6e644e73265ff3761f42738ee1))


### Bug Fixes

* all tool-orphan filters now recognize tool_use + tool_use_id format ([cbe534f](https://github.com/tianshu-ai/tianshu/commit/cbe534f33f834ac5cc4fa33c50363c1455c93aa1))
* auto-recovery uses inbox instead of in-turn harness.prompt() ([8b85a03](https://github.com/tianshu-ai/tianshu/commit/8b85a03d13f15881c24e28ba5edd800cac2f5493))
* cap auto-recovery retries + self-heal orphaned tool_result ([93e866c](https://github.com/tianshu-ai/tianshu/commit/93e866ce6a6f30862c9e0255c220c96583a3e48f))
* filterOrphanedToolResults also recognizes tool_use format ([9228d27](https://github.com/tianshu-ai/tianshu/commit/9228d271fccea36e633c54d15efb63977f347de1))
* force compaction on Anthropic 400 orphaned tool_result ([009521b](https://github.com/tianshu-ai/tianshu/commit/009521b6f2eea448f501790003e976f8b88b4557))
* pre-purge orphaned tool_result before auto-recovery retry ([ad54b0a](https://github.com/tianshu-ai/tianshu/commit/ad54b0a7a9ae5849a96d20b06d93bacc2648440e))
* purgeOrphanedToolResults recognizes both toolCall and tool_use formats ([c6dccaa](https://github.com/tianshu-ai/tianshu/commit/c6dccaa3513beaac0cae394a8d27e9a40fc4248a))
* WS ping/pong keepalive + bridge disconnect grace period ([2ae64d9](https://github.com/tianshu-ai/tianshu/commit/2ae64d9febb25151c28e60a654fb87fd74b835b8))

## [0.51.0](https://github.com/tianshu-ai/tianshu/compare/v0.50.3...v0.51.0) (2026-09-13)


### Features

* **server:** rolling-file log tee under ~/.tianshu/logs ([5ad11ae](https://github.com/tianshu-ai/tianshu/commit/5ad11aeb68b77577e66cb2062354adbade3f61e1))

## [0.50.3](https://github.com/tianshu-ai/tianshu/compare/v0.50.2...v0.50.3) (2026-09-13)


### Bug Fixes

* **chat:** mine assistant JSON for tool names when recovery Map is empty ([750ce9e](https://github.com/tianshu-ai/tianshu/commit/750ce9efe97756afa3de4d22fb30abc35be0476c))

## [0.50.2](https://github.com/tianshu-ai/tianshu/compare/v0.50.1...v0.50.2) (2026-09-13)


### Performance

* **storage:** gate verbose getPathToRoot logging behind env flag ([0f130af](https://github.com/tianshu-ai/tianshu/commit/0f130afae5ba5700214abaeb35b7cdaec6d20a26))

## [0.50.1](https://github.com/tianshu-ai/tianshu/compare/v0.50.0...v0.50.1) (2026-09-13)


### Bug Fixes

* **chat:** name the failing tool in auto-recovery retry prompt ([6828eea](https://github.com/tianshu-ai/tianshu/commit/6828eeae6f5645b7ac54509988ee47bace7c794f))

## [0.50.0](https://github.com/tianshu-ai/tianshu/compare/v0.49.1...v0.50.0) (2026-09-13)


### Features

* **tools:** wrap every tool executor with an actionable error guard ([300ce9e](https://github.com/tianshu-ai/tianshu/commit/300ce9e437602eef1f13f87adba5fcf0aa5c4f48))

## [0.49.1](https://github.com/tianshu-ai/tianshu/compare/v0.49.0...v0.49.1) (2026-09-12)


### Bug Fixes

* **chat:** use prompt() not followUp() for auto-continue/recovery ([802e208](https://github.com/tianshu-ai/tianshu/commit/802e2085f9fe0021e0d9ebcb05d51b52fe5f21e7))

## [0.49.0](https://github.com/tianshu-ai/tianshu/compare/v0.48.8...v0.49.0) (2026-09-12)


### Features

* **chat:** progressive-history disclosure for long sessions ([c6d5ae1](https://github.com/tianshu-ai/tianshu/commit/c6d5ae15ad3b5ca120746992f099d8b96d300f24))
* **chat:** tag old-region user turns with absolute turn numbers ([32463d9](https://github.com/tianshu-ai/tianshu/commit/32463d9c43db98bfc8714c84faab5937b8d7f41b))


### Bug Fixes

* **chat:** keep tool_use blocks intact when stubbing old tool calls ([cbf9791](https://github.com/tianshu-ai/tianshu/commit/cbf9791fe4efad986acd5c6105991ad3a1834827))
* **chat:** skip tianshu-injected pseudo-user messages when counting turns ([287f378](https://github.com/tianshu-ai/tianshu/commit/287f37846f650dc3ff4e5a8f1671e909a7797f9a))
* update release-please manifest to 0.48.8 ([dbaac3a](https://github.com/tianshu-ai/tianshu/commit/dbaac3a5ebc56fd0c349ffc47d691220faf94eda))

## [0.46.1](https://github.com/tianshu-ai/tianshu/compare/v0.46.0...v0.46.1) (2026-09-07)


### Bug Fixes

* use TIANSHU_HOME/models for ASR model storage ([6bc27e3](https://github.com/tianshu-ai/tianshu/commit/6bc27e3ba438d639d264d324db6f9d8374fedb41))

## [0.46.0](https://github.com/tianshu-ai/tianshu/compare/v0.45.0...v0.46.0) (2026-09-07)


### Features

* ASR model management admin page ([cdf361b](https://github.com/tianshu-ai/tianshu/commit/cdf361bc06c8cff981b3e87ec44addf2a17ebbed))
* auto-select best installed ASR model ([455db84](https://github.com/tianshu-ai/tianshu/commit/455db84cb8abc8e04f0c5f85e0c1cfa4d20cf23b))
* customizable push-to-talk shortcut ([4ba743e](https://github.com/tianshu-ai/tianshu/commit/4ba743ef676514272044f7b8072cb61229efa1dc))
* hide mic button when no ASR model is active ([f9bcfe9](https://github.com/tianshu-ai/tianshu/commit/f9bcfe9995c00b43969bb2163d7ca195885ee662))
* in-browser Whisper voice input (no external API) ([8b46aba](https://github.com/tianshu-ai/tianshu/commit/8b46abafdc7982303f92d1221643e4dd1cf1b5e6))
* manual ASR model selection ([fa34f39](https://github.com/tianshu-ai/tianshu/commit/fa34f390ec80af1977d096750485cb73294469e3))
* push-to-talk Alt+V + voice UX improvements ([22aa87e](https://github.com/tianshu-ai/tianshu/commit/22aa87e43cb4013c101c9d3d140e0bd171fdf56b))
* server-side ASR with sherpa-onnx-node (no Python, no cloud) ([a10ed26](https://github.com/tianshu-ai/tianshu/commit/a10ed266dd7809f986be72cae5dfd0a11505793d))
* use hf-mirror.com for Whisper model download ([a62847e](https://github.com/tianshu-ai/tianshu/commit/a62847ead5061fb6c902d0d1b6b8c3d31e5b3035))
* voice input — microphone button in composer ([c43f510](https://github.com/tianshu-ai/tianshu/commit/c43f510e818d89d19e190cc3ae2be63380b0c668))


### Bug Fixes

* add React keys in ShellSidebarSection children ([4cd0533](https://github.com/tianshu-ai/tianshu/commit/4cd0533dd892556a157ecde6cadaeb1c791d1be4))
* asr.ts TS errors — ts-ignore sherpa-onnx-node, async fire-and-forget init ([767811a](https://github.com/tianshu-ai/tianshu/commit/767811aad2a3de7e12d9b635dffc2c837c447d42))
* broaden ASR model path search for monorepo layout ([dc3b5c5](https://github.com/tianshu-ai/tianshu/commit/dc3b5c5b33f3933cf6cacfb97f4c8e214c664846))
* change push-to-talk to Ctrl+Shift+M (⌥V types √ on Mac) ([5030ef5](https://github.com/tianshu-ai/tianshu/commit/5030ef54c25406bc5b47c5120b00006fd50ee156))
* correct model download sizes (actual tarball sizes from GitHub) ([488bee4](https://github.com/tianshu-ai/tianshu/commit/488bee41fab7f2581681e6f1ec594b87bba39a28))
* ESM compat — replace __dirname/require with import.meta.url/dynamic import ([eb5f326](https://github.com/tianshu-ai/tianshu/commit/eb5f3269fec6dc547d4139530abdd23431028f23))
* handle CJS/ESM interop for sherpa-onnx-node dynamic import ([3091378](https://github.com/tianshu-ai/tianshu/commit/3091378388de7ee3a50f0003ebf75dbd603292ba))
* HF model proxy — use middleware instead of wildcard route ([9125b09](https://github.com/tianshu-ai/tianshu/commit/9125b09d427edf3b0960e2affe13395924ff5415))
* HF proxy — use huggingface.co with streaming ([7a1c5b6](https://github.com/tianshu-ai/tianshu/commit/7a1c5b68843bb3cd91b4a589291c64beaab958f4))
* hot-reload ASR model on activate/download ([60326eb](https://github.com/tianshu-ai/tianshu/commit/60326ebe795918c795f0dabe033c8ba2a11e3c8e))
* move HF proxy before auth middleware ([b62a1ed](https://github.com/tianshu-ai/tianshu/commit/b62a1edecba9de64d830a14cb0a0ffd52b9114c5))
* show ⌥V on Mac, Alt+V on others; simplify recording hint ([b831877](https://github.com/tianshu-ai/tianshu/commit/b831877f3f7c7c351743280fdd76d7a8e754c7cf))
* switch to Gitee HF mirror (hf-mirror.com redirects back to HF) ([e81af09](https://github.com/tianshu-ai/tianshu/commit/e81af093edef66a74b8e0efeab693d3668cf3f83))
* unload recognizer when deleting active model ([9a5eea7](https://github.com/tianshu-ai/tianshu/commit/9a5eea7df98859634de11b94dc21cb6aac497c72))

## [0.45.0](https://github.com/tianshu-ai/tianshu/compare/v0.44.0...v0.45.0) (2026-09-07)


### Features

* adapt to @earendil-works/pi-agent-core 0.84.4 breaking changes ([c6ca47c](https://github.com/tianshu-ai/tianshu/commit/c6ca47cc6e9fb440788d3bafe2cc3901408f7835))
* api-reference skill — complete REST API docs for custom shell ([32d093c](https://github.com/tianshu-ai/tianshu/commit/32d093c05f897890cea261e4fb6b30d0a603c2b4))
* auto-inject shell session — no manual API call needed ([2d92dfa](https://github.com/tianshu-ai/tianshu/commit/2d92dfabb7f4e2a2280197474d5b24192a5f66bc))
* dedicated shell session — isolate shell UI conversations ([5a7c435](https://github.com/tianshu-ai/tianshu/commit/5a7c435444ece47dbc7be9ad39d8b8dc275a2c79))
* dual entry — /tenants (native) + /shell/tenants (custom UI) ([5779f4a](https://github.com/tianshu-ai/tianshu/commit/5779f4a3ebc6beb4cb9671f2a74996802d71b192))
* show shell session in native UI sidebar ([63a2121](https://github.com/tianshu-ai/tianshu/commit/63a2121c5f2455f871abd4fe40a2803ac517fb8e))
* ws-protocol skill — complete WebSocket chat protocol reference ([bd46f52](https://github.com/tianshu-ai/tianshu/commit/bd46f5240da115829254e272e90f60f435d1f4bd))


### Bug Fixes

* add YAML frontmatter to shell plugin skills ([6b1fabc](https://github.com/tianshu-ai/tianshu/commit/6b1fabce1ee895bed3a23fab1e8b5a1bcea7da90))
* correct plugin-sdk import path in custom-ui client ([26c9140](https://github.com/tianshu-ai/tianshu/commit/26c9140e8779457aab0067af2c87dbb3115bcace))
* correct WS protocol docs — type:'prompt' not type:'chat' ([9a1b18c](https://github.com/tianshu-ai/tianshu/commit/9a1b18c40314830f1aa7ac9af878ebd309a42283))
* guard harness.abort() against HarnessNotImplemented ([45ecc53](https://github.com/tianshu-ai/tianshu/commit/45ecc5330344597c5e0c7c02253f9775c8c0859d))
* proxy /tenants HTML requests to backend in dev mode ([7dbd38c](https://github.com/tianshu-ai/tianshu/commit/7dbd38cdef3a2df3c4bf1be0f1b20f4132a4ae75))
* replace symlinks with sync script for shell plugin dist/ ([7384757](https://github.com/tianshu-ai/tianshu/commit/73847570d23c5c7f7ed23f466d5890954f373feb))
* revert to harness.subscribe()/on() — events.on/hooks.on not implemented ([cce1558](https://github.com/tianshu-ai/tianshu/commit/cce15583c261b4293c9b4fd90417bb7562c0c6d9))
* shell plugin category runtime → ui ([cd11cc6](https://github.com/tianshu-ai/tianshu/commit/cd11cc6aee0fc4932df78013307874fa4d9da5e4))
* shell session auto-creation — use registry ctx instead of getTenantContext ([c0905a1](https://github.com/tianshu-ai/tianshu/commit/c0905a1cbd4f6798fe98b778760c0f44f696fd2f))


### Reverts

* pin pi-agent-core/pi-ai back to 0.82.1 ([ed94725](https://github.com/tianshu-ai/tianshu/commit/ed94725a82bde36b5d76762cd710ed020c53ec70))


### Documentation

* add session model docs to ws-protocol skill ([75fb5ac](https://github.com/tianshu-ai/tianshu/commit/75fb5ac72053c76921d95db63c680ca70637cd27))
* clarify history rendering in ws-protocol skill ([9203a7c](https://github.com/tianshu-ai/tianshu/commit/9203a7c83fe5dfbeb74743b26fec13c931d4ae9f))
* session isolation checklist in shell-dev skill ([7ba72b4](https://github.com/tianshu-ai/tianshu/commit/7ba72b4db427d373961f9e37c49dbf68584fcfd3))

## [0.44.0](https://github.com/tianshu-ai/tianshu/compare/v0.43.1...v0.44.0) (2026-09-07)


### Features

* **board:** fullscreen mode for board panel ([8fc4314](https://github.com/tianshu-ai/tianshu/commit/8fc43143c1c93308e90fbd57a59c947ee1f80e51))
* doctor + setup agent improvements from 09-05 learnings ([9232b65](https://github.com/tianshu-ai/tianshu/commit/9232b65864812c209b6499a7fba42ded2c746dcd))
* example-shell plugin — demo Dashboard UI replacing default frontend ([18c284e](https://github.com/tianshu-ai/tianshu/commit/18c284e1a3d4cfabecf05a58ff6d33777b0878c3))
* **openshell:** setup agent knows how to build tianshu sandbox image ([6f8ce3e](https://github.com/tianshu-ai/tianshu/commit/6f8ce3e9daee6e5f03e584817186848e0eb146b3))
* per-tenant shell directory — agent writes to _tenant/shell/ ([b419f19](https://github.com/tianshu-ai/tianshu/commit/b419f195b101b777df1d9cc5641e7d99e159d816))
* **setup:** agent knows all builtin plugins, runtime mutual exclusivity ([233379c](https://github.com/tianshu-ai/tianshu/commit/233379ccbe163afc01d56c1dbc266a103b868e75))
* shell plugin preview panel in default UI ([4f03b92](https://github.com/tianshu-ai/tianshu/commit/4f03b92ed174668234a3adcdf79246683da6da77))
* shell publish workflow — draft → preview → publish ([4a3c56c](https://github.com/tianshu-ai/tianshu/commit/4a3c56cbd806e71ca36d1b7267a2bce66d556fc7))
* UI shell plugins — tenant-level full frontend override (ADR-0005) ([0dc6126](https://github.com/tianshu-ai/tianshu/commit/0dc6126c7a0cfd1f424dc067c5ab3c039d1422ca))


### Bug Fixes

* add Paintbrush to plugin icon whitelist ([c032883](https://github.com/tianshu-ai/tianshu/commit/c032883e6543f8aa820d6312f3922db710364a23))
* **board:** chat-embedded boards get allow-same-origin for API access ([608da96](https://github.com/tianshu-ai/tianshu/commit/608da96aa2702bf8d350ace3078a2cfd6f073287))
* **board:** fullscreen toolbar opaque background, z-index above iframe ([28841f3](https://github.com/tianshu-ai/tianshu/commit/28841f3587f94326e2ff11664a04d8ece00ae160))
* **doctor:** only check plugin prerequisites for enabled plugins ([e9d868a](https://github.com/tianshu-ai/tianshu/commit/e9d868a4a5d671fc5f777baadcb9e541dc414a45))
* include plugins/**/sandbox-image/** in npm package files ([8dd8f33](https://github.com/tianshu-ai/tianshu/commit/8dd8f33a2db480bd2ad0394f4cd154cf90f914e7))
* **openshell:** Dockerfile ENTRYPOINT → CMD to not break sandbox provisioning ([d996482](https://github.com/tianshu-ai/tianshu/commit/d9964825e57bc0fb77449650a4b43c46c6278544))
* **openshell:** include sandbox-image/ in npm package files ([6bb80e4](https://github.com/tianshu-ai/tianshu/commit/6bb80e4c280f0801e9d90627167c2bc793b513cd))
* **openshell:** sandbox create uses /bin/bash -c true for ENTRYPOINT compat ([97388ac](https://github.com/tianshu-ai/tianshu/commit/97388ac25798b37391a821183aeda05bf1036a90))
* **openshell:** sandbox main process must stay alive — use sleep infinity ([4ab0a5b](https://github.com/tianshu-ai/tianshu/commit/4ab0a5b238a846030848cc9a0294939b4cb10ad0))
* shell lookup checks user home _tenant/shell/ first ([daf94d0](https://github.com/tianshu-ai/tianshu/commit/daf94d08b23d5be461008308c756a7ad6f40c6d6))
* shell plugin APIs gated on active plugin state ([3e51947](https://github.com/tianshu-ai/tianshu/commit/3e519472418cde86768a4ca95eeed8d096d46fd8))


### Documentation

* unify shell file conventions in prompt + skill ([2af09e6](https://github.com/tianshu-ai/tianshu/commit/2af09e6a5325f16a153a8a817ae08c54fc297a47))
* update README with datasource, board.ds, setup/doctor improvements ([f6d714a](https://github.com/tianshu-ai/tianshu/commit/f6d714ab87ea06a6c476fe74c2f7c31da2606ade))


### Refactor

* example-shell → scaffold + agent knowledge injection ([3c68f72](https://github.com/tianshu-ai/tianshu/commit/3c68f727044c8d539d88532b715ddbbeaf27e0c1))

## [0.43.1](https://github.com/tianshu-ai/tianshu/compare/v0.43.0...v0.43.1) (2026-09-04)


### Bug Fixes

* add --color-bg-surface (opaque) for dropdowns, selects, popups ([d92a961](https://github.com/tianshu-ai/tianshu/commit/d92a9616d12870e694f68fd109a04938d113f1e1))
* model selector dropdown opaque background (bg-gray-900) ([4e1fe00](https://github.com/tianshu-ai/tianshu/commit/4e1fe00f5d2472e67c987e54ee9c38a6e3e340d8))
* workforce-studio buttons use text-bg-surface instead of text-bg-base (transparent) ([2276231](https://github.com/tianshu-ai/tianshu/commit/227623179fa644b2c092a98b1bb815322d143356))

## [0.43.0](https://github.com/tianshu-ai/tianshu/compare/v0.42.0...v0.43.0) (2026-09-04)


### Features

* auto-open datasource panel when agent pushes ds_panel_fill event ([eb5b3db](https://github.com/tianshu-ai/tianshu/commit/eb5b3db4dda24a743eca62d422f12873dc5fae04))
* **board:** board.ds() and board.dsList() — query databases from board apps ([7396304](https://github.com/tianshu-ai/tianshu/commit/7396304db15e32f4a87e08f8bbc0acc9467cccdf))
* datasource plugin settings UI — proper form for connections ([de480fc](https://github.com/tianshu-ai/tianshu/commit/de480fcdf1cbcb4c2378020c1ddb969e9fff00b2))
* **datasource:** ds_panel tool — agent pushes queries to the panel ([a181241](https://github.com/tianshu-ai/tianshu/commit/a181241308ed3b0d90bce75f5f160e3d8fadda5a))
* **datasource:** enhanced result table — resizable columns, sort, filter ([728dffc](https://github.com/tianshu-ai/tianshu/commit/728dffc9847f7c11bc72040c0e9dd2c85a193d95))
* **datasource:** query panel — run SQL/Cypher from the side panel ([8b0c9d1](https://github.com/tianshu-ai/tianshu/commit/8b0c9d1bc69f217ae5465e8a1c8aeb13f5bf42ac))


### Bug Fixes

* add Cylinder to plugin icon whitelist ([4f88686](https://github.com/tianshu-ai/tianshu/commit/4f88686bcb0597ecc7ae77724314ddcbfa632621))
* configSchema.customUI preserved through manifest parser to frontend ([2a51200](https://github.com/tianshu-ai/tianshu/commit/2a5120023cafe4034b3833c58d3d2d7b3944ee11))
* customUI check in PluginConfigForm (not just PluginConfigFormById) ([354650a](https://github.com/tianshu-ai/tianshu/commit/354650a269a7d5ee2df1a31ac5e19fa29c9c2c99))
* datasource types API with credentials, hardcoded fallback ([0deab0b](https://github.com/tianshu-ai/tianshu/commit/0deab0b1d1c97b627f1ef697b721bced3ec39899))
* datasource types hardcoded in frontend, test fetch with credentials ([87a0a0b](https://github.com/tianshu-ai/tianshu/commit/87a0a0b00b3bd42b775b69fd7014fdbff39ef2a4))
* **datasource:** ds_panel autoRun works, tool hints agent to open panel first ([c2cb236](https://github.com/tianshu-ai/tianshu/commit/c2cb2365adc7c8c36f8e842d877412d720a083a6))
* **datasource:** filter dropdown opaque background ([4009352](https://github.com/tianshu-ai/tianshu/commit/40093525212c67b78551223cff6590d47046936c))
* **datasource:** panel icon → Cylinder ([d25bbec](https://github.com/tianshu-ai/tianshu/commit/d25bbecc4a0fc717c1e0aef83802158e4c8132e3))
* **datasource:** panel icon → DatabaseZap ([aefe55b](https://github.com/tianshu-ai/tianshu/commit/aefe55b2b9ddfec95e2fd1a4fbd63c5f422e09c2))
* **datasource:** subscribe to plugin_event then filter by event name ([396eb47](https://github.com/tianshu-ai/tianshu/commit/396eb4747788f9047b3c86bb9069e0c88200ad96))
* **datasource:** WS event type prefixed with pluginId — datasource:ds_panel_fill ([4135161](https://github.com/tianshu-ai/tianshu/commit/4135161375afeeb162dfcc13ccd6a6f137c12f42))
* disable browser autofill on datasource connection fields ([b99fd8c](https://github.com/tianshu-ai/tianshu/commit/b99fd8cbfd0b33f91223721c44ca14867a7b3a4f))
* plugin API routes use /api/p/:pluginId not /api/plugins/:pluginId ([115b585](https://github.com/tianshu-ai/tianshu/commit/115b585e7ccd9e4010b03b442ef521236dee8905))
* Settings page shows for plugins with customUI even if fields is empty ([e903c62](https://github.com/tianshu-ai/tianshu/commit/e903c62afd619f486b29c206e0d3dbe6315ac72d))
* sync_down tests — no longer requires taskId or project slug ([e0277c8](https://github.com/tianshu-ai/tianshu/commit/e0277c81289d05f81005003d49469340d99bb406))


### Refactor

* move board.ds docs from board to datasource systemPromptFragments ([0796f1f](https://github.com/tianshu-ai/tianshu/commit/0796f1f4d790b15d3e6e52f58ee71d1ea9c40b4c))

## [0.42.0](https://github.com/tianshu-ai/tianshu/compare/v0.41.3...v0.42.0) (2026-09-04)


### Features

* unified datasource plugin replacing neo4j plugin ([6348ef2](https://github.com/tianshu-ai/tianshu/commit/6348ef2868992d12c35865e7ca6c303b23de6ff5))

## [0.41.3](https://github.com/tianshu-ai/tianshu/compare/v0.41.2...v0.41.3) (2026-09-04)


### Bug Fixes

* **openshell:** sync_down works outside workboard tasks ([06a2067](https://github.com/tianshu-ai/tianshu/commit/06a2067955018e34421e304d3208781174794327))

## [0.41.2](https://github.com/tianshu-ai/tianshu/compare/v0.41.1...v0.41.2) (2026-09-03)


### Bug Fixes

* compact summarisedCount uses getBranch (respects compaction cut points) ([4267315](https://github.com/tianshu-ai/tianshu/commit/426731523611231fd1360406bf4be89f10f44c42))

## [0.41.1](https://github.com/tianshu-ai/tianshu/compare/v0.41.0...v0.41.1) (2026-09-03)


### Bug Fixes

* tianshu restart uses system-level systemctl when system unit exists ([a41cb99](https://github.com/tianshu-ai/tianshu/commit/a41cb996d74f6fb1e56741abb3127e28ec48f4da))

## [0.41.0](https://github.com/tianshu-ai/tianshu/compare/v0.40.0...v0.41.0) (2026-09-03)


### Features

* **web:** block input during compaction ([b6eed72](https://github.com/tianshu-ai/tianshu/commit/b6eed724c6a09f0254e5deb233d9e4b7dc2f1294))


### Bug Fixes

* compact_context defers to post-turn when harness is busy ([e18c550](https://github.com/tianshu-ai/tianshu/commit/e18c550cfbcc4e5ee3d7278c1ca035b9d1719e12))
* UI stays in streaming state during mid-turn compaction ([1cfc0dc](https://github.com/tianshu-ai/tianshu/commit/1cfc0dc890f648e90aa243b0d32698b1bbb04f2b))
* **web:** /compact is a command, not a chat message ([425a84b](https://github.com/tianshu-ai/tianshu/commit/425a84b28c0f40cd64e238aca61d75aff08674dd))
* **web:** /compact no longer stuck in streaming state after completion ([49cf4ef](https://github.com/tianshu-ai/tianshu/commit/49cf4ef2586b13603888be8f13cc1d729da91e2f))
* **web:** auto-dismiss compact notice after 5 seconds ([5553870](https://github.com/tianshu-ai/tianshu/commit/5553870b0f68a9ceab840b55ea486a92afed4ead))

## [0.40.0](https://github.com/tianshu-ai/tianshu/compare/v0.39.1...v0.40.0) (2026-09-03)


### Features

* auto-wildcard bridge tool names in solution extract ([3c5e94f](https://github.com/tianshu-ai/tianshu/commit/3c5e94f8b5284e20ca7559a6ae2051c61e18ee48))
* toolsAllow/toolsDeny support glob wildcards ([43b28fb](https://github.com/tianshu-ai/tianshu/commit/43b28fb628f6612f1813cdd448343f03670114c4))
* **web:** Test Connection button on plugin config form ([2ac6dd1](https://github.com/tianshu-ai/tianshu/commit/2ac6dd14465aed9de015371dbebc183153491b8e))


### Bug Fixes

* **workboard:** task_get_history shows full transcript in text field ([7c925b1](https://github.com/tianshu-ai/tianshu/commit/7c925b171f1ddf5604245a95e3cbebf85cf43f6a))
* **workboard:** task_list includes description + resultSummary ([d9c6043](https://github.com/tianshu-ai/tianshu/commit/d9c6043e170c77953ac02f6545b620f36abe5bbc))

## [0.39.1](https://github.com/tianshu-ai/tianshu/compare/v0.39.0...v0.39.1) (2026-09-02)


### Bug Fixes

* **neo4j:** add neo4j-driver to root dependencies for global install ([3ad6d32](https://github.com/tianshu-ai/tianshu/commit/3ad6d320f6b91c50df8b7720980a146f6942d7a3))

## [0.39.0](https://github.com/tianshu-ai/tianshu/compare/v0.38.1...v0.39.0) (2026-09-02)


### Features

* Neo4j graph database plugin ([4f1f2b8](https://github.com/tianshu-ai/tianshu/commit/4f1f2b85c4a21bc1f3b2a6267c521f373ad09bda))
* **neo4j:** add neo4j_admin tool for schema management ([9e51d16](https://github.com/tianshu-ai/tianshu/commit/9e51d16fd2201d6e4fd7de28becc456d9eccad9f))


### Bug Fixes

* **neo4j:** configSchema password kind → secret ([3746dc3](https://github.com/tianshu-ai/tianshu/commit/3746dc3dd90305b37094e1aea81107f5e0f6c91e))

## [0.38.1](https://github.com/tianshu-ai/tianshu/compare/v0.38.0...v0.38.1) (2026-09-02)


### Bug Fixes

* health check uses HTTPS when SSL is configured ([6ca446b](https://github.com/tianshu-ai/tianshu/commit/6ca446b9d7108257aea4309311e318c99c006bcc))

## [0.38.0](https://github.com/tianshu-ai/tianshu/compare/v0.37.1...v0.38.0) (2026-09-02)


### Features

* native SSL/TLS support via config.json ([dd702bc](https://github.com/tianshu-ai/tianshu/commit/dd702bc61e402ec7860c2a02b8f6bdee79dd85f1))
* setup writes port to config.json as single source of truth ([9d33b7a](https://github.com/tianshu-ai/tianshu/commit/9d33b7a7f1ae4aebfa33012ace7934fdaa892f0b))


### Bug Fixes

* server.port from config.json was ignored — only env PORT worked ([03dee8b](https://github.com/tianshu-ai/tianshu/commit/03dee8b68efe2b4830eeaf5d26de6b0781a22c80))

## [0.37.1](https://github.com/tianshu-ai/tianshu/compare/v0.37.0...v0.37.1) (2026-09-02)


### Bug Fixes

* **web:** modal gets opaque background per theme ([ac5ed55](https://github.com/tianshu-ai/tianshu/commit/ac5ed55011e5aa31d5e6a210d84b2b5e5de56913))

## [0.37.0](https://github.com/tianshu-ai/tianshu/compare/v0.36.1...v0.37.0) (2026-09-02)


### Features

* abort signal propagates to bridge tool calls ([5af18a8](https://github.com/tianshu-ai/tianshu/commit/5af18a8c6c0750dbdb09529931d52e80a455ffc5))


### Bug Fixes

* abort button sometimes has no effect ([ca4657c](https://github.com/tianshu-ai/tianshu/commit/ca4657ca5eaba66ece23fa75b6c822a865a71894))
* abort immediately cancels pending tool calls ([811ffbb](https://github.com/tianshu-ai/tianshu/commit/811ffbb6bbf1b628944bb8b9ee6663b78a07d44a))
* abort pre-check throws instead of returning tool_result ([5f40a7d](https://github.com/tianshu-ai/tianshu/commit/5f40a7d8da1f8ddc31d4824040ffdb1d1650fb24))
* auto-purge orphaned toolResult rows from DB on Anthropic 400 ([a225620](https://github.com/tianshu-ai/tianshu/commit/a2256202f74ca1dea2f32cdf94f25f58a830786d))
* persist synthetic toolResult on cancel to prevent orphaned toolCall corruption ([e5598f1](https://github.com/tianshu-ai/tianshu/commit/e5598f11a5f775c3155f15fee994c18c687b1565))
* strip nested orphan toolCall blocks from toolResult content ([ccbd6e4](https://github.com/tianshu-ai/tianshu/commit/ccbd6e47e8c4a9ac34b5096f2091a22692afb104))

## [0.36.1](https://github.com/tianshu-ai/tianshu/compare/v0.36.0...v0.36.1) (2026-09-01)


### Bug Fixes

* **web:** bubble accent line follows border-radius (8px rounded corners) ([abbb683](https://github.com/tianshu-ai/tianshu/commit/abbb683185058aaedcf454f644b4d084808eef89))

## [0.36.0](https://github.com/tianshu-ai/tianshu/compare/v0.35.0...v0.36.0) (2026-09-01)


### Features

* **web:** cloud bed decoration — clouds carrying the AI bubble ([13c6a4f](https://github.com/tianshu-ai/tianshu/commit/13c6a4fd8775036a5ccd99c420c928ecc8e33025))
* **web:** cloud shelf — fluffy wispy clouds carrying the bubble ([452c654](https://github.com/tianshu-ai/tianshu/commit/452c654511c4cfc0af30f2b65620e133c999da20))


### Bug Fixes

* **web:** add cloud+seal to renderAssistantBlock — the actual render path ([0b976c4](https://github.com/tianshu-ai/tianshu/commit/0b976c470acf569af20e54f66105781e284bb0ca))
* **web:** cloud bed taller (40px) + contain ratio, more natural shape ([9311af5](https://github.com/tianshu-ai/tianshu/commit/9311af5587ad31ad5b9a4b1a4ec6bd4a1b681078))
* **web:** cloud shelf aligned to bubble bottom edge (bottom: -1px) ([ce9d3cb](https://github.com/tianshu-ai/tianshu/commit/ce9d3cb0229201ed5c612b7bdcf9c6dc141d1579))
* **web:** cloud shelf brightened to white-blue (226,242,250), no more grey blobs ([d0a2427](https://github.com/tianshu-ai/tianshu/commit/d0a242734132a9bf6d7bdbc6487eafa88b3ae313))
* **web:** cloud shelf full width (fill), 50px tall, extends 20px beyond edges ([5c5a6c4](https://github.com/tianshu-ai/tianshu/commit/5c5a6c43b63ae9c9115bd70a6c0497b4406c5958))
* **web:** cloud shelf lighter — 15%/12% opacity, brighter in dark ([73ba264](https://github.com/tianshu-ai/tianshu/commit/73ba264f65e45ad7b876577f8def439a59077520))
* **web:** cloud shelf original brightness, 20px height, top overlaps bottom border ([b0e1cb8](https://github.com/tianshu-ai/tianshu/commit/b0e1cb865f5846dca41997a37eb82c2189d0da65))
* **web:** cloud shelf v2 — fluffier bottom edge, cropped to cloud area ([f2da0dd](https://github.com/tianshu-ai/tianshu/commit/f2da0dd88a2e657c55eccaa6b4d8a9a1edf7b742))
* **web:** cloud wisp below bubble (bottom: -14px) — carrying the bubble ([ac8f4cb](https://github.com/tianshu-ai/tianshu/commit/ac8f4cbb5cd35e546ca97a4f1953ad2feaa299ad))
* **web:** cloud wisp centered under bubble (carrying effect), seal inset 8/10px ([725e6c6](https://github.com/tianshu-ai/tianshu/commit/725e6c6b493aa46a211b31d278c09e3489728d83))
* **web:** cloud wisp full width + squished (16px height) under bubble ([adc6932](https://github.com/tianshu-ai/tianshu/commit/adc6932ff2593793af975a48c1f8c0c91404cf5c))
* **web:** cloud wisp more visible — 35% opacity, brighter in dark ([9835bff](https://github.com/tianshu-ai/tianshu/commit/9835bff4b0c56876bdbacbcc23fffa8e3871eef3))
* **web:** cloud wisp smaller (36px) + subtler (15%/12%), offset from seal ([060590c](https://github.com/tianshu-ai/tianshu/commit/060590cc5982d58306c1e6108dd479a00eea046b))
* **web:** move cloud+seal outside overflow-x-auto prose container ([b1b3fd8](https://github.com/tianshu-ai/tianshu/commit/b1b3fd85e25fc465509b96176e88e1c8024a605c))
* **web:** regenerate cloud wisp (129k opaque pixels), seal flush right ([1c5c2e3](https://github.com/tianshu-ai/tianshu/commit/1c5c2e38cea583b6dee2bef2685ca57615b8bce4))

## [0.35.0](https://github.com/tianshu-ai/tianshu/compare/v0.34.0...v0.35.0) (2026-09-01)


### Features

* **web:** cloud wisp (祥云) decoration at bottom-right of AI bubbles ([e543d15](https://github.com/tianshu-ai/tianshu/commit/e543d159d1a8fd48d401a901a8789dc5b924b061))
* **web:** real scroll rod images on bubbles (卷轴) ([781d4ae](https://github.com/tianshu-ai/tianshu/commit/781d4aee6b70b791fbc72402a927b2e61e16dc68))
* **web:** scroll (卷轴) style bubbles — top/bottom rod decorations ([285bf8d](https://github.com/tianshu-ai/tianshu/commit/285bf8d70e068622aa9f776b55e9020454eca267))


### Bug Fixes

* **web:** ai-bubble overflow-hidden → overflow-visible ([1abe567](https://github.com/tianshu-ai/tianshu/commit/1abe567b75e457dd185dfea9d2989da49df424e6))
* **web:** cloud wisp + seal as real DOM elements instead of pseudo-elements ([6cce1c2](https://github.com/tianshu-ai/tianshu/commit/6cce1c2af8937918994d0b63396a6e6ac714d7f0))
* **web:** cloud wisp bigger (80px) + more visible (25%/15%) ([c786b7c](https://github.com/tianshu-ai/tianshu/commit/c786b7c384991293297a9ba678bc6b0de5069fc8))
* **web:** revert to left/right accent border style bubbles ([eaba8c6](https://github.com/tianshu-ai/tianshu/commit/eaba8c6d26116a4e892c98bc72fdc801729c3757))
* **web:** scroll bubbles — thin top/bottom border lines, remove rod images ([d276099](https://github.com/tianshu-ai/tianshu/commit/d2760997b4c627feb9343ab1a7c79ab737809521))

## [0.34.0](https://github.com/tianshu-ai/tianshu/compare/v0.33.2...v0.34.0) (2026-09-01)


### Features

* **web:** AI bubble decorations — accent left border + gradient bg + shadow ([d50ce7b](https://github.com/tianshu-ai/tianshu/commit/d50ce7b8b8690fd2a6a80ad96051b51aa5e59147))
* **web:** user bubble decorations — right accent border + gradient + shadow ([2e05317](https://github.com/tianshu-ai/tianshu/commit/2e0531753a2b8960b2ef66495c66fde0a6546a52))


### Bug Fixes

* **web:** add ai-bubble class to ALL assistant bubble code paths (6 total) ([a7d5f2b](https://github.com/tianshu-ai/tianshu/commit/a7d5f2b30bac6b30c91802eb6ecfc6fe6d09298c))
* **web:** dark border-subtle → 30% opacity, less visible divider line ([7e81b71](https://github.com/tianshu-ai/tianshu/commit/7e81b715c6508c382ed26ea025cd004a3ea46f02))
* **web:** dark mountains retinted to match new [#0](https://github.com/tianshu-ai/tianshu/issues/0)f1724 body color ([9138e35](https://github.com/tianshu-ai/tianshu/commit/9138e35155bc42caab2c35163374509ae1fed411))
* **web:** dark theme lightened — [#030712](https://github.com/tianshu-ai/tianshu/issues/030712) → [#0](https://github.com/tianshu-ai/tianshu/issues/0)f1724, slate palette ([229770b](https://github.com/tianshu-ai/tianshu/commit/229770b5861d471dc834f6cff29ffa6bbe5957ba))
* **web:** revert dark to original [#030712](https://github.com/tianshu-ai/tianshu/issues/030712) + border-subtle transparent ([990ba59](https://github.com/tianshu-ai/tianshu/commit/990ba599c73005541bb6c4666e44129c02d974d7))
* **web:** use original mountain PNGs + mix-blend-mode:multiply ([8b26704](https://github.com/tianshu-ai/tianshu/commit/8b26704944dceca083cff90dba55450b4fa2da11))


### Reverts

* undo dark theme changes back to v0.33.2 state ([cdd9127](https://github.com/tianshu-ai/tianshu/commit/cdd9127880a733923742acda3678f24f26d5ad21))

## [0.33.2](https://github.com/tianshu-ai/tianshu/compare/v0.33.1...v0.33.2) (2026-09-01)


### Bug Fixes

* **web:** light mountains — dark ink strokes + light gold stars on transparent bg ([4da3cda](https://github.com/tianshu-ai/tianshu/commit/4da3cdad9b8ebb50cbe2d2e89cf8c1636dd4c558))
* **web:** light mountains opacity 40%→20% sidebar, 30%→15% right panel ([cb8b7f0](https://github.com/tianshu-ai/tianshu/commit/cb8b7f0b7292b0bb963ae45b7956ebe066d8f6f2))
* **web:** light mountains regenerated — faint grey misty layers + gold stars ([4103846](https://github.com/tianshu-ai/tianshu/commit/4103846324cdf7f51da8916a17ca62d87376f332))
* **web:** light theme — paper texture from classical base (with fibers), stars tinted gold ([ae6c419](https://github.com/tianshu-ai/tianshu/commit/ae6c4191de22510b7104dc02756cf9f89c8d762e))

## [0.33.1](https://github.com/tianshu-ai/tianshu/compare/v0.33.0...v0.33.1) (2026-09-01)


### Bug Fixes

* **test:** wait for inbox flush timer before closing DB in recovery-tools test ([de47466](https://github.com/tianshu-ai/tianshu/commit/de4746663aacfeb580e9e019d353396735ef8135))

## [0.33.0](https://github.com/tianshu-ai/tianshu/compare/v0.32.1...v0.33.0) (2026-09-01)


### Features

* **web:** all themes get texture + mountains + seal + stars ([a4f4a01](https://github.com/tianshu-ai/tianshu/commit/a4f4a01eba9bab880f687ec9ae4d054139eb0742))
* **web:** regenerate light + classical mountains matching dark theme style ([048d11e](https://github.com/tianshu-ai/tianshu/commit/048d11e59c05a79f267185e361fb2a05ad9ddfe2))
* **web:** replace Bot icon with Tianshu classical avatar ([01467af](https://github.com/tianshu-ai/tianshu/commit/01467af79378144a14991f21ef26474c1c0c3d25))


### Bug Fixes

* **web:** all mountain PNGs converted to transparent background ([fe9cb43](https://github.com/tianshu-ai/tianshu/commit/fe9cb43f64b17fd430acc1c55a647d56f8c20fb5))
* **web:** avatar larger — chat 20px, sidebar 24px ([3a0a749](https://github.com/tianshu-ai/tianshu/commit/3a0a749b69ede0891eab8b276c7229e31ec7bf4c))
* **web:** convert ink mountains PNG white areas to transparent alpha ([3f18e90](https://github.com/tianshu-ai/tianshu/commit/3f18e90cfcd6503913e6bc92c3f53bcd1f495d06))
* **web:** dark + light themes also use transparent bg variables ([27cdeab](https://github.com/tianshu-ai/tianshu/commit/27cdeabcd7dca7f749137792fbab5961b27eec8c))
* **web:** ink mountains background tinted to parchment #f0e8d8 ([808cfec](https://github.com/tianshu-ai/tianshu/commit/808cfecd70759ce47635794307e3e01212caa967))
* **web:** ink mountains mix-blend-mode:multiply — white areas become transparent ([0381537](https://github.com/tianshu-ai/tianshu/commit/0381537a9ccb2bff4a3cef8301c5cb645f9d9fb1))
* **web:** regenerate seal with green-screen chroma key removal ([9325ea6](https://github.com/tianshu-ai/tianshu/commit/9325ea6916ed3d38e1c4acef1dd7d7c33c26cce2))
* **web:** seal 20px ([76b23ba](https://github.com/tianshu-ai/tianshu/commit/76b23ba59966291ae9b7b9143dc43f6330a97db0))
* **web:** seal back to 32px ([13176c0](https://github.com/tianshu-ai/tianshu/commit/13176c0005340ff0388ed17d2237c2e442315b46))
* **web:** seal PNG background removed — 85% transparent ([2768836](https://github.com/tianshu-ai/tianshu/commit/276883620749d41f469da29c4b2287c7bfec0f08))
* **web:** seal watermark larger (48px) + more visible (20% opacity) ([bfe0a4c](https://github.com/tianshu-ai/tianshu/commit/bfe0a4c9b4e31a39101453acc1ca74f6f09e6b1b))
* **web:** sidebar mountains only bottom 60% — no color mismatch at top ([b408aa5](https://github.com/tianshu-ai/tianshu/commit/b408aa5c1d0755a8f70593a71d65a4603834a352))

## [0.32.1](https://github.com/tianshu-ai/tianshu/compare/v0.32.0...v0.32.1) (2026-08-31)


### Bug Fixes

* **web:** all bg-elevated/bg-base/bg-raised surfaces transparent in classical theme ([fcb6f92](https://github.com/tianshu-ai/tianshu/commit/fcb6f9213fd8f56fca8a8d7717d3444bfb62f446))
* **web:** paper texture blend-mode soft-light — subtler than overlay ([06e3a2b](https://github.com/tianshu-ai/tianshu/commit/06e3a2bfd618003d69f08425915ae58c4c0ef2b9))
* **web:** set bg-base/bg-elevated to transparent in CSS variables ([dfb1bed](https://github.com/tianshu-ai/tianshu/commit/dfb1bed3cc93c2b5fba96178494c23dd2537f928))
* **web:** sidebar all children transparent — no more white patches ([265696d](https://github.com/tianshu-ai/tianshu/commit/265696d952eb00d296a699647b0373b0c7269131))

## [0.32.0](https://github.com/tianshu-ai/tianshu/compare/v0.31.0...v0.32.0) (2026-08-31)


### Features

* **web:** bold ink mountains + Big Dipper golden stars ([eb31e70](https://github.com/tianshu-ai/tianshu/commit/eb31e70d4e2b21185d6caeb82cd0ab87ba749cd9))
* **web:** new ink mountains with Big Dipper constellation + highlighted Tianshu star ([694cacf](https://github.com/tianshu-ai/tianshu/commit/694cacff6035e811dda5bca6b23efceb76459664))


### Bug Fixes

* **web:** faint minimal mountains + simple golden star dots ([05811d8](https://github.com/tianshu-ai/tianshu/commit/05811d8957abb478afb755532a0901587d1e60af))
* **web:** mountains more transparent — sidebar 12%, right panel 10% ([3a6b42f](https://github.com/tianshu-ai/tianshu/commit/3a6b42f4d0cb9c8da0ec213127b11c8212da479a))
* **web:** mountains opacity — sidebar 30%, right panel 20% ([a909b3a](https://github.com/tianshu-ai/tianshu/commit/a909b3a829382884ae3f54d55306e0ac8b34760c))
* **web:** mountains opacity — sidebar 40%, right panel 30% ([fbab75a](https://github.com/tianshu-ai/tianshu/commit/fbab75a92c7a085b75721df72ef3a9dbb54e2c79))
* **web:** revert to simple minimalist ink mountains — less detail ([0a97d38](https://github.com/tianshu-ai/tianshu/commit/0a97d38bf7158892548692f07423966dabe008f9))

## [0.31.0](https://github.com/tianshu-ai/tianshu/compare/v0.30.3...v0.31.0) (2026-08-31)


### Features

* **web:** add '古风' classical Chinese theme (素宣暖阳) ([47760d4](https://github.com/tianshu-ai/tianshu/commit/47760d47a028bedf2794bbbe7f11e94756e4a059))
* **web:** classical theme as default for new users ([3ad34c0](https://github.com/tianshu-ai/tianshu/commit/3ad34c0315cdcd28798f655c936942ed46291e36))
* **web:** classical theme visual assets — Gemini-generated ([c62035e](https://github.com/tianshu-ai/tianshu/commit/c62035e4ead89ae46187f66858d3edaf31933008))
* **web:** right panel full-height ink mountains (12% opacity, cover) ([525c178](https://github.com/tianshu-ai/tianshu/commit/525c1780f6a505947a4fd54c09ecf7909b18f5fd))


### Bug Fixes

* **web:** entire UI is parchment — all panels/inputs transparent, body carries texture ([96bed10](https://github.com/tianshu-ai/tianshu/commit/96bed1083ac0565c7909dfd3e7a022a9a1bfc3c8))
* **web:** ink mountains only on left sidebar (aside.border-r), not right panel ([1edb6fb](https://github.com/tianshu-ai/tianshu/commit/1edb6fb1d69d1a08fe189a806381c9d28cf4bbfb))
* **web:** inline paper texture URL + multiply blend mode for visibility ([4ae626d](https://github.com/tianshu-ai/tianshu/commit/4ae626d7ac28135631fb6ae3f4f333b9987f8de0))
* **web:** make root layout transparent in classical theme so paper texture shows ([4427095](https://github.com/tianshu-ai/tianshu/commit/44270953567bbe67544da67c96cbc538a2c5c2f0))
* **web:** panels semi-transparent (60%), sidebar mountains 20% opacity ([606fd71](https://github.com/tianshu-ai/tianshu/commit/606fd71a4c8f437c29e2d2aa93794537ea1b7c54))
* **web:** paper texture as 15% opacity pseudo-element overlay ([2979ccf](https://github.com/tianshu-ai/tianshu/commit/2979ccf326ed932724d06c953ab0fc47bd59e8b8))
* **web:** paper texture not showing — add !important to override base layer ([2512f07](https://github.com/tianshu-ai/tianshu/commit/2512f07fdf0127b44c1b6cfaf578a353e0436f9d))
* **web:** regenerate paper texture with visible fiber structure ([1d21949](https://github.com/tianshu-ai/tianshu/commit/1d21949b15eb94301767bf35387cec16633eeba5))
* **web:** right panel more transparent (35%) + mountains 18% opacity ([cd5afa6](https://github.com/tianshu-ai/tianshu/commit/cd5afa699e781bb5d63ffc32e184294d0417240c))
* **web:** uniform 50% parchment transparency across all surfaces ([797eb62](https://github.com/tianshu-ai/tianshu/commit/797eb6288604b7d1ea178ff5d944a5a2fc4266d3))

## [0.30.3](https://github.com/tianshu-ai/tianshu/compare/v0.30.2...v0.30.3) (2026-08-31)


### Bug Fixes

* **web:** add min-w-0 to message wrapper to fix flex overflow ([c2dec6b](https://github.com/tianshu-ai/tianshu/commit/c2dec6b283910972a9b4f9241e91446071120e73))
* **web:** blocks path tool calls also need min-w-0 for truncation ([399c8ac](https://github.com/tianshu-ai/tianshu/commit/399c8ac97168efe9d6147376b151193e47af65d7))
* **web:** replace max-w-none with max-w-full to constrain prose/table width ([bfc00d5](https://github.com/tianshu-ai/tianshu/commit/bfc00d53f6f8aaa153e828f9a02295aa73308711))
* **web:** table overflow scroll without clipping text ([891ab23](https://github.com/tianshu-ai/tianshu/commit/891ab23e0127a777442565340e23a8377f53199a))
* **web:** table scrollbar inside bubble, not on chat container ([bdf9cdb](https://github.com/tianshu-ai/tianshu/commit/bdf9cdb64d1bce38a8e89815ae3ef99ccdacba8b))
* **web:** tool call rows overflow — add min-w-0 + overflow-hidden ([fa8fbc3](https://github.com/tianshu-ai/tianshu/commit/fa8fbc3ca463626bfd54313a111e82b3e1beacd6))
* **web:** ToolCallRow outer div needs w-full min-w-0 for truncation ([2f7902a](https://github.com/tianshu-ai/tianshu/commit/2f7902a0e915205d4a30bb3e122cd1af4f0bfd6f))
* **web:** use overflow-hidden on wrapper instead of constraining prose width ([beef0a4](https://github.com/tianshu-ai/tianshu/commit/beef0a4d6cfe838b5c549294432a5e04ca223059))

## [0.30.2](https://github.com/tianshu-ai/tianshu/compare/v0.30.1...v0.30.2) (2026-08-31)


### Bug Fixes

* **web:** add overflow-x-auto to prose blocks to prevent table/code overflow ([20de206](https://github.com/tianshu-ai/tianshu/commit/20de206b6bc6da5408215b9e861c9d7af849e5dd))

## [0.30.1](https://github.com/tianshu-ai/tianshu/compare/v0.30.0...v0.30.1) (2026-08-31)


### Bug Fixes

* **deps:** bump papaparse, tailwindcss/postcss, types/react-dom, build-tooling ([657e160](https://github.com/tianshu-ai/tianshu/commit/657e1604e4bd9c2f9bcc96e9af516bca0cbe35f4))

## [0.30.0](https://github.com/tianshu-ai/tianshu/compare/v0.29.1...v0.30.0) (2026-08-31)


### Features

* structured inbox events for event card rendering ([149fc71](https://github.com/tianshu-ai/tianshu/commit/149fc7143e77f9e104829fc51136672fc1502f6b))
* **web:** render cron/system events as styled event cards ([132a332](https://github.com/tianshu-ai/tianshu/commit/132a3329b6a84bd1915f0f08f202c95002440988))


### Bug Fixes

* extract inbox events from text tag (covers followUp path) ([1783901](https://github.com/tianshu-ai/tianshu/commit/17839010b14a1deb3fc317cb4daae0f4ebd32424))
* **web:** event cards hide YOU label, strip system prefix, friendly time ([64ed565](https://github.com/tianshu-ai/tianshu/commit/64ed565749ad1e1748ad30c345b226798a9fece5))
* **web:** event cards left-aligned, not centered ([5fbe989](https://github.com/tianshu-ai/tianshu/commit/5fbe9894db12027f2857db94f92cc8d1b946ed6f))
* **web:** event cards right-aligned with user messages ([bb57a4f](https://github.com/tianshu-ai/tianshu/commit/bb57a4f96b2b59537f15862127a3c551f7cf41c6))
* **web:** parse all system event formats for event card rendering ([5a8d609](https://github.com/tianshu-ai/tianshu/commit/5a8d609f5e73587e4d4077a88451ca0f74a50813))


### Refactor

* bridge syncDown/syncUp use native file tools ([#403](https://github.com/tianshu-ai/tianshu/issues/403)) ([13357ac](https://github.com/tianshu-ai/tianshu/commit/13357ac8c3acbf580926a25f76b183b57866188a))

## [0.29.1](https://github.com/tianshu-ai/tianshu/compare/v0.29.0...v0.29.1) (2026-08-30)


### Bug Fixes

* **wiki:** i18n all hardcoded Chinese in Indexing tab ([f5d1a1c](https://github.com/tianshu-ai/tianshu/commit/f5d1a1c06e0500450aec34c12dfaff5fb1c2b9ef))

## [0.29.0](https://github.com/tianshu-ai/tianshu/compare/v0.28.0...v0.29.0) (2026-08-30)


### Features

* **wiki:** embedding status card in indexing tab ([6aef560](https://github.com/tianshu-ai/tianshu/commit/6aef560ff6251fccb324f1907e1e51d966c17d7b))
* **wiki:** session indexing day counts in indexing tab ([47a3f9b](https://github.com/tianshu-ai/tianshu/commit/47a3f9ba0be08a054c5a1615c8e1b61324a8dba6))
* **wiki:** trigger embedding reindex on Update Wiki button ([e50585f](https://github.com/tianshu-ai/tianshu/commit/e50585faa96d0527b99b1d9c0ef53c9b8ea87e81))


### Bug Fixes

* **wiki:** count actual message days instead of date-span approximation ([7d023f6](https://github.com/tianshu-ai/tianshu/commit/7d023f6f28b598eff096af2ba6424f8e1f2ec6fc))
* **wiki:** register semantic-search and embedding-status API routes in manifest ([6edecf7](https://github.com/tianshu-ai/tianshu/commit/6edecf7e572b9841f961c72b01cf2acbcdc623ab))
* **wiki:** separate Update Wiki and embedding reindex ([8a58cce](https://github.com/tianshu-ai/tianshu/commit/8a58cce1c2f567e281e85cd3653e7f21c5b333ba))

## [0.28.0](https://github.com/tianshu-ai/tianshu/compare/v0.27.1...v0.28.0) (2026-08-29)


### Features

* **wiki:** collapsible sections + progressive loading ([12edc3c](https://github.com/tianshu-ai/tianshu/commit/12edc3c8e58b0bc9587cfb48041213e1c36ed6b0))
* **wiki:** date range picker for session records view ([fa13697](https://github.com/tianshu-ai/tianshu/commit/fa1369723b69740a9f5f2bac7210982e9acfeca8))
* **wiki:** semantic search toggle + recently updated section ([8fc68a4](https://github.com/tianshu-ai/tianshu/commit/8fc68a4d2aaba55722189f9fefa087fc286fc026))
* **wiki:** single-column navigation layout ([fdd0fd0](https://github.com/tianshu-ai/tianshu/commit/fdd0fd0f642b8c2fbc14d9dabea45a67fcd4408b))
* **wiki:** split session/kb views with month navigator ([af7aef8](https://github.com/tianshu-ai/tianshu/commit/af7aef895a8fc7f54b9ead5c01b92637669ba1b7))

## [0.27.1](https://github.com/tianshu-ai/tianshu/compare/v0.27.0...v0.27.1) (2026-08-29)


### Bug Fixes

* **compaction:** report actual summarised/kept message counts ([30a4204](https://github.com/tianshu-ai/tianshu/commit/30a4204a541c3e4b292be33a6cca8396ca932178))

## [0.26.0](https://github.com/tianshu-ai/tianshu/compare/v0.25.4...v0.26.0) (2026-08-29)


### Features

* **host-tools:** add switch_panel tool for agent UI control ([8bfc9ba](https://github.com/tianshu-ai/tianshu/commit/8bfc9bacfe255addbb4217b66b8305381381a989))


### Refactor

* **switch_panel:** dynamic panel discovery from plugin registry ([a6b6d9c](https://github.com/tianshu-ai/tianshu/commit/a6b6d9c3126a89077d0f9ef686363b5322ce3401))

## [0.25.4](https://github.com/tianshu-ai/tianshu/compare/v0.25.3...v0.25.4) (2026-08-29)


### Bug Fixes

* repair .release-please-manifest.json (escaped quotes) ([c8e99b0](https://github.com/tianshu-ai/tianshu/commit/c8e99b0539162e6e84a53db80fa16485b06e881d))

## [0.25.2](https://github.com/tianshu-ai/tianshu/compare/v0.25.1...v0.25.2) (2026-08-29)


### Bug Fixes

* **session-inbox:** don't fall through to idle-runner when harness is active ([7d19fd2](https://github.com/tianshu-ai/tianshu/commit/7d19fd277251a9a4bd9b25bdd2f908ab6e8055d1))

## [0.25.1](https://github.com/tianshu-ai/tianshu/compare/v0.25.0...v0.25.1) (2026-08-29)


### Bug Fixes

* repair package.json after broken rebase ([f8e1989](https://github.com/tianshu-ai/tianshu/commit/f8e1989999c2376d1e8e71a1fcbda415b97b3ec6))

## [0.24.0](https://github.com/tianshu-ai/tianshu/compare/v0.23.7...v0.24.0) (2026-08-29)


### Features

* **handler:** auto-recover from transient abort/error ([e58ab90](https://github.com/tianshu-ai/tianshu/commit/e58ab90e27ab6212266d2ed3a7bd98d67a95a839))


### Bug Fixes

* **handler:** don't abort in-flight turn on WebSocket close ([0a2d6da](https://github.com/tianshu-ai/tianshu/commit/0a2d6da00daf4fccb8245470ca0d01a6f3294e5f))

## [0.23.7](https://github.com/tianshu-ai/tianshu/compare/v0.23.6...v0.23.7) (2026-08-28)


### Bug Fixes

* **model-retry:** retry transport aborts instead of giving up ([733e4e4](https://github.com/tianshu-ai/tianshu/commit/733e4e4008232368db4709f0ff357443c5926acb))

## [0.23.6](https://github.com/tianshu-ai/tianshu/compare/v0.23.5...v0.23.6) (2026-08-28)


### Bug Fixes

* **solutions:** always clear per-worker skills on activate ([e8b5d04](https://github.com/tianshu-ai/tianshu/commit/e8b5d0473bb0398746a96a3e477725c7e25a06da))

## [0.23.5](https://github.com/tianshu-ai/tianshu/compare/v0.23.4...v0.23.5) (2026-08-28)


### Bug Fixes

* **solutions:** apply writes main-agent skills to correct directory ([cdaf3bb](https://github.com/tianshu-ai/tianshu/commit/cdaf3bbd991079fd3aa366e543cd27d525669d52))

## [0.23.4](https://github.com/tianshu-ai/tianshu/compare/v0.23.3...v0.23.4) (2026-08-28)


### Bug Fixes

* **solutions:** classify skills by source on export/import ([325e0d6](https://github.com/tianshu-ai/tianshu/commit/325e0d69cdde55d66daa4431e45b0b87e791b38f))
* **solutions:** double-filter skills in exportSolution ([779688b](https://github.com/tianshu-ai/tianshu/commit/779688b28e65dbb0f37170476fd8cfc34b99128f))

## [0.23.3](https://github.com/tianshu-ai/tianshu/compare/v0.23.2...v0.23.3) (2026-08-28)


### Bug Fixes

* **snapshot:** export raw skill files with frontmatter intact ([17a752d](https://github.com/tianshu-ai/tianshu/commit/17a752d9df6e34de5a79a8ddb9fc0d89b0597ed2))

## [0.23.2](https://github.com/tianshu-ai/tianshu/compare/v0.23.1...v0.23.2) (2026-08-28)


### Bug Fixes

* **snapshot:** load per-worker tenant skills in workforce snapshot ([825f1a0](https://github.com/tianshu-ai/tianshu/commit/825f1a0f4f0219c35c1df9865d2852e3477a3f38))

## [0.23.1](https://github.com/tianshu-ai/tianshu/compare/v0.23.0...v0.23.1) (2026-08-28)


### Bug Fixes

* **snapshot:** use contributionId in skill relativePath ([9e80115](https://github.com/tianshu-ai/tianshu/commit/9e8011567186957038619a8b5e53b8e2fe3415aa))
* **solutions:** strip pluginId prefix when writing skill files ([abd80d5](https://github.com/tianshu-ai/tianshu/commit/abd80d5bafd7a0140c132da0459b055c694d955e))

## [0.23.0](https://github.com/tianshu-ai/tianshu/compare/v0.22.0...v0.23.0) (2026-08-28)


### Features

* **workforce:** portable solution export/import with skill files ([effbf69](https://github.com/tianshu-ai/tianshu/commit/effbf69dbe4a1cf233dbed27cccd5fb69852c865))
* **workforce:** save and restore skill files with solutions ([7a558e3](https://github.com/tianshu-ai/tianshu/commit/7a558e3e1ed860ab46c9dba4981907b4f36fcf78))

## [0.22.0](https://github.com/tianshu-ai/tianshu/compare/v0.21.4...v0.22.0) (2026-08-28)


### Features

* **handler:** auto-continue when model hits maxTokens limit ([7dd460c](https://github.com/tianshu-ai/tianshu/commit/7dd460c17ea828ced054130972863148fabdcab2))

## [0.21.4](https://github.com/tianshu-ai/tianshu/compare/v0.21.3...v0.21.4) (2026-08-27)


### Bug Fixes

* **test:** update handler tests for Loop Agent Mode prompt ([31e4286](https://github.com/tianshu-ai/tianshu/commit/31e42865b8b4ea1820f9d8c36fe171d028ce2339))
* **test:** update workforce snapshot tests for Loop Agent Mode ([f6b3d1d](https://github.com/tianshu-ai/tianshu/commit/f6b3d1d7795b7d90496146a9e94e307361183510))

## [0.17.0](https://github.com/tianshu-ai/tianshu/compare/v0.16.0...v0.17.0) (2026-08-11)


### Features

* **board:** inject LLM API knowledge into agent system prompt ([5123fc2](https://github.com/tianshu-ai/tianshu/commit/5123fc23c3c8eff4c6d6a556ee8d34775dacf2e8))
* general-purpose LLM chat API (/api/llm/chat) + board.llm() helper ([b5910c8](https://github.com/tianshu-ai/tianshu/commit/b5910c883cf31b47eb887520bc65bcb93817fb85))


### Bug Fixes

* **llm-chat:** assistant messages need content as TextContent[] array ([9a9eb10](https://github.com/tianshu-ai/tianshu/commit/9a9eb104fdd8b86010b5bd0a7c4c3232defc8ae2))
* **llm-chat:** register API providers + debug empty response ([076cff7](https://github.com/tianshu-ai/tianshu/commit/076cff78d139ae0cb8b030362ed1dd6a654ac6ec))
* **llm-chat:** surface stream error instead of returning empty text ([9b71ec2](https://github.com/tianshu-ai/tianshu/commit/9b71ec2ae59ee1b8ac49a1db41243fe038ac3c76))
* **llm-chat:** swap resolveTenantConfig args (tenantId, home) ([8c9a2b8](https://github.com/tianshu-ai/tianshu/commit/8c9a2b805a1b5a37beb12b4a439fee3f61d109cc))
* **llm-chat:** use complete() instead of streamSimple ([c7cdee4](https://github.com/tianshu-ai/tianshu/commit/c7cdee40a5f157f75e5f1b7099e104fb43930654))

## [0.16.0](https://github.com/tianshu-ai/tianshu/compare/v0.15.0...v0.16.0) (2026-08-05)


### Features

* compact_context tool — agent can proactively compress history ([0148a05](https://github.com/tianshu-ai/tianshu/commit/0148a054f3e9a8ebc33041d83328a8aa1f4b792d))
* compaction config in doctor checks + setup agent knowledge ([b0bedbc](https://github.com/tianshu-ai/tianshu/commit/b0bedbce00d4199c5f48a46323f27936a49adc29))
* configurable compaction settings (models.compaction in config.json) ([798a797](https://github.com/tianshu-ai/tianshu/commit/798a797b107fc66bac8fd675955f1ed2c2eed061))
* Google Gemini OAuth via CLI integration ([70d84f1](https://github.com/tianshu-ai/tianshu/commit/70d84f1f88e44f3b5c12c4ea171fb4277d601b71))
* percentage-based compaction trigger (default 80%) ([b5f7388](https://github.com/tianshu-ai/tianshu/commit/b5f7388ba17dd6a13c2ce575d3f7c76076372cf4))


### Bug Fixes

* disable filterOrphanedToolResults (incorrectly filtering all tool_results) ([2aec126](https://github.com/tianshu-ai/tianshu/commit/2aec126b5749d33b5f9e100973181d91c153133a))
* filter orphaned tool_results from context (prevents 400 after compaction) ([cb6858b](https://github.com/tianshu-ai/tianshu/commit/cb6858b2e9a9a340fb778b326d14c71a1e2f9041))
* filter orphans in compaction retainedTail (not just top-level entries) ([a6f2465](https://github.com/tianshu-ai/tianshu/commit/a6f246558389874146d556e3aaa9b37d05043e3e))
* filterOrphanedToolResults now uses correct pi-ai type ('toolCall' not 'tool_use') ([3f88453](https://github.com/tianshu-ai/tianshu/commit/3f884536b1d11fa88b02da77719d2294c673880b))
* move orphan filter to storage layer (getPathToRoot) ([ac61c9b](https://github.com/tianshu-ai/tianshu/commit/ac61c9bf7ec4a3174c4a8128726740fa20f7e1d1))
* positional orphan filter — tool_result must follow its tool_use's assistant msg ([95d2920](https://github.com/tianshu-ai/tianshu/commit/95d292069a21ec0d15ac82802baa7591e0fe6c0c))


### Refactor

* compact_context as host-level tool (available to all agents) ([2a23bc1](https://github.com/tianshu-ai/tianshu/commit/2a23bc1c8696c7e15a31bc648de1fb602fb7fb36))

## [0.15.0](https://github.com/tianshu-ai/tianshu/compare/v0.14.0...v0.15.0) (2026-07-29)


### Features

* **bridge-runner:** implement syncDown (pull files from bridge to server) ([f7d8ba0](https://github.com/tianshu-ai/tianshu/commit/f7d8ba03c1ce6b7bca5c62a797a5cf1e77cc7d76))
* **reverse-mcp:** BridgeSandboxRunner — run opencode on bridge host ([a79f695](https://github.com/tianshu-ai/tianshu/commit/a79f69528a2ccf7579a1c6a89dd50e2ee9088eea))
* SandboxRunner.runOpencode() — decouple opencode execution per runner ([16b525a](https://github.com/tianshu-ai/tianshu/commit/16b525a5fd17739f04cc83fc0d04143983773d9d))
* **workboard:** prefer bridge device over Docker sandbox for opencode ([f17fa92](https://github.com/tianshu-ai/tianshu/commit/f17fa92e51bafb7a9f165a044b711541121d3604))


### Bug Fixes

* **bridge-runner:** call 'exec' not 'shell_exec' (bridge tool name) ([6a1f79c](https://github.com/tianshu-ai/tianshu/commit/6a1f79c93d415a741a40204463cbbe8fa4f6214f))
* **bridge-runner:** parse JSON exec result from bridge tool ([8088532](https://github.com/tianshu-ai/tianshu/commit/808853214d001022aa929bc4a6c9b3b3f93d8434))
* **bridge-runner:** read full oc.out/oc.err via chunked dd (bypass 8KB truncation) ([cfb3aa2](https://github.com/tianshu-ai/tianshu/commit/cfb3aa295b85f84aa65ff988ad1e41eaee8e12c3))
* **bridge-runner:** read oc.err back into result.stderr for execution log ([b229408](https://github.com/tianshu-ai/tianshu/commit/b22940890282c0b46d33a5a699ecd8326b97bfe9))
* **bridge-runner:** readFileFull compare byte length not char length ([9b71d9e](https://github.com/tianshu-ai/tianshu/commit/9b71d9e4773d0458166d2c84b4e85f84372acecc))
* **bridge-runner:** readFileFull via base64 chunks (bypass 200-line cap) ([b2349b8](https://github.com/tianshu-ai/tianshu/commit/b2349b80c1109b1894a24db9cba12bbc2285f328))
* **bridge-runner:** replace -print0/read -d '' with -print/read -r (zsh compat) ([625b1dd](https://github.com/tianshu-ai/tianshu/commit/625b1dd6fb1b428177e5f06730503a63e23c2382))
* **bridge-runner:** replace GNU find -printf with macOS-compatible sed ([017c6c8](https://github.com/tianshu-ai/tianshu/commit/017c6c8b6eefc302cb0b311ec01e041db3bb0648))
* **bridge-runner:** robust -printf replacement (handles all variants) ([b06dc72](https://github.com/tianshu-ai/tianshu/commit/b06dc7287e5b00a23ca2bc6d8a310dbac74f2cab))
* **bridge-runner:** simple cp for deliverables (bypass find+while zsh issue) ([ab13102](https://github.com/tianshu-ai/tianshu/commit/ab13102bcb1860838c4fe0d44a0924ce1ba1dfba))
* **bridge-runner:** simpler -print0/read -d replacement regex ([ee564ff](https://github.com/tianshu-ai/tianshu/commit/ee564ff8026f6752b75c34a42c2bb8dd4ba518e3))
* **bridge-runner:** strip GNU timeout + /sandbox/workspace paths (macOS compat) ([0a04b33](https://github.com/tianshu-ai/tianshu/commit/0a04b33423bec09028ff0b25dc71ef2724d82512))
* **bridge-runner:** wait up to 30s for bridge to connect before failing ([c295aa2](https://github.com/tianshu-ai/tianshu/commit/c295aa266a8ef0546ca179889b074a0790efd60d))
* **bridge-worker:** collect + stage deliverables after runOpencode ([226acde](https://github.com/tianshu-ai/tianshu/commit/226acde65dc1f67ca66c6dc2c2ee6684d5ca502b))
* increase bridge call timeout for long-running commands (opencode) ([80690ee](https://github.com/tianshu-ai/tianshu/commit/80690eeffe0983616fdee98b6a0ae4bfc51dd377))
* **reverse-mcp:** add displayName to sandboxes manifest entry ([2c63eed](https://github.com/tianshu-ai/tianshu/commit/2c63eeda6f618dd76483defbf007e3cd23ab7a44))
* **reverse-mcp:** remove host.bridgeToken from provides (host owns it) ([b3a266b](https://github.com/tianshu-ai/tianshu/commit/b3a266b59907e1a933ca85107ee5594dfc29c798))
* **workboard:** lazy capability get for sandbox.shell (activation order fix) ([c2afca0](https://github.com/tianshu-ai/tianshu/commit/c2afca0cfe061a9fab053e4eb1e6221e54542c5d))
* **workboard:** lazy shell runner — opencode worker available even without Docker ([6b31b6c](https://github.com/tianshu-ai/tianshu/commit/6b31b6c69b842b8ed29a44afe21a1d93df53681a))
* **workboard:** Proxy-based lazy shell (opencode worker always registers) ([1124a42](https://github.com/tianshu-ai/tianshu/commit/1124a42b4c36398e5d188a8e953afb2e42decafa))


### Refactor

* bridge provides sandbox.shell directly (no custom capability) ([ef2527d](https://github.com/tianshu-ai/tianshu/commit/ef2527d9e4d15975ccebca6df31e62beb6fefd05))

## [0.14.0](https://github.com/tianshu-ai/tianshu/compare/v0.13.0...v0.14.0) (2026-07-27)


### Features

* **deps:** upgrade pi-agent-core + pi-ai to 0.82.1 ([309e63f](https://github.com/tianshu-ai/tianshu/commit/309e63f11403e4c2d73346d55ee95a29b5cef306))
* **openshell:** list pre-installed tools in sandbox_exec description ([726182c](https://github.com/tianshu-ai/tianshu/commit/726182ce06a91d8f0ae680977c812ac011be1b12))
* **sandbox:** install P0/P1/P2 dependencies in sandbox image ([c3b55c6](https://github.com/tianshu-ai/tianshu/commit/c3b55c679c565373e730cc5f47849fef9c53a275))


### Bug Fixes

* bump react-dom to 19.2.8 (match react version) ([e5f5abe](https://github.com/tianshu-ai/tianshu/commit/e5f5abef96cf027a812696fc7e139dcb467e60e5))
* **chat:** optimistic user message display (instant, no wait for echo) ([88dc581](https://github.com/tianshu-ai/tianshu/commit/88dc581139714d9bd9bd70774bf62d03ae045a70))
* exclude t from deps (locale changes don't need a re-fetch). ([4dc6dfa](https://github.com/tianshu-ai/tianshu/commit/4dc6dfaa6845f19a410c64ff43c4effb824e2745))
* **files:** remove unstable 't' from useEffect deps (caused infinite render loop) ([4dc6dfa](https://github.com/tianshu-ai/tianshu/commit/4dc6dfaa6845f19a410c64ff43c4effb824e2745))
* **modal:** remove backdrop-blur-sm (suspected GPU repaint flicker) ([93004cd](https://github.com/tianshu-ai/tianshu/commit/93004cda87636d03ba3567ed55a89d1fb6b80cfe))
* **modal:** remove React.StrictMode (causes modal flicker in React 19) ([b6fa1a8](https://github.com/tianshu-ai/tianshu/commit/b6fa1a8df84566ecdb5abca6181cc75ae09edd83))
* revert react/react-dom to 19.2.7 (modal flickering on 19.2.8) ([47f191b](https://github.com/tianshu-ai/tianshu/commit/47f191b4a0e35e7061a480c973ee174f0c71c6c8))
* unify react/react-dom at 19.2.8 (revert failed 19.2.7 downgrade) ([f3e863f](https://github.com/tianshu-ai/tianshu/commit/f3e863f0331ddd544784a0ff4168fae6ec5227b0))
* **viewer:** overflow-y-scroll to prevent scrollbar flicker ([3ecf64f](https://github.com/tianshu-ai/tianshu/commit/3ecf64fcbca38f4e01f4955581f8ffbf0822378f))

## [0.13.0](https://github.com/tianshu-ai/tianshu/compare/v0.12.0...v0.13.0) (2026-07-27)


### Features

* **reverse-mcp:** inline screenshot display in chat ([17f600c](https://github.com/tianshu-ai/tianshu/commit/17f600cd519f1ce78b3b503c08937715b5712a78))


### Bug Fixes

* **reverse-mcp:** clean up bridge tools on socket close ([84a1956](https://github.com/tianshu-ai/tianshu/commit/84a1956f851be3cacee139904fcee50e3c928111))
* **ui:** screenshots auto-visible like MCP-UI (no expand needed) ([d9f6c75](https://github.com/tianshu-ai/tianshu/commit/d9f6c756ad0e09193f7680db95b140b4b516bd69))


### Documentation

* **reverse-mcp:** point users to bridge-desktop app for install ([e90e314](https://github.com/tianshu-ai/tianshu/commit/e90e314ae87463c06d07f6668c96d2788b831926))

## [0.12.0](https://github.com/tianshu-ai/tianshu/compare/v0.11.0...v0.12.0) (2026-07-23)


### Features

* **setup:** fetch the endpoint's model list for OpenAI-compatible providers ([#341](https://github.com/tianshu-ai/tianshu/issues/341)) ([773c0d0](https://github.com/tianshu-ai/tianshu/commit/773c0d07c4640bbfc208a75f135a0d1833a7bf72))

## [0.11.0](https://github.com/tianshu-ai/tianshu/compare/v0.10.0...v0.11.0) (2026-07-23)


### Features

* **setup:** guided OpenAI-compatible endpoint option in the wizard ([#340](https://github.com/tianshu-ai/tianshu/issues/340)) ([1238917](https://github.com/tianshu-ai/tianshu/commit/123891739738fcc9c1ebe574446512070546d2a1))


### Documentation

* **readme:** model-first onboarding; OpenAI-compatible endpoints (Qwen/local) ([#338](https://github.com/tianshu-ai/tianshu/issues/338)) ([c703cac](https://github.com/tianshu-ai/tianshu/commit/c703cacbb7f584651ef2408b9b555903dddc58f2))

## [0.10.0](https://github.com/tianshu-ai/tianshu/compare/v0.9.1...v0.10.0) (2026-07-22)


### Features

* **setup:** Linux support — systemd user service + Dockerfile ([#335](https://github.com/tianshu-ai/tianshu/issues/335)) ([d4eeeba](https://github.com/tianshu-ai/tianshu/commit/d4eeebaab06feafadb0cc19885c1587eb1a603d6))

## [0.9.1](https://github.com/tianshu-ai/tianshu/compare/v0.9.0...v0.9.1) (2026-07-22)


### Bug Fixes

* **reverse-mcp:** keep the bridge registry alive across re-activation ([#332](https://github.com/tianshu-ai/tianshu/issues/332)) ([d4e53a7](https://github.com/tianshu-ai/tianshu/commit/d4e53a72fa0f0c530ac7f49102c8eadbd86bd085))
* **server:** close live WebSockets on shutdown (fix zombie process after restart) ([#334](https://github.com/tianshu-ai/tianshu/issues/334)) ([0061890](https://github.com/tianshu-ai/tianshu/commit/0061890cc85b94ee947e83ac1c023147594dbd35))

## [0.9.0](https://github.com/tianshu-ai/tianshu/compare/v0.8.0...v0.9.0) (2026-07-21)


### Features

* **plugins:** group plugins into sections + localize name/description ([#329](https://github.com/tianshu-ai/tianshu/issues/329)) ([66318e5](https://github.com/tianshu-ai/tianshu/commit/66318e5b37d9e8fa137054831ac5a4cfb00ee7ce))
* **plugins:** read-only plugin manager for members + WeChat binding in a panel ([#331](https://github.com/tianshu-ai/tianshu/issues/331)) ([fec72ef](https://github.com/tianshu-ai/tianshu/commit/fec72ef9b4d97747394ba3892785b001b4260839))

## [0.8.0](https://github.com/tianshu-ai/tianshu/compare/v0.7.0...v0.8.0) (2026-07-21)


### Features

* **reverse-mcp:** Shell capability toggle in the Local Bridge panel ([#326](https://github.com/tianshu-ai/tianshu/issues/326)) ([eb0e4a7](https://github.com/tianshu-ai/tianshu/commit/eb0e4a745f093d117c9daba314af8f07031fe832))


### Bug Fixes

* **reverse-mcp:** include browser flag in the app deep-link ([#328](https://github.com/tianshu-ai/tianshu/issues/328)) ([4c513e2](https://github.com/tianshu-ai/tianshu/commit/4c513e209a673fc921f96b2e952a0e9eb5ff721a))

## [0.7.0](https://github.com/tianshu-ai/tianshu/compare/v0.6.0...v0.7.0) (2026-07-20)


### Features

* **plugin-i18n:** plugin-provided translations loaded by the host (+ workboard reference) ([#324](https://github.com/tianshu-ai/tianshu/issues/324)) ([fe53266](https://github.com/tianshu-ai/tianshu/commit/fe532667b44dbe77383e885f79d563ddb729dec9))
* **web/i18n:** full Simplified-Chinese localization of the host web UI ([#323](https://github.com/tianshu-ai/tianshu/issues/323)) ([70e4e63](https://github.com/tianshu-ai/tianshu/commit/70e4e632040fce99d863bfedae716ab5eefd73d6))

## [0.6.0](https://github.com/tianshu-ai/tianshu/compare/v0.5.8...v0.6.0) (2026-07-19)


### Features

* **admin:** /admin shell + microsandbox sandbox-admin page (ADR-0004 N+4) ([#67](https://github.com/tianshu-ai/tianshu/issues/67)) ([c0b864f](https://github.com/tianshu-ai/tianshu/commit/c0b864f2b88a231eb34862e6df7ec3a69bc09350))
* ADR-0005 LSP integration + plugin-files hardening ([#125](https://github.com/tianshu-ai/tianshu/issues/125)) ([ad81da8](https://github.com/tianshu-ai/tianshu/commit/ad81da8cc191805cb3da04a97bef24133f331c30))
* **auth:** config-driven OAuth/OIDC authentication + admin settings ([14463c7](https://github.com/tianshu-ai/tianshu/commit/14463c7a994be40c3b4a55b6f6376dc4b0d9ee8b))
* **auth:** local password accounts + tenant-level roles ([0efe2af](https://github.com/tianshu-ai/tianshu/commit/0efe2af0b5e803064867000221f6d7a773e604be))
* **auth:** microsandbox image build/switch is admin-only ([7c58bcf](https://github.com/tianshu-ai/tianshu/commit/7c58bcfd1f46cf66ea613f814b1cf3a966967bd9))
* **auth:** per-route access control for plugin routes (member vs admin) ([3d87122](https://github.com/tianshu-ai/tianshu/commit/3d8712286befbe1cea2c5673fa6677d7876f027b))
* **auth:** super-admin tenant management + soft disable ([e620b0e](https://github.com/tianshu-ai/tianshu/commit/e620b0e5082f130f1ba4ae779f097c814b814e25))
* **auth:** tenant switcher for users with multi-tenant access ([ffbc6b6](https://github.com/tianshu-ai/tianshu/commit/ffbc6b6157e8e79c3680a55d3e0d1e8a34af920f))
* **auth:** workforce-studio is admin-only ([ef45378](https://github.com/tianshu-ai/tianshu/commit/ef4537889c50534296f5794965fb02ed3f53c753))
* auto-compact via harness + worker sidebar UI cleanup ([#85](https://github.com/tianshu-ai/tianshu/issues/85)) ([6bfcadd](https://github.com/tianshu-ai/tianshu/commit/6bfcadd689ff79030d7da8285d680f8ef1dd9151))
* **broadcast:** plugin and tool-catalog changes reach every tenant member ([800f31b](https://github.com/tianshu-ai/tianshu/commit/800f31b68da4590a129cd6e346a54ae400e3ca93))
* **broadcast:** plugin change appends history note to every active session in the tenant ([388bab6](https://github.com/tianshu-ai/tianshu/commit/388bab6602d7045759fb05c80e0a72197eb31212))
* **channels/wechat:** send images, videos, files through the iLink CDN ([a38ce09](https://github.com/tianshu-ai/tianshu/commit/a38ce09a98a43ea3bf28c88867d3052b19623da1))
* **channels:** cascade delete wechat sessions + pop viewer to webchat ([5d362fe](https://github.com/tianshu-ai/tianshu/commit/5d362feee4fbbead8e3acf6e2c3be5ef18672b7b))
* **channels:** channel system skeleton (host hub + bindings + plugin SDK) ([edcbab3](https://github.com/tianshu-ai/tianshu/commit/edcbab3c05b203adca0237813cadf38820b5068e))
* **channels:** model picker in the channel-session chat area ([775566b](https://github.com/tianshu-ai/tianshu/commit/775566b5f646853349014b6d9f43892e5fb210c9))
* **channels:** per-session tool visibility + channel context in AgentToolContext ([2f1b14b](https://github.com/tianshu-ai/tianshu/commit/2f1b14bae68434e6d5b4083da71166f25c23adb3))
* **channels:** pick a model per wechat binding ([1f2ddd9](https://github.com/tianshu-ai/tianshu/commit/1f2ddd91065936bae5706fb9f9834d8f021ff71a))
* **channels:** push channel_session_changed event for live sidebar refresh ([9def0e1](https://github.com/tianshu-ai/tianshu/commit/9def0e1466fb4b0db049e0b478b61a79ab36dac1))
* **channels:** retry transient errors + fallback to default model ([b98c9cf](https://github.com/tianshu-ai/tianshu/commit/b98c9cf672ce0eba21de02282ccfa896629d6f35))
* **channels:** sidebar lists channel sessions + chat area pins per session ([e57cde4](https://github.com/tianshu-ai/tianshu/commit/e57cde43706aa28bde8d2e9d3047595009b785d3))
* **channels:** wechat channel plugin (iLink bot API) ([f1a71f5](https://github.com/tianshu-ai/tianshu/commit/f1a71f578a4055387194b7546a14d1175860f57a))
* **channels:** wechat plugin admin UI + host.channelBindings capability ([d1b06c8](https://github.com/tianshu-ai/tianshu/commit/d1b06c8de11cb3b853d9fc459a3c89865873b1b0))
* **channels:** wire agent reply path (router → runPrompt → adapter.send) ([6903086](https://github.com/tianshu-ai/tianshu/commit/6903086eccc0217ca64e3ee849c982ad72da5018))
* **chat:** agent tool loop with fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)b, server side) ([#43](https://github.com/tianshu-ai/tianshu/issues/43)) ([424bfaf](https://github.com/tianshu-ai/tianshu/commit/424bfaf1ff17e9c036ed15cd6c51f4a0ea9d9bb6))
* **chat:** assistant message meta line (model / token usage / context %) ([#57](https://github.com/tianshu-ai/tianshu/issues/57)) ([156ed73](https://github.com/tianshu-ai/tianshu/commit/156ed73c338f15bcad24463b713102be42dcdc5a))
* **chat:** auto-compact conversation history at 50% context window ([#56](https://github.com/tianshu-ai/tianshu/issues/56)) ([c24e728](https://github.com/tianshu-ai/tianshu/commit/c24e728281b6881fff7393d419bf8b87081658c4))
* **chat:** auto-compress oversize images before sending to vision providers ([#55](https://github.com/tianshu-ai/tianshu/issues/55)) ([31b715f](https://github.com/tianshu-ai/tianshu/commit/31b715f7dc71ae130a6ddba46ccc7ba3a48854d0))
* **chat:** chat handler + worker on pi-agent-core's AgentHarness (N+6.4) ([#81](https://github.com/tianshu-ai/tianshu/issues/81)) ([5cea697](https://github.com/tianshu-ai/tianshu/commit/5cea697d74e9f5346bce152af26ae4b8ff58dd61))
* **chat:** inject workspace scaffold into agent prompt; move projects to user level ([#46](https://github.com/tianshu-ai/tianshu/issues/46)) ([#47](https://github.com/tianshu-ai/tianshu/issues/47)) ([761cd92](https://github.com/tianshu-ai/tianshu/commit/761cd9217f722079d89a8ff1863ba7a35f9dd4e1))
* **chat:** minimal end-to-end chat over WebSocket (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)) ([#25](https://github.com/tianshu-ai/tianshu/issues/25)) ([348f214](https://github.com/tianshu-ai/tianshu/commit/348f214f153bfa1c7763704f6daf92016293c9d4))
* **chat:** multimodal user messages — attachments as first-class content ([#52](https://github.com/tianshu-ai/tianshu/issues/52)) ([a74689a](https://github.com/tianshu-ai/tianshu/commit/a74689ae9573c7153b85e258a923d6ecc7470820))
* **chat:** persist tool turns + render them inline (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)c) ([#44](https://github.com/tianshu-ai/tianshu/issues/44)) ([8b2f96f](https://github.com/tianshu-ai/tianshu/commit/8b2f96f572b73cedf89104836e46af8d586743bc))
* **chat:** session-recovery agent for self-healing on harness errors ([#239](https://github.com/tianshu-ai/tianshu/issues/239)) ([8c138e7](https://github.com/tianshu-ai/tianshu/commit/8c138e729020ad843ed1af3df03ff936f8f255b8))
* **cli-agent:** check_build_progress — distinguish in-flight builds from errors ([a91bbf6](https://github.com/tianshu-ai/tianshu/commit/a91bbf69f8a093fd6a5c60708669c79dfa936827))
* **cli-agent:** check_for_update + apply_update tools, fix-flow guidance ([a2a48b7](https://github.com/tianshu-ai/tianshu/commit/a2a48b72b52025cc37acec1fa6671a85e383fdff))
* **cli-agent:** sandbox_inventory tool + inventory-first guidance ([6bfaca5](https://github.com/tianshu-ai/tianshu/commit/6bfaca5f8c29864b80640e7faaa1a5d6876b11fb))
* **cli:** `tianshu doctor` + `tianshu setup --wizard` + global-installable bin ([#158](https://github.com/tianshu-ai/tianshu/issues/158)) ([2772e6d](https://github.com/tianshu-ai/tianshu/commit/2772e6dcc3e1897f285592fc6060940208fd651b))
* **cli:** tianshu update — npm self-updater with checkout safety ([#170](https://github.com/tianshu-ai/tianshu/issues/170)) ([979fb31](https://github.com/tianshu-ai/tianshu/commit/979fb31a0e613c30723b91e848f66aeaf7471eb0))
* **cli:** tianshu update runs a post-install doctor and points at the setup agent ([#258](https://github.com/tianshu-ai/tianshu/issues/258)) ([951c24d](https://github.com/tianshu-ai/tianshu/commit/951c24da0d8d83fd4ac51fdec230b042869ed52d))
* **core:** centralise port/URL resolution in core/urls.ts ([2a7611f](https://github.com/tianshu-ai/tianshu/commit/2a7611f53103d5e804827c0659dfa852f3de68d3))
* **cron:** scheduled & recurring jobs plugin (once + cron, message + task) ([#303](https://github.com/tianshu-ai/tianshu/issues/303)) ([ae2902e](https://github.com/tianshu-ai/tianshu/commit/ae2902ee893adcf77d84406a6ff282c8f53c0f3b))
* **cron:** verify workerAgentId is a real worker on create + update ([#306](https://github.com/tianshu-ai/tianshu/issues/306)) ([099b8fc](https://github.com/tianshu-ai/tianshu/commit/099b8fc2eda329f0596ebf7cf0298cec8c2b5351))
* day-0 scaffolding ([786a0bd](https://github.com/tianshu-ai/tianshu/commit/786a0bdfb1bdf6cdd5e9e3abd2a03677da7c63b6))
* **dev-identity:** URL-driven tenant/user switching via cookie ([#159](https://github.com/tianshu-ai/tianshu/issues/159)) ([5c8d9b3](https://github.com/tianshu-ai/tianshu/commit/5c8d9b3b08dd1cd1f8dff241c425d18c3d46759a))
* **doctor,cli-agent:** differentiate dev vs production mode ([a197004](https://github.com/tianshu-ai/tianshu/commit/a19700435faa3f8d258ead05967ada566ccb997b))
* **doctor:** add Tianshu version check (compare to npm latest) ([736e1f1](https://github.com/tianshu-ai/tianshu/commit/736e1f1079f4790821d32227637755e0d638cd4e))
* **doctor:** auth configuration health check ([c0d621c](https://github.com/tianshu-ai/tianshu/commit/c0d621c7713b1c5fa855fe8b7c966b8213e257f6))
* **files,server:** move workspace layout block to files plugin fragment ([#136](https://github.com/tianshu-ai/tianshu/issues/136)) ([cb823e5](https://github.com/tianshu-ai/tianshu/commit/cb823e5baaafd973eb022d4a452d8067693b298b))
* **files:** clarify read-required prompt + accept paged reads as full ([#138](https://github.com/tianshu-ai/tianshu/issues/138)) ([6450d4b](https://github.com/tianshu-ai/tianshu/commit/6450d4b3e80a7dec42b463489144bc0e62db11b7))
* **files:** move fs agent tools into the files plugin (ADR-0004 N+3.5) ([#62](https://github.com/tianshu-ai/tianshu/issues/62)) ([49ab627](https://github.com/tianshu-ai/tianshu/commit/49ab6272fe8155b2c135c23789e315b4b0fd7526))
* **files:** workspace:// URI scheme for tool→UI file references ([#86](https://github.com/tianshu-ai/tianshu/issues/86)) ([77e7fb7](https://github.com/tianshu-ai/tianshu/commit/77e7fb7181c0cdd6c3f517a46d6924c37b4dcb8e))
* **launchd:** use ai.tianshu.prod / ai.tianshu.dev labels (no hash) + migrate old ones ([9e533ac](https://github.com/tianshu-ai/tianshu/commit/9e533acd86aa8ab535fcec230a8e949f9393b2dc))
* LLM Wiki — distil the rolling conversation into an Obsidian-style vault ([#309](https://github.com/tianshu-ai/tianshu/issues/309)) ([a9b5b34](https://github.com/tianshu-ai/tianshu/commit/a9b5b34e3635ee6d7ac89e31f3cf863a9a6d1e68))
* MCP-UI support + board plugin (interactive HTML dashboards the agent can drive) ([#308](https://github.com/tianshu-ai/tianshu/issues/308)) ([7482e53](https://github.com/tianshu-ai/tianshu/commit/7482e53c0add0fd63723e9dd7f0d704d89feb352))
* **microsandbox,workboard:** per-task sandbox pool with stop-not-remove lifecycle ([#141](https://github.com/tianshu-ai/tianshu/issues/141)) ([16c277c](https://github.com/tianshu-ai/tianshu/commit/16c277cde20171d62ed381933065a62ef6b0c481))
* **microsandbox:** allow file:// + pdf + vision in Playwright MCP, prompt fragment for ephemeral task sandbox ([#145](https://github.com/tianshu-ai/tianshu/issues/145)) ([c6fbabc](https://github.com/tianshu-ai/tianshu/commit/c6fbabced99df5c7b4de7885461ba5bb8f4e567a))
* **microsandbox:** browser sidecar scaffold + 3 agent tools + admin Browser page (ADR-0004 N+5.1) ([#68](https://github.com/tianshu-ai/tianshu/issues/68)) ([74e17a7](https://github.com/tianshu-ai/tianshu/commit/74e17a7d98068f2c48dfdf0a2036eb0c565a96b5))
* **microsandbox:** build resilience — SDK rename, Node fallback, node-python template ([#133](https://github.com/tianshu-ai/tianshu/issues/133)) ([a65490d](https://github.com/tianshu-ai/tianshu/commit/a65490db579687e630ec2615b4eed16191140c89))
* **microsandbox:** builtin plugin scaffold + nullable runner (ADR-0004 N+2) ([#60](https://github.com/tianshu-ai/tianshu/issues/60)) ([babdf6d](https://github.com/tianshu-ai/tianshu/commit/babdf6d8cd1beb67d5c1df36a94a1fa3e2604706))
* **microsandbox:** drop privileges to a real tenant user inside the guest ([#139](https://github.com/tianshu-ai/tianshu/issues/139)) ([53c1b83](https://github.com/tianshu-ai/tianshu/commit/53c1b838858ea20593af627a50a43eda8119ed4e))
* **microsandbox:** eager warm-up on plugin activation ([#64](https://github.com/tianshu-ai/tianshu/issues/64)) ([43a8424](https://github.com/tianshu-ai/tianshu/commit/43a842478e0a1d1bf1084129b530327874f34d41))
* **microsandbox:** expand node-python template to full browser stack ([#134](https://github.com/tianshu-ai/tianshu/issues/134)) ([cd4c0af](https://github.com/tianshu-ai/tianshu/commit/cd4c0afde1fef1b4d63e9069f60a5b473e8a6e6b))
* **microsandbox:** expose memory / cpu / image / timeout in plugin config UI + browser_health_check ([#120](https://github.com/tianshu-ai/tianshu/issues/120)) ([d06326e](https://github.com/tianshu-ai/tianshu/commit/d06326e02314556ec523ac66ea75f1f1b64c5899))
* **microsandbox:** inject $USER / $HOME / $MSB_USER_ID into exec context ([#137](https://github.com/tianshu-ai/tianshu/issues/137)) ([e93cb1b](https://github.com/tianshu-ai/tianshu/commit/e93cb1bc1e82d4a0f3ea7167f3a06b7c7575980a))
* **microsandbox:** live browser stack — port forward + auto supervisord + Playwright MCP wired (ADR-0004 N+5.3) ([#70](https://github.com/tianshu-ai/tianshu/issues/70)) ([fb671c2](https://github.com/tianshu-ai/tianshu/commit/fb671c247e36966e79103c973e9f4ba5ff6bf8ef))
* **microsandbox:** make minimal.yaml a real task-runner template ([#151](https://github.com/tianshu-ai/tianshu/issues/151)) ([79e92f0](https://github.com/tianshu-ai/tianshu/commit/79e92f04b47f613221cecd66a9a41f482f99c4f7))
* **microsandbox:** pool monitor section + Configure dialog ([#143](https://github.com/tianshu-ai/tianshu/issues/143)) ([6a38c3d](https://github.com/tianshu-ai/tianshu/commit/6a38c3d8eb434b04c29d8ca696d908d4d824c531))
* **microsandbox:** Sandboxfile templates + Browser template (CloakBrowser + Playwright MCP + noVNC) (ADR-0004 N+5.2) ([#69](https://github.com/tianshu-ai/tianshu/issues/69)) ([00ed8f1](https://github.com/tianshu-ai/tianshu/commit/00ed8f1432c06e9d58dfd5721422f451f55fcd6f))
* **microsandbox:** split snapshot pointer into Browser + Task roles ([#140](https://github.com/tianshu-ai/tianshu/issues/140)) ([79581a5](https://github.com/tianshu-ai/tianshu/commit/79581a59203fc0fbe40295a91dc573a8ffbb6d9b))
* migrate pi-ai/pi-agent-core 0.79 → 0.80 ([#260](https://github.com/tianshu-ai/tianshu/issues/260)) ([#274](https://github.com/tianshu-ai/tianshu/issues/274)) ([f72ea3b](https://github.com/tianshu-ai/tianshu/commit/f72ea3b0e3ca9504c228d96bd666ecbcb6ec31f2))
* **n5-4:** direct MCP mount via SDK, dynamic browser viewport, MCP servers admin ([#76](https://github.com/tianshu-ai/tianshu/issues/76)) ([6eb310f](https://github.com/tianshu-ai/tianshu/commit/6eb310ff51718ae4c6a86750577830bdcc18de93))
* per-prompt tool-delta detector for cross-upgrade sessions ([253f580](https://github.com/tianshu-ai/tianshu/commit/253f5800780ae0029cc26c2f587a91ae1efbe164))
* **plugin-files:** fuzzy replacers + replace_all in edit_file (ADR-0006 PR-B groundwork) ([#130](https://github.com/tianshu-ai/tianshu/issues/130)) ([9c5796a](https://github.com/tianshu-ai/tianshu/commit/9c5796aa1315eb7fd0ce8759933ff1dc8be88add))
* **plugins/files:** scope to per-user home + tighten top-bar icons ([#40](https://github.com/tianshu-ai/tianshu/issues/40)) ([e8be301](https://github.com/tianshu-ai/tianshu/commit/e8be30150c785a534438d24686ae2d6b7e09f317))
* **plugins/files:** styled panel matching the closed-source repo ([#38](https://github.com/tianshu-ai/tianshu/issues/38)) ([22c1b01](https://github.com/tianshu-ai/tianshu/commit/22c1b017c6ed42d3a9deb9c377eabcb42b8c9544))
* **plugins:** capability registry, requires/provides, sandbox surface (ADR-0004 N+1) ([#59](https://github.com/tianshu-ai/tianshu/issues/59)) ([ba751c7](https://github.com/tianshu-ai/tianshu/commit/ba751c7b9b6fa97fd4d946a0d65e38476107810a))
* **plugins:** catalog client + Plugin Manager Catalog tab (P1) ([#34](https://github.com/tianshu-ai/tianshu/issues/34)) ([4376d67](https://github.com/tianshu-ai/tianshu/commit/4376d672becc941f86779ee895e54c99054e5e18))
* **plugins:** composer file uploads + composerActions SDK contribution ([#48](https://github.com/tianshu-ai/tianshu/issues/48)) ([#49](https://github.com/tianshu-ai/tianshu/issues/49)) ([0bea614](https://github.com/tianshu-ai/tianshu/commit/0bea61476f5e74e393f68f6460d29b8b4aeb0a00))
* **plugins:** contributes.tools[] \u2014 plugins own their agent tools (ADR-0004 N+3) ([#61](https://github.com/tianshu-ai/tianshu/issues/61)) ([db56329](https://github.com/tianshu-ai/tianshu/commit/db56329bc7d6044f2674bb4a3b254e02af7f3111))
* **plugins:** files plugin (workspace browser, server side) ([#35](https://github.com/tianshu-ai/tianshu/issues/35)) ([b2ec9a3](https://github.com/tianshu-ai/tianshu/commit/b2ec9a312c4805aeb546e750d0dacb76e72ed6bb))
* **plugins:** OpenShell shell-sandbox + setup agent prerequisites + project-scoped task results ([97b4eed](https://github.com/tianshu-ai/tianshu/commit/97b4eed2a840229e29be2d24c0a933016ed32b0e))
* **plugins:** plugin runtime + Plugin Manager UI (PR [#31](https://github.com/tianshu-ai/tianshu/issues/31)) ([#32](https://github.com/tianshu-ai/tianshu/issues/32)) ([9405d57](https://github.com/tianshu-ai/tianshu/commit/9405d57ad9e1785c95856c048bbb3320edb67da0))
* **prompt:** add tool-guidelines block to defaultSystemPrompt (OpenClaw-style) ([#124](https://github.com/tianshu-ai/tianshu/issues/124)) ([ea227ea](https://github.com/tianshu-ai/tianshu/commit/ea227ea340940b93f96e63acaac6783ab57ac7a5))
* **prompt:** inject runtime context (time / timezone / host) for every agent ([fc8f994](https://github.com/tianshu-ai/tianshu/commit/fc8f99495c81cfb098052c86faa04b5a6fa4d24d))
* reverse-MCP — bridge local tools (browser) into the agent from the user's machine ([#313](https://github.com/tianshu-ai/tianshu/issues/313)) ([6175d92](https://github.com/tianshu-ai/tianshu/commit/6175d921954fa463cd5b9855c90cecfa524ddcac))
* **reverse-mcp:** copy a config string for the menu-bar app to paste ([#315](https://github.com/tianshu-ai/tianshu/issues/315)) ([898b502](https://github.com/tianshu-ai/tianshu/commit/898b5024167d72b71a5925d3f3ce881001dae855))
* **reverse-mcp:** headless toggle in the Local Bridge panel ([#314](https://github.com/tianshu-ai/tianshu/issues/314)) ([662a102](https://github.com/tianshu-ai/tianshu/commit/662a102437c5cd0b4925ade907e2aaf4a497ff9e))
* **reverse-mcp:** step-by-step panel (install → CLI or menu-bar app) ([#316](https://github.com/tianshu-ai/tianshu/issues/316)) ([26bf60b](https://github.com/tianshu-ai/tianshu/commit/26bf60b6c9ce1af0f9081628f644df35ab3d8c59))
* **server,setup:** serve mode — production startup without dev toolchain ([a87340d](https://github.com/tianshu-ai/tianshu/commit/a87340d833c4b4f8351b374afa84096c1d2e71b8))
* **server:** agent fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)a) ([#42](https://github.com/tianshu-ai/tianshu/issues/42)) ([791819a](https://github.com/tianshu-ai/tianshu/commit/791819ac2ea51883b4263fcee559689a400ec141))
* **server:** inject Execution Bias + AGENTS.md / SOUL.md / USER.md into system prompt ([#148](https://github.com/tianshu-ai/tianshu/issues/148)) ([ee1c97c](https://github.com/tianshu-ai/tianshu/commit/ee1c97c7c287f9ce04c4ff1d61b624a1b6fdf4c4))
* **server:** inject plugin systemPromptFragments into worker prompt (ADR-0007 PR-B) ([#129](https://github.com/tianshu-ai/tianshu/issues/129)) ([aa2e055](https://github.com/tianshu-ai/tianshu/commit/aa2e05535bbae7f3eee9b4ab5bc755ba2e7a0080))
* **server:** optional system-prompt dump for debugging ([#131](https://github.com/tianshu-ai/tianshu/issues/131)) ([76328db](https://github.com/tianshu-ai/tianshu/commit/76328db337dd5436b11abf9b683601b5277beb26))
* **server:** publish effectivePublicUrl on boot ([e15e917](https://github.com/tianshu-ai/tianshu/commit/e15e91716e733a10d77590ca00beebb98883bea5))
* **setup:** cli-agent shows every action, confirms before mutating, no silent auto-fix ([#167](https://github.com/tianshu-ai/tianshu/issues/167)) ([bee4106](https://github.com/tianshu-ai/tianshu/commit/bee4106333d79c92ebe7e1d2b324b93c355b9d92))
* **setup:** in-CLI agent handoff after wizard for conversational setup ([#165](https://github.com/tianshu-ai/tianshu/issues/165)) ([07e1012](https://github.com/tianshu-ai/tianshu/commit/07e1012e10abb1140ca87d687850aa0aa6640392))
* **setup:** wizard probes default model first; smart-skip when working ([#164](https://github.com/tianshu-ai/tianshu/issues/164)) ([c6f9f7f](https://github.com/tianshu-ai/tianshu/commit/c6f9f7fa5e4f2d94f3a4e90bda0be343272f1a89))
* **setup:** wizard supports custom baseUrl + custom model id ([#163](https://github.com/tianshu-ai/tianshu/issues/163)) ([4d21143](https://github.com/tianshu-ai/tianshu/commit/4d21143f037f60b27b7faf802e21a184f1b2db3e))
* **skills:** drop load_skill meta-tool; manage skills via filesystem ([#98](https://github.com/tianshu-ai/tianshu/issues/98)) ([b352c74](https://github.com/tianshu-ai/tianshu/commit/b352c749b0bc8f19d753e478ed70b0f6acbd16fc))
* **skills:** mirror host & plugin SKILL.md into tenant config so one tool reads them all ([#104](https://github.com/tianshu-ai/tianshu/issues/104)) ([bc5c890](https://github.com/tianshu-ai/tianshu/commit/bc5c8900dbf4c07577cdab6d742c344917425832))
* **skills:** on-demand prompt fragments via plugin-contributed skills (ADR-0004 N+4) ([#63](https://github.com/tianshu-ai/tianshu/issues/63)) ([ec6cf6f](https://github.com/tianshu-ai/tianshu/commit/ec6cf6ffdb0258625b484fe1c7c53834756a15ea))
* **skills:** tenant-scoped skill discovery + main agent skill-creator ([#97](https://github.com/tianshu-ai/tianshu/issues/97)) ([98e0480](https://github.com/tianshu-ai/tianshu/commit/98e0480bfed24f05642c951eb543e9f542ad4ff8))
* **tenant:** infrastructure layer (PR [#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([4b6e7ae](https://github.com/tianshu-ai/tianshu/commit/4b6e7ae62da101c7998cf8e7dfe9b8b58cc969a3))
* tool_catalog_refresh — force-replay the tool catalog into chat ([73d8c5d](https://github.com/tianshu-ai/tianshu/commit/73d8c5d0f95e73669f0405bd11e3516f3535a982))
* **ui-a:** host-shared Modal + MarkdownBlock + DocumentViewer primitives ([a345380](https://github.com/tianshu-ai/tianshu/commit/a345380932dfadff4da3cf84e3c4b49efeed0f04))
* **ui-b:** migrate every dialog + markdown surface to UiPrimitives ([6568215](https://github.com/tianshu-ai/tianshu/commit/6568215340ce5f3c6a7af36a9cecb1dcc3b0729a))
* **ui:** CSV/TSV table preview + SVG Render/Source toggle ([1325ff4](https://github.com/tianshu-ai/tianshu/commit/1325ff4eb806a9aa8718f0284774c1ff6f628055))
* **ui:** HTML render+source preview and syntax-highlighted code ([24c2d7c](https://github.com/tianshu-ai/tianshu/commit/24c2d7cbd39ef8f874b40ea881adc551ea0d0565))
* **ui:** light / dark theme switch with semantic CSS variable tokens ([2d31543](https://github.com/tianshu-ai/tianshu/commit/2d315438c87f4440a6092dc236da13b58b95a71a))
* **ui:** Modal headerActions slot + download button in file previews ([9feb899](https://github.com/tianshu-ai/tianshu/commit/9feb8990f9b5508b8554ae7af4f76be4861f713c))
* **ui:** Modal maximize button + double-click toggle ([e5ba744](https://github.com/tianshu-ai/tianshu/commit/e5ba744d2d8423b998e17ca2a9c605be0c046c2d))
* **ui:** model selector pill in composer (PR [#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([5a835ff](https://github.com/tianshu-ai/tianshu/commit/5a835ff99b0b74c135e7c02cdebe895079d1b53c))
* **ui:** Office file placeholder + STREAMED_EXTS includes office ([f9e0acd](https://github.com/tianshu-ai/tianshu/commit/f9e0acd1b9a19ce0c1f4c3dfaf59ec2420f4c658))
* **ui:** PDF / video / audio / image preview through DocumentViewer ([b53912d](https://github.com/tianshu-ai/tianshu/commit/b53912d4847d5d94ff4bac1e24c1853d396ac7ca))
* **ui:** refine chat layout to match closed-source repo (PR [#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([#27](https://github.com/tianshu-ai/tianshu/issues/27)) ([090c6eb](https://github.com/tianshu-ai/tianshu/commit/090c6eb47e6b02c6d0c0c6dcaabb4debe06c47f0))
* **ui:** tianshu-style chat UI (PR [#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([#26](https://github.com/tianshu-ai/tianshu/issues/26)) ([086fce7](https://github.com/tianshu-ai/tianshu/commit/086fce7fe55d29131ccce9cf7da48750aa2c74ef))
* **web-search:** plugin with Tavily / Brave + secret config + provider health cache ([#114](https://github.com/tianshu-ai/tianshu/issues/114)) ([fc636f2](https://github.com/tianshu-ai/tianshu/commit/fc636f285cdeef8590246f4ca3acbd9b6513d6db))
* **web/admin:** render PluginConfigForm banner on every plugin admin page ([#246](https://github.com/tianshu-ai/tianshu/issues/246)) ([ddc9a96](https://github.com/tianshu-ai/tianshu/commit/ddc9a9662d61461ea73c0b858e24e3314667f14f))
* **web:** add logout button (chat sidebar menu + admin sidebar) ([c07bb37](https://github.com/tianshu-ai/tianshu/commit/c07bb370c9107448754056b450e767be85ea2e29))
* **web:** button-driven local-user admin UI (no window.prompt) ([6309438](https://github.com/tianshu-ai/tianshu/commit/63094384716efb82553f954630918bf9c348cbf2))
* **web:** collapsible tool-call rows (closed-source UI parity) ([#45](https://github.com/tianshu-ai/tianshu/issues/45)) ([78c1fb7](https://github.com/tianshu-ai/tianshu/commit/78c1fb7a2c87b7377827d2fa308b6c0db2bf35c1))
* **web:** force URL identity to match session when auth is on ([b962b99](https://github.com/tianshu-ai/tianshu/commit/b962b99e11ad02439fb314ecef468f66c1cd4a16))
* **web:** hide Admin entry from members ([6cf54db](https://github.com/tianshu-ai/tianshu/commit/6cf54db5926325ec124cfe88b677fffea521941c))
* **web:** manifest-driven top bar + right panel (PR [#33](https://github.com/tianshu-ai/tianshu/issues/33)) ([#36](https://github.com/tianshu-ai/tianshu/issues/36)) ([ba488fb](https://github.com/tianshu-ai/tianshu/commit/ba488fbff6a4c68e88f131d8d7fa34a2b59556aa))
* **web:** right-panel tab bar + resize handle (closed-source parity) ([#41](https://github.com/tianshu-ai/tianshu/issues/41)) ([25f1c98](https://github.com/tianshu-ai/tianshu/commit/25f1c984a25865911b65d8ab2c66331bac089f7a))
* **workboard,server,web:** execution dialog + session inbox + history pagination + concurrency fixes ([#94](https://github.com/tianshu-ai/tianshu/issues/94)) ([d79e665](https://github.com/tianshu-ai/tianshu/commit/d79e665eb97f10bc49b3f361090c74fa6bab4f40))
* **workboard:** add worker_analytics tool for orchestrator-side insights ([0929f51](https://github.com/tianshu-ai/tianshu/commit/0929f514728778c81cd5d72b497e454a82353467))
* **workboard:** batch task_create + task_delete ([#93](https://github.com/tianshu-ai/tianshu/issues/93)) ([759226e](https://github.com/tianshu-ai/tianshu/commit/759226e128d183c2292cad4f7cef90fb3380aa52))
* **workboard:** Configure modal + allow one worker to run multiple tasks in parallel ([#250](https://github.com/tianshu-ai/tianshu/issues/250)) ([6ea0f01](https://github.com/tianshu-ai/tianshu/commit/6ea0f011b74849e50d8645fc72afec08a66488af))
* **workboard:** drop worker_agents table; UI read-only; REST mutation routes removed (PR-C) ([#101](https://github.com/tianshu-ai/tianshu/issues/101)) ([cba6701](https://github.com/tianshu-ai/tianshu/commit/cba67011824ced8e34e885250f231cc8d9866b5c))
* **workboard:** enable/disable worker agent from the admin UI ([#146](https://github.com/tianshu-ai/tianshu/issues/146)) ([d057696](https://github.com/tianshu-ai/tianshu/commit/d0576966fb9155d187745f7a6460db8c6bb0ed23))
* **workboard:** fs-only worker config + intervention model + skill / context plumbing ([#102](https://github.com/tianshu-ai/tianshu/issues/102)) ([f4e571e](https://github.com/tianshu-ai/tianshu/commit/f4e571e7546981b0cae0dabc2d32b44c9bdbd2be))
* **workboard:** host.modelCatalog capability + model_list tool for the main agent ([#107](https://github.com/tianshu-ai/tianshu/issues/107)) ([fb2d9ef](https://github.com/tianshu-ai/tianshu/commit/fb2d9ef98167ba68630476cdec3095ad664dd140))
* **workboard:** hot-reload pool when worker bundles change on disk ([#103](https://github.com/tianshu-ai/tianshu/issues/103)) ([2008527](https://github.com/tianshu-ai/tianshu/commit/2008527ccc542a9c19c1cb2c39edda2fc72248a2))
* **workboard:** kanban + worker pool plugin (ADR-0002 §6) ([#78](https://github.com/tianshu-ai/tianshu/issues/78)) ([0fac44a](https://github.com/tianshu-ai/tianshu/commit/0fac44af8afdf8f4d11620405c12d8ce4b34a041))
* **workboard:** LLM worker kind via host.agentLoop capability (N+6.3) ([#80](https://github.com/tianshu-ai/tianshu/issues/80)) ([cd53fac](https://github.com/tianshu-ai/tianshu/commit/cd53fac940ab7241ed2a9b03a5f5985352b21514))
* **workboard:** main agent can list available LLM models via  ([#106](https://github.com/tianshu-ai/tianshu/issues/106)) ([3e7a008](https://github.com/tianshu-ai/tianshu/commit/3e7a00811a21e3c1f43d9e25af277a3c1f1f86df))
* **workboard:** nudge main agent toward plan/design/build/verify decomposition ([#150](https://github.com/tianshu-ai/tianshu/issues/150)) ([a0a9a05](https://github.com/tianshu-ai/tianshu/commit/a0a9a05bd6a1604e1b2f8c6232af5744c29ba771))
* **workboard:** one-shot DB-&gt;fs migration; widen tenant_config_write boundary; retire worker_agent_* tools (PR-B) ([#100](https://github.com/tianshu-ai/tianshu/issues/100)) ([0ff0249](https://github.com/tianshu-ai/tianshu/commit/0ff0249b9a3310ee6c8e7eed192c6263e94f06fa))
* **workboard:** orchestrator tools for managing worker agents ([#96](https://github.com/tianshu-ai/tianshu/issues/96)) ([5f2d314](https://github.com/tianshu-ai/tianshu/commit/5f2d314e00e9c1272c372773c49a2720fb2a46b9))
* **workboard:** per-user concurrency cap, layered on top of the tenant cap ([#245](https://github.com/tianshu-ai/tianshu/issues/245)) ([f4afab5](https://github.com/tianshu-ai/tianshu/commit/f4afab578ec50e619eba2dee47c833ab6fb2300f))
* **workboard:** plugin-contributed agent seeds, fs-backed worker layout (PR-A) ([#99](https://github.com/tianshu-ai/tianshu/issues/99)) ([65b3b11](https://github.com/tianshu-ai/tianshu/commit/65b3b111b662e5015a550f3cfb528ef389e5cab6))
* **workboard:** push worker status over WebSocket instead of polling ([ce32c4c](https://github.com/tianshu-ai/tianshu/commit/ce32c4c3c00934c4a3c062a9ea1f563a54d65cc6))
* **workboard:** quick-delete a task from its board card, with confirm ([#304](https://github.com/tianshu-ai/tianshu/issues/304)) ([0b18732](https://github.com/tianshu-ai/tianshu/commit/0b18732498f79be4438cdbc89db8bde6b0da4f1f))
* **workboard:** retry/publish buttons on label chips ([#91](https://github.com/tianshu-ai/tianshu/issues/91)) ([6a0531e](https://github.com/tianshu-ai/tianshu/commit/6a0531ef586883e10b844e7edd51cd8f563f6d7b))
* **workboard:** show per-task sandbox name in task detail dialog ([#142](https://github.com/tianshu-ai/tianshu/issues/142)) ([4441cc4](https://github.com/tianshu-ai/tianshu/commit/4441cc49922270fb7a4cc8a6a938b2a49326777d))
* **workboard:** task execution history (REST + agent tool) ([#92](https://github.com/tianshu-ai/tianshu/issues/92)) ([3949e14](https://github.com/tianshu-ai/tianshu/commit/3949e14a038164a29096c6b711d9c5e8193fdeca))
* **workboard:** tenant-wide concurrency cap on worker runs ([#244](https://github.com/tianshu-ai/tianshu/issues/244)) ([10e0d4c](https://github.com/tianshu-ai/tianshu/commit/10e0d4cb3165cec89ee4238d839f56de1d3995c0))
* **workboard:** tool/skill catalog capabilities + worker agent ChipPicker ([#95](https://github.com/tianshu-ai/tianshu/issues/95)) ([aa1126a](https://github.com/tianshu-ai/tianshu/commit/aa1126aed6115786f2facafb0826846624e238cd))
* **worker-agents:** host table + REST + plugin seed + admin UI (ADR-0002 §7.1, N+6.2) ([#79](https://github.com/tianshu-ai/tianshu/issues/79)) ([a8b7378](https://github.com/tianshu-ai/tianshu/commit/a8b7378a80e4609f73eeef4f6e1ed1759ceb6255))
* **workforce-studio:** `solution` agent tool (main agent only) ([1852ece](https://github.com/tianshu-ai/tianshu/commit/1852ece8088d751dac5fdc95af2825b6cea09c33))
* **workforce-studio:** Activate (active solution pointer) ([b84d169](https://github.com/tianshu-ai/tianshu/commit/b84d16990c3d1f9bddc0f9ebac4615575ac1cbc0))
* **workforce-studio:** add Main agent section to Solution view ([72afd53](https://github.com/tianshu-ai/tianshu/commit/72afd535ed620bde483c0e28ae4d9a341ab11aa8))
* **workforce-studio:** block-style editor in Solution view main agent ([3a5c10b](https://github.com/tianshu-ai/tianshu/commit/3a5c10bcc82a0a835c8a91704b7740a70f4d2365))
* **workforce-studio:** deny-only skill/tool pickers in Solution view ([2b944aa](https://github.com/tianshu-ai/tianshu/commit/2b944aa3d99f5d1e7e214a702edc88d3f7d0f3d0))
* **workforce-studio:** Develop / Rendered tabs + block decomposition ([b865ec9](https://github.com/tianshu-ai/tianshu/commit/b865ec9659f8f974b74f13a99275b628c6e813d4))
* **workforce-studio:** editable workers in Solution view ([a0cc013](https://github.com/tianshu-ai/tianshu/commit/a0cc013c9b8c560999a6c97d89fb3b3da8c37a05))
* **workforce-studio:** exclude whole workers from a solution ([60f6824](https://github.com/tianshu-ai/tianshu/commit/60f6824058df27ee53d26ce1f52ad9a68130a4f0))
* **workforce-studio:** export/import a solution as a file ([1f4fd60](https://github.com/tianshu-ai/tianshu/commit/1f4fd603bfc7aa4cc7eda95be02d800e65d4b29e))
* **workforce-studio:** group skill/tool pickers by source ([f158545](https://github.com/tianshu-ai/tianshu/commit/f1585458772d63d49ebe2bbf10088625375b3a34))
* **workforce-studio:** in-app Activate confirm (drop window.confirm) ([f25ca29](https://github.com/tianshu-ai/tianshu/commit/f25ca29e60243d10c60d9dc8e31a0de4f366453e))
* **workforce-studio:** include/exclude plugins in a solution ([9ebfc3b](https://github.com/tianshu-ai/tianshu/commit/9ebfc3b7ec423f67c280a894624b77982aa6b713))
* **workforce-studio:** override host blocks + custom fragments ([37f72bb](https://github.com/tianshu-ai/tianshu/commit/37f72bb1e9d666c5bba7be283d75c40628230bf0))
* **workforce-studio:** Phase 1 — inspect + export agent bundle ([f88de5d](https://github.com/tianshu-ai/tianshu/commit/f88de5d24138eb33edc3b14f55608182f5e12d94))
* **workforce-studio:** Phase 2 — Solution abstraction (extract/save/edit/diff) ([7f2f857](https://github.com/tianshu-ai/tianshu/commit/7f2f857744c133fa7d7532c37a803d6ecc945d82))
* **workforce-studio:** Phase 3 — Apply solution to reality ([666327c](https://github.com/tianshu-ai/tianshu/commit/666327c9fee71986a35f95d34882682923e824b8))
* **workforce-studio:** show concrete plugin id on skill/tool picker rows ([52f956b](https://github.com/tianshu-ai/tianshu/commit/52f956bb9e807ac4fe93e96ec0b886fb037e9596))
* **workforce-studio:** surface plugin inventory + tool/skill origin ([39ca266](https://github.com/tianshu-ai/tianshu/commit/39ca2663530d09c7c181d605cce43c803f0c1a07))
* **workforce-studio:** three-pane IDE layout for Solution view ([e24f9cd](https://github.com/tianshu-ai/tianshu/commit/e24f9cdb3e8cf788edd582e29a32f5572bc9e218))
* **workforce:** activate applies the solution's plugin enable-set ([a625297](https://github.com/tianshu-ai/tianshu/commit/a625297ee4bf000e4a59590f68965c5eb528546f))
* **workforce:** per-worker execution-bias override ([e88ddcf](https://github.com/tianshu-ai/tianshu/commit/e88ddcfe17fa37aea8bf4782cb6ea8e123abd1a0))


### Bug Fixes

* Fix:  ([c99a827](https://github.com/tianshu-ai/tianshu/commit/c99a827a259b1ce4b8a7db505292c429c1629d02))
* **adapter:** detect stream-truncated tool calls and surface a useful error ([#105](https://github.com/tianshu-ai/tianshu/issues/105)) ([2e95618](https://github.com/tianshu-ai/tianshu/commit/2e95618d78a4a536b2ab108095605e185baac6ec))
* **auth:** require admin for all settings write routes ([611b5f2](https://github.com/tianshu-ai/tianshu/commit/611b5f26b03dd20034e30fb5342985e3834497c8))
* **auth:** seed per-tenant users row for authed identities (FK error) ([5da6764](https://github.com/tianshu-ai/tianshu/commit/5da67643cf200195412bc91c62819d09870d9aad))
* **channels:** channel bindings are per-user, not per-tenant ([af115f1](https://github.com/tianshu-ai/tianshu/commit/af115f1606e57946304f934fae097dd815933327))
* **channels:** forward every assistant message, not just the last ([b28dc9c](https://github.com/tianshu-ai/tianshu/commit/b28dc9ca71664fefdeaeac0b1a6deadfac43b20f))
* **channels:** friendly agent-error message in channel replies ([b84d4f0](https://github.com/tianshu-ai/tianshu/commit/b84d4f0ccf93fc2cabb3671ef31a0f643f960a3a))
* **channels:** live message_added push for viewed channel sessions ([7c1ed15](https://github.com/tianshu-ai/tianshu/commit/7c1ed1515dd9f3ab2a09fb83c91deae1ca5891c6))
* **channels:** manifest parser drops contributes.channels[] ([a97f61f](https://github.com/tianshu-ai/tianshu/commit/a97f61f90b37e73e1a9045d1446b3551d567cb3b))
* **channels:** one binding per (tenant, user, channel) ([0840592](https://github.com/tianshu-ai/tianshu/commit/084059238383272ad0c1e1137656409f30b5491f))
* **channels:** queue from message_added events, not just stream_end ([d8b5e60](https://github.com/tianshu-ai/tianshu/commit/d8b5e605d7df1cd42a579db9998c99aa5547961b))
* **channels:** route idle-runner replies back through the channel adapter ([b365396](https://github.com/tianshu-ai/tianshu/commit/b365396a857bf2b0196d5d2653eaebc1feafee76))
* **channels:** wire tenantHomeDir from ctx.workspaceDir so tenant_config_* tools see the right tree ([67fc018](https://github.com/tianshu-ai/tianshu/commit/67fc018c029448a835061ca2020956b9132bbaa4))
* **chat:** assistant messages with mixed text + tool calls render in author order ([#65](https://github.com/tianshu-ai/tianshu/issues/65)) ([ccedf35](https://github.com/tianshu-ai/tianshu/commit/ccedf3554072f8be8c912b596b764adabb7d81c5))
* **chat:** keep webchat history separate from channel sessions ([ef53dc3](https://github.com/tianshu-ai/tianshu/commit/ef53dc3f464df873171de568af6cda1d9048d3a8))
* **chat:** mark inbox rows delivered when message text is JSON-escaped ([#237](https://github.com/tianshu-ai/tianshu/issues/237)) ([70dc045](https://github.com/tianshu-ai/tianshu/commit/70dc04523230ec262a55d0ce6a8eecf1756c0615))
* **chat:** pi 0.80 'compact then stop' — over-window fork fallback + guard ([#275](https://github.com/tianshu-ai/tianshu/issues/275)) ([74108ae](https://github.com/tianshu-ai/tianshu/commit/74108ae024a8abe35d3e868bf41bb7bd806b560b))
* **chat:** pre-prompt auto-compact so an over-window turn still runs ([972ba9a](https://github.com/tianshu-ai/tianshu/commit/972ba9abd5efba13868088c7789d1720642f7d09))
* **chat:** session storage chain + bridge pi tool_execution events (N+6.4 follow-up) ([#83](https://github.com/tianshu-ai/tianshu/issues/83)) ([0446273](https://github.com/tianshu-ai/tianshu/commit/04462730378ccf0037b121ed8361f918c2838740))
* **env:** write/read .env at TIANSHU_HOME on global installs ([6bd4f69](https://github.com/tianshu-ai/tianshu/commit/6bd4f69f50502ee731fab46b5a89adb0431fb8e7))
* **files:** make `edits` required in edit_file / tenant_config_edit schema ([#123](https://github.com/tianshu-ai/tianshu/issues/123)) ([daf2875](https://github.com/tianshu-ai/tianshu/commit/daf287514e0d040e003dbcb8d9600116a73a4c63))
* **microsandbox:** adapt to SDK rename of stopAndWait/removePersisted ([#132](https://github.com/tianshu-ai/tianshu/issues/132)) ([026d290](https://github.com/tianshu-ai/tianshu/commit/026d2909022a64329912cd07f9fced3d7feef526))
* **microsandbox:** destroyTask reclaims orphan VMs not in the pool map ([#144](https://github.com/tianshu-ai/tianshu/issues/144)) ([476f462](https://github.com/tianshu-ai/tianshu/commit/476f46287368fe24a667aa455318e6623586358f))
* **microsandbox:** guard exec against host-guest channel hangs ([#153](https://github.com/tianshu-ai/tianshu/issues/153)) ([80d5f54](https://github.com/tianshu-ai/tianshu/commit/80d5f54e05b3302acb2cffd826008611ce66697d))
* **microsandbox:** make execTimeoutMs actually fire (use shellStream + kill) ([#121](https://github.com/tianshu-ai/tianshu/issues/121)) ([ec41a55](https://github.com/tianshu-ai/tianshu/commit/ec41a559a49140d9132a39bd5cccc73a98a42836))
* **microsandbox:** tighten server-startup + verify-task prompts ([#152](https://github.com/tianshu-ai/tianshu/issues/152)) ([c4491a3](https://github.com/tianshu-ai/tianshu/commit/c4491a3118c441655c82510d4ad425852bbe4143))
* **openshell:** ctx.taskId wins over agent-supplied task arg ([#241](https://github.com/tianshu-ai/tianshu/issues/241)) ([74a62cc](https://github.com/tianshu-ai/tianshu/commit/74a62ccc20a6917a68333a1ca6effe310e2b0057))
* **openshell:** drop projects/&lt;project&gt;/ doubling from sync_down host path ([#238](https://github.com/tianshu-ai/tianshu/issues/238)) ([4eef383](https://github.com/tianshu-ai/tianshu/commit/4eef3830687160b68bc6ca1dd7161bdc7d3ae19b))
* **openshell:** remove agent-controllable 'task' arg from sync_down schema ([#242](https://github.com/tianshu-ai/tianshu/issues/242)) ([057aed3](https://github.com/tianshu-ai/tianshu/commit/057aed305b3d029ecee2ec75efb48b126fa85d2a))
* **openshell:** strip redundant projects/&lt;p&gt;/ + users/&lt;u&gt;/ from agent path inputs ([#240](https://github.com/tianshu-ai/tianshu/issues/240)) ([8abbb6d](https://github.com/tianshu-ai/tianshu/commit/8abbb6ddbfc482548fdaf5091decc178f0cf3576))
* **openshell:** task folder name uses slugified taskTitle, not taskId-prefix ([#243](https://github.com/tianshu-ai/tianshu/issues/243)) ([f49559d](https://github.com/tianshu-ai/tianshu/commit/f49559d2fd924b49d1b43461e4e64b920754f6bd))
* pipe agent-loop abort signal into tools so task_abort actually frees workers ([#154](https://github.com/tianshu-ai/tianshu/issues/154)) ([653f542](https://github.com/tianshu-ai/tianshu/commit/653f5428c0d7599de06e4a14f47aa956209483d2))
* **plugin-sdk:** re-resolve MCP endpoint on every callRemote ([#155](https://github.com/tianshu-ai/tianshu/issues/155)) ([827a888](https://github.com/tianshu-ai/tianshu/commit/827a888ad3fa8cddebde5d4a93dcd949bb572e01))
* **plugins:** mount contributed routes under /api/p/&lt;id&gt;/... ([#37](https://github.com/tianshu-ai/tianshu/issues/37)) ([3484ace](https://github.com/tianshu-ai/tianshu/commit/3484aceb51bc19d6900c91770e46dc9d91c3194f))
* **publish:** include plugins/**/templates/** in the npm tarball ([3bd8ff5](https://github.com/tianshu-ai/tianshu/commit/3bd8ff53275d1ddeeff5a72a937a86e3dd9db119))
* **publish:** rename plugin-sdk to scope + bundleDependencies for npm install ([#172](https://github.com/tianshu-ai/tianshu/issues/172)) ([b01a2cf](https://github.com/tianshu-ai/tianshu/commit/b01a2cfaa931b26df392809ca930da05c8f2d56c))
* **publish:** revert plugin-sdk to dependencies (peerDependencies + bundle broke npm install -g) ([741368d](https://github.com/tianshu-ai/tianshu/commit/741368d2e8bd4e6fa369c0a4e7f41dbf3c8c1e7c))
* **server:** read /api/health version from package.json ([50b24fb](https://github.com/tianshu-ai/tianshu/commit/50b24fb9553c2654f0232082b4f1e932f5f859dd))
* **server:** refresh stale dynamic toolsets at worker run start ([#156](https://github.com/tianshu-ai/tianshu/issues/156)) ([1c0ae85](https://github.com/tianshu-ai/tianshu/commit/1c0ae85fc39c489c00ae4b0000aa718b04141530))
* **server:** substitute &lt;self&gt;/&lt;userId&gt; placeholders with caller's actual userId in system prompts ([#157](https://github.com/tianshu-ai/tianshu/issues/157)) ([3550d2a](https://github.com/tianshu-ai/tianshu/commit/3550d2ad6c88d76b9da9231888c2e3274c786ee3))
* **server:** unify USER.md prompt so empty templates trigger onboarding ([#149](https://github.com/tianshu-ai/tianshu/issues/149)) ([c595e08](https://github.com/tianshu-ai/tianshu/commit/c595e08309fe96338d649cc69c20e8d0025b6cb5))
* **serve:** serve index.html via buffer, not res.sendFile ([c296867](https://github.com/tianshu-ai/tianshu/commit/c29686748f51cf7c86d272355dd23fe22240de5d))
* **serve:** use bin/serve.mjs entrypoint (not shell-var script) ([b2bd315](https://github.com/tianshu-ai/tianshu/commit/b2bd315c6a9f7dada2fd63a4c0042e85fc4314da))
* **setup:** force-reload .env after wizard writes; clear pass/fail signal on model ping ([#166](https://github.com/tianshu-ai/tianshu/issues/166)) ([1130ce6](https://github.com/tianshu-ai/tianshu/commit/1130ce695713ba423542f9fb956cfa2d76278694))
* **setup:** skip web-port prompt in production mode ([59ab697](https://github.com/tianshu-ai/tianshu/commit/59ab697d1ca4e26ce0f1259bd1d2e1ce2a3cffc0))
* **ui:** channel session footer layout is now stacked + compact ([b946e92](https://github.com/tianshu-ai/tianshu/commit/b946e925a12fd26c032f215fe38e2d1166eec2e2))
* **ui:** channel session selected-row visible on light theme ([960df8b](https://github.com/tianshu-ai/tianshu/commit/960df8bc0853a1109fc7db27ccf675d254059e43))
* **ui:** de-dupe ws handlers + message renders (StrictMode) ([#28](https://github.com/tianshu-ai/tianshu/issues/28)) ([0b8b5bc](https://github.com/tianshu-ai/tianshu/commit/0b8b5bcb3c163cfa277fa23ae32243bd8280de4d))
* **ui:** drop prose-invert on light theme ([92dccee](https://github.com/tianshu-ai/tianshu/commit/92dccee4aa7364273beab70b5c4acb415c286b4e))
* **ui:** FileOpenDialog renders markdown through DocumentViewer ([3126b30](https://github.com/tianshu-ai/tianshu/commit/3126b30edabe0182f70899703ab6c214c3c5917e))
* **ui:** HTML preview height + CodeBlock line-number drift ([02f5185](https://github.com/tianshu-ai/tianshu/commit/02f51850789e0a547916022e19e2ac73f7dbc92a))
* **ui:** inline code chip on light theme ([803860a](https://github.com/tianshu-ai/tianshu/commit/803860a6937214b9fb3f570d7c4e7f44a2c124b6))
* **ui:** light theme — invert canvas/surface hierarchy ([be9d4d9](https://github.com/tianshu-ai/tianshu/commit/be9d4d9bc069717ec0d6e9a0c38c9d37fef51ab8))
* **ui:** light theme coverage + visual contrast rework ([c6c28fc](https://github.com/tianshu-ai/tianshu/commit/c6c28fca361b5f4a7c9d7a3ab4aba92107ac4897))
* **ui:** Modal panel height collapses to content height for previews ([b6cff84](https://github.com/tianshu-ai/tianshu/commit/b6cff848e014516076c8e377a3ba550feece5423))
* **ui:** preview height collapses to a sliver for PDF / HTML / images ([d975ebb](https://github.com/tianshu-ai/tianshu/commit/d975ebb998c364554812bb99d2ffdc9edbaaa3af))
* **ui:** really strip backtick pseudo-elements from prose code ([9231a80](https://github.com/tianshu-ai/tianshu/commit/9231a8069ee381af967e73eec7d081eda2176ca9))
* **ui:** remove Modal's built-in scroll container to fix double scrollbars ([c41927f](https://github.com/tianshu-ai/tianshu/commit/c41927f999b9c21dae0b22be91d9e02bdff7ef2a))
* **ui:** soften light theme overlay (0.5 -&gt; 0.4) ([805d581](https://github.com/tianshu-ai/tianshu/commit/805d581870b23531d1eaad59ecd6fb2367afdd9d))
* **ui:** switch Modal body to flex column + callers use flex-1 min-h-0 ([7525e12](https://github.com/tianshu-ai/tianshu/commit/7525e12e48b2268f8f854b6f77dd2e175a427a5f))
* **ui:** tool-call name + status colors use semantic tokens ([7a74e5f](https://github.com/tianshu-ai/tianshu/commit/7a74e5f011f297a3dbe27f59de15c8ef6a22dd7c))
* **ui:** white text on light surfaces ([d431034](https://github.com/tianshu-ai/tianshu/commit/d4310347df744b50aac3a8b02982da3e0a9a1c59))
* **ui:** workboard task result summary visible on light theme ([e289c1d](https://github.com/tianshu-ai/tianshu/commit/e289c1de4afeef563bbc6b4117efb477779948c1))
* **web:** admin nav used stale dev-identity cookie after user switch ([937548b](https://github.com/tianshu-ai/tianshu/commit/937548bd2a83bf89b516c03d88b5375ae07e23c9))
* **web:** align tool-call rows inside a unified turn card ([#317](https://github.com/tianshu-ai/tianshu/issues/317)) ([75a931d](https://github.com/tianshu-ai/tianshu/commit/75a931d9509fe96f9ff32218917eb1fd289710ef))
* **web:** chat topbar shows username, not raw userId ([3f17d25](https://github.com/tianshu-ai/tianshu/commit/3f17d25c60ce1985b95616ad6506470e96774d19))
* **web:** don't rewrite /login under the dev-identity path prefix ([ca39118](https://github.com/tianshu-ai/tianshu/commit/ca39118684f0269b98f82751cf0965bd023c5073))
* **web:** eliminate per-token re-render churn in chat transcript ([#294](https://github.com/tianshu-ai/tianshu/issues/294)) ([79b8419](https://github.com/tianshu-ai/tianshu/commit/79b8419c271746e8d556851a99e8d1a533caee00))
* **web:** flag super-admins in the Users list (not "no tenant roles") ([dc429b0](https://github.com/tianshu-ai/tianshu/commit/dc429b03cbb73ba024f0f3e521b401a6d4a958eb))
* **web:** match ThemeToggle active state to sidebar channel selection ([d855d22](https://github.com/tianshu-ai/tianshu/commit/d855d2257342831a35170f186258346f6ab40566))
* **web:** Modal steals focus from inputs on every keystroke ([a52b228](https://github.com/tianshu-ai/tianshu/commit/a52b22897db655216c9247e1eeebcbd1126ed2d3))
* **web:** render tool calls live, not only after refresh ([258efb1](https://github.com/tianshu-ai/tianshu/commit/258efb1e9fa1a69ea6f76c2e5055ea77fe39343d))
* **web:** show username in admin sidebar; group Models/MCP with auth ([bcf1594](https://github.com/tianshu-ai/tianshu/commit/bcf1594099434c9e06666c0c773a43c25eba6c2c))
* **web:** solid accent highlight for active ThemeToggle mode ([d6ee995](https://github.com/tianshu-ai/tianshu/commit/d6ee995a34984c7f31ba79df8d9b0b646c5a9091))
* **web:** unify selected-row highlight across app (match webchat/wechat) ([1799dc0](https://github.com/tianshu-ai/tianshu/commit/1799dc0059d6003fcfe80cb6da2c0c002667f5a5))
* **web:** visible active mode in light-theme ThemeToggle ([3f90dff](https://github.com/tianshu-ai/tianshu/commit/3f90dff197e8aafe681e55ab484bcc6d851f6247))
* **wechat:** admin UI reflects 'one binding per user' ([99f0adf](https://github.com/tianshu-ai/tianshu/commit/99f0adf2e52ae6376808ca29a3f0dfabe199f7c9))
* **wechat:** Authorization Bearer + channel_version as semver string ([13656d4](https://github.com/tianshu-ai/tianshu/commit/13656d41e9997cdd6e58cc0609d2a7b7d169b743))
* **wechat:** correct iLink QR-status polling (GET + status enum) ([c99a827](https://github.com/tianshu-ai/tianshu/commit/c99a827a259b1ce4b8a7db505292c429c1629d02))
* **wechat:** normaliseInbound matches the real iLink wire shape ([c050c00](https://github.com/tianshu-ai/tianshu/commit/c050c00ea92313da83aa53aa262fec139a2f8dde))
* **wechat:** outbound sendmessage uses real iLink wire shape (msg wrapper + item_list) ([9658a31](https://github.com/tianshu-ai/tianshu/commit/9658a31a857bdcf6cff184fcc2b7e7432715f615))
* **wechat:** render QR via canvas instead of &lt;img src=URL&gt; ([ef38be7](https://github.com/tianshu-ai/tianshu/commit/ef38be716e69252b2e8b9a3c471dd2262949f652))
* **wechat:** use base64(hex-string) encoding for aes_key on all media types ([8065d0a](https://github.com/tianshu-ai/tianshu/commit/8065d0abbd2675f7a1b88fe375789492700ee7e3))
* **wechat:** use OpenClaw's iLink auth headers + correct base_info ([5481fd5](https://github.com/tianshu-ai/tianshu/commit/5481fd5f9d8c66bc9516c8c06da4b132aad25223))
* **wiki:** working embedding search — Gemini proxy protocol + sqlite-vec/FTS5 hybrid + CJK ([#311](https://github.com/tianshu-ai/tianshu/issues/311)) ([2e7dcf7](https://github.com/tianshu-ai/tianshu/commit/2e7dcf75b1664b7dfa3fc62d938b870e8ac08979))
* **workboard:** cancel live worker on task delete / status move ([6714758](https://github.com/tianshu-ai/tianshu/commit/6714758fe78c9f807a66e7174e90873c74bef2bb))
* **workboard:** nudge on done patches + fallback polling timer ([#89](https://github.com/tianshu-ai/tianshu/issues/89)) ([b959cd2](https://github.com/tianshu-ai/tianshu/commit/b959cd23efb24c2d16e7f229063ae14939d99143))
* **workboard:** show awaiting-intervention chip on board cards ([#118](https://github.com/tianshu-ai/tianshu/issues/118)) ([2220f76](https://github.com/tianshu-ai/tianshu/commit/2220f7631a42e9a2fbc7c03e58ab6b344929ed9b))
* **workboard:** surface worker_analytics via manifest + add hygiene tests ([c44a9c8](https://github.com/tianshu-ai/tianshu/commit/c44a9c81135bbb73ad9df3056c1ec385fa888c03))
* **workboard:** task_move(status=ready) clears intervention labels (zombie task fix) ([#117](https://github.com/tianshu-ai/tianshu/issues/117)) ([a0d37b0](https://github.com/tianshu-ai/tianshu/commit/a0d37b0fa0089ff78fbf695c91b6a5a12ea998d1))
* **worker:** drop MAX_TURNS cap; deny task management tools in LLM workers ([#87](https://github.com/tianshu-ai/tianshu/issues/87)) ([4c00b41](https://github.com/tianshu-ai/tianshu/commit/4c00b418c2331b76dd039dd5fd732c4459ef5d0d))
* **workforce-studio:** bigger chevrons + collapsible Main agent ([2d12095](https://github.com/tianshu-ai/tianshu/commit/2d1209561907a6338002999827c64cfb44b832ff))
* **workforce-studio:** explain why Current mirror pickers are inert ([31c1cce](https://github.com/tianshu-ai/tianshu/commit/31c1cce0cf3846f891e7cd17fd4fb7b880c8d10b))
* **workforce-studio:** flatten worker host blocks to match main agent ([c348896](https://github.com/tianshu-ai/tianshu/commit/c348896b7a9ea275a4d7eac067450a23b7018cb2))
* **workforce-studio:** include tenant-authored skills in snapshot ([acd39d6](https://github.com/tianshu-ai/tianshu/commit/acd39d6c64bd6eccdbb21277b96f319bc740451c))
* **workforce-studio:** legible Activate modal text + buttons ([aac79cc](https://github.com/tianshu-ai/tianshu/commit/aac79ccd23b314776f017b33227628451fb00a01))
* **workforce-studio:** only plugin-sourced resources are locked ([bf43922](https://github.com/tianshu-ai/tianshu/commit/bf43922da006754113b75dceeaa42c2ee27b58bf))
* **workforce-studio:** picker button is the action, plus an excluded pill ([120edf7](https://github.com/tianshu-ai/tianshu/commit/120edf7dce8ed75e24727eb963212ba583263098))
* **workforce-studio:** restore worker exclude/include in Workers overview ([d7b0855](https://github.com/tianshu-ai/tianshu/commit/d7b0855a87c4d0ce15c4cb78dd66e8b4a7dc5eee))
* **workforce-studio:** solution tool `save` accepts spec as JSON string ([dd82972](https://github.com/tianshu-ai/tianshu/commit/dd829725f5dfdfcc77ec44f1424b3c218191ebc8))
* **workforce-studio:** visible tree selection in light theme ([5bb880c](https://github.com/tianshu-ai/tianshu/commit/5bb880cc7bce8b2ded88850cca8e77bab3d4da1b))
* **workforce-studio:** worker SOUL.md empty in Current mirror ([bb4b4fd](https://github.com/tianshu-ai/tianshu/commit/bb4b4fdf4800db131a3d844f55820ab8c58f62b6))
* **workforce:** current mirror extract reads applied main-agent config ([64646a7](https://github.com/tianshu-ai/tianshu/commit/64646a78922696e47893769a65c2ab6607a6c5cd))
* **workforce:** reject malformed customFragments instead of silently dropping ([#276](https://github.com/tianshu-ai/tianshu/issues/276)) ([7a4d36d](https://github.com/tianshu-ai/tianshu/commit/7a4d36de01bc2192616c5d99d49132aa19c59bf1))
* **workforce:** snapshot reads applied-solution config so Reality view matches reality ([d8a3326](https://github.com/tianshu-ai/tianshu/commit/d8a332676d708bef65140b9218b536dc03dc9e4a))
* **write:** tool description guideline + repeat-truncation escalation ([#116](https://github.com/tianshu-ai/tianshu/issues/116)) ([91e60fe](https://github.com/tianshu-ai/tianshu/commit/91e60fe18591828b836e63d138b6506b8a072d44))
* WS chat respects user identity (close conversation isolation hole) ([#162](https://github.com/tianshu-ai/tianshu/issues/162)) ([c2f83b3](https://github.com/tianshu-ai/tianshu/commit/c2f83b31e9d6267de10e17a7054a0ed11f0e960e))


### Performance

* **config:** mtime-invalidated read cache for config.json ([8288b56](https://github.com/tianshu-ai/tianshu/commit/8288b561da140488a2419ecbdde15fe9d5c54feb))


### Documentation

* add v0.5.0 launch post links to the Build log ([#293](https://github.com/tianshu-ai/tianshu/issues/293)) ([d110f8c](https://github.com/tianshu-ai/tianshu/commit/d110f8c90eebaf98a61b02aa69a822adb2ad0ea9))
* ADR-0001 multi-tenant architecture ([#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([e5d1cc7](https://github.com/tianshu-ai/tianshu/commit/e5d1cc794783ccd045b6081d9c0c9145fa24f2d9))
* ADR-0002 orchestrator + workers, with config layering ([#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([6d5fff6](https://github.com/tianshu-ai/tianshu/commit/6d5fff6cac433e6134463b169103f20594cf7fd5))
* ADR-0003 plugin system (UI panels, sidebar sections, API routes) ([#30](https://github.com/tianshu-ai/tianshu/issues/30)) ([4386ccd](https://github.com/tianshu-ai/tianshu/commit/4386ccddcc8158b286559af894f0f532b1816724))
* ADR-0004 plugin capabilities & sandbox contract ([#58](https://github.com/tianshu-ai/tianshu/issues/58)) ([b6a84f4](https://github.com/tianshu-ai/tianshu/commit/b6a84f46e732ae483640d5efd3247db078192312))
* **adr:** ADR-0008 — Solution model & Workforce Studio ([f4da3b9](https://github.com/tianshu-ai/tianshu/commit/f4da3b985553beb52c7811e2bd9ea16784f38ecd))
* **adr:** record channel-bindings stay user-scoped (v0 decision) ([#235](https://github.com/tianshu-ai/tianshu/issues/235)) ([203cfe6](https://github.com/tianshu-ai/tianshu/commit/203cfe6787fff32c3cd8fd5f7a5e3c535fa92cb7))
* **architecture:** ADR-0007 — skill progressive disclosure ([#128](https://github.com/tianshu-ai/tianshu/issues/128)) ([56e114c](https://github.com/tianshu-ai/tianshu/commit/56e114c3c5c3319c444458c9e8aa4f54400c006e))
* clarify setup-agent hand-off + drop unmaintained hosted-demo link ([dee1596](https://github.com/tianshu-ai/tianshu/commit/dee159650e1c29e9506ecdb06a154b644eea5af8))
* **dev:** document the two upstream npm deprecation warnings (install-time only) ([d0ac38f](https://github.com/tianshu-ai/tianshu/commit/d0ac38f9d3010f3301ed779d792c9e20cd4d3183))
* **files,microsandbox:** clarify cross-tool path semantics ([#135](https://github.com/tianshu-ai/tianshu/issues/135)) ([802301b](https://github.com/tianshu-ai/tianshu/commit/802301beb80053d9e43e6b330b54399d6ff0bf5c))
* highlight the orchestrator's supervisor role + analytics ([0dac40f](https://github.com/tianshu-ai/tianshu/commit/0dac40f16e2f18f1c783fdcda2345b763e1ac96e))
* how to run tianshu as a background service (macOS launchd) ([#161](https://github.com/tianshu-ai/tianshu/issues/161)) ([e439c67](https://github.com/tianshu-ai/tianshu/commit/e439c678c7ac2de18f8b3bc3e50a07b3d1b5b615))
* **microsandbox:** teach the agent how to start servers without hanging exec ([#119](https://github.com/tianshu-ai/tianshu/issues/119)) ([c03a2f3](https://github.com/tianshu-ai/tianshu/commit/c03a2f3ddcfb5fb9c62620309d3d6bb8ada7b0b1))
* **microsandbox:** tell agents to use existing chromium + libreoffice instead of reinstalling ([#122](https://github.com/tianshu-ai/tianshu/issues/122)) ([16b3363](https://github.com/tianshu-ai/tianshu/commit/16b33634d366876695cd1aabdeb62e9f72e5aa03))
* pi 0.80 migration brief (issue [#260](https://github.com/tianshu-ai/tianshu/issues/260)) ([c72f5aa](https://github.com/tianshu-ai/tianshu/commit/c72f5aa5b452e26b052fc68f9ba955b6f96da3ce))
* README rewrite — guide users from install to first run ([de9ec3e](https://github.com/tianshu-ai/tianshu/commit/de9ec3e1df0060609335f4347dcaccdd84b9c2c0))
* **readme:** lead with `npm install -g`, demote dev-checkout flow ([85fe23b](https://github.com/tianshu-ai/tianshu/commit/85fe23b87bc2dac9b91e6bae6fe3f9d9ae5e557d))
* Workforce Studio IDE-layout rework brief ([8b741e8](https://github.com/tianshu-ai/tianshu/commit/8b741e8a7a9c237b185aba7ff414902d079c02f2))


### Refactor

* **auth:** tenant by membership, not a global strategy ([858290a](https://github.com/tianshu-ai/tianshu/commit/858290a7aab4ab737bfe19be6f001d8902acebcb))
* **channels:** channel session sidebar rows belong to plugins, not the host ([0f5c54e](https://github.com/tianshu-ai/tianshu/commit/0f5c54e24fc8c5e1783d4cf2b56978c50c6082f0))
* **chat:** extract system-prompt + compact-decision out of handler.ts ([969ba94](https://github.com/tianshu-ai/tianshu/commit/969ba94a7eb1fbad575a67861ba74fa3d84631fd))
* **chat:** storage owns image base64 + drop legacy helpers + migration 004 ([#84](https://github.com/tianshu-ai/tianshu/issues/84)) ([2a1fa58](https://github.com/tianshu-ai/tianshu/commit/2a1fa580b06b2288b2ff499fbd57613ceb429f69))
* **cli,setup:** use core/urls for port/URL resolution ([d0fc71e](https://github.com/tianshu-ai/tianshu/commit/d0fc71e2ce6478726cf5613d6d5d1c31717dffa1))
* **config:** drop dead OverridableConfig.oauth; document global-only auth ([50a4463](https://github.com/tianshu-ai/tianshu/commit/50a446387e3428d6b89abff8ab9f5681c4328500))
* **middleware:** pluggable IdentityResolver chain ([#160](https://github.com/tianshu-ai/tianshu/issues/160)) ([d7e9265](https://github.com/tianshu-ai/tianshu/commit/d7e9265016a6533ec72d421c85174cd2a7a569dc))
* **plugins:** bundle plugin JS deps into dist instead of hoisting to root ([#307](https://github.com/tianshu-ai/tianshu/issues/307)) ([1f3838d](https://github.com/tianshu-ai/tianshu/commit/1f3838dadd87d7604c2b61458cd77f7e58726df8))
* **server:** split index.ts boot into focused modules; harden homeDir resolution ([66dd54e](https://github.com/tianshu-ai/tianshu/commit/66dd54e8f60e63b630d1710b02be4f98a202e5bb))
* **web:** split Auth admin page into sidebar sub-nodes ([47d1f73](https://github.com/tianshu-ai/tianshu/commit/47d1f736701cb86131080f6e1cb50faba527b727))
* **wiki:** configure embedding models in Settings → Models; wiki config just picks one ([#310](https://github.com/tianshu-ai/tianshu/issues/310)) ([417ce7a](https://github.com/tianshu-ai/tianshu/commit/417ce7a310a249b839e2d02f477698eb46c1b26f))
* **workboard:** rename todo→ready, retry-on-failure, drop aborted state ([#88](https://github.com/tianshu-ai/tianshu/issues/88)) ([67a8cbb](https://github.com/tianshu-ai/tianshu/commit/67a8cbb77cdf962b198bc5cf1f64518392972095))
* **workboard:** stalled is a label, not a status (3 columns total) ([#90](https://github.com/tianshu-ai/tianshu/issues/90)) ([0c80ae9](https://github.com/tianshu-ai/tianshu/commit/0c80ae97242added8d289b950c56d700f96e8c57))
* **workforce-studio:** rename Develop tab label to Blocks (ADR-0008 §8) ([3f2fc9f](https://github.com/tianshu-ai/tianshu/commit/3f2fc9f8e738efcfc417e064c1fecda10d846759))

## [0.5.8](https://github.com/tianshu-ai/tianshu/compare/v0.5.7...v0.5.8) (2026-07-19)

### Features

* **wiki:** hybrid semantic search engine — sqlite-vec (`vec0`) + FTS5 (trigram, CJK-capable) in the tenant DB, fused with Reciprocal Rank Fusion, replacing the JSON cosine scan ([#311](https://github.com/tianshu-ai/tianshu/pull/311))
* **wiki:** "Rebuild index" button in the panel to re-embed all pages on demand
* **wiki:** configure embedding models in Settings → Models (`mode: "embedding"`); the plugin config just picks one ([#310](https://github.com/tianshu-ai/tianshu/pull/310))
* **setup:** the setup agent can test/diagnose embedding models (both OpenAI-compatible and Gemini-proxy protocols)

### Bug Fixes

* **wiki:** embed via the provider's actual protocol (OpenAI `/embeddings` vs Gemini proxy `:embedContent`), send the key as both `x-goog-api-key` and Bearer, and surface embed failures instead of swallowing them
* **wiki:** fix CJK keyword matching (trigram tokenizer) and normalise fused scores to [0,1] so `minScore` no longer discards every hit; embed queries with `RETRIEVAL_QUERY`

## [0.5.7](https://github.com/tianshu-ai/tianshu/compare/v0.5.6...v0.5.7) (2026-07-18)

### Features

* **wiki:** LLM Wiki plugin — distil the rolling conversation timeline into an Obsidian-style vault (sources + entities/concepts/topics + a daily→weekly→monthly→yearly journal), written by a background worker session ([#309](https://github.com/tianshu-ai/tianshu/pull/309))
* **wiki:** embedding-backed semantic search with keyword fallback; mode-aware `wiki_search`
* **wiki:** clickable wikilinks + a lazy-loaded `react-force-graph-2d` graph view
* configurable system-level default output language (auto/English/Chinese) injected into agents + workers

### Bug Fixes

* **board:** use a dashboard icon (not a globe) for the Boards topbar button

## [0.5.1](https://github.com/tianshu-ai/tianshu/compare/v0.5.0...v0.5.1) (2026-07-15)


### Bug Fixes

* **web:** render tool calls live, not only after refresh ([258efb1](https://github.com/tianshu-ai/tianshu/commit/258efb1e9fa1a69ea6f76c2e5055ea77fe39343d))

## [0.5.0](https://github.com/tianshu-ai/tianshu/compare/v0.4.85...v0.5.0) (2026-07-15)


### Features

* **admin:** /admin shell + microsandbox sandbox-admin page (ADR-0004 N+4) ([#67](https://github.com/tianshu-ai/tianshu/issues/67)) ([c0b864f](https://github.com/tianshu-ai/tianshu/commit/c0b864f2b88a231eb34862e6df7ec3a69bc09350))
* ADR-0005 LSP integration + plugin-files hardening ([#125](https://github.com/tianshu-ai/tianshu/issues/125)) ([ad81da8](https://github.com/tianshu-ai/tianshu/commit/ad81da8cc191805cb3da04a97bef24133f331c30))
* **auth:** config-driven OAuth/OIDC authentication + admin settings ([14463c7](https://github.com/tianshu-ai/tianshu/commit/14463c7a994be40c3b4a55b6f6376dc4b0d9ee8b))
* **auth:** local password accounts + tenant-level roles ([0efe2af](https://github.com/tianshu-ai/tianshu/commit/0efe2af0b5e803064867000221f6d7a773e604be))
* **auth:** microsandbox image build/switch is admin-only ([7c58bcf](https://github.com/tianshu-ai/tianshu/commit/7c58bcfd1f46cf66ea613f814b1cf3a966967bd9))
* **auth:** per-route access control for plugin routes (member vs admin) ([3d87122](https://github.com/tianshu-ai/tianshu/commit/3d8712286befbe1cea2c5673fa6677d7876f027b))
* **auth:** super-admin tenant management + soft disable ([e620b0e](https://github.com/tianshu-ai/tianshu/commit/e620b0e5082f130f1ba4ae779f097c814b814e25))
* **auth:** tenant switcher for users with multi-tenant access ([ffbc6b6](https://github.com/tianshu-ai/tianshu/commit/ffbc6b6157e8e79c3680a55d3e0d1e8a34af920f))
* **auth:** workforce-studio is admin-only ([ef45378](https://github.com/tianshu-ai/tianshu/commit/ef4537889c50534296f5794965fb02ed3f53c753))
* auto-compact via harness + worker sidebar UI cleanup ([#85](https://github.com/tianshu-ai/tianshu/issues/85)) ([6bfcadd](https://github.com/tianshu-ai/tianshu/commit/6bfcadd689ff79030d7da8285d680f8ef1dd9151))
* **broadcast:** plugin and tool-catalog changes reach every tenant member ([800f31b](https://github.com/tianshu-ai/tianshu/commit/800f31b68da4590a129cd6e346a54ae400e3ca93))
* **broadcast:** plugin change appends history note to every active session in the tenant ([388bab6](https://github.com/tianshu-ai/tianshu/commit/388bab6602d7045759fb05c80e0a72197eb31212))
* **channels/wechat:** send images, videos, files through the iLink CDN ([a38ce09](https://github.com/tianshu-ai/tianshu/commit/a38ce09a98a43ea3bf28c88867d3052b19623da1))
* **channels:** cascade delete wechat sessions + pop viewer to webchat ([5d362fe](https://github.com/tianshu-ai/tianshu/commit/5d362feee4fbbead8e3acf6e2c3be5ef18672b7b))
* **channels:** channel system skeleton (host hub + bindings + plugin SDK) ([edcbab3](https://github.com/tianshu-ai/tianshu/commit/edcbab3c05b203adca0237813cadf38820b5068e))
* **channels:** model picker in the channel-session chat area ([775566b](https://github.com/tianshu-ai/tianshu/commit/775566b5f646853349014b6d9f43892e5fb210c9))
* **channels:** per-session tool visibility + channel context in AgentToolContext ([2f1b14b](https://github.com/tianshu-ai/tianshu/commit/2f1b14bae68434e6d5b4083da71166f25c23adb3))
* **channels:** pick a model per wechat binding ([1f2ddd9](https://github.com/tianshu-ai/tianshu/commit/1f2ddd91065936bae5706fb9f9834d8f021ff71a))
* **channels:** push channel_session_changed event for live sidebar refresh ([9def0e1](https://github.com/tianshu-ai/tianshu/commit/9def0e1466fb4b0db049e0b478b61a79ab36dac1))
* **channels:** retry transient errors + fallback to default model ([b98c9cf](https://github.com/tianshu-ai/tianshu/commit/b98c9cf672ce0eba21de02282ccfa896629d6f35))
* **channels:** sidebar lists channel sessions + chat area pins per session ([e57cde4](https://github.com/tianshu-ai/tianshu/commit/e57cde43706aa28bde8d2e9d3047595009b785d3))
* **channels:** wechat channel plugin (iLink bot API) ([f1a71f5](https://github.com/tianshu-ai/tianshu/commit/f1a71f578a4055387194b7546a14d1175860f57a))
* **channels:** wechat plugin admin UI + host.channelBindings capability ([d1b06c8](https://github.com/tianshu-ai/tianshu/commit/d1b06c8de11cb3b853d9fc459a3c89865873b1b0))
* **channels:** wire agent reply path (router → runPrompt → adapter.send) ([6903086](https://github.com/tianshu-ai/tianshu/commit/6903086eccc0217ca64e3ee849c982ad72da5018))
* **chat:** agent tool loop with fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)b, server side) ([#43](https://github.com/tianshu-ai/tianshu/issues/43)) ([424bfaf](https://github.com/tianshu-ai/tianshu/commit/424bfaf1ff17e9c036ed15cd6c51f4a0ea9d9bb6))
* **chat:** assistant message meta line (model / token usage / context %) ([#57](https://github.com/tianshu-ai/tianshu/issues/57)) ([156ed73](https://github.com/tianshu-ai/tianshu/commit/156ed73c338f15bcad24463b713102be42dcdc5a))
* **chat:** auto-compact conversation history at 50% context window ([#56](https://github.com/tianshu-ai/tianshu/issues/56)) ([c24e728](https://github.com/tianshu-ai/tianshu/commit/c24e728281b6881fff7393d419bf8b87081658c4))
* **chat:** auto-compress oversize images before sending to vision providers ([#55](https://github.com/tianshu-ai/tianshu/issues/55)) ([31b715f](https://github.com/tianshu-ai/tianshu/commit/31b715f7dc71ae130a6ddba46ccc7ba3a48854d0))
* **chat:** chat handler + worker on pi-agent-core's AgentHarness (N+6.4) ([#81](https://github.com/tianshu-ai/tianshu/issues/81)) ([5cea697](https://github.com/tianshu-ai/tianshu/commit/5cea697d74e9f5346bce152af26ae4b8ff58dd61))
* **chat:** inject workspace scaffold into agent prompt; move projects to user level ([#46](https://github.com/tianshu-ai/tianshu/issues/46)) ([#47](https://github.com/tianshu-ai/tianshu/issues/47)) ([761cd92](https://github.com/tianshu-ai/tianshu/commit/761cd9217f722079d89a8ff1863ba7a35f9dd4e1))
* **chat:** minimal end-to-end chat over WebSocket (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)) ([#25](https://github.com/tianshu-ai/tianshu/issues/25)) ([348f214](https://github.com/tianshu-ai/tianshu/commit/348f214f153bfa1c7763704f6daf92016293c9d4))
* **chat:** multimodal user messages — attachments as first-class content ([#52](https://github.com/tianshu-ai/tianshu/issues/52)) ([a74689a](https://github.com/tianshu-ai/tianshu/commit/a74689ae9573c7153b85e258a923d6ecc7470820))
* **chat:** persist tool turns + render them inline (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)c) ([#44](https://github.com/tianshu-ai/tianshu/issues/44)) ([8b2f96f](https://github.com/tianshu-ai/tianshu/commit/8b2f96f572b73cedf89104836e46af8d586743bc))
* **chat:** session-recovery agent for self-healing on harness errors ([#239](https://github.com/tianshu-ai/tianshu/issues/239)) ([8c138e7](https://github.com/tianshu-ai/tianshu/commit/8c138e729020ad843ed1af3df03ff936f8f255b8))
* **cli-agent:** check_build_progress — distinguish in-flight builds from errors ([a91bbf6](https://github.com/tianshu-ai/tianshu/commit/a91bbf69f8a093fd6a5c60708669c79dfa936827))
* **cli-agent:** check_for_update + apply_update tools, fix-flow guidance ([a2a48b7](https://github.com/tianshu-ai/tianshu/commit/a2a48b72b52025cc37acec1fa6671a85e383fdff))
* **cli-agent:** sandbox_inventory tool + inventory-first guidance ([6bfaca5](https://github.com/tianshu-ai/tianshu/commit/6bfaca5f8c29864b80640e7faaa1a5d6876b11fb))
* **cli:** `tianshu doctor` + `tianshu setup --wizard` + global-installable bin ([#158](https://github.com/tianshu-ai/tianshu/issues/158)) ([2772e6d](https://github.com/tianshu-ai/tianshu/commit/2772e6dcc3e1897f285592fc6060940208fd651b))
* **cli:** tianshu update — npm self-updater with checkout safety ([#170](https://github.com/tianshu-ai/tianshu/issues/170)) ([979fb31](https://github.com/tianshu-ai/tianshu/commit/979fb31a0e613c30723b91e848f66aeaf7471eb0))
* **cli:** tianshu update runs a post-install doctor and points at the setup agent ([#258](https://github.com/tianshu-ai/tianshu/issues/258)) ([951c24d](https://github.com/tianshu-ai/tianshu/commit/951c24da0d8d83fd4ac51fdec230b042869ed52d))
* **core:** centralise port/URL resolution in core/urls.ts ([2a7611f](https://github.com/tianshu-ai/tianshu/commit/2a7611f53103d5e804827c0659dfa852f3de68d3))
* day-0 scaffolding ([786a0bd](https://github.com/tianshu-ai/tianshu/commit/786a0bdfb1bdf6cdd5e9e3abd2a03677da7c63b6))
* **dev-identity:** URL-driven tenant/user switching via cookie ([#159](https://github.com/tianshu-ai/tianshu/issues/159)) ([5c8d9b3](https://github.com/tianshu-ai/tianshu/commit/5c8d9b3b08dd1cd1f8dff241c425d18c3d46759a))
* **doctor,cli-agent:** differentiate dev vs production mode ([a197004](https://github.com/tianshu-ai/tianshu/commit/a19700435faa3f8d258ead05967ada566ccb997b))
* **doctor:** add Tianshu version check (compare to npm latest) ([736e1f1](https://github.com/tianshu-ai/tianshu/commit/736e1f1079f4790821d32227637755e0d638cd4e))
* **doctor:** auth configuration health check ([c0d621c](https://github.com/tianshu-ai/tianshu/commit/c0d621c7713b1c5fa855fe8b7c966b8213e257f6))
* **files,server:** move workspace layout block to files plugin fragment ([#136](https://github.com/tianshu-ai/tianshu/issues/136)) ([cb823e5](https://github.com/tianshu-ai/tianshu/commit/cb823e5baaafd973eb022d4a452d8067693b298b))
* **files:** clarify read-required prompt + accept paged reads as full ([#138](https://github.com/tianshu-ai/tianshu/issues/138)) ([6450d4b](https://github.com/tianshu-ai/tianshu/commit/6450d4b3e80a7dec42b463489144bc0e62db11b7))
* **files:** move fs agent tools into the files plugin (ADR-0004 N+3.5) ([#62](https://github.com/tianshu-ai/tianshu/issues/62)) ([49ab627](https://github.com/tianshu-ai/tianshu/commit/49ab6272fe8155b2c135c23789e315b4b0fd7526))
* **files:** workspace:// URI scheme for tool→UI file references ([#86](https://github.com/tianshu-ai/tianshu/issues/86)) ([77e7fb7](https://github.com/tianshu-ai/tianshu/commit/77e7fb7181c0cdd6c3f517a46d6924c37b4dcb8e))
* **launchd:** use ai.tianshu.prod / ai.tianshu.dev labels (no hash) + migrate old ones ([9e533ac](https://github.com/tianshu-ai/tianshu/commit/9e533acd86aa8ab535fcec230a8e949f9393b2dc))
* **microsandbox,workboard:** per-task sandbox pool with stop-not-remove lifecycle ([#141](https://github.com/tianshu-ai/tianshu/issues/141)) ([16c277c](https://github.com/tianshu-ai/tianshu/commit/16c277cde20171d62ed381933065a62ef6b0c481))
* **microsandbox:** allow file:// + pdf + vision in Playwright MCP, prompt fragment for ephemeral task sandbox ([#145](https://github.com/tianshu-ai/tianshu/issues/145)) ([c6fbabc](https://github.com/tianshu-ai/tianshu/commit/c6fbabced99df5c7b4de7885461ba5bb8f4e567a))
* **microsandbox:** browser sidecar scaffold + 3 agent tools + admin Browser page (ADR-0004 N+5.1) ([#68](https://github.com/tianshu-ai/tianshu/issues/68)) ([74e17a7](https://github.com/tianshu-ai/tianshu/commit/74e17a7d98068f2c48dfdf0a2036eb0c565a96b5))
* **microsandbox:** build resilience — SDK rename, Node fallback, node-python template ([#133](https://github.com/tianshu-ai/tianshu/issues/133)) ([a65490d](https://github.com/tianshu-ai/tianshu/commit/a65490db579687e630ec2615b4eed16191140c89))
* **microsandbox:** builtin plugin scaffold + nullable runner (ADR-0004 N+2) ([#60](https://github.com/tianshu-ai/tianshu/issues/60)) ([babdf6d](https://github.com/tianshu-ai/tianshu/commit/babdf6d8cd1beb67d5c1df36a94a1fa3e2604706))
* **microsandbox:** drop privileges to a real tenant user inside the guest ([#139](https://github.com/tianshu-ai/tianshu/issues/139)) ([53c1b83](https://github.com/tianshu-ai/tianshu/commit/53c1b838858ea20593af627a50a43eda8119ed4e))
* **microsandbox:** eager warm-up on plugin activation ([#64](https://github.com/tianshu-ai/tianshu/issues/64)) ([43a8424](https://github.com/tianshu-ai/tianshu/commit/43a842478e0a1d1bf1084129b530327874f34d41))
* **microsandbox:** expand node-python template to full browser stack ([#134](https://github.com/tianshu-ai/tianshu/issues/134)) ([cd4c0af](https://github.com/tianshu-ai/tianshu/commit/cd4c0afde1fef1b4d63e9069f60a5b473e8a6e6b))
* **microsandbox:** expose memory / cpu / image / timeout in plugin config UI + browser_health_check ([#120](https://github.com/tianshu-ai/tianshu/issues/120)) ([d06326e](https://github.com/tianshu-ai/tianshu/commit/d06326e02314556ec523ac66ea75f1f1b64c5899))
* **microsandbox:** inject $USER / $HOME / $MSB_USER_ID into exec context ([#137](https://github.com/tianshu-ai/tianshu/issues/137)) ([e93cb1b](https://github.com/tianshu-ai/tianshu/commit/e93cb1bc1e82d4a0f3ea7167f3a06b7c7575980a))
* **microsandbox:** live browser stack — port forward + auto supervisord + Playwright MCP wired (ADR-0004 N+5.3) ([#70](https://github.com/tianshu-ai/tianshu/issues/70)) ([fb671c2](https://github.com/tianshu-ai/tianshu/commit/fb671c247e36966e79103c973e9f4ba5ff6bf8ef))
* **microsandbox:** make minimal.yaml a real task-runner template ([#151](https://github.com/tianshu-ai/tianshu/issues/151)) ([79e92f0](https://github.com/tianshu-ai/tianshu/commit/79e92f04b47f613221cecd66a9a41f482f99c4f7))
* **microsandbox:** pool monitor section + Configure dialog ([#143](https://github.com/tianshu-ai/tianshu/issues/143)) ([6a38c3d](https://github.com/tianshu-ai/tianshu/commit/6a38c3d8eb434b04c29d8ca696d908d4d824c531))
* **microsandbox:** Sandboxfile templates + Browser template (CloakBrowser + Playwright MCP + noVNC) (ADR-0004 N+5.2) ([#69](https://github.com/tianshu-ai/tianshu/issues/69)) ([00ed8f1](https://github.com/tianshu-ai/tianshu/commit/00ed8f1432c06e9d58dfd5721422f451f55fcd6f))
* **microsandbox:** split snapshot pointer into Browser + Task roles ([#140](https://github.com/tianshu-ai/tianshu/issues/140)) ([79581a5](https://github.com/tianshu-ai/tianshu/commit/79581a59203fc0fbe40295a91dc573a8ffbb6d9b))
* migrate pi-ai/pi-agent-core 0.79 → 0.80 ([#260](https://github.com/tianshu-ai/tianshu/issues/260)) ([#274](https://github.com/tianshu-ai/tianshu/issues/274)) ([f72ea3b](https://github.com/tianshu-ai/tianshu/commit/f72ea3b0e3ca9504c228d96bd666ecbcb6ec31f2))
* **n5-4:** direct MCP mount via SDK, dynamic browser viewport, MCP servers admin ([#76](https://github.com/tianshu-ai/tianshu/issues/76)) ([6eb310f](https://github.com/tianshu-ai/tianshu/commit/6eb310ff51718ae4c6a86750577830bdcc18de93))
* per-prompt tool-delta detector for cross-upgrade sessions ([253f580](https://github.com/tianshu-ai/tianshu/commit/253f5800780ae0029cc26c2f587a91ae1efbe164))
* **plugin-files:** fuzzy replacers + replace_all in edit_file (ADR-0006 PR-B groundwork) ([#130](https://github.com/tianshu-ai/tianshu/issues/130)) ([9c5796a](https://github.com/tianshu-ai/tianshu/commit/9c5796aa1315eb7fd0ce8759933ff1dc8be88add))
* **plugins/files:** scope to per-user home + tighten top-bar icons ([#40](https://github.com/tianshu-ai/tianshu/issues/40)) ([e8be301](https://github.com/tianshu-ai/tianshu/commit/e8be30150c785a534438d24686ae2d6b7e09f317))
* **plugins/files:** styled panel matching the closed-source repo ([#38](https://github.com/tianshu-ai/tianshu/issues/38)) ([22c1b01](https://github.com/tianshu-ai/tianshu/commit/22c1b017c6ed42d3a9deb9c377eabcb42b8c9544))
* **plugins:** capability registry, requires/provides, sandbox surface (ADR-0004 N+1) ([#59](https://github.com/tianshu-ai/tianshu/issues/59)) ([ba751c7](https://github.com/tianshu-ai/tianshu/commit/ba751c7b9b6fa97fd4d946a0d65e38476107810a))
* **plugins:** catalog client + Plugin Manager Catalog tab (P1) ([#34](https://github.com/tianshu-ai/tianshu/issues/34)) ([4376d67](https://github.com/tianshu-ai/tianshu/commit/4376d672becc941f86779ee895e54c99054e5e18))
* **plugins:** composer file uploads + composerActions SDK contribution ([#48](https://github.com/tianshu-ai/tianshu/issues/48)) ([#49](https://github.com/tianshu-ai/tianshu/issues/49)) ([0bea614](https://github.com/tianshu-ai/tianshu/commit/0bea61476f5e74e393f68f6460d29b8b4aeb0a00))
* **plugins:** contributes.tools[] \u2014 plugins own their agent tools (ADR-0004 N+3) ([#61](https://github.com/tianshu-ai/tianshu/issues/61)) ([db56329](https://github.com/tianshu-ai/tianshu/commit/db56329bc7d6044f2674bb4a3b254e02af7f3111))
* **plugins:** files plugin (workspace browser, server side) ([#35](https://github.com/tianshu-ai/tianshu/issues/35)) ([b2ec9a3](https://github.com/tianshu-ai/tianshu/commit/b2ec9a312c4805aeb546e750d0dacb76e72ed6bb))
* **plugins:** OpenShell shell-sandbox + setup agent prerequisites + project-scoped task results ([97b4eed](https://github.com/tianshu-ai/tianshu/commit/97b4eed2a840229e29be2d24c0a933016ed32b0e))
* **plugins:** plugin runtime + Plugin Manager UI (PR [#31](https://github.com/tianshu-ai/tianshu/issues/31)) ([#32](https://github.com/tianshu-ai/tianshu/issues/32)) ([9405d57](https://github.com/tianshu-ai/tianshu/commit/9405d57ad9e1785c95856c048bbb3320edb67da0))
* **prompt:** add tool-guidelines block to defaultSystemPrompt (OpenClaw-style) ([#124](https://github.com/tianshu-ai/tianshu/issues/124)) ([ea227ea](https://github.com/tianshu-ai/tianshu/commit/ea227ea340940b93f96e63acaac6783ab57ac7a5))
* **prompt:** inject runtime context (time / timezone / host) for every agent ([fc8f994](https://github.com/tianshu-ai/tianshu/commit/fc8f99495c81cfb098052c86faa04b5a6fa4d24d))
* **server,setup:** serve mode — production startup without dev toolchain ([a87340d](https://github.com/tianshu-ai/tianshu/commit/a87340d833c4b4f8351b374afa84096c1d2e71b8))
* **server:** agent fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)a) ([#42](https://github.com/tianshu-ai/tianshu/issues/42)) ([791819a](https://github.com/tianshu-ai/tianshu/commit/791819ac2ea51883b4263fcee559689a400ec141))
* **server:** inject Execution Bias + AGENTS.md / SOUL.md / USER.md into system prompt ([#148](https://github.com/tianshu-ai/tianshu/issues/148)) ([ee1c97c](https://github.com/tianshu-ai/tianshu/commit/ee1c97c7c287f9ce04c4ff1d61b624a1b6fdf4c4))
* **server:** inject plugin systemPromptFragments into worker prompt (ADR-0007 PR-B) ([#129](https://github.com/tianshu-ai/tianshu/issues/129)) ([aa2e055](https://github.com/tianshu-ai/tianshu/commit/aa2e05535bbae7f3eee9b4ab5bc755ba2e7a0080))
* **server:** optional system-prompt dump for debugging ([#131](https://github.com/tianshu-ai/tianshu/issues/131)) ([76328db](https://github.com/tianshu-ai/tianshu/commit/76328db337dd5436b11abf9b683601b5277beb26))
* **server:** publish effectivePublicUrl on boot ([e15e917](https://github.com/tianshu-ai/tianshu/commit/e15e91716e733a10d77590ca00beebb98883bea5))
* **setup:** cli-agent shows every action, confirms before mutating, no silent auto-fix ([#167](https://github.com/tianshu-ai/tianshu/issues/167)) ([bee4106](https://github.com/tianshu-ai/tianshu/commit/bee4106333d79c92ebe7e1d2b324b93c355b9d92))
* **setup:** in-CLI agent handoff after wizard for conversational setup ([#165](https://github.com/tianshu-ai/tianshu/issues/165)) ([07e1012](https://github.com/tianshu-ai/tianshu/commit/07e1012e10abb1140ca87d687850aa0aa6640392))
* **setup:** wizard probes default model first; smart-skip when working ([#164](https://github.com/tianshu-ai/tianshu/issues/164)) ([c6f9f7f](https://github.com/tianshu-ai/tianshu/commit/c6f9f7fa5e4f2d94f3a4e90bda0be343272f1a89))
* **setup:** wizard supports custom baseUrl + custom model id ([#163](https://github.com/tianshu-ai/tianshu/issues/163)) ([4d21143](https://github.com/tianshu-ai/tianshu/commit/4d21143f037f60b27b7faf802e21a184f1b2db3e))
* **skills:** drop load_skill meta-tool; manage skills via filesystem ([#98](https://github.com/tianshu-ai/tianshu/issues/98)) ([b352c74](https://github.com/tianshu-ai/tianshu/commit/b352c749b0bc8f19d753e478ed70b0f6acbd16fc))
* **skills:** mirror host & plugin SKILL.md into tenant config so one tool reads them all ([#104](https://github.com/tianshu-ai/tianshu/issues/104)) ([bc5c890](https://github.com/tianshu-ai/tianshu/commit/bc5c8900dbf4c07577cdab6d742c344917425832))
* **skills:** on-demand prompt fragments via plugin-contributed skills (ADR-0004 N+4) ([#63](https://github.com/tianshu-ai/tianshu/issues/63)) ([ec6cf6f](https://github.com/tianshu-ai/tianshu/commit/ec6cf6ffdb0258625b484fe1c7c53834756a15ea))
* **skills:** tenant-scoped skill discovery + main agent skill-creator ([#97](https://github.com/tianshu-ai/tianshu/issues/97)) ([98e0480](https://github.com/tianshu-ai/tianshu/commit/98e0480bfed24f05642c951eb543e9f542ad4ff8))
* **tenant:** infrastructure layer (PR [#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([4b6e7ae](https://github.com/tianshu-ai/tianshu/commit/4b6e7ae62da101c7998cf8e7dfe9b8b58cc969a3))
* tool_catalog_refresh — force-replay the tool catalog into chat ([73d8c5d](https://github.com/tianshu-ai/tianshu/commit/73d8c5d0f95e73669f0405bd11e3516f3535a982))
* **ui-a:** host-shared Modal + MarkdownBlock + DocumentViewer primitives ([a345380](https://github.com/tianshu-ai/tianshu/commit/a345380932dfadff4da3cf84e3c4b49efeed0f04))
* **ui-b:** migrate every dialog + markdown surface to UiPrimitives ([6568215](https://github.com/tianshu-ai/tianshu/commit/6568215340ce5f3c6a7af36a9cecb1dcc3b0729a))
* **ui:** CSV/TSV table preview + SVG Render/Source toggle ([1325ff4](https://github.com/tianshu-ai/tianshu/commit/1325ff4eb806a9aa8718f0284774c1ff6f628055))
* **ui:** HTML render+source preview and syntax-highlighted code ([24c2d7c](https://github.com/tianshu-ai/tianshu/commit/24c2d7cbd39ef8f874b40ea881adc551ea0d0565))
* **ui:** light / dark theme switch with semantic CSS variable tokens ([2d31543](https://github.com/tianshu-ai/tianshu/commit/2d315438c87f4440a6092dc236da13b58b95a71a))
* **ui:** Modal headerActions slot + download button in file previews ([9feb899](https://github.com/tianshu-ai/tianshu/commit/9feb8990f9b5508b8554ae7af4f76be4861f713c))
* **ui:** Modal maximize button + double-click toggle ([e5ba744](https://github.com/tianshu-ai/tianshu/commit/e5ba744d2d8423b998e17ca2a9c605be0c046c2d))
* **ui:** model selector pill in composer (PR [#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([5a835ff](https://github.com/tianshu-ai/tianshu/commit/5a835ff99b0b74c135e7c02cdebe895079d1b53c))
* **ui:** Office file placeholder + STREAMED_EXTS includes office ([f9e0acd](https://github.com/tianshu-ai/tianshu/commit/f9e0acd1b9a19ce0c1f4c3dfaf59ec2420f4c658))
* **ui:** PDF / video / audio / image preview through DocumentViewer ([b53912d](https://github.com/tianshu-ai/tianshu/commit/b53912d4847d5d94ff4bac1e24c1853d396ac7ca))
* **ui:** refine chat layout to match closed-source repo (PR [#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([#27](https://github.com/tianshu-ai/tianshu/issues/27)) ([090c6eb](https://github.com/tianshu-ai/tianshu/commit/090c6eb47e6b02c6d0c0c6dcaabb4debe06c47f0))
* **ui:** tianshu-style chat UI (PR [#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([#26](https://github.com/tianshu-ai/tianshu/issues/26)) ([086fce7](https://github.com/tianshu-ai/tianshu/commit/086fce7fe55d29131ccce9cf7da48750aa2c74ef))
* **web-search:** plugin with Tavily / Brave + secret config + provider health cache ([#114](https://github.com/tianshu-ai/tianshu/issues/114)) ([fc636f2](https://github.com/tianshu-ai/tianshu/commit/fc636f285cdeef8590246f4ca3acbd9b6513d6db))
* **web/admin:** render PluginConfigForm banner on every plugin admin page ([#246](https://github.com/tianshu-ai/tianshu/issues/246)) ([ddc9a96](https://github.com/tianshu-ai/tianshu/commit/ddc9a9662d61461ea73c0b858e24e3314667f14f))
* **web:** add logout button (chat sidebar menu + admin sidebar) ([c07bb37](https://github.com/tianshu-ai/tianshu/commit/c07bb370c9107448754056b450e767be85ea2e29))
* **web:** button-driven local-user admin UI (no window.prompt) ([6309438](https://github.com/tianshu-ai/tianshu/commit/63094384716efb82553f954630918bf9c348cbf2))
* **web:** collapsible tool-call rows (closed-source UI parity) ([#45](https://github.com/tianshu-ai/tianshu/issues/45)) ([78c1fb7](https://github.com/tianshu-ai/tianshu/commit/78c1fb7a2c87b7377827d2fa308b6c0db2bf35c1))
* **web:** force URL identity to match session when auth is on ([b962b99](https://github.com/tianshu-ai/tianshu/commit/b962b99e11ad02439fb314ecef468f66c1cd4a16))
* **web:** hide Admin entry from members ([6cf54db](https://github.com/tianshu-ai/tianshu/commit/6cf54db5926325ec124cfe88b677fffea521941c))
* **web:** manifest-driven top bar + right panel (PR [#33](https://github.com/tianshu-ai/tianshu/issues/33)) ([#36](https://github.com/tianshu-ai/tianshu/issues/36)) ([ba488fb](https://github.com/tianshu-ai/tianshu/commit/ba488fbff6a4c68e88f131d8d7fa34a2b59556aa))
* **web:** right-panel tab bar + resize handle (closed-source parity) ([#41](https://github.com/tianshu-ai/tianshu/issues/41)) ([25f1c98](https://github.com/tianshu-ai/tianshu/commit/25f1c984a25865911b65d8ab2c66331bac089f7a))
* **workboard,server,web:** execution dialog + session inbox + history pagination + concurrency fixes ([#94](https://github.com/tianshu-ai/tianshu/issues/94)) ([d79e665](https://github.com/tianshu-ai/tianshu/commit/d79e665eb97f10bc49b3f361090c74fa6bab4f40))
* **workboard:** add worker_analytics tool for orchestrator-side insights ([0929f51](https://github.com/tianshu-ai/tianshu/commit/0929f514728778c81cd5d72b497e454a82353467))
* **workboard:** batch task_create + task_delete ([#93](https://github.com/tianshu-ai/tianshu/issues/93)) ([759226e](https://github.com/tianshu-ai/tianshu/commit/759226e128d183c2292cad4f7cef90fb3380aa52))
* **workboard:** Configure modal + allow one worker to run multiple tasks in parallel ([#250](https://github.com/tianshu-ai/tianshu/issues/250)) ([6ea0f01](https://github.com/tianshu-ai/tianshu/commit/6ea0f011b74849e50d8645fc72afec08a66488af))
* **workboard:** drop worker_agents table; UI read-only; REST mutation routes removed (PR-C) ([#101](https://github.com/tianshu-ai/tianshu/issues/101)) ([cba6701](https://github.com/tianshu-ai/tianshu/commit/cba67011824ced8e34e885250f231cc8d9866b5c))
* **workboard:** enable/disable worker agent from the admin UI ([#146](https://github.com/tianshu-ai/tianshu/issues/146)) ([d057696](https://github.com/tianshu-ai/tianshu/commit/d0576966fb9155d187745f7a6460db8c6bb0ed23))
* **workboard:** fs-only worker config + intervention model + skill / context plumbing ([#102](https://github.com/tianshu-ai/tianshu/issues/102)) ([f4e571e](https://github.com/tianshu-ai/tianshu/commit/f4e571e7546981b0cae0dabc2d32b44c9bdbd2be))
* **workboard:** host.modelCatalog capability + model_list tool for the main agent ([#107](https://github.com/tianshu-ai/tianshu/issues/107)) ([fb2d9ef](https://github.com/tianshu-ai/tianshu/commit/fb2d9ef98167ba68630476cdec3095ad664dd140))
* **workboard:** hot-reload pool when worker bundles change on disk ([#103](https://github.com/tianshu-ai/tianshu/issues/103)) ([2008527](https://github.com/tianshu-ai/tianshu/commit/2008527ccc542a9c19c1cb2c39edda2fc72248a2))
* **workboard:** kanban + worker pool plugin (ADR-0002 §6) ([#78](https://github.com/tianshu-ai/tianshu/issues/78)) ([0fac44a](https://github.com/tianshu-ai/tianshu/commit/0fac44af8afdf8f4d11620405c12d8ce4b34a041))
* **workboard:** LLM worker kind via host.agentLoop capability (N+6.3) ([#80](https://github.com/tianshu-ai/tianshu/issues/80)) ([cd53fac](https://github.com/tianshu-ai/tianshu/commit/cd53fac940ab7241ed2a9b03a5f5985352b21514))
* **workboard:** main agent can list available LLM models via  ([#106](https://github.com/tianshu-ai/tianshu/issues/106)) ([3e7a008](https://github.com/tianshu-ai/tianshu/commit/3e7a00811a21e3c1f43d9e25af277a3c1f1f86df))
* **workboard:** nudge main agent toward plan/design/build/verify decomposition ([#150](https://github.com/tianshu-ai/tianshu/issues/150)) ([a0a9a05](https://github.com/tianshu-ai/tianshu/commit/a0a9a05bd6a1604e1b2f8c6232af5744c29ba771))
* **workboard:** one-shot DB-&gt;fs migration; widen tenant_config_write boundary; retire worker_agent_* tools (PR-B) ([#100](https://github.com/tianshu-ai/tianshu/issues/100)) ([0ff0249](https://github.com/tianshu-ai/tianshu/commit/0ff0249b9a3310ee6c8e7eed192c6263e94f06fa))
* **workboard:** orchestrator tools for managing worker agents ([#96](https://github.com/tianshu-ai/tianshu/issues/96)) ([5f2d314](https://github.com/tianshu-ai/tianshu/commit/5f2d314e00e9c1272c372773c49a2720fb2a46b9))
* **workboard:** per-user concurrency cap, layered on top of the tenant cap ([#245](https://github.com/tianshu-ai/tianshu/issues/245)) ([f4afab5](https://github.com/tianshu-ai/tianshu/commit/f4afab578ec50e619eba2dee47c833ab6fb2300f))
* **workboard:** plugin-contributed agent seeds, fs-backed worker layout (PR-A) ([#99](https://github.com/tianshu-ai/tianshu/issues/99)) ([65b3b11](https://github.com/tianshu-ai/tianshu/commit/65b3b111b662e5015a550f3cfb528ef389e5cab6))
* **workboard:** push worker status over WebSocket instead of polling ([ce32c4c](https://github.com/tianshu-ai/tianshu/commit/ce32c4c3c00934c4a3c062a9ea1f563a54d65cc6))
* **workboard:** retry/publish buttons on label chips ([#91](https://github.com/tianshu-ai/tianshu/issues/91)) ([6a0531e](https://github.com/tianshu-ai/tianshu/commit/6a0531ef586883e10b844e7edd51cd8f563f6d7b))
* **workboard:** show per-task sandbox name in task detail dialog ([#142](https://github.com/tianshu-ai/tianshu/issues/142)) ([4441cc4](https://github.com/tianshu-ai/tianshu/commit/4441cc49922270fb7a4cc8a6a938b2a49326777d))
* **workboard:** task execution history (REST + agent tool) ([#92](https://github.com/tianshu-ai/tianshu/issues/92)) ([3949e14](https://github.com/tianshu-ai/tianshu/commit/3949e14a038164a29096c6b711d9c5e8193fdeca))
* **workboard:** tenant-wide concurrency cap on worker runs ([#244](https://github.com/tianshu-ai/tianshu/issues/244)) ([10e0d4c](https://github.com/tianshu-ai/tianshu/commit/10e0d4cb3165cec89ee4238d839f56de1d3995c0))
* **workboard:** tool/skill catalog capabilities + worker agent ChipPicker ([#95](https://github.com/tianshu-ai/tianshu/issues/95)) ([aa1126a](https://github.com/tianshu-ai/tianshu/commit/aa1126aed6115786f2facafb0826846624e238cd))
* **worker-agents:** host table + REST + plugin seed + admin UI (ADR-0002 §7.1, N+6.2) ([#79](https://github.com/tianshu-ai/tianshu/issues/79)) ([a8b7378](https://github.com/tianshu-ai/tianshu/commit/a8b7378a80e4609f73eeef4f6e1ed1759ceb6255))
* **workforce-studio:** `solution` agent tool (main agent only) ([1852ece](https://github.com/tianshu-ai/tianshu/commit/1852ece8088d751dac5fdc95af2825b6cea09c33))
* **workforce-studio:** Activate (active solution pointer) ([b84d169](https://github.com/tianshu-ai/tianshu/commit/b84d16990c3d1f9bddc0f9ebac4615575ac1cbc0))
* **workforce-studio:** add Main agent section to Solution view ([72afd53](https://github.com/tianshu-ai/tianshu/commit/72afd535ed620bde483c0e28ae4d9a341ab11aa8))
* **workforce-studio:** block-style editor in Solution view main agent ([3a5c10b](https://github.com/tianshu-ai/tianshu/commit/3a5c10bcc82a0a835c8a91704b7740a70f4d2365))
* **workforce-studio:** deny-only skill/tool pickers in Solution view ([2b944aa](https://github.com/tianshu-ai/tianshu/commit/2b944aa3d99f5d1e7e214a702edc88d3f7d0f3d0))
* **workforce-studio:** Develop / Rendered tabs + block decomposition ([b865ec9](https://github.com/tianshu-ai/tianshu/commit/b865ec9659f8f974b74f13a99275b628c6e813d4))
* **workforce-studio:** editable workers in Solution view ([a0cc013](https://github.com/tianshu-ai/tianshu/commit/a0cc013c9b8c560999a6c97d89fb3b3da8c37a05))
* **workforce-studio:** exclude whole workers from a solution ([60f6824](https://github.com/tianshu-ai/tianshu/commit/60f6824058df27ee53d26ce1f52ad9a68130a4f0))
* **workforce-studio:** export/import a solution as a file ([1f4fd60](https://github.com/tianshu-ai/tianshu/commit/1f4fd603bfc7aa4cc7eda95be02d800e65d4b29e))
* **workforce-studio:** group skill/tool pickers by source ([f158545](https://github.com/tianshu-ai/tianshu/commit/f1585458772d63d49ebe2bbf10088625375b3a34))
* **workforce-studio:** in-app Activate confirm (drop window.confirm) ([f25ca29](https://github.com/tianshu-ai/tianshu/commit/f25ca29e60243d10c60d9dc8e31a0de4f366453e))
* **workforce-studio:** include/exclude plugins in a solution ([9ebfc3b](https://github.com/tianshu-ai/tianshu/commit/9ebfc3b7ec423f67c280a894624b77982aa6b713))
* **workforce-studio:** override host blocks + custom fragments ([37f72bb](https://github.com/tianshu-ai/tianshu/commit/37f72bb1e9d666c5bba7be283d75c40628230bf0))
* **workforce-studio:** Phase 1 — inspect + export agent bundle ([f88de5d](https://github.com/tianshu-ai/tianshu/commit/f88de5d24138eb33edc3b14f55608182f5e12d94))
* **workforce-studio:** Phase 2 — Solution abstraction (extract/save/edit/diff) ([7f2f857](https://github.com/tianshu-ai/tianshu/commit/7f2f857744c133fa7d7532c37a803d6ecc945d82))
* **workforce-studio:** Phase 3 — Apply solution to reality ([666327c](https://github.com/tianshu-ai/tianshu/commit/666327c9fee71986a35f95d34882682923e824b8))
* **workforce-studio:** show concrete plugin id on skill/tool picker rows ([52f956b](https://github.com/tianshu-ai/tianshu/commit/52f956bb9e807ac4fe93e96ec0b886fb037e9596))
* **workforce-studio:** surface plugin inventory + tool/skill origin ([39ca266](https://github.com/tianshu-ai/tianshu/commit/39ca2663530d09c7c181d605cce43c803f0c1a07))
* **workforce-studio:** three-pane IDE layout for Solution view ([e24f9cd](https://github.com/tianshu-ai/tianshu/commit/e24f9cdb3e8cf788edd582e29a32f5572bc9e218))
* **workforce:** activate applies the solution's plugin enable-set ([a625297](https://github.com/tianshu-ai/tianshu/commit/a625297ee4bf000e4a59590f68965c5eb528546f))
* **workforce:** per-worker execution-bias override ([e88ddcf](https://github.com/tianshu-ai/tianshu/commit/e88ddcfe17fa37aea8bf4782cb6ea8e123abd1a0))


### Bug Fixes

* Fix:  ([c99a827](https://github.com/tianshu-ai/tianshu/commit/c99a827a259b1ce4b8a7db505292c429c1629d02))
* **adapter:** detect stream-truncated tool calls and surface a useful error ([#105](https://github.com/tianshu-ai/tianshu/issues/105)) ([2e95618](https://github.com/tianshu-ai/tianshu/commit/2e95618d78a4a536b2ab108095605e185baac6ec))
* **auth:** require admin for all settings write routes ([611b5f2](https://github.com/tianshu-ai/tianshu/commit/611b5f26b03dd20034e30fb5342985e3834497c8))
* **auth:** seed per-tenant users row for authed identities (FK error) ([5da6764](https://github.com/tianshu-ai/tianshu/commit/5da67643cf200195412bc91c62819d09870d9aad))
* **channels:** channel bindings are per-user, not per-tenant ([af115f1](https://github.com/tianshu-ai/tianshu/commit/af115f1606e57946304f934fae097dd815933327))
* **channels:** forward every assistant message, not just the last ([b28dc9c](https://github.com/tianshu-ai/tianshu/commit/b28dc9ca71664fefdeaeac0b1a6deadfac43b20f))
* **channels:** friendly agent-error message in channel replies ([b84d4f0](https://github.com/tianshu-ai/tianshu/commit/b84d4f0ccf93fc2cabb3671ef31a0f643f960a3a))
* **channels:** live message_added push for viewed channel sessions ([7c1ed15](https://github.com/tianshu-ai/tianshu/commit/7c1ed1515dd9f3ab2a09fb83c91deae1ca5891c6))
* **channels:** manifest parser drops contributes.channels[] ([a97f61f](https://github.com/tianshu-ai/tianshu/commit/a97f61f90b37e73e1a9045d1446b3551d567cb3b))
* **channels:** one binding per (tenant, user, channel) ([0840592](https://github.com/tianshu-ai/tianshu/commit/084059238383272ad0c1e1137656409f30b5491f))
* **channels:** queue from message_added events, not just stream_end ([d8b5e60](https://github.com/tianshu-ai/tianshu/commit/d8b5e605d7df1cd42a579db9998c99aa5547961b))
* **channels:** route idle-runner replies back through the channel adapter ([b365396](https://github.com/tianshu-ai/tianshu/commit/b365396a857bf2b0196d5d2653eaebc1feafee76))
* **channels:** wire tenantHomeDir from ctx.workspaceDir so tenant_config_* tools see the right tree ([67fc018](https://github.com/tianshu-ai/tianshu/commit/67fc018c029448a835061ca2020956b9132bbaa4))
* **chat:** assistant messages with mixed text + tool calls render in author order ([#65](https://github.com/tianshu-ai/tianshu/issues/65)) ([ccedf35](https://github.com/tianshu-ai/tianshu/commit/ccedf3554072f8be8c912b596b764adabb7d81c5))
* **chat:** keep webchat history separate from channel sessions ([ef53dc3](https://github.com/tianshu-ai/tianshu/commit/ef53dc3f464df873171de568af6cda1d9048d3a8))
* **chat:** mark inbox rows delivered when message text is JSON-escaped ([#237](https://github.com/tianshu-ai/tianshu/issues/237)) ([70dc045](https://github.com/tianshu-ai/tianshu/commit/70dc04523230ec262a55d0ce6a8eecf1756c0615))
* **chat:** pi 0.80 'compact then stop' — over-window fork fallback + guard ([#275](https://github.com/tianshu-ai/tianshu/issues/275)) ([74108ae](https://github.com/tianshu-ai/tianshu/commit/74108ae024a8abe35d3e868bf41bb7bd806b560b))
* **chat:** pre-prompt auto-compact so an over-window turn still runs ([972ba9a](https://github.com/tianshu-ai/tianshu/commit/972ba9abd5efba13868088c7789d1720642f7d09))
* **chat:** session storage chain + bridge pi tool_execution events (N+6.4 follow-up) ([#83](https://github.com/tianshu-ai/tianshu/issues/83)) ([0446273](https://github.com/tianshu-ai/tianshu/commit/04462730378ccf0037b121ed8361f918c2838740))
* **env:** write/read .env at TIANSHU_HOME on global installs ([6bd4f69](https://github.com/tianshu-ai/tianshu/commit/6bd4f69f50502ee731fab46b5a89adb0431fb8e7))
* **files:** make `edits` required in edit_file / tenant_config_edit schema ([#123](https://github.com/tianshu-ai/tianshu/issues/123)) ([daf2875](https://github.com/tianshu-ai/tianshu/commit/daf287514e0d040e003dbcb8d9600116a73a4c63))
* **microsandbox:** adapt to SDK rename of stopAndWait/removePersisted ([#132](https://github.com/tianshu-ai/tianshu/issues/132)) ([026d290](https://github.com/tianshu-ai/tianshu/commit/026d2909022a64329912cd07f9fced3d7feef526))
* **microsandbox:** destroyTask reclaims orphan VMs not in the pool map ([#144](https://github.com/tianshu-ai/tianshu/issues/144)) ([476f462](https://github.com/tianshu-ai/tianshu/commit/476f46287368fe24a667aa455318e6623586358f))
* **microsandbox:** guard exec against host-guest channel hangs ([#153](https://github.com/tianshu-ai/tianshu/issues/153)) ([80d5f54](https://github.com/tianshu-ai/tianshu/commit/80d5f54e05b3302acb2cffd826008611ce66697d))
* **microsandbox:** make execTimeoutMs actually fire (use shellStream + kill) ([#121](https://github.com/tianshu-ai/tianshu/issues/121)) ([ec41a55](https://github.com/tianshu-ai/tianshu/commit/ec41a559a49140d9132a39bd5cccc73a98a42836))
* **microsandbox:** tighten server-startup + verify-task prompts ([#152](https://github.com/tianshu-ai/tianshu/issues/152)) ([c4491a3](https://github.com/tianshu-ai/tianshu/commit/c4491a3118c441655c82510d4ad425852bbe4143))
* **openshell:** ctx.taskId wins over agent-supplied task arg ([#241](https://github.com/tianshu-ai/tianshu/issues/241)) ([74a62cc](https://github.com/tianshu-ai/tianshu/commit/74a62ccc20a6917a68333a1ca6effe310e2b0057))
* **openshell:** drop projects/&lt;project&gt;/ doubling from sync_down host path ([#238](https://github.com/tianshu-ai/tianshu/issues/238)) ([4eef383](https://github.com/tianshu-ai/tianshu/commit/4eef3830687160b68bc6ca1dd7161bdc7d3ae19b))
* **openshell:** remove agent-controllable 'task' arg from sync_down schema ([#242](https://github.com/tianshu-ai/tianshu/issues/242)) ([057aed3](https://github.com/tianshu-ai/tianshu/commit/057aed305b3d029ecee2ec75efb48b126fa85d2a))
* **openshell:** strip redundant projects/&lt;p&gt;/ + users/&lt;u&gt;/ from agent path inputs ([#240](https://github.com/tianshu-ai/tianshu/issues/240)) ([8abbb6d](https://github.com/tianshu-ai/tianshu/commit/8abbb6ddbfc482548fdaf5091decc178f0cf3576))
* **openshell:** task folder name uses slugified taskTitle, not taskId-prefix ([#243](https://github.com/tianshu-ai/tianshu/issues/243)) ([f49559d](https://github.com/tianshu-ai/tianshu/commit/f49559d2fd924b49d1b43461e4e64b920754f6bd))
* pipe agent-loop abort signal into tools so task_abort actually frees workers ([#154](https://github.com/tianshu-ai/tianshu/issues/154)) ([653f542](https://github.com/tianshu-ai/tianshu/commit/653f5428c0d7599de06e4a14f47aa956209483d2))
* **plugin-sdk:** re-resolve MCP endpoint on every callRemote ([#155](https://github.com/tianshu-ai/tianshu/issues/155)) ([827a888](https://github.com/tianshu-ai/tianshu/commit/827a888ad3fa8cddebde5d4a93dcd949bb572e01))
* **plugins:** mount contributed routes under /api/p/&lt;id&gt;/... ([#37](https://github.com/tianshu-ai/tianshu/issues/37)) ([3484ace](https://github.com/tianshu-ai/tianshu/commit/3484aceb51bc19d6900c91770e46dc9d91c3194f))
* **publish:** include plugins/**/templates/** in the npm tarball ([3bd8ff5](https://github.com/tianshu-ai/tianshu/commit/3bd8ff53275d1ddeeff5a72a937a86e3dd9db119))
* **publish:** rename plugin-sdk to scope + bundleDependencies for npm install ([#172](https://github.com/tianshu-ai/tianshu/issues/172)) ([b01a2cf](https://github.com/tianshu-ai/tianshu/commit/b01a2cfaa931b26df392809ca930da05c8f2d56c))
* **publish:** revert plugin-sdk to dependencies (peerDependencies + bundle broke npm install -g) ([741368d](https://github.com/tianshu-ai/tianshu/commit/741368d2e8bd4e6fa369c0a4e7f41dbf3c8c1e7c))
* **server:** read /api/health version from package.json ([50b24fb](https://github.com/tianshu-ai/tianshu/commit/50b24fb9553c2654f0232082b4f1e932f5f859dd))
* **server:** refresh stale dynamic toolsets at worker run start ([#156](https://github.com/tianshu-ai/tianshu/issues/156)) ([1c0ae85](https://github.com/tianshu-ai/tianshu/commit/1c0ae85fc39c489c00ae4b0000aa718b04141530))
* **server:** substitute &lt;self&gt;/&lt;userId&gt; placeholders with caller's actual userId in system prompts ([#157](https://github.com/tianshu-ai/tianshu/issues/157)) ([3550d2a](https://github.com/tianshu-ai/tianshu/commit/3550d2ad6c88d76b9da9231888c2e3274c786ee3))
* **server:** unify USER.md prompt so empty templates trigger onboarding ([#149](https://github.com/tianshu-ai/tianshu/issues/149)) ([c595e08](https://github.com/tianshu-ai/tianshu/commit/c595e08309fe96338d649cc69c20e8d0025b6cb5))
* **serve:** serve index.html via buffer, not res.sendFile ([c296867](https://github.com/tianshu-ai/tianshu/commit/c29686748f51cf7c86d272355dd23fe22240de5d))
* **serve:** use bin/serve.mjs entrypoint (not shell-var script) ([b2bd315](https://github.com/tianshu-ai/tianshu/commit/b2bd315c6a9f7dada2fd63a4c0042e85fc4314da))
* **setup:** force-reload .env after wizard writes; clear pass/fail signal on model ping ([#166](https://github.com/tianshu-ai/tianshu/issues/166)) ([1130ce6](https://github.com/tianshu-ai/tianshu/commit/1130ce695713ba423542f9fb956cfa2d76278694))
* **setup:** skip web-port prompt in production mode ([59ab697](https://github.com/tianshu-ai/tianshu/commit/59ab697d1ca4e26ce0f1259bd1d2e1ce2a3cffc0))
* **ui:** channel session footer layout is now stacked + compact ([b946e92](https://github.com/tianshu-ai/tianshu/commit/b946e925a12fd26c032f215fe38e2d1166eec2e2))
* **ui:** channel session selected-row visible on light theme ([960df8b](https://github.com/tianshu-ai/tianshu/commit/960df8bc0853a1109fc7db27ccf675d254059e43))
* **ui:** de-dupe ws handlers + message renders (StrictMode) ([#28](https://github.com/tianshu-ai/tianshu/issues/28)) ([0b8b5bc](https://github.com/tianshu-ai/tianshu/commit/0b8b5bcb3c163cfa277fa23ae32243bd8280de4d))
* **ui:** drop prose-invert on light theme ([92dccee](https://github.com/tianshu-ai/tianshu/commit/92dccee4aa7364273beab70b5c4acb415c286b4e))
* **ui:** FileOpenDialog renders markdown through DocumentViewer ([3126b30](https://github.com/tianshu-ai/tianshu/commit/3126b30edabe0182f70899703ab6c214c3c5917e))
* **ui:** HTML preview height + CodeBlock line-number drift ([02f5185](https://github.com/tianshu-ai/tianshu/commit/02f51850789e0a547916022e19e2ac73f7dbc92a))
* **ui:** inline code chip on light theme ([803860a](https://github.com/tianshu-ai/tianshu/commit/803860a6937214b9fb3f570d7c4e7f44a2c124b6))
* **ui:** light theme — invert canvas/surface hierarchy ([be9d4d9](https://github.com/tianshu-ai/tianshu/commit/be9d4d9bc069717ec0d6e9a0c38c9d37fef51ab8))
* **ui:** light theme coverage + visual contrast rework ([c6c28fc](https://github.com/tianshu-ai/tianshu/commit/c6c28fca361b5f4a7c9d7a3ab4aba92107ac4897))
* **ui:** Modal panel height collapses to content height for previews ([b6cff84](https://github.com/tianshu-ai/tianshu/commit/b6cff848e014516076c8e377a3ba550feece5423))
* **ui:** preview height collapses to a sliver for PDF / HTML / images ([d975ebb](https://github.com/tianshu-ai/tianshu/commit/d975ebb998c364554812bb99d2ffdc9edbaaa3af))
* **ui:** really strip backtick pseudo-elements from prose code ([9231a80](https://github.com/tianshu-ai/tianshu/commit/9231a8069ee381af967e73eec7d081eda2176ca9))
* **ui:** remove Modal's built-in scroll container to fix double scrollbars ([c41927f](https://github.com/tianshu-ai/tianshu/commit/c41927f999b9c21dae0b22be91d9e02bdff7ef2a))
* **ui:** soften light theme overlay (0.5 -&gt; 0.4) ([805d581](https://github.com/tianshu-ai/tianshu/commit/805d581870b23531d1eaad59ecd6fb2367afdd9d))
* **ui:** switch Modal body to flex column + callers use flex-1 min-h-0 ([7525e12](https://github.com/tianshu-ai/tianshu/commit/7525e12e48b2268f8f854b6f77dd2e175a427a5f))
* **ui:** tool-call name + status colors use semantic tokens ([7a74e5f](https://github.com/tianshu-ai/tianshu/commit/7a74e5f011f297a3dbe27f59de15c8ef6a22dd7c))
* **ui:** white text on light surfaces ([d431034](https://github.com/tianshu-ai/tianshu/commit/d4310347df744b50aac3a8b02982da3e0a9a1c59))
* **ui:** workboard task result summary visible on light theme ([e289c1d](https://github.com/tianshu-ai/tianshu/commit/e289c1de4afeef563bbc6b4117efb477779948c1))
* **web:** admin nav used stale dev-identity cookie after user switch ([937548b](https://github.com/tianshu-ai/tianshu/commit/937548bd2a83bf89b516c03d88b5375ae07e23c9))
* **web:** chat topbar shows username, not raw userId ([3f17d25](https://github.com/tianshu-ai/tianshu/commit/3f17d25c60ce1985b95616ad6506470e96774d19))
* **web:** don't rewrite /login under the dev-identity path prefix ([ca39118](https://github.com/tianshu-ai/tianshu/commit/ca39118684f0269b98f82751cf0965bd023c5073))
* **web:** eliminate per-token re-render churn in chat transcript ([#294](https://github.com/tianshu-ai/tianshu/issues/294)) ([79b8419](https://github.com/tianshu-ai/tianshu/commit/79b8419c271746e8d556851a99e8d1a533caee00))
* **web:** flag super-admins in the Users list (not "no tenant roles") ([dc429b0](https://github.com/tianshu-ai/tianshu/commit/dc429b03cbb73ba024f0f3e521b401a6d4a958eb))
* **web:** match ThemeToggle active state to sidebar channel selection ([d855d22](https://github.com/tianshu-ai/tianshu/commit/d855d2257342831a35170f186258346f6ab40566))
* **web:** Modal steals focus from inputs on every keystroke ([a52b228](https://github.com/tianshu-ai/tianshu/commit/a52b22897db655216c9247e1eeebcbd1126ed2d3))
* **web:** show username in admin sidebar; group Models/MCP with auth ([bcf1594](https://github.com/tianshu-ai/tianshu/commit/bcf1594099434c9e06666c0c773a43c25eba6c2c))
* **web:** solid accent highlight for active ThemeToggle mode ([d6ee995](https://github.com/tianshu-ai/tianshu/commit/d6ee995a34984c7f31ba79df8d9b0b646c5a9091))
* **web:** unify selected-row highlight across app (match webchat/wechat) ([1799dc0](https://github.com/tianshu-ai/tianshu/commit/1799dc0059d6003fcfe80cb6da2c0c002667f5a5))
* **web:** visible active mode in light-theme ThemeToggle ([3f90dff](https://github.com/tianshu-ai/tianshu/commit/3f90dff197e8aafe681e55ab484bcc6d851f6247))
* **wechat:** admin UI reflects 'one binding per user' ([99f0adf](https://github.com/tianshu-ai/tianshu/commit/99f0adf2e52ae6376808ca29a3f0dfabe199f7c9))
* **wechat:** Authorization Bearer + channel_version as semver string ([13656d4](https://github.com/tianshu-ai/tianshu/commit/13656d41e9997cdd6e58cc0609d2a7b7d169b743))
* **wechat:** correct iLink QR-status polling (GET + status enum) ([c99a827](https://github.com/tianshu-ai/tianshu/commit/c99a827a259b1ce4b8a7db505292c429c1629d02))
* **wechat:** normaliseInbound matches the real iLink wire shape ([c050c00](https://github.com/tianshu-ai/tianshu/commit/c050c00ea92313da83aa53aa262fec139a2f8dde))
* **wechat:** outbound sendmessage uses real iLink wire shape (msg wrapper + item_list) ([9658a31](https://github.com/tianshu-ai/tianshu/commit/9658a31a857bdcf6cff184fcc2b7e7432715f615))
* **wechat:** render QR via canvas instead of &lt;img src=URL&gt; ([ef38be7](https://github.com/tianshu-ai/tianshu/commit/ef38be716e69252b2e8b9a3c471dd2262949f652))
* **wechat:** use base64(hex-string) encoding for aes_key on all media types ([8065d0a](https://github.com/tianshu-ai/tianshu/commit/8065d0abbd2675f7a1b88fe375789492700ee7e3))
* **wechat:** use OpenClaw's iLink auth headers + correct base_info ([5481fd5](https://github.com/tianshu-ai/tianshu/commit/5481fd5f9d8c66bc9516c8c06da4b132aad25223))
* **workboard:** cancel live worker on task delete / status move ([6714758](https://github.com/tianshu-ai/tianshu/commit/6714758fe78c9f807a66e7174e90873c74bef2bb))
* **workboard:** nudge on done patches + fallback polling timer ([#89](https://github.com/tianshu-ai/tianshu/issues/89)) ([b959cd2](https://github.com/tianshu-ai/tianshu/commit/b959cd23efb24c2d16e7f229063ae14939d99143))
* **workboard:** show awaiting-intervention chip on board cards ([#118](https://github.com/tianshu-ai/tianshu/issues/118)) ([2220f76](https://github.com/tianshu-ai/tianshu/commit/2220f7631a42e9a2fbc7c03e58ab6b344929ed9b))
* **workboard:** surface worker_analytics via manifest + add hygiene tests ([c44a9c8](https://github.com/tianshu-ai/tianshu/commit/c44a9c81135bbb73ad9df3056c1ec385fa888c03))
* **workboard:** task_move(status=ready) clears intervention labels (zombie task fix) ([#117](https://github.com/tianshu-ai/tianshu/issues/117)) ([a0d37b0](https://github.com/tianshu-ai/tianshu/commit/a0d37b0fa0089ff78fbf695c91b6a5a12ea998d1))
* **worker:** drop MAX_TURNS cap; deny task management tools in LLM workers ([#87](https://github.com/tianshu-ai/tianshu/issues/87)) ([4c00b41](https://github.com/tianshu-ai/tianshu/commit/4c00b418c2331b76dd039dd5fd732c4459ef5d0d))
* **workforce-studio:** bigger chevrons + collapsible Main agent ([2d12095](https://github.com/tianshu-ai/tianshu/commit/2d1209561907a6338002999827c64cfb44b832ff))
* **workforce-studio:** explain why Current mirror pickers are inert ([31c1cce](https://github.com/tianshu-ai/tianshu/commit/31c1cce0cf3846f891e7cd17fd4fb7b880c8d10b))
* **workforce-studio:** flatten worker host blocks to match main agent ([c348896](https://github.com/tianshu-ai/tianshu/commit/c348896b7a9ea275a4d7eac067450a23b7018cb2))
* **workforce-studio:** include tenant-authored skills in snapshot ([acd39d6](https://github.com/tianshu-ai/tianshu/commit/acd39d6c64bd6eccdbb21277b96f319bc740451c))
* **workforce-studio:** legible Activate modal text + buttons ([aac79cc](https://github.com/tianshu-ai/tianshu/commit/aac79ccd23b314776f017b33227628451fb00a01))
* **workforce-studio:** only plugin-sourced resources are locked ([bf43922](https://github.com/tianshu-ai/tianshu/commit/bf43922da006754113b75dceeaa42c2ee27b58bf))
* **workforce-studio:** picker button is the action, plus an excluded pill ([120edf7](https://github.com/tianshu-ai/tianshu/commit/120edf7dce8ed75e24727eb963212ba583263098))
* **workforce-studio:** restore worker exclude/include in Workers overview ([d7b0855](https://github.com/tianshu-ai/tianshu/commit/d7b0855a87c4d0ce15c4cb78dd66e8b4a7dc5eee))
* **workforce-studio:** solution tool `save` accepts spec as JSON string ([dd82972](https://github.com/tianshu-ai/tianshu/commit/dd829725f5dfdfcc77ec44f1424b3c218191ebc8))
* **workforce-studio:** visible tree selection in light theme ([5bb880c](https://github.com/tianshu-ai/tianshu/commit/5bb880cc7bce8b2ded88850cca8e77bab3d4da1b))
* **workforce-studio:** worker SOUL.md empty in Current mirror ([bb4b4fd](https://github.com/tianshu-ai/tianshu/commit/bb4b4fdf4800db131a3d844f55820ab8c58f62b6))
* **workforce:** current mirror extract reads applied main-agent config ([64646a7](https://github.com/tianshu-ai/tianshu/commit/64646a78922696e47893769a65c2ab6607a6c5cd))
* **workforce:** reject malformed customFragments instead of silently dropping ([#276](https://github.com/tianshu-ai/tianshu/issues/276)) ([7a4d36d](https://github.com/tianshu-ai/tianshu/commit/7a4d36de01bc2192616c5d99d49132aa19c59bf1))
* **workforce:** snapshot reads applied-solution config so Reality view matches reality ([d8a3326](https://github.com/tianshu-ai/tianshu/commit/d8a332676d708bef65140b9218b536dc03dc9e4a))
* **write:** tool description guideline + repeat-truncation escalation ([#116](https://github.com/tianshu-ai/tianshu/issues/116)) ([91e60fe](https://github.com/tianshu-ai/tianshu/commit/91e60fe18591828b836e63d138b6506b8a072d44))
* WS chat respects user identity (close conversation isolation hole) ([#162](https://github.com/tianshu-ai/tianshu/issues/162)) ([c2f83b3](https://github.com/tianshu-ai/tianshu/commit/c2f83b31e9d6267de10e17a7054a0ed11f0e960e))


### Performance

* **config:** mtime-invalidated read cache for config.json ([8288b56](https://github.com/tianshu-ai/tianshu/commit/8288b561da140488a2419ecbdde15fe9d5c54feb))


### Documentation

* add v0.5.0 launch post links to the Build log ([#293](https://github.com/tianshu-ai/tianshu/issues/293)) ([d110f8c](https://github.com/tianshu-ai/tianshu/commit/d110f8c90eebaf98a61b02aa69a822adb2ad0ea9))
* ADR-0001 multi-tenant architecture ([#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([e5d1cc7](https://github.com/tianshu-ai/tianshu/commit/e5d1cc794783ccd045b6081d9c0c9145fa24f2d9))
* ADR-0002 orchestrator + workers, with config layering ([#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([6d5fff6](https://github.com/tianshu-ai/tianshu/commit/6d5fff6cac433e6134463b169103f20594cf7fd5))
* ADR-0003 plugin system (UI panels, sidebar sections, API routes) ([#30](https://github.com/tianshu-ai/tianshu/issues/30)) ([4386ccd](https://github.com/tianshu-ai/tianshu/commit/4386ccddcc8158b286559af894f0f532b1816724))
* ADR-0004 plugin capabilities & sandbox contract ([#58](https://github.com/tianshu-ai/tianshu/issues/58)) ([b6a84f4](https://github.com/tianshu-ai/tianshu/commit/b6a84f46e732ae483640d5efd3247db078192312))
* **adr:** ADR-0008 — Solution model & Workforce Studio ([f4da3b9](https://github.com/tianshu-ai/tianshu/commit/f4da3b985553beb52c7811e2bd9ea16784f38ecd))
* **adr:** record channel-bindings stay user-scoped (v0 decision) ([#235](https://github.com/tianshu-ai/tianshu/issues/235)) ([203cfe6](https://github.com/tianshu-ai/tianshu/commit/203cfe6787fff32c3cd8fd5f7a5e3c535fa92cb7))
* **architecture:** ADR-0007 — skill progressive disclosure ([#128](https://github.com/tianshu-ai/tianshu/issues/128)) ([56e114c](https://github.com/tianshu-ai/tianshu/commit/56e114c3c5c3319c444458c9e8aa4f54400c006e))
* clarify setup-agent hand-off + drop unmaintained hosted-demo link ([dee1596](https://github.com/tianshu-ai/tianshu/commit/dee159650e1c29e9506ecdb06a154b644eea5af8))
* **dev:** document the two upstream npm deprecation warnings (install-time only) ([d0ac38f](https://github.com/tianshu-ai/tianshu/commit/d0ac38f9d3010f3301ed779d792c9e20cd4d3183))
* **files,microsandbox:** clarify cross-tool path semantics ([#135](https://github.com/tianshu-ai/tianshu/issues/135)) ([802301b](https://github.com/tianshu-ai/tianshu/commit/802301beb80053d9e43e6b330b54399d6ff0bf5c))
* highlight the orchestrator's supervisor role + analytics ([0dac40f](https://github.com/tianshu-ai/tianshu/commit/0dac40f16e2f18f1c783fdcda2345b763e1ac96e))
* how to run tianshu as a background service (macOS launchd) ([#161](https://github.com/tianshu-ai/tianshu/issues/161)) ([e439c67](https://github.com/tianshu-ai/tianshu/commit/e439c678c7ac2de18f8b3bc3e50a07b3d1b5b615))
* **microsandbox:** teach the agent how to start servers without hanging exec ([#119](https://github.com/tianshu-ai/tianshu/issues/119)) ([c03a2f3](https://github.com/tianshu-ai/tianshu/commit/c03a2f3ddcfb5fb9c62620309d3d6bb8ada7b0b1))
* **microsandbox:** tell agents to use existing chromium + libreoffice instead of reinstalling ([#122](https://github.com/tianshu-ai/tianshu/issues/122)) ([16b3363](https://github.com/tianshu-ai/tianshu/commit/16b33634d366876695cd1aabdeb62e9f72e5aa03))
* pi 0.80 migration brief (issue [#260](https://github.com/tianshu-ai/tianshu/issues/260)) ([c72f5aa](https://github.com/tianshu-ai/tianshu/commit/c72f5aa5b452e26b052fc68f9ba955b6f96da3ce))
* README rewrite — guide users from install to first run ([de9ec3e](https://github.com/tianshu-ai/tianshu/commit/de9ec3e1df0060609335f4347dcaccdd84b9c2c0))
* **readme:** lead with `npm install -g`, demote dev-checkout flow ([85fe23b](https://github.com/tianshu-ai/tianshu/commit/85fe23b87bc2dac9b91e6bae6fe3f9d9ae5e557d))
* Workforce Studio IDE-layout rework brief ([8b741e8](https://github.com/tianshu-ai/tianshu/commit/8b741e8a7a9c237b185aba7ff414902d079c02f2))


### Refactor

* **auth:** tenant by membership, not a global strategy ([858290a](https://github.com/tianshu-ai/tianshu/commit/858290a7aab4ab737bfe19be6f001d8902acebcb))
* **channels:** channel session sidebar rows belong to plugins, not the host ([0f5c54e](https://github.com/tianshu-ai/tianshu/commit/0f5c54e24fc8c5e1783d4cf2b56978c50c6082f0))
* **chat:** extract system-prompt + compact-decision out of handler.ts ([969ba94](https://github.com/tianshu-ai/tianshu/commit/969ba94a7eb1fbad575a67861ba74fa3d84631fd))
* **chat:** storage owns image base64 + drop legacy helpers + migration 004 ([#84](https://github.com/tianshu-ai/tianshu/issues/84)) ([2a1fa58](https://github.com/tianshu-ai/tianshu/commit/2a1fa580b06b2288b2ff499fbd57613ceb429f69))
* **cli,setup:** use core/urls for port/URL resolution ([d0fc71e](https://github.com/tianshu-ai/tianshu/commit/d0fc71e2ce6478726cf5613d6d5d1c31717dffa1))
* **config:** drop dead OverridableConfig.oauth; document global-only auth ([50a4463](https://github.com/tianshu-ai/tianshu/commit/50a446387e3428d6b89abff8ab9f5681c4328500))
* **middleware:** pluggable IdentityResolver chain ([#160](https://github.com/tianshu-ai/tianshu/issues/160)) ([d7e9265](https://github.com/tianshu-ai/tianshu/commit/d7e9265016a6533ec72d421c85174cd2a7a569dc))
* **server:** split index.ts boot into focused modules; harden homeDir resolution ([66dd54e](https://github.com/tianshu-ai/tianshu/commit/66dd54e8f60e63b630d1710b02be4f98a202e5bb))
* **web:** split Auth admin page into sidebar sub-nodes ([47d1f73](https://github.com/tianshu-ai/tianshu/commit/47d1f736701cb86131080f6e1cb50faba527b727))
* **workboard:** rename todo→ready, retry-on-failure, drop aborted state ([#88](https://github.com/tianshu-ai/tianshu/issues/88)) ([67a8cbb](https://github.com/tianshu-ai/tianshu/commit/67a8cbb77cdf962b198bc5cf1f64518392972095))
* **workboard:** stalled is a label, not a status (3 columns total) ([#90](https://github.com/tianshu-ai/tianshu/issues/90)) ([0c80ae9](https://github.com/tianshu-ai/tianshu/commit/0c80ae97242added8d289b950c56d700f96e8c57))
* **workforce-studio:** rename Develop tab label to Blocks (ADR-0008 §8) ([3f2fc9f](https://github.com/tianshu-ai/tianshu/commit/3f2fc9f8e738efcfc417e064c1fecda10d846759))

## [0.4.85](https://github.com/tianshu-ai/tianshu/compare/v0.4.84...v0.4.85) (2026-07-11)

### Bug Fixes

* **web:** Models page never binds the apiKey mask sentinel to the
  password input. Previously the server's `"__stored__"` sentinel was
  shown in the field, so a partial edit stored a corrupted key
  (`"__stored__xyz"`) and the UX was confusing. Now the field loads
  empty with a "•••• stored (leave blank to keep)" placeholder; an
  untouched field re-sends the sentinel (server preserves the real
  key), a typed value replaces it, and a new **Clear** button removes
  a stored key. Verified live: saving with the key field untouched
  preserves all providers' real keys intact. (Review finding B3.)

## [0.4.84](https://github.com/tianshu-ai/tianshu/compare/v0.4.83...v0.4.84) (2026-07-10)

### Bug Fixes

* **web:** Models delete buttons now use the theme-aware `danger`
  token instead of hard-coded dark-theme rose shades, which were
  washed out (looked disabled) on the light theme. Provider "Remove"
  and the per-model trash icon now render `text-danger` /
  `border-danger` with a solid `bg-danger` hover, readable in both
  light and dark themes.

## [0.4.83](https://github.com/tianshu-ai/tianshu/compare/v0.4.82...v0.4.83) (2026-07-10)

### Bug Fixes

* **web:** Models page delete buttons no longer look disabled. The
  provider "Remove" button is now an outlined danger button (solid
  rose text + border, full opacity) and the per-model trash icon uses
  a brighter rose with a hover fill, so both read as active
  destructive actions rather than greyed-out/disabled.

## [0.4.82](https://github.com/tianshu-ai/tianshu/compare/v0.4.81...v0.4.82) (2026-07-10)

### Features

* **web:** Settings → Models default-model field is now a dropdown
  instead of free text. Options are derived from the live (including
  unsaved) provider catalog as `<providerId>/<modelId>` with a
  friendly label; a stored value that isn't in the catalog (set
  externally, or whose model was removed) is preserved as a
  "(not in catalog)" option so it's never silently dropped.

## [0.4.81](https://github.com/tianshu-ai/tianshu/compare/v0.4.80...v0.4.81) (2026-07-10)

### Features

* **web,server:** Settings → Models page. A new host admin page
  (Agent → Models) displays and maintains the provider catalog stored
  in the global config (`~/.tianshu/config.json` → `models.providers`)
  — the same shape you'd hand-edit. Add / edit / remove providers
  (baseUrl, api, group, apiKey) and their models (id, display name,
  context window, reasoning). Saving writes back to config.json; an
  external edit to the file shows up on Reload (config is re-read per
  request, no restart). API keys are never sent to the browser: GET
  masks them to a sentinel and PUT preserves the stored key when the
  sentinel comes back, so editing other fields can't wipe a secret.
  New endpoints `GET`/`PUT /api/admin/models/providers`.

## [0.4.80](https://github.com/tianshu-ai/tianshu/compare/v0.4.79...v0.4.80) (2026-07-10)

### Bug Fixes

* **web:** de-dupe the user bubble on resumed turns. Server-side
  resume deletes + recreates the user row (new id) and broadcasts
  `message_added`, so the client appended a fresh identical user
  bubble on every retry (Yu saw N bubbles for N attempts — clean text
  now, not nested JSON, but still repeated). The client now detects a
  `message_added` user row whose text matches an existing bubble in
  the current turn (scanning back to the previous completed assistant
  reply as the boundary) and REPLACES it in place instead of
  appending. Verified live (kill server mid-stream, 5+ retries,
  reconnect+complete): exactly one user bubble throughout, DB holds
  one row.

## [0.4.79](https://github.com/tianshu-ai/tianshu/compare/v0.4.78...v0.4.79) (2026-07-10)

### Bug Fixes

* **server:** fix retry re-wrapping the user prompt into nested JSON.
  Found via live DB inspection: user rows are stored as a full
  AgentMessage JSON (`{"role":"user","content":[{"type":"text","text":
  "…"}]}`). `takeResumableUserPrompt` returned that raw JSON string and
  the resume re-ran `prompt()` on it, re-serializing into another
  AgentMessage — so every retry nested the JSON one layer deeper and
  the chat showed repeated `{"role":"user"…}` blobs. Now extracts the
  plain text (via `extractUserText`, concatenating text blocks; legacy
  plain-text rows pass through).
* **server:** resume past an errored/partial assistant. A provider
  that drops the stream mid-response persists an assistant row with
  content but `stopReason:"error"` (e.g. SAP-proxy Claude
  `errorMessage:"terminated"`). `takeResumableUserPrompt` treated that
  partial as a completed reply and refused to resume (the stuck `…`).
  It now recognizes `stopReason` error/aborted rows as failed turns to
  drop + resume.
* **models:** classify provider `"terminated"` / `"stream
  interrupted"` / `"connection closed"` as retriable transient
  failures so the server-side model-retry layer catches them too.

## [0.4.78](https://github.com/tianshu-ai/tianshu/compare/v0.4.77...v0.4.78) (2026-07-10)

### Bug Fixes

* **web:** fix the stuck "…" after auto-retry. Verified live by killing
  the server mid-stream: two real bugs remained. (1) A mid-stream
  socket drop left `isStreaming` pinned true (no stream_end/error ever
  arrives on a dead socket), and the retry-send path was gated behind
  `if (isStreaming) return`, so every backoff fired but nothing was
  ever sent — the loop spun forever on the "…" bubble. The retry loop
  no longer gates on isStreaming and clears the stale flag when
  arming. (2) A turn dropped before stream_start (isStreaming still
  false) never re-armed; now tracked via `_awaitingResponse` (set from
  send until a successful stream_end), so any unacknowledged turn
  recovers. Also: on socket reconnect the pending retry fires
  immediately (`_retryNow`) instead of waiting out the remaining
  backoff. Confirmed end-to-end: retry climbs, resumes on reconnect,
  completes, and history keeps a single user message.

## [0.4.77](https://github.com/tianshu-ai/tianshu/compare/v0.4.76...v0.4.77) (2026-07-10)

### Bug Fixes

* **web:** auto-retry no longer stalls or resets its backoff when a
  retry itself fails. Two bugs: (1) `stream_start` cleared the whole
  auto-retry state, so a retry that resumed then failed again snapped
  the backoff back to 1s instead of climbing; (2) a retry sent while
  still disconnected just re-queued and produced no event, stalling
  the loop (the stuck "…" spinner). Fix: the attempt counter now lives
  in module scope and only resets on success / user-stop / a fresh
  prompt (not on `stream_start`), so backoff climbs monotonically
  toward the 30-minute cap across repeated failures; and a watchdog
  re-arms the next backoff if a sent retry neither resumes nor errors
  within 15s. The loop keeps retrying until it succeeds or the user
  hits stop.

## [0.4.76](https://github.com/tianshu-ai/tianshu/compare/v0.4.75...v0.4.76) (2026-07-10)

### Bug Fixes

* **web,server:** auto-retry now RESUMES the last turn instead of
  resending a new prompt. The 0.4.75 loop re-sent a fresh `prompt`
  each attempt, so a flaky connection stacked duplicate user messages
  in history ("继续" ×N). New `retry` WS message re-runs the existing
  turn server-side: `takeResumableUserPrompt` drops the dangling
  failed turn (trailing user msg + any empty/partial assistant),
  re-points the session leaf at the last completed reply, and re-runs
  that single user message via one `prompt()`. History keeps exactly
  one user message no matter how many retries happen. Falls back to a
  clean stream end when there's nothing to resume.

## [0.4.75](https://github.com/tianshu-ai/tianshu/compare/v0.4.74...v0.4.75) (2026-07-10)

### Features

* **web:** auto-retry interrupted runs with exponential backoff until
  the user stops. When a run fails transiently (`stream_error`) or the
  socket drops mid-stream (server restart / network blip), the client
  resends the last prompt on a backoff schedule that doubles from 1s
  and caps at 30 minutes (1s,2s,4s,…,30m), with jitter. Replaces the
  one-shot "Retry" button with a live "retrying in … (attempt N)"
  banner and a Stop button that cancels the loop. User-initiated
  aborts are never auto-retried. The WS layer now surfaces
  connection open/close so an orphaned stream re-arms the loop.

## [0.4.74](https://github.com/tianshu-ai/tianshu/compare/v0.4.73...v0.4.74) (2026-07-09)

### Features

* **models:** retry mid-stream failures. When a transient error hits
  after partial content already streamed (e.g. the connection dropped
  mid-response), the call is re-run and the assistant message is
  rebuilt from scratch; the replay's `start` event is suppressed so
  the harness keeps one message slot, and a new `stream_reset` WS
  event tells the client to clear the in-progress bubble so text isn't
  duplicated. Gated by `models.resilience.retryAfterContent` (default
  true); user aborts are never retried.
* **web:** add a "Retry" button to the stream-error banner that
  resends the last prompt (covers terminated / connection-dropped
  runs), and handle `stream_reset` by clearing the streaming bubble
  before the rebuilt answer arrives. The WS layer already
  auto-reconnects with backoff.

## [0.4.73](https://github.com/tianshu-ai/tianshu/compare/v0.4.72...v0.4.73) (2026-07-09)

### Features

* **models:** surface LLM-call retries in logs and the UI. Every
  retry logs a one-line reason (`[model-retry] provider/model: rate
  limited (http-429), retrying in 5.0s (attempt 1/4)`) and emits a
  new `model_retry` WS event, so the chat area shows a small
  "retrying…" banner with the reason, backoff, and attempt count
  while a transient failure is being retried. The banner clears on
  the next stream start / end. Worker agent-loop runs can forward
  the same notice via `onModelRetry`.

## [0.4.72](https://github.com/tianshu-ai/tianshu/compare/v0.4.71...v0.4.72) (2026-07-09)

### Features

* **models:** resilient LLM calls with a unified retry policy at the
  single stream chokepoint (`core/pi-models.ts`), covering the chat
  handler, worker agent-loop, and compaction. Retries transient
  failures (network blips, 5xx, 429 rate-limits) and re-resolves the
  apiKey on 401/403 so an expired JWT recovers. Retries only happen
  before any content has streamed (never duplicates output); a user
  cancel / watchdog abort stops retries mid-backoff.
* **models:** rate-limit aware backoff. Extracts the server's
  requested wait time from `Retry-After` / `x-ratelimit-reset*`
  headers (seconds/ms/duration/epoch/RFC3339), Gemini's structured
  `retryDelay`, or a "try again in Xs" message hint, and waits at
  least that long (never less, small jitter on top). When no explicit
  wait is given, a 429 falls back to a conservative floor
  (`rateLimitFloorMs`, default 5s) instead of the short exponential
  schedule that would keep re-tripping the limit. The SDK's own
  client-side retries are disabled so the two layers don't compound.
  Configurable via `models.resilience`.

## [0.4.71](https://github.com/tianshu-ai/tianshu/compare/v0.4.70...v0.4.71) (2026-07-09)

### Features

* **files:** paste attachments from the clipboard into the chat
  composer (Cmd/Ctrl+V) — screenshots, copied images, and copied
  files stage via the same upload path as the attach button. Pure
  text paste is unaffected.

## [0.4.70](https://github.com/tianshu-ai/tianshu/compare/v0.4.68...v0.4.70) (2026-07-09)

### Bug Fixes

* **web:** don't send the chat message on Enter while an IME is
  composing (Chinese/Japanese/Korean). Pressing Enter to confirm an
  IME candidate no longer triggers send; guarded with
  `!nativeEvent.isComposing && keyCode !== 229`.

### Chores

* 0.4.69: added diagnostic logging to `syncProjectUp`.

## [0.4.68](https://github.com/tianshu-ai/tianshu/compare/v0.4.67...v0.4.68) (2026-07-09)

### Features

* **opencode-worker:** sync the project's existing files into the
  sandbox before the run (sync-up), so opencode can read/edit an
  existing project instead of only creating from scratch. Mirrors the
  LLM-worker layout (`users/<userId>/projects/<slug>/` → task
  workdir), excludes prior results/scratch, no-ops for fresh
  projects. Results continue to sync down via stageDeliverables.
  Adds optional `syncUp()` to the SDK `SandboxRunner`.

## [0.4.67](https://github.com/tianshu-ai/tianshu/compare/v0.4.66...v0.4.67) (2026-07-08)

### Bug Fixes

* **opencode-worker:** `rm -rf ./.opencode` before every run. 0.4.66
  stopped the worker creating it, but opencode itself can
  (re)create a project-relative `./.opencode` on start, re-triggering
  the ~12-minute per-task project-local dependency install. Removing
  it each run (omo config lives in XDG; omo is a global prewarmed
  plugin) keeps startup instant.

## [0.4.66](https://github.com/tianshu-ai/tianshu/compare/v0.4.65...v0.4.66) (2026-07-08)

### Bug Fixes

* **opencode-worker:** write the omo config to the XDG location only
  (`./.oc-config/opencode`), never to a project-relative
  `./.opencode`. A `./.opencode` dir made opencode treat the workdir
  as a project and run a ~12-minute per-task project-local dependency
  install (`@opencode-ai/plugin` into `./.opencode/node_modules`,
  logging "background dependency install failed / token mismatch").
  omo is a global prewarmed plugin, so XDG-only config loads it and
  the run starts instantly.

## [0.4.65](https://github.com/tianshu-ai/tianshu/compare/v0.4.64...v0.4.65) (2026-07-08)

### Bug Fixes

* **opencode-worker:** isolate omo locks per task to fix the
  intermittent "hang after loading config". omo's codegraph lock
  lives in the sandbox-global `$HOME/.omo/codegraph/locks`, so
  concurrent runs (or a SIGKILL'd run's leftover lock) contend and
  the next run's acquireLock stalls. Now set `codegraph.install_dir`
  to a per-task path and re-add pre-run stale-lock cleanup (dropped
  in the 0.4.59 simplification).

## [0.4.64](https://github.com/tianshu-ai/tianshu/compare/v0.4.63...v0.4.64) (2026-07-08)

### Reverts

* **opencode/openshell:** drop `allow_encoded_slash` (0.4.62). The
  openshell CLI doesn't support it in the endpoint options segment,
  so it always failed and fell back — spamming a warning per grant.
  omo deps are pre-warmed into the image, so no scoped-package (%2F)
  install happens at task time; the option was unnecessary.

## [0.4.63](https://github.com/tianshu-ai/tianshu/compare/v0.4.62...v0.4.63) (2026-07-08)

### Refactor

* **opencode-worker:** drop the redundant `$HOME/.oc-npm/bin` PATH
  prepend from the run command — the sandbox image ships the pinned
  opencode globally, so plain `opencode` is already correct.

## [0.4.62](https://github.com/tianshu-ai/tianshu/compare/v0.4.61...v0.4.62) (2026-07-08)

### Bug Fixes

* **opencode/openshell:** allow encoded slash (%2F) for the npm
  registry egress. openshell's L7 REST engine denies request-targets
  containing %2F by default, so npm scoped-package installs
  (@ai-sdk%2Fanthropic, ...) — which omo depends on — were DENIED.
  `allowEgress` now takes `allowEncodedSlash`; the runner appends
  `allow_encoded_slash=true` to the endpoint spec (falls back to the
  plain spec if the CLI rejects the option).

## [0.4.61](https://github.com/tianshu-ai/tianshu/compare/v0.4.60...v0.4.61) (2026-07-08)

### Bug Fixes

* **opencode-worker:** `mkdir -p .opencode .oc-config/opencode` before
  writing the omo config. `sandbox upload` only auto-creates the
  immediate parent, so the nested `.opencode/oh-my-opencode.jsonc`
  write failed on a fresh workdir (observed: workdir had only
  opencode.json). Without the omo config, omo used its DEFAULT config
  (agents not pinned to the proxied model).

## [0.4.60](https://github.com/tianshu-ai/tianshu/compare/v0.4.59...v0.4.60) (2026-07-08)

### Bug Fixes

* **opencode-worker:** surface oh-my-opencode.jsonc write
  success/failure (was `.catch(()=>undefined)`, silently hiding a
  failed write). If the omo config write fails, omo falls back to
  its DEFAULT config (agents not pinned to the single proxied
  model). Now logged so a missing omo config is visible.

## [0.4.59](https://github.com/tianshu-ai/tianshu/compare/v0.4.58...v0.4.59) (2026-07-08)

### Refactor

* **opencode-worker:** simplify the generated opencode run command.
  Removed the accumulated firefighting env (proxy-env unset,
  NO_PROXY, NODE_OPTIONS=ipv4first, stale-lock clearing) now that the
  opencode.json baseURL is the IPv4 literal and opencode connects
  directly. Matches the verified manual command
  `OPENCODE_CONFIG=<workdir>/opencode.json opencode run <prompt>`;
  keeps only worker mechanics + the proven-necessary env
  (DISABLE_MODELS_FETCH, ENABLE_PARALLEL, SEND_ANONYMOUS_TELEMETRY=no,
  DISABLE_LSP_DOWNLOAD).

## [0.4.58](https://github.com/tianshu-ai/tianshu/compare/v0.4.57...v0.4.58) (2026-07-08)

### Bug Fixes

* **opencode-worker:** disable oh-my-openagent's anonymous PostHog
  telemetry (`OMO_SEND_ANONYMOUS_TELEMETRY=no`). In the locked
  sandbox the telemetry POST to us.i.posthog.com is egress-denied
  (403), spamming the run output with harmless-but-noisy
  PostHogFetchHttpError stack traces. (omo end-to-end run now works;
  this removes the last cosmetic noise.)

## [0.4.57](https://github.com/tianshu-ai/tianshu/compare/v0.4.56...v0.4.57) (2026-07-08)

### Features

* **opencode-proxy:** `OPENCODE_PROXY_SKIP_TOKEN_VALIDATION=1` debug
  switch — accept ANY token (uses the real grant if present, else a
  default model) so manual proxy testing isn't blocked by
  mint/revoke/TTL. No hardcoded token. Replaces the 0.4.56
  hardcoded-test-token approach. Do NOT enable in production.

## [0.4.56](https://github.com/tianshu-ai/tianshu/compare/v0.4.55...v0.4.56) (2026-07-08)

### Features

* **opencode-proxy:** `OPENCODE_PROXY_TEST_TOKEN` — a long-lived proxy
  token (never expires, never revoked) for manually exercising the
  full proxy chain without racing the worker's per-task mint/revoke.
  Optional `OPENCODE_PROXY_TEST_MODEL` (default
  anthropic/claude-opus-4-6) + `OPENCODE_PROXY_TEST_TENANT` (default
  default). Debugging only — do not set in production.

## [0.4.55](https://github.com/tianshu-ai/tianshu/compare/v0.4.54...v0.4.55) (2026-07-08)

### Chores

* log each openshell exec RESULT (exit code + trimmed stdout/stderr)
  so the version-check / mkdir / opencode-run steps can be seen to
  succeed or fail with their output.

## [0.4.54](https://github.com/tianshu-ai/tianshu/compare/v0.4.53...v0.4.54) (2026-07-08)

### Chores

* log the full openshell exec command the opencode worker runs
  ("opencode-worker: RUN cmd" + "openshell exec argv") to diff a
  failing worker task against a working manual `openshell sandbox
  exec ... opencode run`.

## [0.4.53](https://github.com/tianshu-ai/tianshu/compare/v0.4.52...v0.4.53) (2026-07-07)

### Bug Fixes

* **opencode-worker:** pin the proxy baseURL + egress grant to the
  IPv4 host-gateway literal (192.168.65.254, override via
  OPENCODE_PROXY_HOST_IP). The sandbox resolves host.docker.internal
  to IPv6 first, which openshell rejects (only the first /etc/hosts
  IP is permitted) — opencode's model call never connected and the
  proxy never received it ("Cannot connect to API"). NODE_OPTIONS
  ipv4first doesn't work on Bun. Rewriting both the baseURL and the
  egress host to IPv4 fixes it.

## [0.4.52](https://github.com/tianshu-ai/tianshu/compare/v0.4.51...v0.4.52) (2026-07-07)

### Chores

* **opencode-proxy:** add diagnostic logging (recv token lookup /
  forward upstream URL / upstream>=400 status) to pin down whether an
  opencode "Unauthorized" is a proxy-token miss or an upstream 401.

## [0.4.51](https://github.com/tianshu-ai/tianshu/compare/v0.4.50...v0.4.51) (2026-07-07)

### Bug Fixes

* **opencode-worker:** trim `OPENCODE_BINARIES` to paths that exist
  in the sandbox image. openshell symlink-resolves each policy
  binary and logged "Cannot access container filesystem" WARNs for
  the nonexistent entries; keeping only the real paths
  (/usr/bin/opencode + opencode.exe + node/npm) removes the noise
  and the ambiguity.

## [0.4.50](https://github.com/tianshu-ai/tianshu/compare/v0.4.49...v0.4.50) (2026-07-07)

### Bug Fixes

* **opencode-worker:** force IPv4 DNS
  (`NODE_OPTIONS=--dns-result-order=ipv4first`) for the opencode run.
  The sandbox maps host.docker.internal to both IPv4 and IPv6;
  Node/Bun prefer IPv6, but openshell only permits the first
  /etc/hosts entry (IPv4) and rejects other IPs — so opencode's model
  call to the tianshu proxy resolved to IPv6 and was rejected
  ("Cannot connect to API"). Found via `openshell logs --level
  trace`.

## [0.4.49](https://github.com/tianshu-ai/tianshu/compare/v0.4.48...v0.4.49) (2026-07-07)

### Bug Fixes

* **opencode/omo:** disable omo's `lsp` MCP (its lsp-daemon blocks on
  the L7 proxy at startup and deadlocks init) and UNSET the proxy env
  for the opencode run (with models.dev + lsp off, opencode only needs
  direct connections to the tianshu proxy + its loopback server;
  Bun mis-routes those through the L7 proxy -> "Cannot connect").
  Sandbox image warmup config mirrors disabled_mcps:["lsp"]. Verified
  via docker exec: reaches the model, rc=0. A residual
  gRPC-exec-tunnel hang may remain in some envs; OPENCODE_DISABLE_OMO=1
  is the fallback.

## [0.4.48](https://github.com/tianshu-ai/tianshu/compare/v0.4.47...v0.4.48) (2026-07-07)

### Bug Fixes

* **opencode-worker:** pin the oh-my-openagent plugin to an exact
  version (`@4.15.1`) instead of bare/`@latest`. opencode re-resolves
  an unpinned plugin against npm on every startup, and that resolve
  stalls through the openshell L7 proxy — hanging plugin-load before
  omo runs. Pinning to the version warmed in the sandbox image skips
  the npm resolve. Also add `host.docker.internal` to NO_PROXY so
  model calls to the tianshu proxy go direct. A residual intermittent
  plugin-load deadlock may remain; `OPENCODE_DISABLE_OMO=1` is the
  fallback.

## [0.4.47](https://github.com/tianshu-ai/tianshu/compare/v0.4.46...v0.4.47) (2026-07-07)

### Bug Fixes

* **opencode-worker:** set `OPENCODE_DISABLE_MODELS_FETCH=1` —
  opencode's startup models.dev fetch stalled through the openshell
  L7 proxy and blocked omo init; we don't need it (model metadata
  comes from the tianshu provider). Plus warm omo first-init
  provisioning into the sandbox image + strip the stale build-time
  codegraph lock. Note: a residual openshell gRPC-exec-tunnel plugin
  init deadlock remains under investigation; `OPENCODE_DISABLE_OMO=1`
  is the reliable fallback.

## [0.4.46](https://github.com/tianshu-ai/tianshu/compare/v0.4.45...v0.4.46) (2026-07-06)

### Bug Fixes

* **opencode-worker:** harden the headless omo config — disable the
  reply-listener daemon (background-notification hook), codegraph
  auto-provision, and gate remote-MCP egress; add `--auto` to the
  run. Bare `docker run` omo init completes (~28s, reaches the model)
  but the openshell L7-proxied sandbox still hangs before init —
  residual hang is environment-specific, under investigation.
  Escape hatch: `OPENCODE_DISABLE_OMO=1`.

## [0.4.45](https://github.com/tianshu-ai/tianshu/compare/v0.4.44...v0.4.45) (2026-07-06)

### Bug Fixes

* **opencode-worker:** generate a headless-safe oh-my-openagent
  config (tmux/team_mode/monitor/new_task_system off + all always-on
  MCPs disabled). Finding: even fully stripped, omo still hangs at
  plugin init in the locked sandbox — the working path remains
  `OPENCODE_DISABLE_OMO=1`. Documented in code.

## [0.4.44](https://github.com/tianshu-ai/tianshu/compare/v0.4.43...v0.4.44) (2026-07-06)

### Features

* **opencode-worker:** `OPENCODE_DISABLE_OMO=1` env toggle to run
  bare opencode without the oh-my-openagent plugin. Root-caused the
  "opencode hangs after loading config" symptom to omo's init (not
  the proxy/upstream key): with omo disabled the same task completes
  and returns an assistant message. Escape hatch + diagnostic lever.
* **workboard:** `scripts/opencode-e2e.mjs` end-to-end integration
  probe — fires an opencoder task on the ENV default model, waits
  for completion, asserts an assistant message came back, and
  classifies the failing layer otherwise.

## [0.4.43](https://github.com/tianshu-ai/tianshu/compare/v0.4.42...v0.4.43) (2026-07-06)

### Features

* **workboard:** add a "Raw log" view to the task Execution dialog.
  A tab next to "transcript" shows the raw opencode.log read
  straight from the sandbox (new `GET /tasks/:id/opencode-log`
  route), so debugging opencode startup/egress/MCP issues no longer
  needs `docker exec`. Tails every 3s while the task is running.

## [0.4.42](https://github.com/tianshu-ai/tianshu/compare/v0.4.41...v0.4.42) (2026-07-06)

### Bug Fixes

* **opencode-worker:** grant sandbox egress for oh-my-openagent's
  always-on remote MCP servers (mcp.context7.com, mcp.grep.app,
  mcp.exa.ai, mcp.tavily.com) so they connect instead of logging
  "server unavailable" at startup.

## [0.4.41](https://github.com/tianshu-ai/tianshu/compare/v0.4.40...v0.4.41) (2026-07-06)

### Bug Fixes

* **opencode-worker:** authorize the `opencode.exe` binary for
  sandbox egress. opencode 1.17.x ships a compiled native binary
  (opencode.exe); openshell gates egress by the requesting binary
  and the authorized list omitted it, so opencode's startup
  models.dev fetch (and model-proxy calls) were 403'd and it stalled
  at startup. Verified the models.dev 403 is gone after the fix.

## [0.4.40](https://github.com/tianshu-ai/tianshu/compare/v0.4.39...v0.4.40) (2026-07-06)

### Bug Fixes

* **openshell:** don't recreate a busy sandbox mid-run. A long
  opencode run makes the sandbox slow to list; waitForReady treated
  >15s of that as "gone" and recreated it, wiping the workdir and
  killing the running task (longer tasks stuck in_progress). Now the
  history-poller read never triggers recreate, and before recreating
  on "not listable" the runner checks the docker container is truly
  gone (vs just busy). Verified end-to-end: oh-my-openagent's
  Sisyphus completed a real FizzBuzz task (code written, executed,
  output recorded) with zero recreates.

## [0.4.39](https://github.com/tianshu-ai/tianshu/compare/v0.4.38...v0.4.39) (2026-07-06)

### Features

* **openshell:** prebuilt opencode sandbox image
  (plugins/openshell/sandbox-image/Dockerfile) baking opencode
  1.17.13 + a warmed oh-my-openagent plugin cache, so sandboxes
  start instantly instead of installing ~500MB per task. Point at it
  via `plugins.openshell.config.fromImage`.

### Bug Fixes

* **opencode-worker:** oh-my-openagent's Sisyphus now runs as the
  default agent end-to-end (verified: agent self-reports as
  Sisyphus, task done in ~10s). Pre-grant models.dev egress
  (opencode fetches its model catalog at startup; blocked = silent
  no-op run). Skip the runtime opencode install when the pinned
  version is already on PATH (fast path for the prebuilt image).
  Removed an invalid `--agent sisyphus` (omo already sets Sisyphus
  as the default primary).

## [0.4.38](https://github.com/tianshu-ai/tianshu/compare/v0.4.37...v0.4.38) (2026-07-06)

### Features

* **opencode-worker:** make oh-my-openagent's agents actually run.
  Listing the plugin wasn't enough — omo's built-in fallback chains
  reference provider names (anthropic/openai/google/…) that don't
  include our "tianshu" proxy provider, so it resolved no model and
  the agents never ran. The worker now writes an oh-my-opencode
  config pinning every omo agent + delegation category to the single
  proxied model and disabling the multi-provider fallback. (First
  pass: all agents share one model.)

## [0.4.37](https://github.com/tianshu-ai/tianshu/compare/v0.4.36...v0.4.37) (2026-07-05)

### Bug Fixes

* **opencode-worker:** enable opencode's web_search tool
  (OPENCODE_ENABLE_PARALLEL, key-free Parallel backend), add the
  oh-my-openagent plugin, and force the pinned opencode version
  (1.17.13) instead of keeping the base image's stale preinstall
  (1.2.18, which lacks websearch). Installs to a user-writable
  prefix (avoids EACCES on the root global), pre-grants npm egress
  for the install, and centralizes the authorized-binary list so
  egress grants cover opencode at its new location. web_fetch works
  once policyAdvisor is enabled (config).

## [0.4.36](https://github.com/tianshu-ai/tianshu/compare/v0.4.35...v0.4.36) (2026-07-03)

### Features

* **opencode-worker:** judge completion with an LLM agent turn
  instead of opencode's exit code. After opencode finishes, the
  worker runs a short host.agentLoop turn that reads the transcript
  + produced files, decides whether the task was actually completed
  (opencode exits 0 even when it gives up), and calls task_complete.
  Also fixes a hang where the task stayed in_progress after opencode
  had already exited — the worker now proceeds to judgment
  immediately. Falls back to mechanical judgment if the agent-loop
  capability is unavailable.

## [0.4.35](https://github.com/tianshu-ai/tianshu/compare/v0.4.34...v0.4.35) (2026-07-03)

### Features

* **opencode-worker:** generated opencode.json now allows all tools
  (edit/bash/webfetch = allow) so a headless run never stalls on a
  tool-approval prompt ("user rejected permission").
* **openshell:** new `allowPublicEgress` plugin config. When true,
  the sandbox is created with a permissive policy allowing all
  public + host egress for any binary (instead of deny-by-default),
  so an OpenCode worker can install toolchains and reach external
  services. Opt-in — weakens sandbox isolation.

## [0.4.34](https://github.com/tianshu-ai/tianshu/compare/v0.4.33...v0.4.34) (2026-07-03)

### Features

* **opencode-worker:** near-real-time transcript + resolved tool
  chips. A 4s poller now reads opencode's NDJSON from the sandbox
  while it runs and rewrites the session history, so the task
  Execution tab shows progress mid-run instead of only at the end.
  And tool chips no longer spin forever: the parser captures each
  tool's completion status + output, and the worker writes a paired
  tool-result row so the chip resolves to done/failed with the real
  output.

## [0.4.33](https://github.com/tianshu-ai/tianshu/compare/v0.4.32...v0.4.33) (2026-07-03)

### Bug Fixes

* **opencode-worker:** the task Execution tab now renders the
  opencode run as structured cards (clean text + tool chips with
  real arguments) instead of raw JSON blobs with empty args. The
  worker was writing history in a shape the reader didn't
  understand (so it dumped the JSON as text), and tool args were
  read from the wrong field (opencode puts them under
  part.state.input). Both fixed and round-trip verified.

## [0.4.32](https://github.com/tianshu-ai/tianshu/compare/v0.4.31...v0.4.32) (2026-07-03)

### Features

* **opencode-worker:** optional `enableLsp` toggle on the worker
  agent.json (default false). When on, opencode keeps LSP +
  formatters enabled and the worker opens sandbox egress to the
  package registries opencode installs language servers from
  (npm + GitHub) so the auto-install can complete instead of
  hanging. Off by default preserves the locked-down, proxy-only
  egress. Opt-in because it widens the sandbox's network surface.

## [0.4.31](https://github.com/tianshu-ai/tianshu/compare/v0.4.30...v0.4.31) (2026-07-03)

### Bug Fixes

* **opencode-worker:** opencode runs now actually complete inside the
  openshell sandbox (validated end-to-end: task done, file created,
  result + transcript + history persisted, clean process exit). The
  "stuck in_progress forever" was opencode auto-installing a language
  server (bash-language-server via npm) before calling the model —
  the sandbox egress is locked to the model proxy, so the install had
  no network and hung, and the model was never called. Fixed with
  OPENCODE_DISABLE_LSP_DOWNLOAD=1 + disabling lsp/formatter/snapshot/
  autoupdate in the generated opencode.json. Also: run opencode in
  the foreground under `timeout` (backgrounding broke the stdout
  capture), and fixed a FOREIGN KEY failure when writing run history
  for dev/virtual users.

## [0.4.30](https://github.com/tianshu-ai/tianshu/compare/v0.4.29...v0.4.30) (2026-07-03)

### Features

* **opencode-worker:** write the opencode run transcript into task
  history so the Execution tab shows what opencode did. The worker
  now creates a worker session and inserts messages (prompt,
  assistant text + tool calls, outcome) into the shared messages
  table, and the pool stamps the session id onto the task — the
  existing GET /tasks/:id/history renders it with no frontend
  change. The raw NDJSON is also saved as opencode-transcript.jsonl
  in the task workdir.

## [0.4.29](https://github.com/tianshu-ai/tianshu/compare/v0.4.28...v0.4.29) (2026-07-03)

### Bug Fixes

* **opencode-worker:** isolate opencode's XDG dirs per task so it
  no longer loads the container's global opencode config/plugins
  (e.g. opencode-anthropic-auth) that fight the injected tianshu
  provider and left it spinning on init without producing task
  output. Runs now use per-task XDG_CONFIG_HOME/XDG_DATA_HOME while
  OPENCODE_CONFIG still supplies the proxied provider.

## [0.4.28](https://github.com/tianshu-ai/tianshu/compare/v0.4.27...v0.4.28) (2026-07-02)

### Bug Fixes

* **opencode-worker:** grant sandbox egress by binary, not just
  host:port — the OpenCode worker now runs end to end. openshell's
  network policy gates egress by BOTH the host:port endpoint AND the
  requesting binary; registering the proxy endpoint with no
  authorized binaries left every request denied (403 policy_denied,
  the error that persisted through the earlier attempts).
  SandboxRunner.allowEgress gains an optional `binaries` list; the
  openshell runner passes them as `--binary` to
  `policy update --add-endpoint`, and OpenCodeWorker authorizes the
  opencode binary + node. Validated on a real local openshell
  sandbox: task → self-install opencode → egress granted → opencode
  run through the proxy → result returned → task done.

## [0.4.27](https://github.com/tianshu-ai/tianshu/compare/v0.4.26...v0.4.27) (2026-07-02)

### Bug Fixes

* **opencode-worker:** surface the full API error. Failures showed a
  bare `OpenCode error: APIError` because the NDJSON parser only
  read `error.name`; opencode nests the detail under
  `error.data.{message,statusCode,responseBody}`. Now the task's
  failure_reason includes the status code, message, and an upstream
  body snippet, so a proxy/upstream 4xx/5xx is diagnosable.

## [0.4.26](https://github.com/tianshu-ai/tianshu/compare/v0.4.25...v0.4.26) (2026-07-02)

### Bug Fixes

* **opencode-worker:** pipe the task prompt via stdin instead of
  passing it as a CLI argument. The openshell exec transport rejects
  any argv element containing a newline ("command argument N
  contains newline"), so a multi-line task description broke every
  run (OpenCode exited 1 after ~20s). The worker now writes the
  prompt to `<workdir>/.prompt.txt` and runs
  `opencode run --format json < .prompt.txt`, keeping the command
  line newline-free while delivering the full multi-line prompt.
  Added run logging (start/finish + stderr head) for observability.

## [0.4.25](https://github.com/tianshu-ai/tianshu/compare/v0.4.24...v0.4.25) (2026-07-02)

### Features

* **opencode-worker:** new `kind:"opencode"` worker drives the
  headless OpenCode CLI inside the tenant shell sandbox to complete
  a workboard task, using any tianshu model. A host OpenCode proxy
  (`packages/server/src/opencode-proxy`) mints a per-task,
  single-model, single-tenant token; the sandbox reaches a model
  through the proxy and never sees the real provider key or baseUrl.
  The proxy overwrites the request `model` (anti-tamper), enforces a
  path/method allowlist, and normalizes the upstream API version per
  protocol. The worker self-installs opencode
  (`npm i -g opencode-ai@1.17.13`, idempotent) so no custom Docker
  image is needed. Per-task model override via an `opencode-model:<id>`
  label. Configure the sandbox-reachable proxy origin via
  `opencodeProxy.sandboxReachableOrigin` (default
  `http://host.docker.internal:<server.port>`). The opencode <-> proxy
  <-> model core is validated end-to-end; live openshell wiring
  depends on the operator's sandbox runtime.

## [0.4.24](https://github.com/tianshu-ai/tianshu/compare/v0.4.23...v0.4.24) (2026-07-02)

### Features

* **workboard:** `task_create` can now define a dependency graph in
  one batch call. Each task may carry a local `ref` alias; other
  rows in the same `tasks` array reference it in `depends_on` to
  depend on a sibling that has no real id yet. The batch assigns
  ids up front, resolves refs to ids, creates rows in topological
  order (so the `blocked` flag is correct at creation), and
  rejects cyclic batch deps per-row (the offending edge is dropped
  with a note; the task is still created). `depends_on` still
  accepts existing task ids you own. Previously an intra-batch
  dependency was silently dropped because the sibling didn't exist
  in the DB yet, forcing serial create-then-link calls.

## [0.4.23](https://github.com/tianshu-ai/tianshu/compare/v0.4.22...v0.4.23) (2026-07-02)

### Features

* **web-search:** simplified to a single key-free backend, per Yu.
  Dropped the Tavily / Brave / SearXNG schemes and the scheme
  selector entirely; web_search now always uses the hosted MCP
  path. The only config is `backend`: Exa or Parallel (both
  anonymous/free). Removed all API-key and SearXNG-URL fields. The
  hosted provider's `key` argument is now just the backend name,
  not a credential blob. web_fetch is unchanged. Both backends
  re-verified live after the cut.

## [0.4.22](https://github.com/tianshu-ai/tianshu/compare/v0.4.21...v0.4.22) (2026-07-01)

### Bug Fixes

* **web:** the capability/state tags in the Plugin Manager (active,
  disabled, failed, verified, no-client-bundle, provides/requires/
  missing) used dark-theme-only tints (bg-emerald-900/40,
  bg-sky-900/40, …) that turned muddy and low-contrast on the white
  light-theme surface. All now use theme-aware semantic colours
  (bg-<sem>/15 + border-<sem>/40 + text-<sem>): success for
  active/provides/verified, accent for satisfied requires, danger
  for missing/failed, warning for no-client-bundle, and bg-hover
  for disabled. Legible in both themes. Verified by rendering old
  vs new on light and dark surfaces.

## [0.4.21](https://github.com/tianshu-ai/tianshu/compare/v0.4.20...v0.4.21) (2026-07-01)

### Bug Fixes

* **workboard:** the Retry button on awaiting-intervention and
  stalled task cards was invisible in light theme. It used
  text-rose-100 / text-orange-100 (near-white) with no background
  (transparent until hover), so on the card's light rose/orange
  tint the label vanished — leaving just an empty red outline. Both
  Retry buttons now use a solid accent background (rose-600 /
  orange-600) with white text, legible in both themes. Verified by
  rendering old vs new on light and dark card backgrounds.

## [0.4.20](https://github.com/tianshu-ai/tianshu/compare/v0.4.19...v0.4.20) (2026-07-01)

### Features

* **web-search:** the plugin now offers selectable search schemes
  and a `web_fetch` tool. Schemes: **hosted** (key-free — queries
  Exa's or Parallel's free hosted MCP endpoints anonymously; an
  optional key raises limits), **searxng** (point at your own
  self-hosted instance URL, no key), and the existing **tavily** /
  **brave** (API key). The operator picks the scheme in Settings →
  Plugins; the agent can still force one per call via `provider`.
  `web_fetch(url, extractMode?, maxChars?)` does a dependency-free
  HTTP GET with readable-content extraction (HTML → markdown/text)
  and an SSRF guard blocking private/loopback/metadata hosts; it
  needs no configuration. Hosted Exa/Parallel round-trips verified
  live against both endpoints.

## [0.4.19](https://github.com/tianshu-ai/tianshu/compare/v0.4.18...v0.4.19) (2026-07-01)

### Features

* **workforce-studio:** export / import a solution as a
  `.solution.json` file. Export serialises the loaded solution
  (inlining tenant prompt, host-block overrides, custom fragments,
  worker SOUL.md and per-worker execution-bias) into the same
  SolutionSpecInput shape the frozen `/solutions/save` contract
  accepts, wrapped in a versioned envelope. Import reads a file,
  validates it (envelope or bare spec), assigns a collision-free
  slug (never touching the reserved `current` mirror) and saves it
  as a new solution. No new server routes — pure client round-trip
  over the existing get + save endpoints. New Export/Import buttons
  sit in the solution IDE topbar next to Extract. Round-trip
  verified in isolation.

## [0.4.18](https://github.com/tianshu-ai/tianshu/compare/v0.4.17...v0.4.18) (2026-07-01)

### Bug Fixes

* **web:** unify selected-row highlight across the app to match the
  sidebar channel list (webchat / wechat), per Yu. All now use
  --color-bg-hover as the selected background instead of drifting
  looks: studio file tree (was bg-info-fg/10), admin nav and image/
  html preview tabs (were bg-bg-raised — invisible white in light
  theme), model-selector dropdown (was bg-bg-hover/60) and plugin
  panel tabs (were bg-bg-hover/70). bg-bg-raised is #ffffff in light
  theme so any selection built on it vanished on white surfaces.

## [0.4.17](https://github.com/tianshu-ai/tianshu/compare/v0.4.16...v0.4.17) (2026-07-01)

### Bug Fixes

* **web:** the active ThemeToggle mode now matches the sidebar
  channel-list selected row (webchat / wechat) exactly, per Yu:
  bg-hover background + fg-default text + a border-default
  outline, instead of the invented solid-accent / faint-accent
  looks from 0.4.15/0.4.16. --color-bg-hover is a visible grey in
  both themes. Verified by rendering the channel row and the
  toggle side by side in both themes.

## [0.4.16](https://github.com/tianshu-ai/tianshu/compare/v0.4.15...v0.4.16) (2026-07-01)

### Bug Fixes

* **web:** the active mode in the ThemeToggle now has a clearly
  visible highlight. 0.4.15 used --color-accent-faint, which is
  only 8% alpha (rgba(66 99 235 / 0.08)) in light theme — barely
  visible on the white sidebar. The active pill now uses the SOLID
  accent colour with on-accent (white) text, like a standard
  segmented control, unmistakable on any surface. Verified by
  rendering both themes in isolation.

## [0.4.15](https://github.com/tianshu-ai/tianshu/compare/v0.4.14...v0.4.15) (2026-07-01)

### Bug Fixes

* **web:** the active mode in the light/dark/system ThemeToggle is
  now visible in light theme. The active button used
  bg-bg-raised via inline style, which is white (#ffffff) in light
  theme — identical to the toggle's own bg-elevated backing — so
  the selected state was invisible. The active mode now uses the
  semi-transparent accent tint (--color-accent-faint) as
  background, the accent colour for the icon/label, and an inset
  accent border, all visible in both themes. Same root cause as
  the 0.4.14 tree-selection fix, different component.

## [0.4.14](https://github.com/tianshu-ai/tianshu/compare/v0.4.13...v0.4.14) (2026-07-01)

### Bug Fixes

* **workforce-studio:** the selected tree item is now visible in
  light theme. It used bg-bg-raised, which is white (same as the
  sidebar) in light theme, so the highlight vanished. Selection
  now uses a semi-transparent blue (bg-info-fg/10) and hover uses
  the dedicated bg-hover token.

## [0.4.0](https://github.com/tianshu-ai/tianshu/compare/v0.3.56...v0.4.0) (2026-06-28)


### Features

* **admin:** /admin shell + microsandbox sandbox-admin page (ADR-0004 N+4) ([#67](https://github.com/tianshu-ai/tianshu/issues/67)) ([c0b864f](https://github.com/tianshu-ai/tianshu/commit/c0b864f2b88a231eb34862e6df7ec3a69bc09350))
* ADR-0005 LSP integration + plugin-files hardening ([#125](https://github.com/tianshu-ai/tianshu/issues/125)) ([ad81da8](https://github.com/tianshu-ai/tianshu/commit/ad81da8cc191805cb3da04a97bef24133f331c30))
* auto-compact via harness + worker sidebar UI cleanup ([#85](https://github.com/tianshu-ai/tianshu/issues/85)) ([6bfcadd](https://github.com/tianshu-ai/tianshu/commit/6bfcadd689ff79030d7da8285d680f8ef1dd9151))
* **broadcast:** plugin and tool-catalog changes reach every tenant member ([800f31b](https://github.com/tianshu-ai/tianshu/commit/800f31b68da4590a129cd6e346a54ae400e3ca93))
* **broadcast:** plugin change appends history note to every active session in the tenant ([388bab6](https://github.com/tianshu-ai/tianshu/commit/388bab6602d7045759fb05c80e0a72197eb31212))
* **channels/wechat:** send images, videos, files through the iLink CDN ([a38ce09](https://github.com/tianshu-ai/tianshu/commit/a38ce09a98a43ea3bf28c88867d3052b19623da1))
* **channels:** cascade delete wechat sessions + pop viewer to webchat ([5d362fe](https://github.com/tianshu-ai/tianshu/commit/5d362feee4fbbead8e3acf6e2c3be5ef18672b7b))
* **channels:** channel system skeleton (host hub + bindings + plugin SDK) ([edcbab3](https://github.com/tianshu-ai/tianshu/commit/edcbab3c05b203adca0237813cadf38820b5068e))
* **channels:** model picker in the channel-session chat area ([775566b](https://github.com/tianshu-ai/tianshu/commit/775566b5f646853349014b6d9f43892e5fb210c9))
* **channels:** per-session tool visibility + channel context in AgentToolContext ([2f1b14b](https://github.com/tianshu-ai/tianshu/commit/2f1b14bae68434e6d5b4083da71166f25c23adb3))
* **channels:** pick a model per wechat binding ([1f2ddd9](https://github.com/tianshu-ai/tianshu/commit/1f2ddd91065936bae5706fb9f9834d8f021ff71a))
* **channels:** push channel_session_changed event for live sidebar refresh ([9def0e1](https://github.com/tianshu-ai/tianshu/commit/9def0e1466fb4b0db049e0b478b61a79ab36dac1))
* **channels:** retry transient errors + fallback to default model ([b98c9cf](https://github.com/tianshu-ai/tianshu/commit/b98c9cf672ce0eba21de02282ccfa896629d6f35))
* **channels:** sidebar lists channel sessions + chat area pins per session ([e57cde4](https://github.com/tianshu-ai/tianshu/commit/e57cde43706aa28bde8d2e9d3047595009b785d3))
* **channels:** wechat channel plugin (iLink bot API) ([f1a71f5](https://github.com/tianshu-ai/tianshu/commit/f1a71f578a4055387194b7546a14d1175860f57a))
* **channels:** wechat plugin admin UI + host.channelBindings capability ([d1b06c8](https://github.com/tianshu-ai/tianshu/commit/d1b06c8de11cb3b853d9fc459a3c89865873b1b0))
* **channels:** wire agent reply path (router → runPrompt → adapter.send) ([6903086](https://github.com/tianshu-ai/tianshu/commit/6903086eccc0217ca64e3ee849c982ad72da5018))
* **chat:** agent tool loop with fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)b, server side) ([#43](https://github.com/tianshu-ai/tianshu/issues/43)) ([424bfaf](https://github.com/tianshu-ai/tianshu/commit/424bfaf1ff17e9c036ed15cd6c51f4a0ea9d9bb6))
* **chat:** assistant message meta line (model / token usage / context %) ([#57](https://github.com/tianshu-ai/tianshu/issues/57)) ([156ed73](https://github.com/tianshu-ai/tianshu/commit/156ed73c338f15bcad24463b713102be42dcdc5a))
* **chat:** auto-compact conversation history at 50% context window ([#56](https://github.com/tianshu-ai/tianshu/issues/56)) ([c24e728](https://github.com/tianshu-ai/tianshu/commit/c24e728281b6881fff7393d419bf8b87081658c4))
* **chat:** auto-compress oversize images before sending to vision providers ([#55](https://github.com/tianshu-ai/tianshu/issues/55)) ([31b715f](https://github.com/tianshu-ai/tianshu/commit/31b715f7dc71ae130a6ddba46ccc7ba3a48854d0))
* **chat:** chat handler + worker on pi-agent-core's AgentHarness (N+6.4) ([#81](https://github.com/tianshu-ai/tianshu/issues/81)) ([5cea697](https://github.com/tianshu-ai/tianshu/commit/5cea697d74e9f5346bce152af26ae4b8ff58dd61))
* **chat:** inject workspace scaffold into agent prompt; move projects to user level ([#46](https://github.com/tianshu-ai/tianshu/issues/46)) ([#47](https://github.com/tianshu-ai/tianshu/issues/47)) ([761cd92](https://github.com/tianshu-ai/tianshu/commit/761cd9217f722079d89a8ff1863ba7a35f9dd4e1))
* **chat:** minimal end-to-end chat over WebSocket (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)) ([#25](https://github.com/tianshu-ai/tianshu/issues/25)) ([348f214](https://github.com/tianshu-ai/tianshu/commit/348f214f153bfa1c7763704f6daf92016293c9d4))
* **chat:** multimodal user messages — attachments as first-class content ([#52](https://github.com/tianshu-ai/tianshu/issues/52)) ([a74689a](https://github.com/tianshu-ai/tianshu/commit/a74689ae9573c7153b85e258a923d6ecc7470820))
* **chat:** persist tool turns + render them inline (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)c) ([#44](https://github.com/tianshu-ai/tianshu/issues/44)) ([8b2f96f](https://github.com/tianshu-ai/tianshu/commit/8b2f96f572b73cedf89104836e46af8d586743bc))
* **chat:** session-recovery agent for self-healing on harness errors ([#239](https://github.com/tianshu-ai/tianshu/issues/239)) ([8c138e7](https://github.com/tianshu-ai/tianshu/commit/8c138e729020ad843ed1af3df03ff936f8f255b8))
* **cli-agent:** check_build_progress — distinguish in-flight builds from errors ([a91bbf6](https://github.com/tianshu-ai/tianshu/commit/a91bbf69f8a093fd6a5c60708669c79dfa936827))
* **cli-agent:** check_for_update + apply_update tools, fix-flow guidance ([a2a48b7](https://github.com/tianshu-ai/tianshu/commit/a2a48b72b52025cc37acec1fa6671a85e383fdff))
* **cli-agent:** sandbox_inventory tool + inventory-first guidance ([6bfaca5](https://github.com/tianshu-ai/tianshu/commit/6bfaca5f8c29864b80640e7faaa1a5d6876b11fb))
* **cli:** `tianshu doctor` + `tianshu setup --wizard` + global-installable bin ([#158](https://github.com/tianshu-ai/tianshu/issues/158)) ([2772e6d](https://github.com/tianshu-ai/tianshu/commit/2772e6dcc3e1897f285592fc6060940208fd651b))
* **cli:** tianshu update — npm self-updater with checkout safety ([#170](https://github.com/tianshu-ai/tianshu/issues/170)) ([979fb31](https://github.com/tianshu-ai/tianshu/commit/979fb31a0e613c30723b91e848f66aeaf7471eb0))
* **core:** centralise port/URL resolution in core/urls.ts ([2a7611f](https://github.com/tianshu-ai/tianshu/commit/2a7611f53103d5e804827c0659dfa852f3de68d3))
* day-0 scaffolding ([786a0bd](https://github.com/tianshu-ai/tianshu/commit/786a0bdfb1bdf6cdd5e9e3abd2a03677da7c63b6))
* **dev-identity:** URL-driven tenant/user switching via cookie ([#159](https://github.com/tianshu-ai/tianshu/issues/159)) ([5c8d9b3](https://github.com/tianshu-ai/tianshu/commit/5c8d9b3b08dd1cd1f8dff241c425d18c3d46759a))
* **doctor,cli-agent:** differentiate dev vs production mode ([a197004](https://github.com/tianshu-ai/tianshu/commit/a19700435faa3f8d258ead05967ada566ccb997b))
* **doctor:** add Tianshu version check (compare to npm latest) ([736e1f1](https://github.com/tianshu-ai/tianshu/commit/736e1f1079f4790821d32227637755e0d638cd4e))
* **files,server:** move workspace layout block to files plugin fragment ([#136](https://github.com/tianshu-ai/tianshu/issues/136)) ([cb823e5](https://github.com/tianshu-ai/tianshu/commit/cb823e5baaafd973eb022d4a452d8067693b298b))
* **files:** clarify read-required prompt + accept paged reads as full ([#138](https://github.com/tianshu-ai/tianshu/issues/138)) ([6450d4b](https://github.com/tianshu-ai/tianshu/commit/6450d4b3e80a7dec42b463489144bc0e62db11b7))
* **files:** move fs agent tools into the files plugin (ADR-0004 N+3.5) ([#62](https://github.com/tianshu-ai/tianshu/issues/62)) ([49ab627](https://github.com/tianshu-ai/tianshu/commit/49ab6272fe8155b2c135c23789e315b4b0fd7526))
* **files:** workspace:// URI scheme for tool→UI file references ([#86](https://github.com/tianshu-ai/tianshu/issues/86)) ([77e7fb7](https://github.com/tianshu-ai/tianshu/commit/77e7fb7181c0cdd6c3f517a46d6924c37b4dcb8e))
* **launchd:** use ai.tianshu.prod / ai.tianshu.dev labels (no hash) + migrate old ones ([9e533ac](https://github.com/tianshu-ai/tianshu/commit/9e533acd86aa8ab535fcec230a8e949f9393b2dc))
* **microsandbox,workboard:** per-task sandbox pool with stop-not-remove lifecycle ([#141](https://github.com/tianshu-ai/tianshu/issues/141)) ([16c277c](https://github.com/tianshu-ai/tianshu/commit/16c277cde20171d62ed381933065a62ef6b0c481))
* **microsandbox:** allow file:// + pdf + vision in Playwright MCP, prompt fragment for ephemeral task sandbox ([#145](https://github.com/tianshu-ai/tianshu/issues/145)) ([c6fbabc](https://github.com/tianshu-ai/tianshu/commit/c6fbabced99df5c7b4de7885461ba5bb8f4e567a))
* **microsandbox:** browser sidecar scaffold + 3 agent tools + admin Browser page (ADR-0004 N+5.1) ([#68](https://github.com/tianshu-ai/tianshu/issues/68)) ([74e17a7](https://github.com/tianshu-ai/tianshu/commit/74e17a7d98068f2c48dfdf0a2036eb0c565a96b5))
* **microsandbox:** build resilience — SDK rename, Node fallback, node-python template ([#133](https://github.com/tianshu-ai/tianshu/issues/133)) ([a65490d](https://github.com/tianshu-ai/tianshu/commit/a65490db579687e630ec2615b4eed16191140c89))
* **microsandbox:** builtin plugin scaffold + nullable runner (ADR-0004 N+2) ([#60](https://github.com/tianshu-ai/tianshu/issues/60)) ([babdf6d](https://github.com/tianshu-ai/tianshu/commit/babdf6d8cd1beb67d5c1df36a94a1fa3e2604706))
* **microsandbox:** drop privileges to a real tenant user inside the guest ([#139](https://github.com/tianshu-ai/tianshu/issues/139)) ([53c1b83](https://github.com/tianshu-ai/tianshu/commit/53c1b838858ea20593af627a50a43eda8119ed4e))
* **microsandbox:** eager warm-up on plugin activation ([#64](https://github.com/tianshu-ai/tianshu/issues/64)) ([43a8424](https://github.com/tianshu-ai/tianshu/commit/43a842478e0a1d1bf1084129b530327874f34d41))
* **microsandbox:** expand node-python template to full browser stack ([#134](https://github.com/tianshu-ai/tianshu/issues/134)) ([cd4c0af](https://github.com/tianshu-ai/tianshu/commit/cd4c0afde1fef1b4d63e9069f60a5b473e8a6e6b))
* **microsandbox:** expose memory / cpu / image / timeout in plugin config UI + browser_health_check ([#120](https://github.com/tianshu-ai/tianshu/issues/120)) ([d06326e](https://github.com/tianshu-ai/tianshu/commit/d06326e02314556ec523ac66ea75f1f1b64c5899))
* **microsandbox:** inject $USER / $HOME / $MSB_USER_ID into exec context ([#137](https://github.com/tianshu-ai/tianshu/issues/137)) ([e93cb1b](https://github.com/tianshu-ai/tianshu/commit/e93cb1bc1e82d4a0f3ea7167f3a06b7c7575980a))
* **microsandbox:** live browser stack — port forward + auto supervisord + Playwright MCP wired (ADR-0004 N+5.3) ([#70](https://github.com/tianshu-ai/tianshu/issues/70)) ([fb671c2](https://github.com/tianshu-ai/tianshu/commit/fb671c247e36966e79103c973e9f4ba5ff6bf8ef))
* **microsandbox:** make minimal.yaml a real task-runner template ([#151](https://github.com/tianshu-ai/tianshu/issues/151)) ([79e92f0](https://github.com/tianshu-ai/tianshu/commit/79e92f04b47f613221cecd66a9a41f482f99c4f7))
* **microsandbox:** pool monitor section + Configure dialog ([#143](https://github.com/tianshu-ai/tianshu/issues/143)) ([6a38c3d](https://github.com/tianshu-ai/tianshu/commit/6a38c3d8eb434b04c29d8ca696d908d4d824c531))
* **microsandbox:** Sandboxfile templates + Browser template (CloakBrowser + Playwright MCP + noVNC) (ADR-0004 N+5.2) ([#69](https://github.com/tianshu-ai/tianshu/issues/69)) ([00ed8f1](https://github.com/tianshu-ai/tianshu/commit/00ed8f1432c06e9d58dfd5721422f451f55fcd6f))
* **microsandbox:** split snapshot pointer into Browser + Task roles ([#140](https://github.com/tianshu-ai/tianshu/issues/140)) ([79581a5](https://github.com/tianshu-ai/tianshu/commit/79581a59203fc0fbe40295a91dc573a8ffbb6d9b))
* **n5-4:** direct MCP mount via SDK, dynamic browser viewport, MCP servers admin ([#76](https://github.com/tianshu-ai/tianshu/issues/76)) ([6eb310f](https://github.com/tianshu-ai/tianshu/commit/6eb310ff51718ae4c6a86750577830bdcc18de93))
* per-prompt tool-delta detector for cross-upgrade sessions ([253f580](https://github.com/tianshu-ai/tianshu/commit/253f5800780ae0029cc26c2f587a91ae1efbe164))
* **plugin-files:** fuzzy replacers + replace_all in edit_file (ADR-0006 PR-B groundwork) ([#130](https://github.com/tianshu-ai/tianshu/issues/130)) ([9c5796a](https://github.com/tianshu-ai/tianshu/commit/9c5796aa1315eb7fd0ce8759933ff1dc8be88add))
* **plugins/files:** scope to per-user home + tighten top-bar icons ([#40](https://github.com/tianshu-ai/tianshu/issues/40)) ([e8be301](https://github.com/tianshu-ai/tianshu/commit/e8be30150c785a534438d24686ae2d6b7e09f317))
* **plugins/files:** styled panel matching the closed-source repo ([#38](https://github.com/tianshu-ai/tianshu/issues/38)) ([22c1b01](https://github.com/tianshu-ai/tianshu/commit/22c1b017c6ed42d3a9deb9c377eabcb42b8c9544))
* **plugins:** capability registry, requires/provides, sandbox surface (ADR-0004 N+1) ([#59](https://github.com/tianshu-ai/tianshu/issues/59)) ([ba751c7](https://github.com/tianshu-ai/tianshu/commit/ba751c7b9b6fa97fd4d946a0d65e38476107810a))
* **plugins:** catalog client + Plugin Manager Catalog tab (P1) ([#34](https://github.com/tianshu-ai/tianshu/issues/34)) ([4376d67](https://github.com/tianshu-ai/tianshu/commit/4376d672becc941f86779ee895e54c99054e5e18))
* **plugins:** composer file uploads + composerActions SDK contribution ([#48](https://github.com/tianshu-ai/tianshu/issues/48)) ([#49](https://github.com/tianshu-ai/tianshu/issues/49)) ([0bea614](https://github.com/tianshu-ai/tianshu/commit/0bea61476f5e74e393f68f6460d29b8b4aeb0a00))
* **plugins:** contributes.tools[] \u2014 plugins own their agent tools (ADR-0004 N+3) ([#61](https://github.com/tianshu-ai/tianshu/issues/61)) ([db56329](https://github.com/tianshu-ai/tianshu/commit/db56329bc7d6044f2674bb4a3b254e02af7f3111))
* **plugins:** files plugin (workspace browser, server side) ([#35](https://github.com/tianshu-ai/tianshu/issues/35)) ([b2ec9a3](https://github.com/tianshu-ai/tianshu/commit/b2ec9a312c4805aeb546e750d0dacb76e72ed6bb))
* **plugins:** OpenShell shell-sandbox + setup agent prerequisites + project-scoped task results ([97b4eed](https://github.com/tianshu-ai/tianshu/commit/97b4eed2a840229e29be2d24c0a933016ed32b0e))
* **plugins:** plugin runtime + Plugin Manager UI (PR [#31](https://github.com/tianshu-ai/tianshu/issues/31)) ([#32](https://github.com/tianshu-ai/tianshu/issues/32)) ([9405d57](https://github.com/tianshu-ai/tianshu/commit/9405d57ad9e1785c95856c048bbb3320edb67da0))
* **prompt:** add tool-guidelines block to defaultSystemPrompt (OpenClaw-style) ([#124](https://github.com/tianshu-ai/tianshu/issues/124)) ([ea227ea](https://github.com/tianshu-ai/tianshu/commit/ea227ea340940b93f96e63acaac6783ab57ac7a5))
* **prompt:** inject runtime context (time / timezone / host) for every agent ([fc8f994](https://github.com/tianshu-ai/tianshu/commit/fc8f99495c81cfb098052c86faa04b5a6fa4d24d))
* **server,setup:** serve mode — production startup without dev toolchain ([a87340d](https://github.com/tianshu-ai/tianshu/commit/a87340d833c4b4f8351b374afa84096c1d2e71b8))
* **server:** agent fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)a) ([#42](https://github.com/tianshu-ai/tianshu/issues/42)) ([791819a](https://github.com/tianshu-ai/tianshu/commit/791819ac2ea51883b4263fcee559689a400ec141))
* **server:** inject Execution Bias + AGENTS.md / SOUL.md / USER.md into system prompt ([#148](https://github.com/tianshu-ai/tianshu/issues/148)) ([ee1c97c](https://github.com/tianshu-ai/tianshu/commit/ee1c97c7c287f9ce04c4ff1d61b624a1b6fdf4c4))
* **server:** inject plugin systemPromptFragments into worker prompt (ADR-0007 PR-B) ([#129](https://github.com/tianshu-ai/tianshu/issues/129)) ([aa2e055](https://github.com/tianshu-ai/tianshu/commit/aa2e05535bbae7f3eee9b4ab5bc755ba2e7a0080))
* **server:** optional system-prompt dump for debugging ([#131](https://github.com/tianshu-ai/tianshu/issues/131)) ([76328db](https://github.com/tianshu-ai/tianshu/commit/76328db337dd5436b11abf9b683601b5277beb26))
* **server:** publish effectivePublicUrl on boot ([e15e917](https://github.com/tianshu-ai/tianshu/commit/e15e91716e733a10d77590ca00beebb98883bea5))
* **setup:** cli-agent shows every action, confirms before mutating, no silent auto-fix ([#167](https://github.com/tianshu-ai/tianshu/issues/167)) ([bee4106](https://github.com/tianshu-ai/tianshu/commit/bee4106333d79c92ebe7e1d2b324b93c355b9d92))
* **setup:** in-CLI agent handoff after wizard for conversational setup ([#165](https://github.com/tianshu-ai/tianshu/issues/165)) ([07e1012](https://github.com/tianshu-ai/tianshu/commit/07e1012e10abb1140ca87d687850aa0aa6640392))
* **setup:** wizard probes default model first; smart-skip when working ([#164](https://github.com/tianshu-ai/tianshu/issues/164)) ([c6f9f7f](https://github.com/tianshu-ai/tianshu/commit/c6f9f7fa5e4f2d94f3a4e90bda0be343272f1a89))
* **setup:** wizard supports custom baseUrl + custom model id ([#163](https://github.com/tianshu-ai/tianshu/issues/163)) ([4d21143](https://github.com/tianshu-ai/tianshu/commit/4d21143f037f60b27b7faf802e21a184f1b2db3e))
* **skills:** drop load_skill meta-tool; manage skills via filesystem ([#98](https://github.com/tianshu-ai/tianshu/issues/98)) ([b352c74](https://github.com/tianshu-ai/tianshu/commit/b352c749b0bc8f19d753e478ed70b0f6acbd16fc))
* **skills:** mirror host & plugin SKILL.md into tenant config so one tool reads them all ([#104](https://github.com/tianshu-ai/tianshu/issues/104)) ([bc5c890](https://github.com/tianshu-ai/tianshu/commit/bc5c8900dbf4c07577cdab6d742c344917425832))
* **skills:** on-demand prompt fragments via plugin-contributed skills (ADR-0004 N+4) ([#63](https://github.com/tianshu-ai/tianshu/issues/63)) ([ec6cf6f](https://github.com/tianshu-ai/tianshu/commit/ec6cf6ffdb0258625b484fe1c7c53834756a15ea))
* **skills:** tenant-scoped skill discovery + main agent skill-creator ([#97](https://github.com/tianshu-ai/tianshu/issues/97)) ([98e0480](https://github.com/tianshu-ai/tianshu/commit/98e0480bfed24f05642c951eb543e9f542ad4ff8))
* **tenant:** infrastructure layer (PR [#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([4b6e7ae](https://github.com/tianshu-ai/tianshu/commit/4b6e7ae62da101c7998cf8e7dfe9b8b58cc969a3))
* tool_catalog_refresh — force-replay the tool catalog into chat ([73d8c5d](https://github.com/tianshu-ai/tianshu/commit/73d8c5d0f95e73669f0405bd11e3516f3535a982))
* **ui-a:** host-shared Modal + MarkdownBlock + DocumentViewer primitives ([a345380](https://github.com/tianshu-ai/tianshu/commit/a345380932dfadff4da3cf84e3c4b49efeed0f04))
* **ui-b:** migrate every dialog + markdown surface to UiPrimitives ([6568215](https://github.com/tianshu-ai/tianshu/commit/6568215340ce5f3c6a7af36a9cecb1dcc3b0729a))
* **ui:** CSV/TSV table preview + SVG Render/Source toggle ([1325ff4](https://github.com/tianshu-ai/tianshu/commit/1325ff4eb806a9aa8718f0284774c1ff6f628055))
* **ui:** HTML render+source preview and syntax-highlighted code ([24c2d7c](https://github.com/tianshu-ai/tianshu/commit/24c2d7cbd39ef8f874b40ea881adc551ea0d0565))
* **ui:** light / dark theme switch with semantic CSS variable tokens ([2d31543](https://github.com/tianshu-ai/tianshu/commit/2d315438c87f4440a6092dc236da13b58b95a71a))
* **ui:** Modal headerActions slot + download button in file previews ([9feb899](https://github.com/tianshu-ai/tianshu/commit/9feb8990f9b5508b8554ae7af4f76be4861f713c))
* **ui:** Modal maximize button + double-click toggle ([e5ba744](https://github.com/tianshu-ai/tianshu/commit/e5ba744d2d8423b998e17ca2a9c605be0c046c2d))
* **ui:** model selector pill in composer (PR [#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([5a835ff](https://github.com/tianshu-ai/tianshu/commit/5a835ff99b0b74c135e7c02cdebe895079d1b53c))
* **ui:** Office file placeholder + STREAMED_EXTS includes office ([f9e0acd](https://github.com/tianshu-ai/tianshu/commit/f9e0acd1b9a19ce0c1f4c3dfaf59ec2420f4c658))
* **ui:** PDF / video / audio / image preview through DocumentViewer ([b53912d](https://github.com/tianshu-ai/tianshu/commit/b53912d4847d5d94ff4bac1e24c1853d396ac7ca))
* **ui:** refine chat layout to match closed-source repo (PR [#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([#27](https://github.com/tianshu-ai/tianshu/issues/27)) ([090c6eb](https://github.com/tianshu-ai/tianshu/commit/090c6eb47e6b02c6d0c0c6dcaabb4debe06c47f0))
* **ui:** tianshu-style chat UI (PR [#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([#26](https://github.com/tianshu-ai/tianshu/issues/26)) ([086fce7](https://github.com/tianshu-ai/tianshu/commit/086fce7fe55d29131ccce9cf7da48750aa2c74ef))
* **web-search:** plugin with Tavily / Brave + secret config + provider health cache ([#114](https://github.com/tianshu-ai/tianshu/issues/114)) ([fc636f2](https://github.com/tianshu-ai/tianshu/commit/fc636f285cdeef8590246f4ca3acbd9b6513d6db))
* **web/admin:** render PluginConfigForm banner on every plugin admin page ([#246](https://github.com/tianshu-ai/tianshu/issues/246)) ([ddc9a96](https://github.com/tianshu-ai/tianshu/commit/ddc9a9662d61461ea73c0b858e24e3314667f14f))
* **web:** collapsible tool-call rows (closed-source UI parity) ([#45](https://github.com/tianshu-ai/tianshu/issues/45)) ([78c1fb7](https://github.com/tianshu-ai/tianshu/commit/78c1fb7a2c87b7377827d2fa308b6c0db2bf35c1))
* **web:** manifest-driven top bar + right panel (PR [#33](https://github.com/tianshu-ai/tianshu/issues/33)) ([#36](https://github.com/tianshu-ai/tianshu/issues/36)) ([ba488fb](https://github.com/tianshu-ai/tianshu/commit/ba488fbff6a4c68e88f131d8d7fa34a2b59556aa))
* **web:** right-panel tab bar + resize handle (closed-source parity) ([#41](https://github.com/tianshu-ai/tianshu/issues/41)) ([25f1c98](https://github.com/tianshu-ai/tianshu/commit/25f1c984a25865911b65d8ab2c66331bac089f7a))
* **workboard,server,web:** execution dialog + session inbox + history pagination + concurrency fixes ([#94](https://github.com/tianshu-ai/tianshu/issues/94)) ([d79e665](https://github.com/tianshu-ai/tianshu/commit/d79e665eb97f10bc49b3f361090c74fa6bab4f40))
* **workboard:** add worker_analytics tool for orchestrator-side insights ([0929f51](https://github.com/tianshu-ai/tianshu/commit/0929f514728778c81cd5d72b497e454a82353467))
* **workboard:** batch task_create + task_delete ([#93](https://github.com/tianshu-ai/tianshu/issues/93)) ([759226e](https://github.com/tianshu-ai/tianshu/commit/759226e128d183c2292cad4f7cef90fb3380aa52))
* **workboard:** Configure modal + allow one worker to run multiple tasks in parallel ([#250](https://github.com/tianshu-ai/tianshu/issues/250)) ([6ea0f01](https://github.com/tianshu-ai/tianshu/commit/6ea0f011b74849e50d8645fc72afec08a66488af))
* **workboard:** drop worker_agents table; UI read-only; REST mutation routes removed (PR-C) ([#101](https://github.com/tianshu-ai/tianshu/issues/101)) ([cba6701](https://github.com/tianshu-ai/tianshu/commit/cba67011824ced8e34e885250f231cc8d9866b5c))
* **workboard:** enable/disable worker agent from the admin UI ([#146](https://github.com/tianshu-ai/tianshu/issues/146)) ([d057696](https://github.com/tianshu-ai/tianshu/commit/d0576966fb9155d187745f7a6460db8c6bb0ed23))
* **workboard:** fs-only worker config + intervention model + skill / context plumbing ([#102](https://github.com/tianshu-ai/tianshu/issues/102)) ([f4e571e](https://github.com/tianshu-ai/tianshu/commit/f4e571e7546981b0cae0dabc2d32b44c9bdbd2be))
* **workboard:** host.modelCatalog capability + model_list tool for the main agent ([#107](https://github.com/tianshu-ai/tianshu/issues/107)) ([fb2d9ef](https://github.com/tianshu-ai/tianshu/commit/fb2d9ef98167ba68630476cdec3095ad664dd140))
* **workboard:** hot-reload pool when worker bundles change on disk ([#103](https://github.com/tianshu-ai/tianshu/issues/103)) ([2008527](https://github.com/tianshu-ai/tianshu/commit/2008527ccc542a9c19c1cb2c39edda2fc72248a2))
* **workboard:** kanban + worker pool plugin (ADR-0002 §6) ([#78](https://github.com/tianshu-ai/tianshu/issues/78)) ([0fac44a](https://github.com/tianshu-ai/tianshu/commit/0fac44af8afdf8f4d11620405c12d8ce4b34a041))
* **workboard:** LLM worker kind via host.agentLoop capability (N+6.3) ([#80](https://github.com/tianshu-ai/tianshu/issues/80)) ([cd53fac](https://github.com/tianshu-ai/tianshu/commit/cd53fac940ab7241ed2a9b03a5f5985352b21514))
* **workboard:** main agent can list available LLM models via  ([#106](https://github.com/tianshu-ai/tianshu/issues/106)) ([3e7a008](https://github.com/tianshu-ai/tianshu/commit/3e7a00811a21e3c1f43d9e25af277a3c1f1f86df))
* **workboard:** nudge main agent toward plan/design/build/verify decomposition ([#150](https://github.com/tianshu-ai/tianshu/issues/150)) ([a0a9a05](https://github.com/tianshu-ai/tianshu/commit/a0a9a05bd6a1604e1b2f8c6232af5744c29ba771))
* **workboard:** one-shot DB-&gt;fs migration; widen tenant_config_write boundary; retire worker_agent_* tools (PR-B) ([#100](https://github.com/tianshu-ai/tianshu/issues/100)) ([0ff0249](https://github.com/tianshu-ai/tianshu/commit/0ff0249b9a3310ee6c8e7eed192c6263e94f06fa))
* **workboard:** orchestrator tools for managing worker agents ([#96](https://github.com/tianshu-ai/tianshu/issues/96)) ([5f2d314](https://github.com/tianshu-ai/tianshu/commit/5f2d314e00e9c1272c372773c49a2720fb2a46b9))
* **workboard:** per-user concurrency cap, layered on top of the tenant cap ([#245](https://github.com/tianshu-ai/tianshu/issues/245)) ([f4afab5](https://github.com/tianshu-ai/tianshu/commit/f4afab578ec50e619eba2dee47c833ab6fb2300f))
* **workboard:** plugin-contributed agent seeds, fs-backed worker layout (PR-A) ([#99](https://github.com/tianshu-ai/tianshu/issues/99)) ([65b3b11](https://github.com/tianshu-ai/tianshu/commit/65b3b111b662e5015a550f3cfb528ef389e5cab6))
* **workboard:** retry/publish buttons on label chips ([#91](https://github.com/tianshu-ai/tianshu/issues/91)) ([6a0531e](https://github.com/tianshu-ai/tianshu/commit/6a0531ef586883e10b844e7edd51cd8f563f6d7b))
* **workboard:** show per-task sandbox name in task detail dialog ([#142](https://github.com/tianshu-ai/tianshu/issues/142)) ([4441cc4](https://github.com/tianshu-ai/tianshu/commit/4441cc49922270fb7a4cc8a6a938b2a49326777d))
* **workboard:** task execution history (REST + agent tool) ([#92](https://github.com/tianshu-ai/tianshu/issues/92)) ([3949e14](https://github.com/tianshu-ai/tianshu/commit/3949e14a038164a29096c6b711d9c5e8193fdeca))
* **workboard:** tenant-wide concurrency cap on worker runs ([#244](https://github.com/tianshu-ai/tianshu/issues/244)) ([10e0d4c](https://github.com/tianshu-ai/tianshu/commit/10e0d4cb3165cec89ee4238d839f56de1d3995c0))
* **workboard:** tool/skill catalog capabilities + worker agent ChipPicker ([#95](https://github.com/tianshu-ai/tianshu/issues/95)) ([aa1126a](https://github.com/tianshu-ai/tianshu/commit/aa1126aed6115786f2facafb0826846624e238cd))
* **worker-agents:** host table + REST + plugin seed + admin UI (ADR-0002 §7.1, N+6.2) ([#79](https://github.com/tianshu-ai/tianshu/issues/79)) ([a8b7378](https://github.com/tianshu-ai/tianshu/commit/a8b7378a80e4609f73eeef4f6e1ed1759ceb6255))


### Bug Fixes

* Fix:  ([c99a827](https://github.com/tianshu-ai/tianshu/commit/c99a827a259b1ce4b8a7db505292c429c1629d02))
* **adapter:** detect stream-truncated tool calls and surface a useful error ([#105](https://github.com/tianshu-ai/tianshu/issues/105)) ([2e95618](https://github.com/tianshu-ai/tianshu/commit/2e95618d78a4a536b2ab108095605e185baac6ec))
* **channels:** channel bindings are per-user, not per-tenant ([af115f1](https://github.com/tianshu-ai/tianshu/commit/af115f1606e57946304f934fae097dd815933327))
* **channels:** forward every assistant message, not just the last ([b28dc9c](https://github.com/tianshu-ai/tianshu/commit/b28dc9ca71664fefdeaeac0b1a6deadfac43b20f))
* **channels:** friendly agent-error message in channel replies ([b84d4f0](https://github.com/tianshu-ai/tianshu/commit/b84d4f0ccf93fc2cabb3671ef31a0f643f960a3a))
* **channels:** live message_added push for viewed channel sessions ([7c1ed15](https://github.com/tianshu-ai/tianshu/commit/7c1ed1515dd9f3ab2a09fb83c91deae1ca5891c6))
* **channels:** manifest parser drops contributes.channels[] ([a97f61f](https://github.com/tianshu-ai/tianshu/commit/a97f61f90b37e73e1a9045d1446b3551d567cb3b))
* **channels:** one binding per (tenant, user, channel) ([0840592](https://github.com/tianshu-ai/tianshu/commit/084059238383272ad0c1e1137656409f30b5491f))
* **channels:** queue from message_added events, not just stream_end ([d8b5e60](https://github.com/tianshu-ai/tianshu/commit/d8b5e605d7df1cd42a579db9998c99aa5547961b))
* **channels:** route idle-runner replies back through the channel adapter ([b365396](https://github.com/tianshu-ai/tianshu/commit/b365396a857bf2b0196d5d2653eaebc1feafee76))
* **channels:** wire tenantHomeDir from ctx.workspaceDir so tenant_config_* tools see the right tree ([67fc018](https://github.com/tianshu-ai/tianshu/commit/67fc018c029448a835061ca2020956b9132bbaa4))
* **chat:** assistant messages with mixed text + tool calls render in author order ([#65](https://github.com/tianshu-ai/tianshu/issues/65)) ([ccedf35](https://github.com/tianshu-ai/tianshu/commit/ccedf3554072f8be8c912b596b764adabb7d81c5))
* **chat:** keep webchat history separate from channel sessions ([ef53dc3](https://github.com/tianshu-ai/tianshu/commit/ef53dc3f464df873171de568af6cda1d9048d3a8))
* **chat:** mark inbox rows delivered when message text is JSON-escaped ([#237](https://github.com/tianshu-ai/tianshu/issues/237)) ([70dc045](https://github.com/tianshu-ai/tianshu/commit/70dc04523230ec262a55d0ce6a8eecf1756c0615))
* **chat:** session storage chain + bridge pi tool_execution events (N+6.4 follow-up) ([#83](https://github.com/tianshu-ai/tianshu/issues/83)) ([0446273](https://github.com/tianshu-ai/tianshu/commit/04462730378ccf0037b121ed8361f918c2838740))
* **env:** write/read .env at TIANSHU_HOME on global installs ([6bd4f69](https://github.com/tianshu-ai/tianshu/commit/6bd4f69f50502ee731fab46b5a89adb0431fb8e7))
* **files:** make `edits` required in edit_file / tenant_config_edit schema ([#123](https://github.com/tianshu-ai/tianshu/issues/123)) ([daf2875](https://github.com/tianshu-ai/tianshu/commit/daf287514e0d040e003dbcb8d9600116a73a4c63))
* **microsandbox:** adapt to SDK rename of stopAndWait/removePersisted ([#132](https://github.com/tianshu-ai/tianshu/issues/132)) ([026d290](https://github.com/tianshu-ai/tianshu/commit/026d2909022a64329912cd07f9fced3d7feef526))
* **microsandbox:** destroyTask reclaims orphan VMs not in the pool map ([#144](https://github.com/tianshu-ai/tianshu/issues/144)) ([476f462](https://github.com/tianshu-ai/tianshu/commit/476f46287368fe24a667aa455318e6623586358f))
* **microsandbox:** guard exec against host-guest channel hangs ([#153](https://github.com/tianshu-ai/tianshu/issues/153)) ([80d5f54](https://github.com/tianshu-ai/tianshu/commit/80d5f54e05b3302acb2cffd826008611ce66697d))
* **microsandbox:** make execTimeoutMs actually fire (use shellStream + kill) ([#121](https://github.com/tianshu-ai/tianshu/issues/121)) ([ec41a55](https://github.com/tianshu-ai/tianshu/commit/ec41a559a49140d9132a39bd5cccc73a98a42836))
* **microsandbox:** tighten server-startup + verify-task prompts ([#152](https://github.com/tianshu-ai/tianshu/issues/152)) ([c4491a3](https://github.com/tianshu-ai/tianshu/commit/c4491a3118c441655c82510d4ad425852bbe4143))
* **openshell:** ctx.taskId wins over agent-supplied task arg ([#241](https://github.com/tianshu-ai/tianshu/issues/241)) ([74a62cc](https://github.com/tianshu-ai/tianshu/commit/74a62ccc20a6917a68333a1ca6effe310e2b0057))
* **openshell:** drop projects/&lt;project&gt;/ doubling from sync_down host path ([#238](https://github.com/tianshu-ai/tianshu/issues/238)) ([4eef383](https://github.com/tianshu-ai/tianshu/commit/4eef3830687160b68bc6ca1dd7161bdc7d3ae19b))
* **openshell:** remove agent-controllable 'task' arg from sync_down schema ([#242](https://github.com/tianshu-ai/tianshu/issues/242)) ([057aed3](https://github.com/tianshu-ai/tianshu/commit/057aed305b3d029ecee2ec75efb48b126fa85d2a))
* **openshell:** strip redundant projects/&lt;p&gt;/ + users/&lt;u&gt;/ from agent path inputs ([#240](https://github.com/tianshu-ai/tianshu/issues/240)) ([8abbb6d](https://github.com/tianshu-ai/tianshu/commit/8abbb6ddbfc482548fdaf5091decc178f0cf3576))
* **openshell:** task folder name uses slugified taskTitle, not taskId-prefix ([#243](https://github.com/tianshu-ai/tianshu/issues/243)) ([f49559d](https://github.com/tianshu-ai/tianshu/commit/f49559d2fd924b49d1b43461e4e64b920754f6bd))
* pipe agent-loop abort signal into tools so task_abort actually frees workers ([#154](https://github.com/tianshu-ai/tianshu/issues/154)) ([653f542](https://github.com/tianshu-ai/tianshu/commit/653f5428c0d7599de06e4a14f47aa956209483d2))
* **plugin-sdk:** re-resolve MCP endpoint on every callRemote ([#155](https://github.com/tianshu-ai/tianshu/issues/155)) ([827a888](https://github.com/tianshu-ai/tianshu/commit/827a888ad3fa8cddebde5d4a93dcd949bb572e01))
* **plugins:** mount contributed routes under /api/p/&lt;id&gt;/... ([#37](https://github.com/tianshu-ai/tianshu/issues/37)) ([3484ace](https://github.com/tianshu-ai/tianshu/commit/3484aceb51bc19d6900c91770e46dc9d91c3194f))
* **publish:** include plugins/**/templates/** in the npm tarball ([3bd8ff5](https://github.com/tianshu-ai/tianshu/commit/3bd8ff53275d1ddeeff5a72a937a86e3dd9db119))
* **publish:** rename plugin-sdk to scope + bundleDependencies for npm install ([#172](https://github.com/tianshu-ai/tianshu/issues/172)) ([b01a2cf](https://github.com/tianshu-ai/tianshu/commit/b01a2cfaa931b26df392809ca930da05c8f2d56c))
* **publish:** revert plugin-sdk to dependencies (peerDependencies + bundle broke npm install -g) ([741368d](https://github.com/tianshu-ai/tianshu/commit/741368d2e8bd4e6fa369c0a4e7f41dbf3c8c1e7c))
* **server:** read /api/health version from package.json ([50b24fb](https://github.com/tianshu-ai/tianshu/commit/50b24fb9553c2654f0232082b4f1e932f5f859dd))
* **server:** refresh stale dynamic toolsets at worker run start ([#156](https://github.com/tianshu-ai/tianshu/issues/156)) ([1c0ae85](https://github.com/tianshu-ai/tianshu/commit/1c0ae85fc39c489c00ae4b0000aa718b04141530))
* **server:** substitute &lt;self&gt;/&lt;userId&gt; placeholders with caller's actual userId in system prompts ([#157](https://github.com/tianshu-ai/tianshu/issues/157)) ([3550d2a](https://github.com/tianshu-ai/tianshu/commit/3550d2ad6c88d76b9da9231888c2e3274c786ee3))
* **server:** unify USER.md prompt so empty templates trigger onboarding ([#149](https://github.com/tianshu-ai/tianshu/issues/149)) ([c595e08](https://github.com/tianshu-ai/tianshu/commit/c595e08309fe96338d649cc69c20e8d0025b6cb5))
* **serve:** serve index.html via buffer, not res.sendFile ([c296867](https://github.com/tianshu-ai/tianshu/commit/c29686748f51cf7c86d272355dd23fe22240de5d))
* **serve:** use bin/serve.mjs entrypoint (not shell-var script) ([b2bd315](https://github.com/tianshu-ai/tianshu/commit/b2bd315c6a9f7dada2fd63a4c0042e85fc4314da))
* **setup:** force-reload .env after wizard writes; clear pass/fail signal on model ping ([#166](https://github.com/tianshu-ai/tianshu/issues/166)) ([1130ce6](https://github.com/tianshu-ai/tianshu/commit/1130ce695713ba423542f9fb956cfa2d76278694))
* **setup:** skip web-port prompt in production mode ([59ab697](https://github.com/tianshu-ai/tianshu/commit/59ab697d1ca4e26ce0f1259bd1d2e1ce2a3cffc0))
* **ui:** channel session footer layout is now stacked + compact ([b946e92](https://github.com/tianshu-ai/tianshu/commit/b946e925a12fd26c032f215fe38e2d1166eec2e2))
* **ui:** channel session selected-row visible on light theme ([960df8b](https://github.com/tianshu-ai/tianshu/commit/960df8bc0853a1109fc7db27ccf675d254059e43))
* **ui:** de-dupe ws handlers + message renders (StrictMode) ([#28](https://github.com/tianshu-ai/tianshu/issues/28)) ([0b8b5bc](https://github.com/tianshu-ai/tianshu/commit/0b8b5bcb3c163cfa277fa23ae32243bd8280de4d))
* **ui:** drop prose-invert on light theme ([92dccee](https://github.com/tianshu-ai/tianshu/commit/92dccee4aa7364273beab70b5c4acb415c286b4e))
* **ui:** FileOpenDialog renders markdown through DocumentViewer ([3126b30](https://github.com/tianshu-ai/tianshu/commit/3126b30edabe0182f70899703ab6c214c3c5917e))
* **ui:** HTML preview height + CodeBlock line-number drift ([02f5185](https://github.com/tianshu-ai/tianshu/commit/02f51850789e0a547916022e19e2ac73f7dbc92a))
* **ui:** inline code chip on light theme ([803860a](https://github.com/tianshu-ai/tianshu/commit/803860a6937214b9fb3f570d7c4e7f44a2c124b6))
* **ui:** light theme — invert canvas/surface hierarchy ([be9d4d9](https://github.com/tianshu-ai/tianshu/commit/be9d4d9bc069717ec0d6e9a0c38c9d37fef51ab8))
* **ui:** light theme coverage + visual contrast rework ([c6c28fc](https://github.com/tianshu-ai/tianshu/commit/c6c28fca361b5f4a7c9d7a3ab4aba92107ac4897))
* **ui:** Modal panel height collapses to content height for previews ([b6cff84](https://github.com/tianshu-ai/tianshu/commit/b6cff848e014516076c8e377a3ba550feece5423))
* **ui:** preview height collapses to a sliver for PDF / HTML / images ([d975ebb](https://github.com/tianshu-ai/tianshu/commit/d975ebb998c364554812bb99d2ffdc9edbaaa3af))
* **ui:** really strip backtick pseudo-elements from prose code ([9231a80](https://github.com/tianshu-ai/tianshu/commit/9231a8069ee381af967e73eec7d081eda2176ca9))
* **ui:** remove Modal's built-in scroll container to fix double scrollbars ([c41927f](https://github.com/tianshu-ai/tianshu/commit/c41927f999b9c21dae0b22be91d9e02bdff7ef2a))
* **ui:** soften light theme overlay (0.5 -&gt; 0.4) ([805d581](https://github.com/tianshu-ai/tianshu/commit/805d581870b23531d1eaad59ecd6fb2367afdd9d))
* **ui:** switch Modal body to flex column + callers use flex-1 min-h-0 ([7525e12](https://github.com/tianshu-ai/tianshu/commit/7525e12e48b2268f8f854b6f77dd2e175a427a5f))
* **ui:** tool-call name + status colors use semantic tokens ([7a74e5f](https://github.com/tianshu-ai/tianshu/commit/7a74e5f011f297a3dbe27f59de15c8ef6a22dd7c))
* **ui:** white text on light surfaces ([d431034](https://github.com/tianshu-ai/tianshu/commit/d4310347df744b50aac3a8b02982da3e0a9a1c59))
* **ui:** workboard task result summary visible on light theme ([e289c1d](https://github.com/tianshu-ai/tianshu/commit/e289c1de4afeef563bbc6b4117efb477779948c1))
* **wechat:** admin UI reflects 'one binding per user' ([99f0adf](https://github.com/tianshu-ai/tianshu/commit/99f0adf2e52ae6376808ca29a3f0dfabe199f7c9))
* **wechat:** Authorization Bearer + channel_version as semver string ([13656d4](https://github.com/tianshu-ai/tianshu/commit/13656d41e9997cdd6e58cc0609d2a7b7d169b743))
* **wechat:** correct iLink QR-status polling (GET + status enum) ([c99a827](https://github.com/tianshu-ai/tianshu/commit/c99a827a259b1ce4b8a7db505292c429c1629d02))
* **wechat:** normaliseInbound matches the real iLink wire shape ([c050c00](https://github.com/tianshu-ai/tianshu/commit/c050c00ea92313da83aa53aa262fec139a2f8dde))
* **wechat:** outbound sendmessage uses real iLink wire shape (msg wrapper + item_list) ([9658a31](https://github.com/tianshu-ai/tianshu/commit/9658a31a857bdcf6cff184fcc2b7e7432715f615))
* **wechat:** render QR via canvas instead of &lt;img src=URL&gt; ([ef38be7](https://github.com/tianshu-ai/tianshu/commit/ef38be716e69252b2e8b9a3c471dd2262949f652))
* **wechat:** use base64(hex-string) encoding for aes_key on all media types ([8065d0a](https://github.com/tianshu-ai/tianshu/commit/8065d0abbd2675f7a1b88fe375789492700ee7e3))
* **wechat:** use OpenClaw's iLink auth headers + correct base_info ([5481fd5](https://github.com/tianshu-ai/tianshu/commit/5481fd5f9d8c66bc9516c8c06da4b132aad25223))
* **workboard:** cancel live worker on task delete / status move ([6714758](https://github.com/tianshu-ai/tianshu/commit/6714758fe78c9f807a66e7174e90873c74bef2bb))
* **workboard:** nudge on done patches + fallback polling timer ([#89](https://github.com/tianshu-ai/tianshu/issues/89)) ([b959cd2](https://github.com/tianshu-ai/tianshu/commit/b959cd23efb24c2d16e7f229063ae14939d99143))
* **workboard:** show awaiting-intervention chip on board cards ([#118](https://github.com/tianshu-ai/tianshu/issues/118)) ([2220f76](https://github.com/tianshu-ai/tianshu/commit/2220f7631a42e9a2fbc7c03e58ab6b344929ed9b))
* **workboard:** surface worker_analytics via manifest + add hygiene tests ([c44a9c8](https://github.com/tianshu-ai/tianshu/commit/c44a9c81135bbb73ad9df3056c1ec385fa888c03))
* **workboard:** task_move(status=ready) clears intervention labels (zombie task fix) ([#117](https://github.com/tianshu-ai/tianshu/issues/117)) ([a0d37b0](https://github.com/tianshu-ai/tianshu/commit/a0d37b0fa0089ff78fbf695c91b6a5a12ea998d1))
* **worker:** drop MAX_TURNS cap; deny task management tools in LLM workers ([#87](https://github.com/tianshu-ai/tianshu/issues/87)) ([4c00b41](https://github.com/tianshu-ai/tianshu/commit/4c00b418c2331b76dd039dd5fd732c4459ef5d0d))
* **write:** tool description guideline + repeat-truncation escalation ([#116](https://github.com/tianshu-ai/tianshu/issues/116)) ([91e60fe](https://github.com/tianshu-ai/tianshu/commit/91e60fe18591828b836e63d138b6506b8a072d44))
* WS chat respects user identity (close conversation isolation hole) ([#162](https://github.com/tianshu-ai/tianshu/issues/162)) ([c2f83b3](https://github.com/tianshu-ai/tianshu/commit/c2f83b31e9d6267de10e17a7054a0ed11f0e960e))


### Documentation

* ADR-0001 multi-tenant architecture ([#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([e5d1cc7](https://github.com/tianshu-ai/tianshu/commit/e5d1cc794783ccd045b6081d9c0c9145fa24f2d9))
* ADR-0002 orchestrator + workers, with config layering ([#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([6d5fff6](https://github.com/tianshu-ai/tianshu/commit/6d5fff6cac433e6134463b169103f20594cf7fd5))
* ADR-0003 plugin system (UI panels, sidebar sections, API routes) ([#30](https://github.com/tianshu-ai/tianshu/issues/30)) ([4386ccd](https://github.com/tianshu-ai/tianshu/commit/4386ccddcc8158b286559af894f0f532b1816724))
* ADR-0004 plugin capabilities & sandbox contract ([#58](https://github.com/tianshu-ai/tianshu/issues/58)) ([b6a84f4](https://github.com/tianshu-ai/tianshu/commit/b6a84f46e732ae483640d5efd3247db078192312))
* **architecture:** ADR-0007 — skill progressive disclosure ([#128](https://github.com/tianshu-ai/tianshu/issues/128)) ([56e114c](https://github.com/tianshu-ai/tianshu/commit/56e114c3c5c3319c444458c9e8aa4f54400c006e))
* clarify setup-agent hand-off + drop unmaintained hosted-demo link ([dee1596](https://github.com/tianshu-ai/tianshu/commit/dee159650e1c29e9506ecdb06a154b644eea5af8))
* **dev:** document the two upstream npm deprecation warnings (install-time only) ([d0ac38f](https://github.com/tianshu-ai/tianshu/commit/d0ac38f9d3010f3301ed779d792c9e20cd4d3183))
* **files,microsandbox:** clarify cross-tool path semantics ([#135](https://github.com/tianshu-ai/tianshu/issues/135)) ([802301b](https://github.com/tianshu-ai/tianshu/commit/802301beb80053d9e43e6b330b54399d6ff0bf5c))
* highlight the orchestrator's supervisor role + analytics ([0dac40f](https://github.com/tianshu-ai/tianshu/commit/0dac40f16e2f18f1c783fdcda2345b763e1ac96e))
* how to run tianshu as a background service (macOS launchd) ([#161](https://github.com/tianshu-ai/tianshu/issues/161)) ([e439c67](https://github.com/tianshu-ai/tianshu/commit/e439c678c7ac2de18f8b3bc3e50a07b3d1b5b615))
* **microsandbox:** teach the agent how to start servers without hanging exec ([#119](https://github.com/tianshu-ai/tianshu/issues/119)) ([c03a2f3](https://github.com/tianshu-ai/tianshu/commit/c03a2f3ddcfb5fb9c62620309d3d6bb8ada7b0b1))
* **microsandbox:** tell agents to use existing chromium + libreoffice instead of reinstalling ([#122](https://github.com/tianshu-ai/tianshu/issues/122)) ([16b3363](https://github.com/tianshu-ai/tianshu/commit/16b33634d366876695cd1aabdeb62e9f72e5aa03))
* README rewrite — guide users from install to first run ([de9ec3e](https://github.com/tianshu-ai/tianshu/commit/de9ec3e1df0060609335f4347dcaccdd84b9c2c0))
* **readme:** lead with `npm install -g`, demote dev-checkout flow ([85fe23b](https://github.com/tianshu-ai/tianshu/commit/85fe23b87bc2dac9b91e6bae6fe3f9d9ae5e557d))


### Refactor

* **channels:** channel session sidebar rows belong to plugins, not the host ([0f5c54e](https://github.com/tianshu-ai/tianshu/commit/0f5c54e24fc8c5e1783d4cf2b56978c50c6082f0))
* **chat:** extract system-prompt + compact-decision out of handler.ts ([969ba94](https://github.com/tianshu-ai/tianshu/commit/969ba94a7eb1fbad575a67861ba74fa3d84631fd))
* **chat:** storage owns image base64 + drop legacy helpers + migration 004 ([#84](https://github.com/tianshu-ai/tianshu/issues/84)) ([2a1fa58](https://github.com/tianshu-ai/tianshu/commit/2a1fa580b06b2288b2ff499fbd57613ceb429f69))
* **cli,setup:** use core/urls for port/URL resolution ([d0fc71e](https://github.com/tianshu-ai/tianshu/commit/d0fc71e2ce6478726cf5613d6d5d1c31717dffa1))
* **middleware:** pluggable IdentityResolver chain ([#160](https://github.com/tianshu-ai/tianshu/issues/160)) ([d7e9265](https://github.com/tianshu-ai/tianshu/commit/d7e9265016a6533ec72d421c85174cd2a7a569dc))
* **server:** split index.ts boot into focused modules; harden homeDir resolution ([66dd54e](https://github.com/tianshu-ai/tianshu/commit/66dd54e8f60e63b630d1710b02be4f98a202e5bb))
* **workboard:** rename todo→ready, retry-on-failure, drop aborted state ([#88](https://github.com/tianshu-ai/tianshu/issues/88)) ([67a8cbb](https://github.com/tianshu-ai/tianshu/commit/67a8cbb77cdf962b198bc5cf1f64518392972095))
* **workboard:** stalled is a label, not a status (3 columns total) ([#90](https://github.com/tianshu-ai/tianshu/issues/90)) ([0c80ae9](https://github.com/tianshu-ai/tianshu/commit/0c80ae97242added8d289b950c56d700f96e8c57))

## [0.3.47](https://github.com/tianshu-ai/tianshu/compare/v0.3.46...v0.3.47) (2026-06-27)

### Bug Fixes

* **channels:** every assistant turn from a multi-turn agent run
  is now forwarded to wechat, not just the last. The previous
  fix queued from stream_end (which fires once per runPrompt,
  not once per turn); now queues from each `message_added`
  event whose role is assistant.

## [0.3.36](https://github.com/tianshu-ai/tianshu/compare/v0.3.35...v0.3.36) (2026-06-26)

### Features

* **channels:** chat-platform channel system. Plugins can now
  contribute a `ChannelAdapter` through plugin-sdk's new
  `contributes.channels[]` + `exports.channels` surface. Host
  wires hub + router + adapter manager + bindings CRUD.
* **channels:** WeChat (微信) channel plugin via Tencent's iLink
  bot API. Two admin routes drive QR login; adapter does
  long-poll inbound with per-user context_token caching.
* **chat:** `runPrompt` accepts an optional `session` so non-WS
  callers (channel router) can drive the agent loop against a
  caller-supplied session row.

## [0.3.35](https://github.com/tianshu-ai/tianshu/compare/v0.3.34...v0.3.35) (2026-06-26)

### Bug Fixes

* **workboard:** task result summary italic block uses the
  text-success token so it reads on both themes.

## [0.3.34](https://github.com/tianshu-ai/tianshu/compare/v0.3.33...v0.3.34) (2026-06-26)

### Bug Fixes

* **ui:** light theme coverage + visual contrast rework. 0.3.33
  shipped the theme machinery and migrated host chrome, but
  several classes of regressions only became visible once Yu
  actually tested light:
  * Opacity-variant + hover-prefixed classes (`bg-gray-900/50`,
    `hover:bg-gray-800`, `placeholder-gray-500`) escaped the
    first migration pass — 292 additional sites mapped.
  * Original light palette had base=white, elevated=slate-50;
    sidebar / header / bubbles blended together. Inverted to
    base=slate-100 (canvas), elevated=white (sidebar/header/
    composer/bubbles). Eye now lands on content.
  * `prose-invert` was applied unconditionally; on light theme
    that meant white text on white background. Now toggled by
    resolved theme.
  * Inline code chips had no background of their own and
    inherited prose-invert's near-white. Added a token-driven
    chip (bg-bg-hover + fg-default + border-border-subtle).
    Stripped Tailwind Typography's backtick pseudo-elements.
  * 72 sites using `text-blue-300/400` / `text-emerald-*` /
    `text-amber-*` / `text-rose-*` for tool names and status
    cues moved to `text-link`, `text-success`, `text-warning`,
    `text-danger`. Each token resolves per theme.
  * Modal backdrop alpha 0.5 → 0.4 — dialogs no longer look
    like they're rendering behind tinted glass.
  * Sidebar header brand title, main agent row, AdminShell
    active tab, ModelSelector active row, ChatInput submit
    hover, files breadcrumb — 6 sites with hardcoded
    `text-white` on token-driven surfaces fixed. Buttons with
    their own colored bg (brand-600 etc) keep text-white
    correctly.

## [0.3.33](https://github.com/tianshu-ai/tianshu/compare/v0.3.32...v0.3.33) (2026-06-26)

### Features

* **ui:** light / dark theme switch with semantic CSS variable
  tokens. Three modes (light / dark / system; system follows
  the OS preference live). Picker lives in the sidebar footer
  profile popover. Two themes ship: dark (default, matches the
  legacy chrome exactly) and light (Default Light Modern-ish
  slate palette with a darker brand accent for AA contrast).
  Theme persisted to localStorage; bootstrap paint runs before
  React mounts so the first frame is already in the right
  colors.
* **plugins:** `useTheme()` hook in `@tianshu-ai/plugin-sdk`
  returns `{ mode, resolved, setMode }` and re-renders on
  flip. Semantic token utilities (`bg-bg-base`, `text-fg-default`,
  `border-border-default`, `bg-accent`, etc.) documented inline
  so plugin authors write theme-aware UI without learning the
  host's palette internals.
* **shiki:** CodeBlock follows the active theme by switching
  between `github-light` and `github-dark` highlight themes
  on flip.
* **migration:** 153 host + 326 plugin hardcoded color classes
  mapped to semantic tokens. Plugin admin pages and second-tier
  UI not yet migrated; they render fine in dark but won't flip
  yet (tracked as follow-up).

## [0.3.32](https://github.com/tianshu-ai/tianshu/compare/v0.3.31...v0.3.32) (2026-06-26)

### Features

* **ui:** Modal gains a maximize/restore toggle in the default
  header (left of the close button). When maximized, the panel
  fills the viewport (`h-screen w-screen rounded-none`),
  overriding the size preset; restoring goes back to the size
  default. Double-clicking the header background also toggles
  (clicks on headerActions / Close are ignored). State resets
  each time the modal closes — fresh opens always start at
  preset size. Default-on; callers can opt out via
  `allowMaximize={false}` for tiny confirmation modals.

## [0.3.31](https://github.com/tianshu-ai/tianshu/compare/v0.3.30...v0.3.31) (2026-06-26)

### Bug Fixes

* **ui:** Modal panel itself collapsed to ~400px tall for file
  previews (HTML / PDF / image). Earlier 0.3.29 / 0.3.30 fixes
  unblocked the inner iframe + outer wrapper but the panel
  itself was still `max-h-[85vh]` (a *cap*, not a height). With
  an iframe child that has minimal content at first paint, the
  flex column collapsed around it and the panel ended up only
  big enough for its header + a sliver of preview body. Fix:
  size-aware presets — `sm`/`md` keep `max-h-[85vh]` (forms,
  confirmations), `lg`/`xl` get `h-[85vh]` (file previews;
  fixed height regardless of inner content). File-preview
  callers already use lg/xl so the fix lands automatically.

## [0.3.30](https://github.com/tianshu-ai/tianshu/compare/v0.3.29...v0.3.30) (2026-06-26)

### Bug Fixes

* **ui:** PDF / HTML / image previews collapsed to a thin strip
  at the top of the modal because FilePreviewModal and
  FileOpenDialog wrapped DocumentViewer in `min-h-0 flex-1
  overflow-auto`. An `overflow-auto` parent does not propagate
  bounded height to a `h-full` iframe / img child — it becomes
  a scroll container, and the inner element falls back to
  content height (effectively zero for a remote PDF loading
  asynchronously). Outer body wrappers now use a plain
  `flex min-h-0 flex-1 flex-col` and each DocumentViewer branch
  owns its own overflow when it needs one.

## [0.3.29](https://github.com/tianshu-ai/tianshu/compare/v0.3.28...v0.3.29) (2026-06-26)

### Bug Fixes

* **ui:** three layout regressions in 0.3.28's file previews:
  * HTML preview height collapsed because the iframe sat inside
    an `overflow-auto` parent (an overflow container does not
    propagate height to a `h-full` child). Iframe now gets the
    full body directly.
  * CodeBlock first source line offset ~16px below the gutter's
    "1" because shiki's `<pre>` carries inline `padding: 1rem`
    on top of our wrapper's `p-3`. Added a CSS rule on
    `.shiki-host > pre` that resets shiki's padding to match.
  * CodeBlock last few lines had no line number because the
    gutter used `text-[11px]` and the body used `text-[12px]`,
    drifting ~80px short by line 50. Gutter bumped to 12px.

## [0.3.28](https://github.com/tianshu-ai/tianshu/compare/v0.3.27...v0.3.28) (2026-06-26)

### Features

* **ui:** rich file previews across the host through a single
  unified DocumentViewer. The chain that started in 0.3.23 with
  the host-shared Modal / MarkdownBlock / DocumentViewer now
  covers every common file kind a user might open from the
  files panel, workboard task delivery, or any `OpenFileApi`
  consumer:
  * **HTML**: live `<iframe>` preview running as a null origin
    (sandbox=allow-scripts/popups/forms/modals, no
    same-origin) so even hostile markup can't read tianshu
    cookies. Render / Source toggle.
  * **Code (~30 languages)**: shiki-highlighted with line
    numbers and a copy button. Lazy-imported via
    `shiki/bundle/web` — the ~600KB wasm and per-language
    grammars stay out of the initial bundle and download only
    when a user opens a code file.
  * **PDF**: browser-native PDF viewer via `<iframe>` (no
    pdf.js dependency).
  * **Video / Audio**: `<video controls>` / `<audio controls>`
    against the /raw stream.
  * **Image**: `<img>` against /raw; SVG also gets a
    Render / Source toggle (since SVG is itself markup).
  * **CSV / TSV**: parsed by papaparse (lazy-loaded), rendered
    as a real HTML `<table>` with sticky header and a 1000-row
    cap with an inline notice.
  * **Office (docx/xlsx/pptx + ODF + rtf)**: friendly
    placeholder pointing the user at the Download button.
    In-browser Office rendering needs a server-side LibreOffice
    pass which is a separate follow-up PR.
## [0.3.27](https://github.com/tianshu-ai/tianshu/compare/v0.3.26...v0.3.27) (2026-06-25)

### Features

* **ui:** Modal gains a `headerActions` slot (ReactNode rendered
  to the left of the close X). File-preview modals now use it
  to expose a Download button: files-plugin `FilePreviewModal`
  and the host `FileOpenDialog`. The download `<a>` points at
  the existing `/api/p/files/raw` route with a `download=<name>`
  attribute, so the browser saves instead of navigating even on
  viewable MIME types. FileOpenDialog also drops its bespoke
  inline header in favour of Modal's default header + the new
  slot, with the full path relegated to a small sub-header.

## [0.3.26](https://github.com/tianshu-ai/tianshu/compare/v0.3.25...v0.3.26) (2026-06-25)

### Bug Fixes

* **ui:** Modal height chain now propagates cleanly through flex.
  After 0.3.25 the body wrapper was block-level `min-h-0 flex-1`
  and every caller wrapped its content in `flex h-full flex-col`.
  CSS `height: 100%` inside a flex parent with no explicit pixel
  height anywhere up the tree behaves inconsistently across
  browsers — some collapse it to 0, some size to content. Result:
  files preview lost its scrollbar (content collapsed), and
  FileOpenDialog scrolled but didn't reach the last few lines.
  Fix: Modal body becomes `flex flex-col`, callers switch from
  `h-full` to `flex-1 min-h-0`. The whole chain is now flex-based
  with explicit space distribution.

## [0.3.25](https://github.com/tianshu-ai/tianshu/compare/v0.3.24...v0.3.25) (2026-06-25)

### Bug Fixes

* **ui:** remove Modal's built-in scroll container to fix double
  scrollbars. In 0.3.23 the new Modal body wrapper carried
  `overflow-auto`, but every existing caller already had its own
  inner overflow container. Two stacked scrollers produced a
  visible double scrollbar and let the inner content scroll out
  from under the modal's fixed header. Modal now bounds the body
  height (still `min-h-0 + flex-1`) but lets callers supply the
  scroll container themselves. McpServers EditDialog (the only
  caller without its own inner overflow) gains one on its form.

## [0.3.24](https://github.com/tianshu-ai/tianshu/compare/v0.3.23...v0.3.24) (2026-06-25)

### Bug Fixes

* **ui:** FileOpenDialog now renders Markdown through the shared
  DocumentViewer instead of a bare <pre>. PR #195 (0.3.23)
  swapped the dialog's outer chrome to Modal but missed the
  inner text-rendering path, so opening a .md file from the
  workboard task delivery list (or any other surface routed
  through OpenFileApi) showed raw markdown source. Files-plugin
  preview was unaffected because it already used DocumentViewer
  directly. Both routes now converge on the same host primitive.

## [0.3.23](https://github.com/tianshu-ai/tianshu/compare/v0.3.22...v0.3.23) (2026-06-25)

### Features

* **ui:** host-shared UI primitives (Modal / MarkdownBlock /
  DocumentViewer) plugins reuse through plugin-sdk's
  `__installUiPrimitives` + `useUiPrimitives()` hook. Replaces
  five hand-rolled `fixed inset-0 z-50 bg-black/...` modals
  scattered across files plugin, workboard plugin
  (ExecutionDialog + TaskModal), FileOpenDialog, and McpServers
  EditDialog with one canonical chrome. Replaces three different
  text rendering paths (chat ReactMarkdown vs. files `<pre>`
  vs. workboard `<pre>`) with one DocumentViewer that dispatches
  on filename / mime. Markdown dispatch is conservative—only
  `.md / .markdown` files get the Markdown renderer so source
  code with stray `# heading` lines doesn't render giant H1s.
  Net: a `.md` file viewed in the files plugin now renders
  pixel-identically to the same content rendered in chat.

## [0.3.22](https://github.com/tianshu-ai/tianshu/compare/v0.3.21...v0.3.22) (2026-06-24)

### Features

* **agent:** `tool_catalog_refresh` admin tool. The main agent
  can force-replay the tool catalog into the current chat
  session on demand — e.g. when the user asks 'what tools do I
  have' or after a silent upgrade where the auto-detector
  didn't fire (session stamp == new tool's since version).
  Two modes: `full` (default; lists every tool with a parseable
  since) and `since` (lists tools newer than a given
  since_version). Workers cannot call it. New host-tool plumbing
  in `PluginRegistry` (`opts.hostTools`) means future host-owned
  tools no longer have to forge a fake plugin.

## [0.3.21](https://github.com/tianshu-ai/tianshu/compare/v0.3.20...v0.3.21) (2026-06-24)

### Features

* **agent:** per-prompt tool-delta detector for cross-upgrade
  sessions. When a chat session has been open across a server
  upgrade and a builtin tool's `manifest.since` post-dates the
  session's stamped version, the next user prompt's turn opens
  with a synthetic system note listing the newly-available
  tools. Stops the model from "staying in its lane" on
  historical conversations after a release adds tools. Schema:
  `manifest.contributes.tools[].since` (semver) on the plugin
  side; `sessions.created_under_app_version` on the host side
  (migration 009). Workers are skipped; NULL-stamp sessions are
  claimed without notification.

## [0.3.20](https://github.com/tianshu-ai/tianshu/compare/v0.3.19...v0.3.20) (2026-06-24)

### Bug Fixes

* **workboard:** surface `worker_analytics` via `manifest.json`.
  0.3.19 shipped `buildWorkerAnalyticsTool` in `server.ts`'s
  exports but never listed it in `contributes.tools[]`, so the
  plugin registry skipped it and the agent couldn't see the tool.
  Adds the missing entry plus three manifest-hygiene tests that
  pin the symmetry between server.ts's exports.tools keys and
  manifest.json's contributes.tools[].module values — the bug
  cannot reappear without a test failing.

## [0.3.19](https://github.com/tianshu-ai/tianshu/compare/v0.3.18...v0.3.19) (2026-06-24)

### Features

* **workboard:** add `worker_analytics` orchestrator-only tool.
  ADR-0002 §12 — the main agent (天枢) can now read across
  recent worker runs and report per-agent + per-role stats
  (total / succeeded / intervened / watchdog-timeout counts,
  avg / p50 / p95 duration, total attempts, top-N failure
  reasons). Windowed by `windowDays` (default 7) or
  `allTime`. Owner-scoped — cross-tenant analytics stays
  out of scope. Read-only: this is a recommendation surface
  the orchestrator turns into prose tuning suggestions for
  the user, not a control loop. Workers are denied the tool.

## [0.3.18](https://github.com/tianshu-ai/tianshu/compare/v0.3.17...v0.3.18) (2026-06-24)

### Features

* **prompt:** inject a Runtime Context block (local time +
  timezone + host + tenant/user) into every agent's system
  prompt. Covers the main agent, worker agents, and the
  setup wizard's CLI agent. The LLM no longer has to guess
  "what day is it?" / "am I on macOS or Linux?" / "what
  timezone is the user in?" — the answers are in the prompt
  from the first turn. Re-rendered on every prompt build so
  the clock stays fresh across multi-minute sessions. Time
  format is ISO-8601 with explicit local offset (parses
  cleanly on Anthropic / OpenAI / Google).

## [0.3.17](https://github.com/tianshu-ai/tianshu/compare/v0.3.16...v0.3.17) (2026-06-23)

### Bug Fixes

* **workboard:** cancel the live worker when a task is deleted
  or moved out of `in_progress`. Without this fix, an
  abandoned worker kept burning LLM tokens after its task was
  gone / moved, and (worse) wrote status / labels back when
  it finished — clobbering a status move or crashing on a
  foreign-key error for a deleted row. Covers both the
  chat-side `task_move` / `task_delete` tools and the REST
  `PATCH /tasks/:id` / `DELETE /tasks` handlers (the UI's
  drag-card path). The REST delete handler now also wires the
  per-task sandbox teardown the chat tool already had.

## [0.3.16](https://github.com/tianshu-ai/tianshu/compare/v0.3.15...v0.3.16) (2026-06-22)

### Features

* **launchd:** use stable `ai.tianshu.prod` / `ai.tianshu.dev`
  labels instead of hash-suffixed ones. npm-global installs
  used to get an unreadable id like `ai.tianshu.dev.f71469f0`,
  and the hash rotated whenever the install path changed
  (e.g. an nvm version bump), leaving stale plists behind on
  every upgrade. Now: one stable label per install shape, and
  `tianshu start` / wizard auto-cleans orphan plists pointing
  at the same install path. `tianshu start` when run against
  the new label without an existing plist prints a one-line
  “run the wizard to migrate” hint instead of refusing.

## [0.3.15](https://github.com/tianshu-ai/tianshu/compare/v0.3.14...v0.3.15) (2026-06-22)

### Features

* **cli-agent:** new `check_build_progress` read-only tool +
  system-prompt guidance. When `build_sandbox` appears stuck,
  the agent now checks whether the build is still actively
  making progress (recent `[builder]` activity in the launchd
  logs) or has actually errored, instead of blindly retrying.
  Errors → retry. Still-progressing → quote the latest log
  line to the user ("still pulling apt packages, last activity
  22s ago") and wait. Avoids the 10-15 min double-build that
  happened when the agent's request timed out while the build
  itself was still fine.

## [0.3.14](https://github.com/tianshu-ai/tianshu/compare/v0.3.13...v0.3.14) (2026-06-22)

### Features

* **cli-agent:** new `sandbox_inventory` read-only tool +
  inventory-first system-prompt guidance. The setup agent
  used to dive into the full 2-snapshot layered build flow
  without first checking whether the user already had
  snapshots built and published. It now fetches
  `/api/p/microsandbox/{status,builds}`, surfaces what's on
  disk and which role pointers (browser / task) are
  currently published, and branches accordingly:
  - already fully set up → say so, skip the 10-15 min build
  - builds exist but unpublished → propose `use_sandbox_build`
  - nothing built → run the standard layered flow

## [0.3.13](https://github.com/tianshu-ai/tianshu/compare/v0.3.12...v0.3.13) (2026-06-22)

### Bug Fixes

* **publish:** include `plugins/**/templates/**` in the npm
  tarball. The microsandbox plugin's three Sandboxfile yaml
  templates (task-runner / browser / task-runner-with-browser)
  were missing from published global installs, so
  `build_sandbox` from the cli-agent and the admin UI's
  template dropdown both saw "no built-in templates". Root
  package.json + plugins/microsandbox/package.json `files`
  allowlists both needed to agree; they now do.

## [0.3.12](https://github.com/tianshu-ai/tianshu/compare/v0.3.11...v0.3.12) (2026-06-22)

### Features

* **doctor:** new "Tianshu version" check compares the running
  version against npm's `latest` dist-tag. Reports `ok` when
  up to date, `warning` when newer is available (with the
  `tianshu update` command to apply), `ok` when running from
  a git checkout (suggest `git pull`) or when the registry is
  unreachable. Opt out with `tianshu doctor
  --skip-version-check` for offline / CI runs.
* **cli-agent:** two new tools, `check_for_update` (read-only
  npm-registry probe) and `apply_update` (mutating; runs
  `npm install -g @tianshu-ai/tianshu@<tag>`, gated by CLI
  confirmation), plus system-prompt guidance teaching the
  setup agent how to drive an upgrade and how to act as a
  fixer rather than just an inspector. After a successful
  upgrade the user is told to run `tianshu restart`; the agent
  does not auto-bounce the service.

## [0.3.11](https://github.com/tianshu-ai/tianshu/compare/v0.3.10...v0.3.11) (2026-06-22)

### Bug Fixes

* **server:** `/api/health` now reads `version` from the
  top-level package.json instead of hard-coding it. Previously
  every release shipped with `version: "0.2.0"` baked into the
  endpoint, so doctor and the CLI update check couldn't
  distinguish running versions and would suggest upgrades that
  were already installed.

## [0.3.10](https://github.com/tianshu-ai/tianshu/compare/v0.3.9...v0.3.10) (2026-06-22)

### Features

* **core/urls:** centralise port and URL resolution in a single
  `core/urls.ts` module. Replaces four drifting inline copies
  in cli.ts, setup/service.ts, setup/checks/network.ts, and
  setup/start-server.ts.
* **server:** publish `server.effectivePublicUrl` to global
  config on each boot. Out-of-process CLI commands
  (`tianshu tenant list`, doctor) read it and print a URL that
  actually opens, regardless of whether the install is dev or
  prod shape. Detection is runtime-accurate (looks at
  `TIANSHU_WEB_DIST`), not a filesystem heuristic.

### Bug Fixes

* **cli:** `tianshu tenant list` no longer prints the vite dev
  port on production installs where vite never runs. Reads the
  operator-declared `server.publicUrl` or the
  server-published `server.effectivePublicUrl` first; only
  falls back to dev/prod filesystem heuristic when neither is
  set.

## [0.3.9](https://github.com/tianshu-ai/tianshu/compare/v0.3.8...v0.3.9) (2026-06-22)

### Bug Fixes

* **setup:** skip the "Web port" prompt on production-mode
  installs. In prod the server hosts the SPA on the API port
  (TIANSHU_WEB_DIST), so there's no second port to pick.
  Wizard now asks for just the API port and adjusts the prompt
  copy to say so. Dev mode (git checkout) still prompts for
  both ports.

## [0.3.8](https://github.com/tianshu-ai/tianshu/compare/v0.3.7...v0.3.8) (2026-06-22)

### Bug Fixes

* **env:** read & write `.env` from `<TIANSHU_HOME>/.env` on
  global installs (default `~/.tianshu/.env`). Previously the
  wizard wrote ports to the install dir's `.env` which (a) may
  not be user-writable on some node prefixes and (b) gets
  blown away on `npm install -g` upgrades. Result: doctor and
  the running server fell back to default ports even though
  the user had picked something else in the wizard. Dev mode
  (git checkout) keeps writing to repoRoot/.env so existing
  developer workflows aren't disturbed.

## [0.3.7](https://github.com/tianshu-ai/tianshu/compare/v0.3.6...v0.3.7) (2026-06-22)

### Features

* **doctor, cli-agent:** distinguish dev mode (two ports, vite
  hosts the SPA) from production mode (one port, server hosts
  the SPA via TIANSHU_WEB_DIST). doctor now reports the actual
  access URL instead of a misleading "web port 5183 free" hint
  on prod installs. cli-agent's system prompt teaches it to read
  doctor's output for the canonical URL rather than hardcoding
  one.

## [0.3.6](https://github.com/tianshu-ai/tianshu/compare/v0.3.5...v0.3.6) (2026-06-22)

0.3.5 mounted the static handler and the SPA fallback but the
fallback used `res.sendFile()` which 404'd on global installs
even though the file existed on disk (Express 5 send module
behaviour we don't fully understand on absolute paths). Symptom:
`curl localhost:3110/` returned a 1.6kB NotFoundError page;
browser users saw a blank Express error page instead of the
chat UI.

### Bug Fixes

* **serve:** read `index.html` into a buffer at mount time and
  `res.send` it on each SPA fallback request, bypassing
  `res.sendFile`. Faster too — no per-request syscall.
* **setup:** wizard's "Web UI" output now shows the right URL
  for the actual mode — single-port `http://localhost:3110` in
  production, separate `http://localhost:5183` only in dev.

## [0.3.5](https://github.com/tianshu-ai/tianshu/compare/v0.3.4...v0.3.5) (2026-06-22)

0.3.4 added `npm run serve` for production-mode startup but
the script used a shell variable (`TIANSHU_WEB_DIST="$PWD/..."`)
that npm doesn't always expand. On launchd-driven invocations
the server saw the literal string `"$PWD/packages/web/dist"`
as the dist path, `path.resolve()` turned it into a nonsense
relative path, the directory didn't exist, and the static
mount fell through to the warning branch. Symptom: `curl /`
returned 404 even though `/api/health` was healthy.

### Bug Fixes

* **serve:** replace the shell-variable-based `serve` script
  with a real `bin/serve.mjs` entrypoint that resolves the
  package root from `import.meta.url`. Works regardless of cwd
  or shell quoting behaviour

## [0.3.4](https://github.com/tianshu-ai/tianshu/compare/v0.3.3...v0.3.4) (2026-06-22)

Fixes the wizard's launchd plist on global npm installs. 0.3.3
actually started but the wizard-installed launchd agent ran
`npm run dev`, which invokes `tsc` via the build chain —
devDependencies aren't on disk in a global install:

  sh: tsc: command not found
  npm error code 127  (looped every 30s under KeepAlive)

### Bug Fixes

* **server, setup:** add `npm run serve` (production startup
  without dev toolchain) and teach the wizard to write a plist
  that picks `serve` over `dev` when running from a global
  install. Server mounts the pre-built web dist on the same
  port when `TIANSHU_WEB_DIST` is set, so one process + one
  port is enough for the end-user case. Dev mode (running
  from a git checkout) keeps the existing two-port watch-and-
  rebuild shape

## [0.3.3](https://github.com/tianshu-ai/tianshu/compare/v0.3.2...v0.3.3) (2026-06-22)

Really-working hotfix. 0.3.2 also broke under `npm install -g`:
the `peerDependencies` shape on `@tianshu-ai/plugin-sdk` (added
to trim the tarball) created an empty
`tianshu/node_modules/@modelcontextprotocol/sdk/` placeholder
directory that Node's module resolver treated as authoritative
but couldn't actually load files from. Symptom: same
`ERR_MODULE_NOT_FOUND` users saw on 0.3.0/0.3.1, just one
level deeper.

### Bug Fixes

* **publish:** move `@modelcontextprotocol/sdk` back to
  plugin-sdk's `dependencies`. npm's bundleDependencies now
  ships plugin-sdk's full transitive subtree inside the
  tarball (tarball back to ~5MB, an acceptable cost). Module
  resolution from plugin-sdk's code walks up and finds
  mcp-sdk inside `tianshu/node_modules/` immediately, on both
  local installs and global `npm install -g`. Verified by
  simulating `-g` install via `--prefix <tmpdir>`.

## [0.3.2](https://github.com/tianshu-ai/tianshu/compare/v0.3.1...v0.3.2) (2026-06-22)

Out-of-band hotfix shipping a working npm tarball. Versions
**0.3.0 and 0.3.1 are broken** — the published packages were
missing all 14 server runtime dependencies (better-sqlite3,
ws, hono, the mcp sdk, etc.). Hoisted-workspace install in
dev mode masked this; the published tarball revealed it.
Anyone on those versions will see `Cannot find package` errors
on first invocation. Skip straight to 0.3.2.

### Bug Fixes

* **publish:** rename the workspace plugin SDK from
  `@tianshu/plugin-sdk` (a scope we don't own) to
  `@tianshu-ai/plugin-sdk`. Bundle it into the published
  tarball via `bundleDependencies` so users get it on install
  without needing a separate npm publish for the SDK. Aggregate
  every sub-package's runtime `dependencies` into root so
  `npm install -g @tianshu-ai/tianshu` actually pulls everything
  the server needs at runtime ([#172](https://github.com/tianshu-ai/tianshu/pull/172))

## [0.3.0](https://github.com/tianshu-ai/tianshu/compare/v0.2.0...v0.3.0) (2026-06-21)


### Features

* **admin:** /admin shell + microsandbox sandbox-admin page (ADR-0004 N+4) ([#67](https://github.com/tianshu-ai/tianshu/issues/67)) ([c0b864f](https://github.com/tianshu-ai/tianshu/commit/c0b864f2b88a231eb34862e6df7ec3a69bc09350))
* ADR-0005 LSP integration + plugin-files hardening ([#125](https://github.com/tianshu-ai/tianshu/issues/125)) ([ad81da8](https://github.com/tianshu-ai/tianshu/commit/ad81da8cc191805cb3da04a97bef24133f331c30))
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
* **cli:** `tianshu doctor` + `tianshu setup --wizard` + global-installable bin ([#158](https://github.com/tianshu-ai/tianshu/issues/158)) ([2772e6d](https://github.com/tianshu-ai/tianshu/commit/2772e6dcc3e1897f285592fc6060940208fd651b))
* **dev-identity:** URL-driven tenant/user switching via cookie ([#159](https://github.com/tianshu-ai/tianshu/issues/159)) ([5c8d9b3](https://github.com/tianshu-ai/tianshu/commit/5c8d9b3b08dd1cd1f8dff241c425d18c3d46759a))
* **files,server:** move workspace layout block to files plugin fragment ([#136](https://github.com/tianshu-ai/tianshu/issues/136)) ([cb823e5](https://github.com/tianshu-ai/tianshu/commit/cb823e5baaafd973eb022d4a452d8067693b298b))
* **files:** clarify read-required prompt + accept paged reads as full ([#138](https://github.com/tianshu-ai/tianshu/issues/138)) ([6450d4b](https://github.com/tianshu-ai/tianshu/commit/6450d4b3e80a7dec42b463489144bc0e62db11b7))
* **files:** move fs agent tools into the files plugin (ADR-0004 N+3.5) ([#62](https://github.com/tianshu-ai/tianshu/issues/62)) ([49ab627](https://github.com/tianshu-ai/tianshu/commit/49ab6272fe8155b2c135c23789e315b4b0fd7526))
* **files:** workspace:// URI scheme for tool→UI file references ([#86](https://github.com/tianshu-ai/tianshu/issues/86)) ([77e7fb7](https://github.com/tianshu-ai/tianshu/commit/77e7fb7181c0cdd6c3f517a46d6924c37b4dcb8e))
* **microsandbox,workboard:** per-task sandbox pool with stop-not-remove lifecycle ([#141](https://github.com/tianshu-ai/tianshu/issues/141)) ([16c277c](https://github.com/tianshu-ai/tianshu/commit/16c277cde20171d62ed381933065a62ef6b0c481))
* **microsandbox:** allow file:// + pdf + vision in Playwright MCP, prompt fragment for ephemeral task sandbox ([#145](https://github.com/tianshu-ai/tianshu/issues/145)) ([c6fbabc](https://github.com/tianshu-ai/tianshu/commit/c6fbabced99df5c7b4de7885461ba5bb8f4e567a))
* **microsandbox:** browser sidecar scaffold + 3 agent tools + admin Browser page (ADR-0004 N+5.1) ([#68](https://github.com/tianshu-ai/tianshu/issues/68)) ([74e17a7](https://github.com/tianshu-ai/tianshu/commit/74e17a7d98068f2c48dfdf0a2036eb0c565a96b5))
* **microsandbox:** build resilience — SDK rename, Node fallback, node-python template ([#133](https://github.com/tianshu-ai/tianshu/issues/133)) ([a65490d](https://github.com/tianshu-ai/tianshu/commit/a65490db579687e630ec2615b4eed16191140c89))
* **microsandbox:** builtin plugin scaffold + nullable runner (ADR-0004 N+2) ([#60](https://github.com/tianshu-ai/tianshu/issues/60)) ([babdf6d](https://github.com/tianshu-ai/tianshu/commit/babdf6d8cd1beb67d5c1df36a94a1fa3e2604706))
* **microsandbox:** drop privileges to a real tenant user inside the guest ([#139](https://github.com/tianshu-ai/tianshu/issues/139)) ([53c1b83](https://github.com/tianshu-ai/tianshu/commit/53c1b838858ea20593af627a50a43eda8119ed4e))
* **microsandbox:** eager warm-up on plugin activation ([#64](https://github.com/tianshu-ai/tianshu/issues/64)) ([43a8424](https://github.com/tianshu-ai/tianshu/commit/43a842478e0a1d1bf1084129b530327874f34d41))
* **microsandbox:** expand node-python template to full browser stack ([#134](https://github.com/tianshu-ai/tianshu/issues/134)) ([cd4c0af](https://github.com/tianshu-ai/tianshu/commit/cd4c0afde1fef1b4d63e9069f60a5b473e8a6e6b))
* **microsandbox:** expose memory / cpu / image / timeout in plugin config UI + browser_health_check ([#120](https://github.com/tianshu-ai/tianshu/issues/120)) ([d06326e](https://github.com/tianshu-ai/tianshu/commit/d06326e02314556ec523ac66ea75f1f1b64c5899))
* **microsandbox:** inject $USER / $HOME / $MSB_USER_ID into exec context ([#137](https://github.com/tianshu-ai/tianshu/issues/137)) ([e93cb1b](https://github.com/tianshu-ai/tianshu/commit/e93cb1bc1e82d4a0f3ea7167f3a06b7c7575980a))
* **microsandbox:** live browser stack — port forward + auto supervisord + Playwright MCP wired (ADR-0004 N+5.3) ([#70](https://github.com/tianshu-ai/tianshu/issues/70)) ([fb671c2](https://github.com/tianshu-ai/tianshu/commit/fb671c247e36966e79103c973e9f4ba5ff6bf8ef))
* **microsandbox:** make minimal.yaml a real task-runner template ([#151](https://github.com/tianshu-ai/tianshu/issues/151)) ([79e92f0](https://github.com/tianshu-ai/tianshu/commit/79e92f04b47f613221cecd66a9a41f482f99c4f7))
* **microsandbox:** pool monitor section + Configure dialog ([#143](https://github.com/tianshu-ai/tianshu/issues/143)) ([6a38c3d](https://github.com/tianshu-ai/tianshu/commit/6a38c3d8eb434b04c29d8ca696d908d4d824c531))
* **microsandbox:** Sandboxfile templates + Browser template (CloakBrowser + Playwright MCP + noVNC) (ADR-0004 N+5.2) ([#69](https://github.com/tianshu-ai/tianshu/issues/69)) ([00ed8f1](https://github.com/tianshu-ai/tianshu/commit/00ed8f1432c06e9d58dfd5721422f451f55fcd6f))
* **microsandbox:** split snapshot pointer into Browser + Task roles ([#140](https://github.com/tianshu-ai/tianshu/issues/140)) ([79581a5](https://github.com/tianshu-ai/tianshu/commit/79581a59203fc0fbe40295a91dc573a8ffbb6d9b))
* **n5-4:** direct MCP mount via SDK, dynamic browser viewport, MCP servers admin ([#76](https://github.com/tianshu-ai/tianshu/issues/76)) ([6eb310f](https://github.com/tianshu-ai/tianshu/commit/6eb310ff51718ae4c6a86750577830bdcc18de93))
* **plugin-files:** fuzzy replacers + replace_all in edit_file (ADR-0006 PR-B groundwork) ([#130](https://github.com/tianshu-ai/tianshu/issues/130)) ([9c5796a](https://github.com/tianshu-ai/tianshu/commit/9c5796aa1315eb7fd0ce8759933ff1dc8be88add))
* **plugins/files:** scope to per-user home + tighten top-bar icons ([#40](https://github.com/tianshu-ai/tianshu/issues/40)) ([e8be301](https://github.com/tianshu-ai/tianshu/commit/e8be30150c785a534438d24686ae2d6b7e09f317))
* **plugins/files:** styled panel matching the closed-source repo ([#38](https://github.com/tianshu-ai/tianshu/issues/38)) ([22c1b01](https://github.com/tianshu-ai/tianshu/commit/22c1b017c6ed42d3a9deb9c377eabcb42b8c9544))
* **plugins:** capability registry, requires/provides, sandbox surface (ADR-0004 N+1) ([#59](https://github.com/tianshu-ai/tianshu/issues/59)) ([ba751c7](https://github.com/tianshu-ai/tianshu/commit/ba751c7b9b6fa97fd4d946a0d65e38476107810a))
* **plugins:** catalog client + Plugin Manager Catalog tab (P1) ([#34](https://github.com/tianshu-ai/tianshu/issues/34)) ([4376d67](https://github.com/tianshu-ai/tianshu/commit/4376d672becc941f86779ee895e54c99054e5e18))
* **plugins:** composer file uploads + composerActions SDK contribution ([#48](https://github.com/tianshu-ai/tianshu/issues/48)) ([#49](https://github.com/tianshu-ai/tianshu/issues/49)) ([0bea614](https://github.com/tianshu-ai/tianshu/commit/0bea61476f5e74e393f68f6460d29b8b4aeb0a00))
* **plugins:** contributes.tools[] \u2014 plugins own their agent tools (ADR-0004 N+3) ([#61](https://github.com/tianshu-ai/tianshu/issues/61)) ([db56329](https://github.com/tianshu-ai/tianshu/commit/db56329bc7d6044f2674bb4a3b254e02af7f3111))
* **plugins:** files plugin (workspace browser, server side) ([#35](https://github.com/tianshu-ai/tianshu/issues/35)) ([b2ec9a3](https://github.com/tianshu-ai/tianshu/commit/b2ec9a312c4805aeb546e750d0dacb76e72ed6bb))
* **plugins:** plugin runtime + Plugin Manager UI (PR [#31](https://github.com/tianshu-ai/tianshu/issues/31)) ([#32](https://github.com/tianshu-ai/tianshu/issues/32)) ([9405d57](https://github.com/tianshu-ai/tianshu/commit/9405d57ad9e1785c95856c048bbb3320edb67da0))
* **prompt:** add tool-guidelines block to defaultSystemPrompt (OpenClaw-style) ([#124](https://github.com/tianshu-ai/tianshu/issues/124)) ([ea227ea](https://github.com/tianshu-ai/tianshu/commit/ea227ea340940b93f96e63acaac6783ab57ac7a5))
* **server:** agent fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)a) ([#42](https://github.com/tianshu-ai/tianshu/issues/42)) ([791819a](https://github.com/tianshu-ai/tianshu/commit/791819ac2ea51883b4263fcee559689a400ec141))
* **server:** inject Execution Bias + AGENTS.md / SOUL.md / USER.md into system prompt ([#148](https://github.com/tianshu-ai/tianshu/issues/148)) ([ee1c97c](https://github.com/tianshu-ai/tianshu/commit/ee1c97c7c287f9ce04c4ff1d61b624a1b6fdf4c4))
* **server:** inject plugin systemPromptFragments into worker prompt (ADR-0007 PR-B) ([#129](https://github.com/tianshu-ai/tianshu/issues/129)) ([aa2e055](https://github.com/tianshu-ai/tianshu/commit/aa2e05535bbae7f3eee9b4ab5bc755ba2e7a0080))
* **server:** optional system-prompt dump for debugging ([#131](https://github.com/tianshu-ai/tianshu/issues/131)) ([76328db](https://github.com/tianshu-ai/tianshu/commit/76328db337dd5436b11abf9b683601b5277beb26))
* **setup:** cli-agent shows every action, confirms before mutating, no silent auto-fix ([#167](https://github.com/tianshu-ai/tianshu/issues/167)) ([bee4106](https://github.com/tianshu-ai/tianshu/commit/bee4106333d79c92ebe7e1d2b324b93c355b9d92))
* **setup:** in-CLI agent handoff after wizard for conversational setup ([#165](https://github.com/tianshu-ai/tianshu/issues/165)) ([07e1012](https://github.com/tianshu-ai/tianshu/commit/07e1012e10abb1140ca87d687850aa0aa6640392))
* **setup:** wizard probes default model first; smart-skip when working ([#164](https://github.com/tianshu-ai/tianshu/issues/164)) ([c6f9f7f](https://github.com/tianshu-ai/tianshu/commit/c6f9f7fa5e4f2d94f3a4e90bda0be343272f1a89))
* **setup:** wizard supports custom baseUrl + custom model id ([#163](https://github.com/tianshu-ai/tianshu/issues/163)) ([4d21143](https://github.com/tianshu-ai/tianshu/commit/4d21143f037f60b27b7faf802e21a184f1b2db3e))
* **skills:** drop load_skill meta-tool; manage skills via filesystem ([#98](https://github.com/tianshu-ai/tianshu/issues/98)) ([b352c74](https://github.com/tianshu-ai/tianshu/commit/b352c749b0bc8f19d753e478ed70b0f6acbd16fc))
* **skills:** mirror host & plugin SKILL.md into tenant config so one tool reads them all ([#104](https://github.com/tianshu-ai/tianshu/issues/104)) ([bc5c890](https://github.com/tianshu-ai/tianshu/commit/bc5c8900dbf4c07577cdab6d742c344917425832))
* **skills:** on-demand prompt fragments via plugin-contributed skills (ADR-0004 N+4) ([#63](https://github.com/tianshu-ai/tianshu/issues/63)) ([ec6cf6f](https://github.com/tianshu-ai/tianshu/commit/ec6cf6ffdb0258625b484fe1c7c53834756a15ea))
* **skills:** tenant-scoped skill discovery + main agent skill-creator ([#97](https://github.com/tianshu-ai/tianshu/issues/97)) ([98e0480](https://github.com/tianshu-ai/tianshu/commit/98e0480bfed24f05642c951eb543e9f542ad4ff8))
* **tenant:** infrastructure layer (PR [#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([4b6e7ae](https://github.com/tianshu-ai/tianshu/commit/4b6e7ae62da101c7998cf8e7dfe9b8b58cc969a3))
* **ui:** model selector pill in composer (PR [#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([5a835ff](https://github.com/tianshu-ai/tianshu/commit/5a835ff99b0b74c135e7c02cdebe895079d1b53c))
* **ui:** refine chat layout to match closed-source repo (PR [#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([#27](https://github.com/tianshu-ai/tianshu/issues/27)) ([090c6eb](https://github.com/tianshu-ai/tianshu/commit/090c6eb47e6b02c6d0c0c6dcaabb4debe06c47f0))
* **ui:** tianshu-style chat UI (PR [#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([#26](https://github.com/tianshu-ai/tianshu/issues/26)) ([086fce7](https://github.com/tianshu-ai/tianshu/commit/086fce7fe55d29131ccce9cf7da48750aa2c74ef))
* **web-search:** plugin with Tavily / Brave + secret config + provider health cache ([#114](https://github.com/tianshu-ai/tianshu/issues/114)) ([fc636f2](https://github.com/tianshu-ai/tianshu/commit/fc636f285cdeef8590246f4ca3acbd9b6513d6db))
* **web:** collapsible tool-call rows (closed-source UI parity) ([#45](https://github.com/tianshu-ai/tianshu/issues/45)) ([78c1fb7](https://github.com/tianshu-ai/tianshu/commit/78c1fb7a2c87b7377827d2fa308b6c0db2bf35c1))
* **web:** manifest-driven top bar + right panel (PR [#33](https://github.com/tianshu-ai/tianshu/issues/33)) ([#36](https://github.com/tianshu-ai/tianshu/issues/36)) ([ba488fb](https://github.com/tianshu-ai/tianshu/commit/ba488fbff6a4c68e88f131d8d7fa34a2b59556aa))
* **web:** right-panel tab bar + resize handle (closed-source parity) ([#41](https://github.com/tianshu-ai/tianshu/issues/41)) ([25f1c98](https://github.com/tianshu-ai/tianshu/commit/25f1c984a25865911b65d8ab2c66331bac089f7a))
* **workboard,server,web:** execution dialog + session inbox + history pagination + concurrency fixes ([#94](https://github.com/tianshu-ai/tianshu/issues/94)) ([d79e665](https://github.com/tianshu-ai/tianshu/commit/d79e665eb97f10bc49b3f361090c74fa6bab4f40))
* **workboard:** batch task_create + task_delete ([#93](https://github.com/tianshu-ai/tianshu/issues/93)) ([759226e](https://github.com/tianshu-ai/tianshu/commit/759226e128d183c2292cad4f7cef90fb3380aa52))
* **workboard:** drop worker_agents table; UI read-only; REST mutation routes removed (PR-C) ([#101](https://github.com/tianshu-ai/tianshu/issues/101)) ([cba6701](https://github.com/tianshu-ai/tianshu/commit/cba67011824ced8e34e885250f231cc8d9866b5c))
* **workboard:** enable/disable worker agent from the admin UI ([#146](https://github.com/tianshu-ai/tianshu/issues/146)) ([d057696](https://github.com/tianshu-ai/tianshu/commit/d0576966fb9155d187745f7a6460db8c6bb0ed23))
* **workboard:** fs-only worker config + intervention model + skill / context plumbing ([#102](https://github.com/tianshu-ai/tianshu/issues/102)) ([f4e571e](https://github.com/tianshu-ai/tianshu/commit/f4e571e7546981b0cae0dabc2d32b44c9bdbd2be))
* **workboard:** host.modelCatalog capability + model_list tool for the main agent ([#107](https://github.com/tianshu-ai/tianshu/issues/107)) ([fb2d9ef](https://github.com/tianshu-ai/tianshu/commit/fb2d9ef98167ba68630476cdec3095ad664dd140))
* **workboard:** hot-reload pool when worker bundles change on disk ([#103](https://github.com/tianshu-ai/tianshu/issues/103)) ([2008527](https://github.com/tianshu-ai/tianshu/commit/2008527ccc542a9c19c1cb2c39edda2fc72248a2))
* **workboard:** kanban + worker pool plugin (ADR-0002 §6) ([#78](https://github.com/tianshu-ai/tianshu/issues/78)) ([0fac44a](https://github.com/tianshu-ai/tianshu/commit/0fac44af8afdf8f4d11620405c12d8ce4b34a041))
* **workboard:** LLM worker kind via host.agentLoop capability (N+6.3) ([#80](https://github.com/tianshu-ai/tianshu/issues/80)) ([cd53fac](https://github.com/tianshu-ai/tianshu/commit/cd53fac940ab7241ed2a9b03a5f5985352b21514))
* **workboard:** main agent can list available LLM models via  ([#106](https://github.com/tianshu-ai/tianshu/issues/106)) ([3e7a008](https://github.com/tianshu-ai/tianshu/commit/3e7a00811a21e3c1f43d9e25af277a3c1f1f86df))
* **workboard:** nudge main agent toward plan/design/build/verify decomposition ([#150](https://github.com/tianshu-ai/tianshu/issues/150)) ([a0a9a05](https://github.com/tianshu-ai/tianshu/commit/a0a9a05bd6a1604e1b2f8c6232af5744c29ba771))
* **workboard:** one-shot DB-&gt;fs migration; widen tenant_config_write boundary; retire worker_agent_* tools (PR-B) ([#100](https://github.com/tianshu-ai/tianshu/issues/100)) ([0ff0249](https://github.com/tianshu-ai/tianshu/commit/0ff0249b9a3310ee6c8e7eed192c6263e94f06fa))
* **workboard:** orchestrator tools for managing worker agents ([#96](https://github.com/tianshu-ai/tianshu/issues/96)) ([5f2d314](https://github.com/tianshu-ai/tianshu/commit/5f2d314e00e9c1272c372773c49a2720fb2a46b9))
* **workboard:** plugin-contributed agent seeds, fs-backed worker layout (PR-A) ([#99](https://github.com/tianshu-ai/tianshu/issues/99)) ([65b3b11](https://github.com/tianshu-ai/tianshu/commit/65b3b111b662e5015a550f3cfb528ef389e5cab6))
* **workboard:** retry/publish buttons on label chips ([#91](https://github.com/tianshu-ai/tianshu/issues/91)) ([6a0531e](https://github.com/tianshu-ai/tianshu/commit/6a0531ef586883e10b844e7edd51cd8f563f6d7b))
* **workboard:** show per-task sandbox name in task detail dialog ([#142](https://github.com/tianshu-ai/tianshu/issues/142)) ([4441cc4](https://github.com/tianshu-ai/tianshu/commit/4441cc49922270fb7a4cc8a6a938b2a49326777d))
* **workboard:** task execution history (REST + agent tool) ([#92](https://github.com/tianshu-ai/tianshu/issues/92)) ([3949e14](https://github.com/tianshu-ai/tianshu/commit/3949e14a038164a29096c6b711d9c5e8193fdeca))
* **workboard:** tool/skill catalog capabilities + worker agent ChipPicker ([#95](https://github.com/tianshu-ai/tianshu/issues/95)) ([aa1126a](https://github.com/tianshu-ai/tianshu/commit/aa1126aed6115786f2facafb0826846624e238cd))
* **worker-agents:** host table + REST + plugin seed + admin UI (ADR-0002 §7.1, N+6.2) ([#79](https://github.com/tianshu-ai/tianshu/issues/79)) ([a8b7378](https://github.com/tianshu-ai/tianshu/commit/a8b7378a80e4609f73eeef4f6e1ed1759ceb6255))


### Bug Fixes

* **adapter:** detect stream-truncated tool calls and surface a useful error ([#105](https://github.com/tianshu-ai/tianshu/issues/105)) ([2e95618](https://github.com/tianshu-ai/tianshu/commit/2e95618d78a4a536b2ab108095605e185baac6ec))
* **chat:** assistant messages with mixed text + tool calls render in author order ([#65](https://github.com/tianshu-ai/tianshu/issues/65)) ([ccedf35](https://github.com/tianshu-ai/tianshu/commit/ccedf3554072f8be8c912b596b764adabb7d81c5))
* **chat:** session storage chain + bridge pi tool_execution events (N+6.4 follow-up) ([#83](https://github.com/tianshu-ai/tianshu/issues/83)) ([0446273](https://github.com/tianshu-ai/tianshu/commit/04462730378ccf0037b121ed8361f918c2838740))
* **files:** make `edits` required in edit_file / tenant_config_edit schema ([#123](https://github.com/tianshu-ai/tianshu/issues/123)) ([daf2875](https://github.com/tianshu-ai/tianshu/commit/daf287514e0d040e003dbcb8d9600116a73a4c63))
* **microsandbox:** adapt to SDK rename of stopAndWait/removePersisted ([#132](https://github.com/tianshu-ai/tianshu/issues/132)) ([026d290](https://github.com/tianshu-ai/tianshu/commit/026d2909022a64329912cd07f9fced3d7feef526))
* **microsandbox:** destroyTask reclaims orphan VMs not in the pool map ([#144](https://github.com/tianshu-ai/tianshu/issues/144)) ([476f462](https://github.com/tianshu-ai/tianshu/commit/476f46287368fe24a667aa455318e6623586358f))
* **microsandbox:** guard exec against host-guest channel hangs ([#153](https://github.com/tianshu-ai/tianshu/issues/153)) ([80d5f54](https://github.com/tianshu-ai/tianshu/commit/80d5f54e05b3302acb2cffd826008611ce66697d))
* **microsandbox:** make execTimeoutMs actually fire (use shellStream + kill) ([#121](https://github.com/tianshu-ai/tianshu/issues/121)) ([ec41a55](https://github.com/tianshu-ai/tianshu/commit/ec41a559a49140d9132a39bd5cccc73a98a42836))
* **microsandbox:** tighten server-startup + verify-task prompts ([#152](https://github.com/tianshu-ai/tianshu/issues/152)) ([c4491a3](https://github.com/tianshu-ai/tianshu/commit/c4491a3118c441655c82510d4ad425852bbe4143))
* pipe agent-loop abort signal into tools so task_abort actually frees workers ([#154](https://github.com/tianshu-ai/tianshu/issues/154)) ([653f542](https://github.com/tianshu-ai/tianshu/commit/653f5428c0d7599de06e4a14f47aa956209483d2))
* **plugin-sdk:** re-resolve MCP endpoint on every callRemote ([#155](https://github.com/tianshu-ai/tianshu/issues/155)) ([827a888](https://github.com/tianshu-ai/tianshu/commit/827a888ad3fa8cddebde5d4a93dcd949bb572e01))
* **plugins:** mount contributed routes under /api/p/&lt;id&gt;/... ([#37](https://github.com/tianshu-ai/tianshu/issues/37)) ([3484ace](https://github.com/tianshu-ai/tianshu/commit/3484aceb51bc19d6900c91770e46dc9d91c3194f))
* **server:** refresh stale dynamic toolsets at worker run start ([#156](https://github.com/tianshu-ai/tianshu/issues/156)) ([1c0ae85](https://github.com/tianshu-ai/tianshu/commit/1c0ae85fc39c489c00ae4b0000aa718b04141530))
* **server:** substitute &lt;self&gt;/&lt;userId&gt; placeholders with caller's actual userId in system prompts ([#157](https://github.com/tianshu-ai/tianshu/issues/157)) ([3550d2a](https://github.com/tianshu-ai/tianshu/commit/3550d2ad6c88d76b9da9231888c2e3274c786ee3))
* **server:** unify USER.md prompt so empty templates trigger onboarding ([#149](https://github.com/tianshu-ai/tianshu/issues/149)) ([c595e08](https://github.com/tianshu-ai/tianshu/commit/c595e08309fe96338d649cc69c20e8d0025b6cb5))
* **setup:** force-reload .env after wizard writes; clear pass/fail signal on model ping ([#166](https://github.com/tianshu-ai/tianshu/issues/166)) ([1130ce6](https://github.com/tianshu-ai/tianshu/commit/1130ce695713ba423542f9fb956cfa2d76278694))
* **ui:** de-dupe ws handlers + message renders (StrictMode) ([#28](https://github.com/tianshu-ai/tianshu/issues/28)) ([0b8b5bc](https://github.com/tianshu-ai/tianshu/commit/0b8b5bcb3c163cfa277fa23ae32243bd8280de4d))
* **workboard:** nudge on done patches + fallback polling timer ([#89](https://github.com/tianshu-ai/tianshu/issues/89)) ([b959cd2](https://github.com/tianshu-ai/tianshu/commit/b959cd23efb24c2d16e7f229063ae14939d99143))
* **workboard:** show awaiting-intervention chip on board cards ([#118](https://github.com/tianshu-ai/tianshu/issues/118)) ([2220f76](https://github.com/tianshu-ai/tianshu/commit/2220f7631a42e9a2fbc7c03e58ab6b344929ed9b))
* **workboard:** task_move(status=ready) clears intervention labels (zombie task fix) ([#117](https://github.com/tianshu-ai/tianshu/issues/117)) ([a0d37b0](https://github.com/tianshu-ai/tianshu/commit/a0d37b0fa0089ff78fbf695c91b6a5a12ea998d1))
* **worker:** drop MAX_TURNS cap; deny task management tools in LLM workers ([#87](https://github.com/tianshu-ai/tianshu/issues/87)) ([4c00b41](https://github.com/tianshu-ai/tianshu/commit/4c00b418c2331b76dd039dd5fd732c4459ef5d0d))
* **write:** tool description guideline + repeat-truncation escalation ([#116](https://github.com/tianshu-ai/tianshu/issues/116)) ([91e60fe](https://github.com/tianshu-ai/tianshu/commit/91e60fe18591828b836e63d138b6506b8a072d44))
* WS chat respects user identity (close conversation isolation hole) ([#162](https://github.com/tianshu-ai/tianshu/issues/162)) ([c2f83b3](https://github.com/tianshu-ai/tianshu/commit/c2f83b31e9d6267de10e17a7054a0ed11f0e960e))


### Documentation

* ADR-0001 multi-tenant architecture ([#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([e5d1cc7](https://github.com/tianshu-ai/tianshu/commit/e5d1cc794783ccd045b6081d9c0c9145fa24f2d9))
* ADR-0002 orchestrator + workers, with config layering ([#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([6d5fff6](https://github.com/tianshu-ai/tianshu/commit/6d5fff6cac433e6134463b169103f20594cf7fd5))
* ADR-0003 plugin system (UI panels, sidebar sections, API routes) ([#30](https://github.com/tianshu-ai/tianshu/issues/30)) ([4386ccd](https://github.com/tianshu-ai/tianshu/commit/4386ccddcc8158b286559af894f0f532b1816724))
* ADR-0004 plugin capabilities & sandbox contract ([#58](https://github.com/tianshu-ai/tianshu/issues/58)) ([b6a84f4](https://github.com/tianshu-ai/tianshu/commit/b6a84f46e732ae483640d5efd3247db078192312))
* **architecture:** ADR-0007 — skill progressive disclosure ([#128](https://github.com/tianshu-ai/tianshu/issues/128)) ([56e114c](https://github.com/tianshu-ai/tianshu/commit/56e114c3c5c3319c444458c9e8aa4f54400c006e))
* **files,microsandbox:** clarify cross-tool path semantics ([#135](https://github.com/tianshu-ai/tianshu/issues/135)) ([802301b](https://github.com/tianshu-ai/tianshu/commit/802301beb80053d9e43e6b330b54399d6ff0bf5c))
* how to run tianshu as a background service (macOS launchd) ([#161](https://github.com/tianshu-ai/tianshu/issues/161)) ([e439c67](https://github.com/tianshu-ai/tianshu/commit/e439c678c7ac2de18f8b3bc3e50a07b3d1b5b615))
* **microsandbox:** teach the agent how to start servers without hanging exec ([#119](https://github.com/tianshu-ai/tianshu/issues/119)) ([c03a2f3](https://github.com/tianshu-ai/tianshu/commit/c03a2f3ddcfb5fb9c62620309d3d6bb8ada7b0b1))
* **microsandbox:** tell agents to use existing chromium + libreoffice instead of reinstalling ([#122](https://github.com/tianshu-ai/tianshu/issues/122)) ([16b3363](https://github.com/tianshu-ai/tianshu/commit/16b33634d366876695cd1aabdeb62e9f72e5aa03))


### Refactor

* **chat:** storage owns image base64 + drop legacy helpers + migration 004 ([#84](https://github.com/tianshu-ai/tianshu/issues/84)) ([2a1fa58](https://github.com/tianshu-ai/tianshu/commit/2a1fa580b06b2288b2ff499fbd57613ceb429f69))
* **middleware:** pluggable IdentityResolver chain ([#160](https://github.com/tianshu-ai/tianshu/issues/160)) ([d7e9265](https://github.com/tianshu-ai/tianshu/commit/d7e9265016a6533ec72d421c85174cd2a7a569dc))
* **workboard:** rename todo→ready, retry-on-failure, drop aborted state ([#88](https://github.com/tianshu-ai/tianshu/issues/88)) ([67a8cbb](https://github.com/tianshu-ai/tianshu/commit/67a8cbb77cdf962b198bc5cf1f64518392972095))
* **workboard:** stalled is a label, not a status (3 columns total) ([#90](https://github.com/tianshu-ai/tianshu/issues/90)) ([0c80ae9](https://github.com/tianshu-ai/tianshu/commit/0c80ae97242added8d289b950c56d700f96e8c57))

## [0.2.0](https://github.com/tianshu-ai/tianshu/compare/v0.1.0...v0.2.0) (2026-06-03)


### Features

* day-0 scaffolding ([786a0bd](https://github.com/tianshu-ai/tianshu/commit/786a0bdfb1bdf6cdd5e9e3abd2a03677da7c63b6))

## [Unreleased]

- Initial day-0 scaffolding (Express + WS server, React + Vite web).
