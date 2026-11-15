# bb-plugin-provider-devin

Провайдер `acp-devin` для bb: Devin (SWE-2) через ACP, работающий так же, как Claude и Codex.

## Что внутри

| Часть | Зачем |
|---|---|
| `server.ts` | Объявление провайдера `acp-devin` и регистрация центральных настроек |
| `src/resolve-devin-bin.mjs` | Динамический выбор бинарника и автоматический откат с `KNOWN_BAD_VERSIONS`, включая `3000.12.57`, на старшую здоровую сборку в `~/.local/share/devin/cli/_versions/<ver>/bin/devin` |
| `host.ts` + `src/vendor/acp-bridge.js` | ACP-мост из `@get-bb/plugin-sdk` (собирается `npm run vendor`) с диалектом `devin`: фазовый вотчдог хода, двухступенчатое самовосстановление сессии (`Stage 1` с сохранением контекста через `session/load` и `Stage 2` через `~/.local/state/bb-devin/wedged-sessions.json` + `session/new`), мягкая очередь для `[bb system]` / `[orchestrator]`, синхронизация `permissionMode` (`full` → `bypass`, `accept-edits` → `accept-edits`) и сохранение правил bb треда в `~/.local/state/bb-devin/instructions/<thr>.md` |
| `devin-hooks/` | Хуки Devin CLI: правила bb возвращаются после сжатия и при восстановлении сессии; защита конфигов (`~/.config/devin`, `~/.claude`, хуки); запрет блокирующего ожидания (если он есть у Claude пользователя). Раздача задач и привязка тредов — через плагин `orchestrator` (`bb orchestrator delegate`) |

## Центральная настройка субагентов

`bb plugin config acp-devin set subagentsDisabled true` — тот же контракт, что у
codex/claude-code/agy: server.ts через `deriveProviderOptions` кладёт её в
`options.providerOptions.providerSubagentsEnabled` на каждый thread/start|resume,
а host-обёртка применяет её к `subagents_enabled` в юзерском конфиге Devin —
единственному рычагу, который `devin acp` читает. Запрет запоминает прошлое
значение в dataDir (`subagents-gate.json`) и при выключении настройки его
восстанавливает; `subagents_enabled:false`, поставленный самим пользователем
(в т.ч. `devin-hooks/install.py`), не трогается ни в одну сторону.
Действие глобально — затрагивает и интерактивный `devin` на хосте.

## Центральная настройка памяти

`memoryEnabled` (default **true**, контракт как у codex/claude-code) доезжает до
host-обёртки как `providerMemoryEnabled` — но применять нечего: в этом `devin
acp` локального рычага памяти нет. Memory Drive и auto-notes — облачные фичи,
в юзерском конфиге ключа для них нет (`disabled_tools` существует, но memory-тула
в реестре `devin acp` нет — стемпить имена наугад значило бы врать про эффект).
Гейт логирует «nothing applied» при запросе OFF; когда devin добавит рычаг —
он подключается в `applyMemoryGate` (host.ts).

## Переменные окружения

Переменные окружения моста (`BB_DEVIN_*`) читаются из окружения процесса `bb` — задавайте их только в окружении `bb`, а не в `envVars` треда, иначе хуки и мост разойдутся по каталогам состояния.

| Переменная | По умолчанию | Описание |
|---|---|---|
| `BB_DEVIN_BIN` | _не задана_ | Прямой путь к исполняемому файлу Devin (высший приоритет при выборе бинарника) |
| `BB_DEVIN_KNOWN_BAD_VERSIONS` | `3000.12.57` | Список версий через запятую (пустая строка отключает фильтр) |
| `BB_DEVIN_LLM_IDLE_MS` / `BB_DEVIN_TURN_IDLE_MS` | `75000` | Таймаут простоя генерации LLM (мс) до отправки отмены зависшего хода |
| `BB_DEVIN_OPEN_WORK_MAX_MS` | `3600000` | Предельное время выполнения открытого вызова инструмента (мс) до отмены |
| `BB_DEVIN_CANCEL_GRACE_MS` | `10000` | Льготный интервал (мс) на корректную остановку агента после `session/cancel` |
| `BB_DEVIN_STATE_DIR` | `~/.local/state/bb-devin` | Каталог состояния (инструкции тредов, метки сжатия, `wedged-sessions.json`) |
| `DEVIN_BB_LOG` | `~/.local/state/bb-devin/hooks.log` | Путь к журналу работы хуков Devin |
| `CLAUDE_NO_BLOCKING_WAIT_PATH` | `~/.claude/hooks/no-blocking-wait.py` | Путь к внешнему хуку запрета блокирующего ожидания, проксируемому `no_blocking_wait.py` |

## Установка у пользователя

1. `bb plugin install <путь к этому каталогу> --yes`; запись `devin` из `bb plugin config provider-acp customAgents` убрать (один id не может быть у двух провайдеров).
2. `python3 -I devin-hooks/install.py` — копирует хуки в `~/.local/share/bb-devin/hooks/` (не в чекаут: его переключают на другие ветки), прописывает их в `~/.config/devin/config.json` (чужие хуки пользователя сохраняются), ставит `read_config_from.claude=true` и `subagents_enabled=false`. Скрипт поддерживает комментарии JSONC в `~/.config/devin/config.json` и при наличии комментариев однократно сохраняет резервную копию `config.json.bak` (с правами 0600) перед нормализацией в чистый JSON. Поддерживается режим сухой проверки `python3 -I devin-hooks/install.py --check`. После правки хуков в репозитории — запустить снова.
3. Новые сессии Devin подхватывают хуки сразу; работающие — после перезапуска процесса (`bb thread stop <id>`, когда тред в простое).

Журнал хуков: `~/.local/state/bb-devin/hooks.log` (переопределяется через `DEVIN_BB_LOG`).

## Проверки

```bash
npm test                                   # все наборы Node (gate, resolve-bin, dialect, e2e) и Python-хуков
npm run typecheck                          # проверка типов TypeScript (tsc --noEmit)
npm run vendor                             # пересборка src/vendor/acp-bridge.js из SDK
python3 -I devin-hooks/install.py --check  # проверка хуков и конфига без внесения изменений
```
