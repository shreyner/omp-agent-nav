# Проверки и доказательства

Дата: 2026-10-15. Проверки используют временные Git-проекты и хранилище сессий, а также fake model provider.
Settings, SDK, Git/worktree и Mnemopi выполняются настоящими модулями установленного omp 18.11.0; проверки подтверждают поведение, а не наличие строк исходника.
Прежний общий прогон source-entry варианта сохранён отдельно. Текущие интеграционные проверки запускают обычный установленный omp с расширением из временной конфигурации, без launcher; отдельный source-test harness проверяет штатные классы. Итоговый общий прогон и сборка успешны.

<a id="baseline"></a>
## Исходная версия и окружение

Выбрана опубликованная версия `@oh-my-pi/pi-coding-agent` **18.10.3**.
2026-10-15 поддержка перенесена на 18.11.0: обновлены `SUPPORTED_OMP_VERSION`, peerDependencies, диагностические строки и спека; полный прогон против живой 18.11.0 зелёный (итоги — в таблице результатов ниже). Baseline 18.10.3 ниже сохранён как исторический.
Исходники апстрима — commit `81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b` в [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (npm SLSA provenance gitCommit); локальный checkout только для чтения лежит в `upstream/oh-my-pi` и в репозиторий не входит.
Работающий extension импортирует **установленный** package, а checkout используется только как источник документации; его код и файлы установленного пакета не менялись.

Точки интеграции штатных механизмов: [InteractiveMode](https://github.com/can1357/oh-my-pi/blob/81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b/packages/coding-agent/src/modes/interactive-mode.ts), [SessionManager](https://github.com/can1357/oh-my-pi/blob/81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b/packages/coding-agent/src/session/session-manager.ts), [AgentSession](https://github.com/can1357/oh-my-pi/blob/81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b/packages/coding-agent/src/session/agent-session.ts), [Settings](https://github.com/can1357/oh-my-pi/blob/81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b/packages/coding-agent/src/config/settings.ts), [TaskTool schema](https://github.com/can1357/oh-my-pi/blob/81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b/packages/coding-agent/src/task/types.ts), [Mnemopi backend](https://github.com/can1357/oh-my-pi/blob/81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b/packages/coding-agent/src/mnemopi/backend.ts).
Исходный task не имел cwd, backend сабагента использовал parent alias, банк зависел от cwd. Исправления реализованы локальным bridge без нового upstream API.

Подтверждены Bun 1.4.2, Go 1.27.1 darwin/arm64, gopls 0.23.0 и Rust/Cargo.
Upstream `bun setup/install` не запускался. Пользователь разрешил текущую разработку без worktree; продуктовые проверки создают worktree во временных проектах.

<a id="bridge-probe"></a>
## Проверка module graph и штатной загрузки

Первичная print-проба bundled CLI показала доступный registry/session host, но другой registry исходных modules; запись memory marker из исходного модуля не была видна bundled host getter.
Временный исходный отчёт: `/private/tmp/omp-agent-nav-probe-6b75ejhp/report.json`; переносимый вывод — импорт исходных modules сам по себе не управляет состоянием bundled `dist/cli.js`.

Прежняя реализация запускала опубликованный `src/cli.ts` с расширением. Её [runtime.test.ts](../test/runtime.test.ts) проверял обнаружение пакета, отказ неподдерживаемой версии или отсутствующего entrypoint, запуск и полный print-сценарий через fake provider.
Исторические print-процессы проверяли bridge, регистрацию tools, SID/storage A → B → A, SYSTEM literal/default/template, сохранение явного CLI prefix и фабрик основной сессии.

Повторные изолированные пробы обычного omp 18.10.3 в `/private/tmp/omp-bundle-canonical-awk4mv94` подтвердили: canonical imports через штатный shim используют registry/session/task/settings bundle. File URL импорты прежнего bridge обходили этот shim.
Текущая реализация загружает полный extension через `extensions`/`-e`; bin удалён. Конфигурационное подключение файла и каталога пакета, print-переезды, SYSTEM и target task проверены отдельными bundled процессами.
Mnemopi library adapter отдельно подтверждён native backend операциями и реальными SQLite состояниями в [bundled-memory.test.ts](../test/bundled-memory.test.ts); проверка памяти не опирается на один только module identity marker.

<a id="results"></a>
## Выполненные проверки

### Исторический baseline source-entry варианта

Следующие результаты получены до миграции на штатный bundled entrypoint. Они сохраняют исходный охват, но не являются результатами новой поставки.

| Команда / способ | Фактический результат | Граница |
|---|---|---|
| `bun test ./test` | 58 pass, 0 fail, 610 expect() calls, 9 файлов, 24.74 s | Итоговый прогон всех тестов прежней реализации, включая strict TUI/RPC и дополнительные task/MCP сценарии. |
| `bun test ./test/task.test.ts ./test/memory.test.ts ./test/embedding-lifetime.test.ts` | 28 pass, 248 assertions: task 24, memory 3, lifetime 1 | Контекст цели, журнал/park/revive, две worktree, startup/rollback памяти и все task/MCP случаи ревью. |
| Проверки навигации, [navigation.test.ts](../test/navigation.test.ts) | 13 pass, 97 assertions | Пути/refs/HEAD, точный ignore, metadata/разрешения, чистое создание и удаление, безопасная очистка после ошибки. |
| Проверки host/runtime/MCP/grants | 15 pass, 107 assertions после host исправлений | Цикл агента, task B без AGENTS A, rollback, Setting handles, MCP/разрешения и область инструкций. |
| `bun test ./test/integration-modes.test.ts` | 2 pass, 158 assertions, 6.14 s после host исправлений | Реальные TUI/RPC, отказ при активной BTW, контекст A/B/A, диагностика ветки через gopls/workspace checker и цикл worktree. |
| `bun run check` | Exit 0 после итогового общего прогона | Bun build с внешними пакетами; результаты только в `/private/tmp/omp-agent-nav-build`. Проверка типов TypeScript не выполняется. |

Независимое ревью после исправлений: native task — 24 pass/221 assertions; отдельная проверка срока жизни relocation hooks — 1 pass/11 assertions; новых замечаний нет.
`git status --short` исходного checkout upstream пуст. Исправленные замечания не записывались как оставшийся техдолг.

### Текущая поставка: обычный bundled omp

Bundled subprocess fixtures ниже используют обычный установленный `omp`, временные конфигурацию/session storage/банки и fake provider. Source-test harness выполняется отдельно через `bun test`, используя исходные library modules того же установленного пакета; общий прогон включает оба вида проверок. Старые числовые результаты не переносятся на новый запуск.

| Команда / способ | Фактический результат | Граница |
|---|---|---|
| `bun test ./test` | **69 pass, 0 fail, 801 expect() calls, 12 файлов, 49.39 s** | Итоговый прогон 2026-10-15 (NAV-08 + NAV-09 + миграция на живой omp 18.11.0): обычные bundled config/print/TUI/RPC/task/memory процессы и отдельный source-test harness. Инъектируемый `mcpStartupWait` ускорил unready-MCP кейс (подмена бюджета в тесте вместо реального ожидания). |
| `bun test ./test/runtime.test.ts` | 5 pass, 74 assertions (прогон 2026-10-15) | Конфигурационная загрузка файла/каталога, exact version, print A/B/A с SID/storage, task B, штатный и точный worktree cycle. Проверки SYSTEM literal/default/template/CLI append удалены 2026-10-19 вместе с клоном; вместо них — граница SYSTEM.md (после A → B действует SYSTEM.md A) и сверка hosted-модулей с реестром bundle. |
| `bun test ./test/integration-modes.test.ts` | 2 pass, 158 assertions | Обычный bundled TUI/RPC, активная BTW, контекст/skills/commands/settings A/B/A, mixed batch, gopls/workspace checker и цикл worktree. |
| `bun test ./test/bundled-task.test.ts` | 1 pass, 127 assertions | Task вызывается моделью: single B, batch A/B/worktree B, target MCP/settings/skills/model/память до запроса, живой B после main C и native park/revive. |
| `bun test ./test/task.test.ts` | 24 pass, 214 assertions, 5.49 s | Явный source-test runtime: native executor/schema/isolation, task/MCP ошибки, журнал/session switch, concurrency и вложенные задачи; бюджет MCP-startup подменяется на 10 мс в unready-кейсе, ожидание pid-файла и смерти процесса поллингом. |
| `bun test ./test/host-grants.test.ts` | 3 pass, 30 assertions | NAV-06/NAV-08: сохранение/восстановление грантов, защита цели живого сабагента; workspace grant: suggestedGrants в permission-отказе, worktree→primary, skip уже принятых, запрет .git-метаданных, persist ledger. |
| `bun test ./test/host-move-approval.test.ts` | 6 pass, 27 assertions, 0.34 s | NAV-09: условная approval-декларация session_move (prompt вне корней только при интерактивном owner), approve → grant+move с записью ledger (грант виден до applyPending), повтор без диалога, `.git` без запроса, hint для task.cwd, headless fail-closed без гранта. |
| [bundled-memory.test.ts](../test/bundled-memory.test.ts), включён в итоговый прогон | 1 pass; дополнительные node assertions внутри fixture | Primary/два worktree/B/legacy, native save/status/stats, startup failure, custom LLM, удержанный embedding request, dispose/rebind/postmortem и clear ownership/race. Source memory/lifetime tests также успешны в общем прогоне. |
| `bun run check` | Exit 0; external Bun bundle 101.39 KB; biome check без замечаний | Сборка расширения плюс статический гейт Biome 2.5.15 (`--error-on-warnings`); это не TypeScript compiler check. Состав обновлён 2026-10-16. |
| `bun run lint`; итоговый прогон после разового reformat | lint: 0 ошибок и 0 warnings; reformat 2026-10-16 по src/test/bin верифицирован полным прогоном 69 pass, 0 fail, 802 expect() calls, 12 файлов, 50.04 s | Форматирование и порядок импортов не меняют поведение: фикстуры в template-строках тестов не переформатировались; поведенческий прогон — доказательство. |
| `bun run lint` / `bun run check` после ужесточения правил и декомпозиции | lint: 0 нарушений (26 файлов); check: Exit 0, bundle 106.93 KB; контрольные полные прогоны после каждого этапа — 69 pass, 0 fail, 802 expect() calls, ~49.5 s | 2026-10-16: `useBlockStatements` (247 автофиксов через `fix:unsafe` с ревью), `noExcessiveCognitiveComplexity` ≤ 15 (6 функций декомпозированы), `useSortedInterfaceMembers`; host.ts (1212 строк) разрезан на src/host/{bridge,coordinator,grants,mcp}.ts + тонкий реэкспорт. Поведение подтверждено полным прогоном после каждого шага. |
| `bun run check` с гейтом TypeScript; `bun test ./test` на глобальном omp 18.12.2 | 2026-10-19: до правок прогон дал 66 pass / 3 fail — все три падения из-за хоста вне матрицы (warning в stderr, точное сравнение версии), а не поведения. После правок: `tsc -p .` — 0 ошибок (было 42: 13 в src, 29 в тестах); check Exit 0; **69 pass, 0 fail, 813 expect() calls, 12 файлов, 49.80 s** | `typescript` 7.0.2 и `@types/bun` 1.4.3 — dev-зависимости; модули хоста объявлены в [types/host.d.ts](../types/host.d.ts) и типизируются интерфейсами `*Like` в месте вызова. Typecheck нашёл runtime-ошибку: ветка `runSubagentTask` обращалась к `TaskTool` вне области видимости (EXT-03), теперь фабрика передаётся параметром. Тесты версии принимают непроверенный хост того же major; warning выводится один раз на версию. |

Промежуточный общий прогон до исправлений дал 58 pass, 4 fail, 615 expect() calls в 11 файлах за 80.99 s. Исправлены source-task configured harness и bundled fixture, который должен вызывать зарегистрированный tool через модель, а не напрямую native base tool. Эти результаты не использованы как приёмка.
Независимое ревью runtime и памяти после исправлений не оставило замечаний. Дополнительно проверены canonical read/prompt inputs, CLI append в template и memory clear race; новых записей техдолга нет.

<a id="global-loading"></a>
### Глобальное подключение обычного omp

2026-10-13 в `~/.omp/agent/config.yml` добавлен путь `<clone>/src/index.ts`; остальные настройки сохранены. Mode файла остался `0600`; backup — `~/.omp/agent/config.yml.<backup>`.

| Способ | Фактический результат | Граница |
|---|---|---|
| Обычный `omp` без аргументов из временного проекта A, реальный PTY | Показал omp 18.10.3 и `/nav-move` в autocomplete; завершился с exit 0 | Глобальная загрузка без `-e`, `--config` и замены agent directory; запрос модели не отправлялся. |
| `omp --session-dir /private/tmp/omp-global-load-rr2cLe/sessions`, реальный PTY | `/nav-move` выполнил A → B → A; footer показал целевые каталоги | Расширение унаследовано из того же глобального config. Каталоги, session storage и DB памяти — временные fixtures; коммерческий провайдер не использовался. |

Проверочные артефакты находятся в `/private/tmp/omp-global-load-rr2cLe`. Это smoke загрузки и команды перехода; он не подтверждает выбор инструментов, поведение сабагентов или качество ответов реальной модели.
2026-10-13 после переименования проекта в `<clone>` глобальный extension path обновлён с сохранением mode `0600`. Повторный обычный omp без `-e`/`--config` загрузил `/nav-move` и завершился с exit 0 без запроса модели; proof — `/private/tmp/omp-root-path-fix-OoAxnB/final-proof.json`. 21 проверенный source/test файл сохранил прежние хеши. Focused `bun test test/runtime.test.ts` из нового корня: 5 pass, 0 fail, 74 expect() calls, 10.38 s.

<a id="manual-model"></a>
### Ручной прогон с моделью

[manual-testing.md](manual-testing.md) содержит один готовый промт M01–M08: модель сама создаёт A/B/C внутри нового fixture в начальном разрешённом cwd, затем проверяет навигацию, single/batch task и временную Mnemopi. Статус на 2026-10-13: **выполнен** — M01–M07 PASS (модель zai/glm-5.3, session 01a13587-da38-76d5-b219-9b63dbc8c7d9, runId 20261013-2ba66a, fixture `<fixture>`, отчёт `manual-result.md`: 22 applied / 3 expected-failed). В ходе прогона найден и исправлен критический хардкод бюджета MCP-startup (5 с → 30 с, `host.ts`/`task.ts` + спека). M08 async/lifecycle остаётся вне этого прогона. Микро-расхождения с промтом: initial branch `master` вместо `main`; `autolearn.enabled=false` не задан (записи оставались внутри fixture-банка); `git check-ignore -v` не выполнялся (чистота статуса проверена косвенно); согласованный `git worktree add` внешнего worktree сверх базового промта.
Два worktree разделяют сценарии: nav-probes сохраняет живых детей и проверяет busy-защиту; nav-cleanup не получает детей и проверяет active/dirty отказы, чистое удаление и сохранность ветки/коммита. Ручное закрытие детей и предварительная подготовка папок не требуются.
Исторически прежний внешний shell/Python-блок подготовки выполнен 2026-10-13 в `/private/tmp/omp-nav-manual.a2fm0w2m`: три Git-репозитория, FIXTURE/агентские определения, конфиги без extensions и dirty/untracked A проверены; omp/модель в этом fixture не запускались. Это доказательство только прежнего блока, который заменён новым промтом; его результаты не переносятся на новый сценарий.
После фактического прогона записывать дату, omp version, модель, доступный session ID, root/runId, PASS/FAIL/NOT RUN каждого шага и реальные tool/file evidence. Отчёт — `<fixture>/manual-result.md`, ссылка и итог добавляются сюда. Явные тестовые записи ограничены fixture; штатный старт, автоматическая память и session storage настоящей сессии остаются под её обычными настройками.
2026-10-15 (повтор на живой 18.11.0, модель zai/glm-5.3): S1 + M01–M07 PASS в полигоне `<polygon>/nav-manual` (runId `navman-20261015-165628`; session `01a14007-8532-7408-828d-effb275d94cd`, после переходов актуален JSONL `2026-10-15T14-58-27-405Z_01a14012-5bcd-7749-a85a-63e03c4039c5.jsonl`). Отчёт: `<полигон>/nav-manual/manual-result.md`; реестр 19 applied / 3 ожидаемых отказа. M08 = NOT RUN (`async.enabled: false` в конфигах полигона). Отличия от baseline 18.10.3: у отказов `worktree_remove` появились префиксы `busy:`/`git:`; журнал сессии пересоздаётся с новым UUID при навигационных переходах (подкритерий M02 session-id зафиксирован как расхождение; [INFERENCE] метод «самый свежий JSONL» нестабилен в живой сессии с session_move). Прочие NOT RUN: LSP при переходах, инъекция rollback-ошибок, реальный embeddings transport.

Живой прогон approval-диалогов (M09) выполнен отдельно в `…/nav-approval` — итоги в [V18](#v18).

## Обязательные сценарии и покрытие

V01–V16 ниже описывают контракт и покрытие. Где source-test harness проверяет штатные классы отдельно, это дополнение к обычным bundled процессам, а не замена им; точные результаты находятся в текущей таблице выше.

<a id="v01"></a>
### V01. A → B → A, контекст и LSP

**NAV-01, NAV-04.** [runtime.test.ts](../test/runtime.test.ts), [integration-modes.test.ts](../test/integration-modes.test.ts).
Print проверяет неизменный SID, перенос/возврат JSONL и AGENTS цели. С 2026-10-19 он же закрепляет границу SYSTEM.md: после A → B действует SYSTEM.md стартового A, а SYSTEM.md цели B не подхватывается. TUI/RPC дополнительно проверяют settings, skills, файловые команды и заголовки сохранённой сессии.
TUI/RPC подтвердили отсутствие AGENTS чужого разрешённого проекта при A → B → A. С 2026-10-19 B в этих прогонах разрешён через `--add-dir` и после перехода хранится в ledger; доступ через `workspace_grant` проверяют source-тесты [V20](#v20). Заголовок сохранённой сессии содержит прежний SID и вернувшийся cwd; доступ к B сохранён отдельно.
Для Go `diagnostics file:"*"` использует штатный workspace checker (`go build ./...`), а `*.go` — настоящий gopls. Обе проверки различили ошибочную WT-ветку и корректный primary; после exit gopls снова работал в primary.
До 2026-10-19 print также проходил A default → B text override → A default → B template для клона рендерера; эти проверки удалены вместе с клоном.

<a id="v02"></a>
### V02. Queued → apply → следующий запрос модели

**NAV-02.** [host.test.ts](../test/host.test.ts), [runtime.test.ts](../test/runtime.test.ts).
Подтверждён порядок цикла с fake provider: tool queued, await apply, сохранённый итог и второй запрос модели. Queued сам по себе не меняет cwd; applied виден модели без ввода пользователя.
2026-10-19 (CR-1): по вызовам провайдера итог встречается 0/1/1 раз (до перехода / после него / в следующем прогоне), в состоянии агента — один раз. Старый код давал 2 в следующем прогоне и рос с числом переходов.

<a id="v03"></a>
### V03. Смешанные пакеты, вложенные вызовы и сабагенты

**NAV-03.** [host.test.ts](../test/host.test.ts), [integration-modes.test.ts](../test/integration-modes.test.ts).
Проверка агента блокирует весь move+write пакет до эффекта; вложенный tool ID не допускается; tools навигации удалены у сабагента. До 2026-10-19 context depth/kind дополнительно ограничивали context API (NAV-07, снято).
Интеграционный тест подтвердил отсутствие тестового write-файла после смешанного пакета в реальных TUI/RPC.

<a id="v04"></a>
### V04. Отмена, BTW и восстановление

**NAV-04, NAV-05.** [host.test.ts](../test/host.test.ts), [task.test.ts](../test/task.test.ts), [integration-modes.test.ts](../test/integration-modes.test.ts).
Проверены отмена/закрытие, моделируемая занятость, ошибка подготовки, native rollback и ошибка восстановления с остановкой следующего запроса провайдеру.
Отказ открытия памяти B возвращает основной сессии cwd/file/settings/bank A и допускает следующий ответ fake provider в A, без сохранения ошибки B.
Реальная активная BTW в TUI/RPC дала failed notice с неизменными cwd/storage; отмена queued также сохранила исходную сессию. Общий ephemeral counter защищает все режимы, TUI сохраняет штатное ограждение.
2026-10-19: два одновременных `request()` — первый queued, второй отказ «pending», применяется первый (CR-8; прежний код принимал оба). Восстановление проекта со сломанным MCP-сервером публикует поднявшиеся инструменты и не бросает — [host-mcp.test.ts](../test/host-mcp.test.ts) (CR-5). С того же дня (решение пользователя) так же ведёт себя и прямой переход. `relocate` в B со сломанным сервером даёт cwd B и warning «MCP startup failed». Итог coordinator `applied` несёт `warning` в контекст модели. MCP prompt-команды прежнего проекта снимаются — [host.test.ts](../test/host.test.ts), [host-mcp.test.ts](../test/host-mcp.test.ts). Четыре перехода без изменения корней пишут одну запись ledger, прежде — четыре (CR-10).

<a id="v05"></a>
### V05. Разрешения и canonical paths

**NAV-06.** [host-grants.test.ts](../test/host-grants.test.ts), [navigation.test.ts](../test/navigation.test.ts).
Штатный manager сохраняет разрешение B через A/B/worktree и восстановление состояния. Отзыв B не обходится через посещённые пути. Отдельные gitDir/commonDir и их aliases внутри разрешённых корней запрещены.
Разрешения проверяются отдельно от загрузки проектных инструкций.
С 2026-10-19 (гранты только в ledger) проверки идут через настоящий штатный `moveTo` — [V20](#v20).

<a id="v06"></a>
### V06. TUI, print, RPC и version bridge

**Режимы omp** (до 2026-10-19 — и NAV-07). [runtime.test.ts](../test/runtime.test.ts), [integration-modes.test.ts](../test/integration-modes.test.ts). С 2026-10-19 фикстуры ставят запросы через `bridge.coordinator(ctx)`, а не через context API.
Print, TUI и RPC запускаются обычным установленным `omp` с extension из временной конфигурации. Реальный TUI работает в PTY, RPC — дочерний процесс со штатным JSON protocol; fake provider выполняет зарегистрированные tools.
Конфигурационная загрузка файла и каталога пакета прошла; TUI/RPC context/BTW/LSP и сохранённый заголовок JSONL подтвердили единый контракт. Несовместимая версия отклоняется; runtime не требует `src/cli.ts` и не запускает его.
2026-10-19 (EXT-16): хост, чья версия отличается от omp в PATH, отклоняется сообщением «differs from the running omp» — [runtime.test.ts](../test/runtime.test.ts).
2026-10-19 (EXT-01/EXT-14): каждый specifier `hostedModules` присутствует в реестре модулей `dist/cli.js` установленного omp — [runtime.test.ts](../test/runtime.test.ts); разовая сверка: 24/24 на 18.11.0 и 18.12.2.

<a id="v07"></a>
### V07. List/enter/exit

**WT-01, WT-05.** [navigation.test.ts](../test/navigation.test.ts), [integration-modes.test.ts](../test/integration-modes.test.ts).
Штатный реестр показывает primary/worktree; enter принимает зарегистрированный корень текущего проекта, exit возвращает primary без удаления.
Tools модели в реальных TUI/RPC завершили create/list/enter/exit/remove. Worktree удалён, ветка и коммит сохранены, primary чист; SID/cwd сохранённого заголовка совпали с начальной сессией.

<a id="v08"></a>
### V08. Create и сохранность исходных изменений

**WT-02, WT-04.** [navigation.test.ts](../test/navigation.test.ts).
Изменения и untracked primary сохраняются; новый worktree чист и создан от явного ref или текущего HEAD, включая вызов из worktree с собственным коммитом.
Descendant clone=false/keepChanges=false, exact local exclude не меняет .gitignore. Внешний clone не переносит исходные изменения.

<a id="v09"></a>
### V09. Точный path, managed base и очистка после ошибки

**WT-03, WT-04.** [navigation.test.ts](../test/navigation.test.ts).
Проверены относительные пути от primary, ~, managed base через Settings handle, сохранение inode пустого каталога и отказы occupied/metadata/dangling/overlap/missing-ref до создания ветки.
Существующая ветка не сбрасывается. Точное ignore правило сохраняется с диагностикой при ошибке; общий файл не обрезается.
Собственный чистый неизменённый partial убирается, изменённые данные и их ветка сохраняются.

<a id="v10"></a>
### V10. Remove

**WT-06.** [navigation.test.ts](../test/navigation.test.ts), [host-grants.test.ts](../test/host-grants.test.ts).
Проверены отказы для primary, текущей сессии, живого сабагента и dirty/untracked/locked/detached/unavailable. Безопасное удаление оставляет ветку и коммит.
Изолированный сабагент также защищает исходный worktree независимо от физического cwd sandbox. Force/rm обхода нет.

<a id="v11"></a>
### V11. Проект одиночного и пакетного task

**TASK-01, TASK-02.** [task.test.ts](../test/task.test.ts), [bundled-task.test.ts](../test/bundled-task.test.ts).
Сабагент B получает B AGENTS, agents, skills/rules, prompts, extensions/custom tools/MCP/settings без ресурсов и дополнительных корней A.
Пройдены дополнительные сценарии: задержанный MCP каталог виден до первого запроса модели; failed/pending блокируют провайдер и закрывают процессы; ошибка подготовки или policy закрывает managers остальных элементов; browser MCP сохраняется у агента без eval.
Режим планирования сохраняет отсутствие isolated и отклоняет явно недоступные controls. Дубли имён после trim/lowercase отклоняются до артефактов.
Сабагент с настроенным расширением выполняет обычный native task без cwd; попытка назначить другой cwd получает отказ. Вложенная async задача завершилась при занятом родителем root gate, используя штатный лимит потомка.
Без cwd фиксируется исходный каталог; элементы пакета независимы. Ошибка policy цели не запускает провайдер других элементов.
2026-10-19: два task подряд в B запускают сервер MCP цели один раз (pid не меняется), и неудачный preflight третьего вызова его не закрывает (CR-4; прежний код поднимал второй процесс). Поля seance доходят до preflight цели: отсутствующий источник даёт ошибку поиска, источник без модели — «no saved model», провайдер не вызывается (EXT-02; на хостах без seance тест пропускается). Сабагент без отработавшего `session_start` выполняет обычный native task (EXT-03).
Проверены сохранение штатной single/batch схемы, общий лимит async jobs и суммарный progress; description/schema обновляются после move.
2026-10-19: обёртка отдаёт штатные `renderCall`/`renderResult` и `mergeCallAndResult: true`. Approval-детали сохраняют штатные строки (`Context:`) и добавляют `Cwd`, `Cwd (<name>)` и `Cwd (#n)` для каждого назначения — [task.test.ts](../test/task.test.ts). Граница: отрисовка в живом TUI не проверялась, тест проверяет только наличие делегирующих функций.
Bundled proof использует реальные model toolCalls зарегистрированного task: single B и batch A/B/worktree B завершились успешно. Перед первым запросом каждый ребёнок имел нужные model/settings/AGENTS/agents/skills/MCP, пустые inherited roots и отдельные memory state/соединение; worktree B разделял банк B.
`task.test.ts` использует source-test runtime и отдельный configured task fixture для штатных классов. Его результаты не выдаются за запуск полного расширения через bundled CLI.

<a id="v12"></a>
### V12. Журнал, move/switch и park/revive

**TASK-03.** [task.test.ts](../test/task.test.ts), [bundled-task.test.ts](../test/bundled-task.test.ts).
Работающий B пишет журнал после переезда основной сессии A → C. Стабильный artifact anchor следует за переносом JSONL родителя.
Новый SID родителя получает новый anchor; прежние сабагенты B сохраняют журнал и банк. Штатный park/revive продолжает B и пишет в прежний файл.
2026-10-19 (EXT-05): якорь лежит в `omp-agent-nav/anchors/` и отсутствует в `listAllSessions` хоста, где реальный транскрипт есть; старая пара `.omp-agent-nav/<SID>` переносится, журнал ребёнка сохраняется; после `setSessionFile(<якорь>)` повторная синхронизация оставляет ссылку на реальный файл, append проходит. На прежнем коде оба теста падали.
В обычном bundled omp B удерживался внутри fake provider, пока main A → C менял каталог и банк. После освобождения B завершил запись в прежний JSONL; native park/revive сохранил его SID/cwd/file/bank/model и следующую запись без инструкций C.

<a id="v13"></a>
### V13. Isolated target

**TASK-04.** [task.test.ts](../test/task.test.ts).
Штатная изоляция начинается из B при родителе A и сохраняет общий банк B. Исходные project identity/settings определяют контекст вместо временного пути sandbox.

<a id="v14"></a>
### V14. Canonical memory bank

**MEM-01.** [memory.test.ts](../test/memory.test.ts), [navigation.test.ts](../test/navigation.test.ts), [bundled-memory.test.ts](../test/bundled-memory.test.ts).
Primary и два новых worktree имеют один банк и отдельные состояния; другой проект изолирован. Prefix/global/tagged и идентификаторы обычных cwd сохранены.
Старый WT банк заполнен заранее, исключён из recall и сохранён на диске без миграции.

<a id="v15"></a>
### V15. Memory startup и lifetime

**MEM-02, MEM-03.** [memory.test.ts](../test/memory.test.ts), [task.test.ts](../test/task.test.ts), [embedding-lifetime.test.ts](../test/embedding-lifetime.test.ts), [bundled-memory.test.ts](../test/bundled-memory.test.ts).
Явная запись Mnemopi сабагента работает через собственный backend; autoRetain=false, закрытие не закрывает состояние основной сессии.
Обязательная ошибка startup блокирует первый запрос сабагента; ошибка перехода основной сессии восстанавливает A.
Штатные dispose/relink сессии не останавливают общий embedding client; postmortem завершает его один раз. Реальная нагрузка embeddings не измерялась.
В обычном bundled процессе native save/status/stats выполняются с собственным state расширения; отдельный fake custom LLM также вызывается из Mnemopi через host provider. После удаления синхронизации `api-registry` (2026-10-19) этот вызов по-прежнему проходит: реестр хоста виден библиотеке через штатный shim.
Настроенный Mnemopi startup заканчивается до первого prompt; обязательная ошибка не достигает провайдера. Незавершённый embedding request пережил native child dispose и main rebind; остановка собственного клиента при postmortem одна.
Clear отказал до эффектов при общей открытой базе. После допустимого clear новое состояние осталось владельцем; удержанная clear/rehydration блокировала параллельный startup второго владельца того же банка.
2026-10-19 (CR-6): после отказа открытия базы и устранения причины следующий `ensure` поднимает память; прежде сохранённая ошибка бросалась без повторной попытки до перезапуска.

<a id="v16"></a>
### V16. Документы и соответствие коду

**DOC-01.** AGENTS, восемь основных spec-файлов и дополнительный manual-testing.md проверяются на UTF-8, fences, JSON, local links/anchors, стабильные ID и реальные source/test targets.
Контракты сверены с types/index/runtime/host/navigation/task/memory, включая сохранение фабрик основной сессии, before-model barrier, штатные task modes и локальный bridge API.
Историческая проверка до миграции: UTF-8, отсутствие trailing whitespace, fences, 3 JSON-примера, 196 локальных ссылок с anchors, 21 уникальное требование со связями коду/проверке, 16 сценариев, F1–F7 и TD-01.
2026-10-13: итоговая read-only Python-проверка AGENTS + восьми spec прошла: UTF-8/whitespace/fences, 3 JSON-примера, 216 локальных ссылок с anchors, 21 стабильное требование со статусом «проверено», 16 сценариев и F1–F7. Статусы и границы сверены с итоговым общим прогоном.
Сверены пять вариантов WorkspaceRequest, поля и статусы WorkspaceResult, шесть navigation tools и версия package.json. Это проверка соответствия документации, а не замена поведенческим тестам.
Better Text guard: structural issues и backup errors отсутствуют; changed fingerprints ожидаемы из-за новой поставки, конфигурационного примера, memory bridge/clear контракта и результатов. Изменения защищённых элементов просмотрены вручную; автоматический verify вернул review-required, а не безусловный success.
После добавления manual-testing.md 2026-10-13 повторная read-only проверка AGENTS + девяти spec прошла: UTF-8/whitespace/fences, 3 JSON-примера, 225 локальных ссылок с anchors и прежние 21 ID требования. Прежний shell-блок подготовки прошёл `zsh -n`, вложенный Python — AST/compile; его подготовка отдельно выполнена и проверена во временном fixture. Новый единый промт и запросы модели не выполнялись. Better Text guard для README/verification/assumptions не нашёл structural issues/backup errors; ожидаемые изменения ссылок, anchors и чисел проверены вручную.

После перехода на единый self-contained промт и переименования корня повторная статическая проверка AGENTS + девяти spec прошла: UTF-8/whitespace/fences, 224 локальные ссылки с anchors, 3 JSON-примера и 21 прежний requirement ID. В manual-testing.md один text-блок без внешнего prep и обязательного UI checkpoint; встроенные JSON-параметры проверены. На момент этой проверки новая версия промта с моделью ещё не запускалась (фактический прогон позже в тот же день — см. [manual-model](#manual-model)).
<a id="v17"></a>
### V17. Workspace grant и recovery-hint

**NAV-08.** [host-grants.test.ts](../test/host-grants.test.ts).
Permission-отказ навигации вне корней несёт primary-корень цели (suggestedGrants) и подсказку вызова в сообщении.
`grantWorkspaceDirs` резолвит worktree в primary, пропускает уже принятые корни, записывает корень в ledger и переживает восстановление состояния сессии. С 2026-10-19 корень в штатный список дополнительных каталогов не попадает; до этого он добавлялся через штатный `addWorkspaceDirectory`.
Инструмент `workspace_grant` зарегистрирован только для main, входит в solo-batch gate (NAV-03) и объявляет approval `write` с обязательной `policy: "prompt"` — диалог подтверждения действует в любом режиме omp, включая yolo; без интерактивного UI вызов fail-closed.
2026-10-19 (CR-9 — [host-grants.test.ts](../test/host-grants.test.ts), CR-3): стартовый проект считается принятым — `workspace_grant ["."]` в нём даёт skipped, а не ошибку хоста «already the primary workspace root»; пакет `[B, <отсутствующий>]` падает до первого гранта, B не выдан. Исчезнувший стартовый проект не роняет omp необработанным rejection и не блокирует навигацию между выданными корнями — [navigation.test.ts](../test/navigation.test.ts). До исправления все три проверки падали.

<a id="v18"></a>
### V18. Интерактивный session_move с подтверждением

**NAV-09.** [host-move-approval.test.ts](../test/host-move-approval.test.ts).
Approval-декларация session_move вычисляется по аргументам: вне принятых корней при наличии интерактивного owner — tier write + обязательная policy prompt (диалог переживает yolo), внутри корней и без owner — write; formatApprovalDetails выводит путь цели и, если он отличается, выдаваемый корень.
Approve выполняет вызов: grantWorkspaceDirs выдаёт грант корня цели до валидации (ledger, session-scope), queued → applied доходит до смены cwd; повторный переход в подтверждённый корень не спрашивает.
`.git`-цель сохраняет write и прежний отказ «Git metadata is not a workspace»; task.cwd вне корней сохраняет permission-отказ с suggestedGrants; без owner переход не грантует и возвращает прежний permission-отказ с подсказкой.
Живая TUI-проверка 2026-10-15 (omp 18.11.0; отчёт `<polygon>/nav-approval/manual-result.md`): M09-grant PASS — approve → applied, корень выдан, возврат/повтор/возврат без диалога; M09-deny PASS — `Tool call denied by user: session_move`, cwd стабилен, диалог воспроизводится на каждом вызове; M09-git PASS — `permission: Git metadata is not a workspace: …` без диалога (гард `.git` срабатывает до approval). M09-wg: deny и выдача гранта PASS (raw `roots` содержит корень), но FAIL ожидания «грант снимает диалог» — на грантированный через `workspace_grant` корень approval-диалог session_move возник дважды. Дословные reason/dir диалогов человек не продиктовал: наличие/отсутствие диалогов подтверждено его ответами и raw-результатами вызовов.
**Разбор 2026-10-19 по журналу сессии M09 (сам отчёт `manual-result.md` с полигоном не сохранился).** Причина M09-wg — сравнение путей, а не два источника корней. Модель передавала `dir` под `$TMPDIR` (`/var/folders/…`), а ledger хранит realpath (`/private/var/folders/…`): `grantWorkspaceDirs` пишет `mainRoot` после realpath, а `moveNeedsGrant` сравнивал лексический путь, поэтому `pathIsWithin` давал false и диалог появлялся на каждом вызове. «Дважды» — два отдельных вызова session_move. Тот же механизм опровергает вердикт M09-grant «повтор без диалога»: повторный вход шёл с тем же `/var/…`-путём и занял 2 минуты против 3–8 мс у переходов без диалога; «без диалога» в этом пункте утверждала модель, человек не подтверждал. Хост решение по явной policy prompt инструмента не запоминает (`sessionApprovalScope` только для source `mode`).
Исправление 2026-10-19: `moveNeedsGrant` берёт realpath цели (несуществующая цель — без диалога, её отвергнет validateMove), worktree принятого проекта принимается по его primary; диалоги session_move и workspace_grant показывают выдаваемый корень (`dir: … → grant: …`), так symlink на `$HOME` больше не выдаёт `$HOME` незаметно. Регрессия — тесты с symlink-алиасом и worktree вне корня в [host-move-approval.test.ts](../test/host-move-approval.test.ts); прежние фикстуры заранее делали realpath временного каталога и скрывали ошибку. Живая перепроверка M09 с моделью ещё не выполнялась.
Ревью исправления (2026-10-19, Opus) воспроизвело три обхода, они закрыты тем же днём. (1) Execute решал о гранте заново, поэтому symlink, подменённый после approval «write», получал грант без диалога. (2) `~` в превью раскрывался как домашний каталог, а в гранте — как каталог внутри cwd. (3) Корень из диалога не сверялся с выдаваемым. Теперь фикстура вызывает approval → диалог → execute в порядке хоста, и тесты проверяют: подмена после «write» — permission-отказ без гранта; подмена после диалога — «not the approved <корень>»; `workspace_grant` выдаёт только показанный корень; `~` раскрывается одинаково, литеральный каталог `~` в cwd не выдаётся. Повторное адверсариальное ревью (Opus) обходов в session_move не нашло; в `workspace_grant` закрыты ещё два: путь, появившийся после диалога без показанного корня, теперь отклоняется, а повтор одного каталога в списке сверяется с показанным корнем для каждого вхождения.

<a id="v20"></a>
### V20. Гранты только в ledger и `/nav-roots`

**NAV-06, NAV-10.** [host-grants.test.ts](../test/host-grants.test.ts), [host-move-approval.test.ts](../test/host-move-approval.test.ts), [runtime.test.ts](../test/runtime.test.ts). Дата: 2026-10-19, omp 18.12.2, `bun run test`.
Фикстура main-сессии переезжает через настоящий штатный `moveTo` и TUI-owner. Проверено:
- `--add-dir B`: A → B → worktree B → B → A проходят. Штатный список после первого перехода пуст, B в ledger, запись одна; resume восстанавливает начальный A и грант B. Создание coordinator записей не пишет.
- Переезд с грантом B фиксирует начальный A: после resume в B стартовым остаётся A.
- Неудачный переезд (`applyCwdChange` → false) откатывает перенесённый корень: штатный список снова `[B]`, записей в ledger нет.
- Settings watcher, убравший B из штатного списка во время перехода в `B/nested`, не ломает переезд: B остаётся принятым.
- Корень, добавленный через symlink-alias: approval без диалога, `workspace_grant` даёт skipped, revoke удаляет строку alias и пересобирает prompt.
- `/nav-roots revoke`: отказ для стартового проекта, неизвестного пути (с указанием покрывающего корня) и для корня, без которого текущий worktree остался бы вне корней. Путь worktree отзывает primary сразу из ledger и штатного списка, после чего навигация в B и его worktree получает permission-отказ. Исчезнувший грант виден как `missing` и отзывается по пути.
- `workspace_grant` и подтверждённый `session_move` пишут только в ledger, штатный список остаётся пустым.
- После ревью (2026-10-19, Opus xhigh с верификацией):
  - корень, который settings watcher добавил из настроек проекта цели во время переезда, навигацию не разрешает (approval спрашивает, validateMove отказывает) и в ledger не переносится;
  - корень, засеянный при старте из штатного списка, переживает его удаление watcher'ом;
  - первый переезд без грантов записывает начальный корень, и после resume в подкаталоге стартовым остаётся A;
  - revoke подкаталога отказывает с «inside B», revoke корня-подкаталога из `--add-dir` не снимает грант репозитория;
  - revoke разрешён, когда cwd уже вне корней;
  - откат первого переезда после штатного `/move` не подменяет начальный корень;
  - обработчики `/nav-roots` и `/nav-move`: idle-гейт, Usage, формат списка, revoke и ошибка неудачного переезда.

  Каждый из этих пяти исправлений по отдельности ловится мутацией во временной копии.
- Print-прогон (`--add-dir B`): AGENTS B входят в prompt A до перехода и отсутствуют после A → B → A.
Граница доказательства:
- штатные `/move`, `/wt` и настоящий settings-наблюдатель вживую не прогонялись: тесты имитируют их штатными методами SessionManager и подменой настроек;
- `/nav-roots` в TUI и RPC вживую не проверялся, обработчики проверены с фейковыми `ctx.isIdle` и `ctx.ui.notify`;
- ветка warning у `/nav-move` (частичный MCP) отдельно не тестирована.

<a id="v19"></a>
### V19. Матрица версий omp

**F6.** [matrix.ts](../bin/matrix.ts), [runtime.test.ts](../test/runtime.test.ts).
2026-10-16 `bun bin/matrix.ts`: обе версии матрицы PASS — omp 18.11.0 (**69 pass, 0 fail, 802 expect() calls, 12 файлов, 49.86 s**) и omp 18.11.1 (**69 pass, 0 fail, 802 expect() calls, 12 файлов, 50.30 s**). Каждая версия ставилась `npm --prefix /tmp/omp-matrix/<version> install @oh-my-pi/pi-coding-agent@<version>` во временный каталог; `bun test ./test` резолвил `omp` по PATH из временной установки, глобальная установка не менялась. Это e2e-доказательство: настоящий CLI каждой версии загружает расширение и проходит bundled-сценарии (move/park/revive, память, гранты, approval).
2026-10-17 `bun bin/matrix.ts`: матрица расширена до 18.11.2/18.11.3 после обновления глобального omp пользователя; все четыре версии PASS — omp 18.11.0 (**49 s**), 18.11.1 (**50 s**), 18.11.2 (**52 s**), 18.11.3 (**50 s**), каждая 69 pass / 0 fail, суммарно 265.50 s; тот же метод установки и PATH-резолва, глобальная установка не менялась. Дополнительно на глобально установленном 18.11.3: `bun test ./test` — **69 pass, 0 fail, 804 expect() calls, 12 файлов, 51.38 s**; `bun test ./test/runtime.test.ts` — 5 pass / 77 expect() calls; `bun run check` — Exit 0 (bundle 106.96 KB). Breaking change 18.11.3 (`ExtensionUIContext.approve()` теперь принимает `"once" | "session" | "deny"` вместо boolean) расширение не затрагивает: используются только декларативные approval-уровни/политики инструментов, `ui.approve()` не вызывается и не реализуется.
2026-10-18 (политика гейта, решение пользователя): вместо exact-списка принимается диапазон — любой хост >= 18.11.0 в мажоре 18 грузится; версии вне проверенной матрицы дают warning `omp-agent-nav: host <version> is newer than the verified matrix (…); loading unverified.` (с 2026-10-19 — один раз на версию в процессе, прежде — один на процесс), ниже floor / >= 19.0.0 / не-semver (пререлизы) отклоняются; peerDependencies — `>=18.11.0 <19`. Покрытие — runtime.test.ts: отклонены 19.0.0, 18.10.9, `18.13.0-dev`, `garbage`; приняты все версии матрицы, 18.12.2 и 18.99.0; warning проконтролирован (с 2026-10-19 тест не зависит от версии глобального хоста: непроверенный случай представлен только 18.99.0). На глобально установленном 18.12.1: `bun test ./test` — **69 pass, 0 fail, 812 expect() calls, 12 файлов, 52.01 s**; `bun test ./test/runtime.test.ts` — 5 pass / 85 expect() calls; `bun run check` — Exit 0 (bundle 108.33 KB). Changelog 18.12.0/18.12.1 контракт расширений не затрагивает (breaking 18.12.1 — только `display()` в eval).
2026-10-18 `bun bin/matrix.ts`: все шесть версий матрицы PASS — omp 18.11.0 (**51 s**), 18.11.1 (**49 s**), 18.11.2 (**49 s**), 18.11.3 (**49 s**), 18.12.0 (**50 s**), 18.12.1 (**49 s**), каждая 69 pass / 0 fail / 812 expect() calls, суммарно 378.26 s; тот же метод `npm --prefix`-установки и PATH-резолва, глобальная установка не менялась.
Отказ ниже floor: 18.10.3 (< 18.11.0) отклоняется сообщением `omp-agent-nav supports @oh-my-pi/pi-coding-agent >= 18.11.0 and below 19.0.0 (verified: …); found @oh-my-pi/pi-coding-agent 18.10.3.` (покрыто тестом на 18.10.9; реальная установка 18.10.3 отклонялась и прежним exact-списком — записи 2026-10-16/17 выше).
2026-10-19 `bun bin/matrix.ts`: в матрицу добавлена 18.12.2, все семь версий PASS — 18.11.0, 18.11.1, 18.11.2 (85 pass + 1 skip seance, которого до 18.11.3 нет; 52 s каждая), 18.11.3 (86 pass, 53 s), 18.12.0 (86 pass, 52 s), 18.12.1 (86 pass, 72 s), 18.12.2 (87 pass, 53 s), 0 fail везде; тот же метод установки во временный prefix. Граница: прогон шёл одновременно с последними правками пакета исправлений (коммиты bb4ab82 → 30c80bd), поэтому последние версии прогоняли на один тест больше; это сигнал совместимости, итоговая матрица повторяется после пакета упрощения.

## Что не проверялось и не выполнялось

- Коммерческий провайдер, пользовательские MCP/банки, производительность prompt cache, качество и нагрузка embeddings.
- Другие версии omp, Windows/Linux и одновременное владение worktree разными процессами omp.
- Изменение установленного omp и публикация пакета в npm.
- Ручные прогоны с реальной моделью выполнены 2026-10-13 (omp 18.10.3) и повторены 2026-10-15 на omp 18.11.0 (см. [manual-model](#manual-model)): S1+M01–M07 PASS, M09-deny/git PASS; M08 остаётся NOT RUN; M09-wg и повтор M09-grant требуют живой перепроверки после исправления 2026-10-19 (см. [V18](#v18)). В живых прогонах не проверялись: LSP при переходах, инъекции rollback-ошибок, реальный embeddings transport и дословные тексты диалогов.
