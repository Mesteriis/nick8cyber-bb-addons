# bb-plugin-provider-argon — vendored acp-argon

ACP-провайдер «Argon — Gemini Web»: `acp-server.mjs` (JSON-RPC stdio,
пул аккаунтов + леджер/лизы/ротация/отмена) + `src/gemini-driver.js`
(Playwright/CDP к Gemini Web, модель+thinking picker, стрим).

**Живая копия — `/home/ubuntu/.local/share/argon-gemini/`** (туда указывает
`customAgents` у builtin provider-acp). Эта директория — источник истины в
нашем репо: при правках провайдера синхронизировать сюда тем же коммитом.

`bin/gemini.js`, `scripts/` — ручные утилиты; запускать ТОЛЬКО без активных
Argon-тредов (обходят очередь/лиз).

`ARGON_FAKE=1` — офлайн-режим для тестов протокола (без леджера/аккаунтов).
