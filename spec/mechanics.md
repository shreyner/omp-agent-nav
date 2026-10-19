# Механики расширения

V1 не меняет файлы omp и не поддерживает fork ядра. [Расширение](../src/index.ts) загружается через конфигурацию обычного установленного omp (>= 18.11.0 в мажоре 18).
[Адаптер](../src/runtime.ts) проверяет диапазон package/host версии — >= `SUPPORTED_OMP_VERSIONS[0]` в том же major: версии из проверенной матрицы грузятся молча, более новые того же major — с warning о непроверенности, ниже floor / следующий major / не-semver (включая пререлизы) отклоняются — и использует объекты работающего bundle; готовность этой поставки подтверждается отдельными интеграционными тестами.

## Штатная загрузка и общий host runtime

Bundled `dist/cli.js` и source-файлы, импортированные по file URL, создают разные графы модулей. Это было причиной прежнего launcher, но такой импорт обходил штатный import shim omp.
Canonical imports через поддержанные имена `@oh-my-pi/pi-coding-agent` и subpaths получают объекты уже работающего bundle. SDK берётся из переданного `pi.pi`; неизвестный host subpath даёт отказ, а не fallback в отдельное source-состояние.
В `package.json` `omp.extensions` указывает `src/index.ts`: штатный loader принимает файл и каталог пакета. Поставка не запускает source CLI, не передаёт внутренний runtime-root и не выбирает checkout `upstream/oh-my-pi` для выполнения. Проверки загрузки — [runtime.test.ts](../test/runtime.test.ts) и [V06](verification.md#v06).
Отдельно разрешён короткий список library imports из того же установленного пакета для Mnemopi и renderer. Их состояния принадлежат расширению и явно связаны с host; импорт библиотеки не создаёт вторую сессию omp.

Bridge оборачивает `ExtensionRunner.createContext`, `InteractiveMode.init`, запуск памяти и prompt только в памяти процесса.
Установка одна на процесс. Для каждой сессии сабагента loader omp заново импортирует граф расширения с тегом `?mtime=`, поэтому состояние внутри модуля прежнюю установку не видит. Обещание установки хранится под ключом `Symbol.for` на патчимом объекте хоста: `ExtensionRunner.prototype` для bridge, `AgentSession.prototype` для памяти. Запись идёт через `??=` без `await` между чтением и записью, так что параллельные загрузки сабагентов получают тот же bridge. До 2026-10-19 защита была модульной, и каждый `task` наслаивал обёртки, coordinator и записи ledger. Проверка — [install-guard.test.ts](../test/install-guard.test.ts).
Он использует штатные `moveSession`/`SessionManager.moveTo`, TUI `applyCwdChange`, Settings handles, MCPManager, VCS/worktrees и исполнитель TaskTool.
Это адаптер внутренних API выбранной версии. Для другой версии нужна повторная проверка совместимости — [F6](future-features.md#f6).
Матрица версий: кандидат добавляется в `SUPPORTED_OMP_VERSIONS` ([runtime.ts](../src/runtime.ts)) и peerDependencies, затем `bun bin/matrix.ts` прогоняет весь test suite против временной `npm --prefix`-установки каждой версии матрицы (тесты резолвят `omp` по PATH, глобальная установка не меняется). Зелёный прогон — версия остаётся в матрице, итог записывается в [V19](verification.md#v19); красный — кандидат откатывается, расхождения и вердикт фиксируются там же. С 2026-10-18 runtime грузит и непроверенные версии того же major с warning, поэтому обновление omp в рамках мажора не отключает расширение; матрица — способ подтвердить версию и снять warning.
Собственные Mnemopi resources и их связь с bundled host описаны ниже и проверяются в [A12](assumptions.md#migration).

<a id="turn-boundary"></a>
## Очередь и граница запроса модели

[WorkspaceCoordinator](../src/host.ts) хранит один неприменённый запрос с session ID, исходным cwd и сигналом отмены (NAV-02).
Операция исполняется в awaited `addBeforeModelCallHook`, после завершения пакета инструментов и до следующего запроса провайдеру. Первоначальная гипотеза об `onTurnEnd` заменена этой существующей границей.

`agent.beforeToolCall` проверяет весь пакет модели по набору `NAVIGATION_TOOLS` (NAV-03).
Если навигация вызвана вместе с другими инструментами, проверка блокирует каждый вызов до эффекта. Допущенный прямой tool ID проверяется в execute; глубина делегирования отдельно запрещает вложенную навигацию.
Поле `requiresSoloBatch` в ядро не добавляется.

При применении повторно проверяются session/cwd, разрешения, цель и состояние Git. Итог сохраняется в session JSONL и runtime как developer-message.
Цикл агента отправляет копию состояния, поэтому одного `agent.appendMessage` для текущего прогона мало. Hook получает живой контекст цикла (`addBeforeModelCallHook(signal, context)`, с 18.11.0) и кладёт итог в `context.messages`: так его видят текущий и следующие вызовы прогона. Состояние агента и JSONL переносят итог в последующие прогоны и компакцию. Отдельной подмешивающей очереди нет: до 2026-10-19 она дописывала все прошлые итоги в каждый запрос (дедупликация сравнивала неэкранированный текст с JSON) и возвращала их после компакции. Receipt queued и сохранённый итог имеют один request ID.
Отмена, переключение и закрытие снимают pending; запросы не восстанавливаются автоматически из журнала (NAV-05).
Ошибка неполного восстановления сохраняется, затем выбрасывается из ожидаемой границы, чтобы провайдер не продолжил работу в смешанном состоянии.

<a id="relocation"></a>
## Релокация основной сессии

Move/enter/exit используют [WorkspaceBridge.relocate](../src/host.ts) (NAV-01, NAV-04):

1. Сохранить состояние сессии, завершить записи памяти и flush хранилища сессии.
2. Через штатный move перенести JSONL и cwd, сохраняя session ID и историю.
3. Перезагрузить настройки и ресурсы цели: TUI использует своего владельца, headless — общие helpers. Перевязать память и проектные MCP, обновить skills/commands и базовый prompt.
4. Обновить проектный SYSTEM prefix и task/artifact anchor, синхронизировать разрешения и отображение TUI.
5. При ошибке выполнить native rollbackMove и повторно подготовить исходный контекст. Ошибка восстановления блокирует следующий запрос модели.

Проектный SYSTEM override, автоматически обнаруженный при старте, обновляется для `.omp/SYSTEM.md`, шаблона или стандартного prompt цели.
Явные CLI system-prompt/template и намеренное изменение prefix другим расширением сохраняются.
Это необходимо потому, что штатный refreshBaseSystemPrompt сам по себе сохраняет автоматически обнаруженный prefix запуска.

Renderer `system-prompt.ts` импортируется как библиотека установленного пакета; он не является чистой функцией. Bridge передаёт обнаруженные host context/rules, native snapshots skills, metadata активных tools/MCP/xdev, модель, workspace tree и штатные policy/settings.
Library InternalUrlRouter перенаправляется к live native registry, чтобы prompt сохранил зарегистрированные схемы. Готовые renderedSkills передаются без повторного чтения через отдельный source registry.
Перед чтением PERSONALITY.md проверяется совпадение profile agentDir библиотеки и host. Флаги model/tree/scout/IRC/QA/security и настройки отображения берутся из native handles.
Заменяется только собственный автоматически обнаруженный первый prefix; остальные prompt frames, memory recall и явные CLI/extension overrides сохраняются.
Явный CLI append разрешается штатным `resolvePromptInput` один раз и передаётся renderer как `resolvedAppendSystemPrompt`, поэтому `{{appendPrompt}}` проектного шаблона получает его текст.
Генераторы memory/MCP append не вызываются повторно для переменной prefix: их актуальные блоки уже принадлежат штатному завершающему frame. Этот frame сохраняется вместе с CLI append, без повторного генерирования или переноса в первый prefix.

JS/TS extensions/custom tools основной сессии сохраняются. Bridge не выгружает фабрики A и не загружает фабрики B при переезде — принятый [TD-01](tech-debt.md#td-01) и следующий этап [F7](future-features.md#f7).
У нового сабагента фабрики загружаются по цели.

MCP основной сессии повторно использует тот же принадлежащий ей manager: штатные замыкания prompt/notifications ссылаются на него.
Manager отключает прежние проектные инструменты, меняет cwd, загружает MCP цели, ждёт startup и выполняет refreshMCPTools. Новый объект вместо прежнего оставил бы старые ссылки замыканий.
LSP использует cwd цели и штатное управление ресурсами. Workspace checker и gopls проверяются раздельно в [V01](verification.md#v01).

Разрешения и загрузка инструкций разделены: доступ к B не добавляет AGENTS B к prompt основной сессии A.
Инструкции загружаются из выбранного проекта и его обычной иерархии; права, отображение additional roots и workspace tree сохраняются.
[installInstructionScope](../src/runtime.ts) оборачивает load изменяемых context-file providers и использует per-session AsyncLocalStorage при подготовке prompt и изменении registry.
Владелец привязывается через native SessionTools mutation и AgentSession refresh/prompt. Подавляется только загрузка чужой цели; ledger разрешений и workspace tree не меняются.
Полный prompt не фильтруется regex, native memory recall сохраняется. Пустой результат чужого provider не кэшируется для последующего запуска сабагента B.
Обычные bundled TUI/RPC A → B → A и print task B подтвердили отсутствие чужих AGENTS; source-test harness дополнительно проверяет ресурсы цели.

<a id="grants"></a>
## Разрешения и занятость

[WorkspaceGrantState](../src/host.ts) сохраняет начальный корень и явно принятые корни в session custom entry `omp-agent-nav.workspace` (NAV-06).
Штатный move может убрать текущую B из additionalDirectories; отдельный ledger сохраняет grant B и не создаёт grant для посещённого worktree.
Обёртки add/remove/set фиксируют явные изменения; AsyncLocalStorage transition отличает обновление представления native от пользовательского отзыва.
Approval вычисляется синхронно, поэтому `moveNeedsGrant` и превью выдаваемого корня используют `realpathSync` и уже загруженный модуль VCS (`previewProjectRoot`: realpath, для Git-каталога — realpath primary). Execute выдаёт грант через полный асинхронный `resolveProjectIdentity`. В одиночном пакете между approval и execute другие инструменты не выполняются, поэтому показанный и выданный корень совпадают.

Проект определяется через штатные Git info/commonDir/worktrees. Realpath и границы сегментов проверяются для корней и целей; metadata текущего и разрешённых проектов запрещена, включая separate gitDir и symlink aliases.

Навигация запрещена при compaction, pending/applying и активной BTW (NAV-05).
TUI использует native `withBtwSessionMove`. Обёртка `AgentSession.runEphemeralTurn` ведёт счётчик сессии для ключей `btw:*`; apply проверяет счётчик и отмечает workspaceApplying до первого await.
Новая BTW во время apply отклоняется. Штатное ограждение TUI сохраняется; отказ при активной BTW с неизменными cwd/storage подтверждён в TUI/RPC.

<a id="worktree"></a>
## Штатные worktree

[WorkspaceNavigation](../src/navigation.ts) использует `@oh-my-pi/pi-natives/vcs` для реестра, refs, createBranch и worktreeAdd/remove (WT-01–WT-06).
Ветка всегда новая; существующая ветка отклоняется до создания каталога или ignore rule. Ref разрешается относительно текущего checkout.

Managed base вычисляется через native dirs и Setting registry handles, явный относительный path — от primary. До mkdir проверяются canonical ancestor, пересечение checkout, metadata и доступ.
Внутри primary и для ранее существовавшего пустого каталога clone=false; внешний clone сохраняет clean HEAD и keepChanges=false.

Local exclude дополняется точным экранированным правилом. Ошибка оставляет его с диагностикой вместо восстановления всего общего файла, чтобы не потерять чужой append.
Cleanup проверяет inode/device собственной reservation, принадлежность Git, отсутствие изменений, HEAD/branch и реестр. Только собственный неизменённый чистый partial удаляется; изменённые и чужие данные с защищающей их веткой сохраняются.
Обычный remove всегда сохраняет ветку и не выполняет force/rm обход.

List показывает недоступные записи и available/dirty/untracked. Физический cwd и исходный settings cwd живого сабагента защищают цель, включая isolated sandbox.
Владение между разными процессами omp остаётся [F3](future-features.md#f3).

<a id="subagents"></a>
## Проект сабагента и стабильный журнал

[Обёртка task](../src/task.ts) сохраняет штатные schema/mode и исполнитель. Описание и схема обновляются после релокации основной сессии для её новых settings/agents (TASK-01).
Cwd разрешается для всех элементов пакета до запуска провайдера; общие context, isolation, async jobs, output/progress и root semaphore сохраняются.
Параметр isolation передаётся preflight только при наличии исходного isolated, чтобы не менять штатный режим планирования. Имена пакета проверяются с trim/lowercase до подготовки артефактов.
Обёртка async register применяет root gate только к ownerId основной сессии. Вложенные задания используют штатный лимит потомка, даже если родитель уже держит единственное место root gate.
При загрузке расширения у сабагента ordinary task передаётся native TaskTool без cwd; попытка указать cwd отклоняется. Relocation hook создаётся только для основной сессии и снимается при повторном старте или dispose.

Контекст цели создаётся через cloneForCwd с пустыми унаследованными additional directories (TASK-02).
Скопированные context/skills/rules/prompts/extensions/custom tools и memory getters родителя убираются; SDK/TaskTool заново загружают цель.
Skills загружаются явно, поскольку пустой parent list иначе подавлял бы поиск в цели. MCP цели получает свой manager; MCP родительского проекта не наследуется.
После discovery bridge ждёт startup до 30 секунд и отклоняет failed/pending. Это выбранный бюджет плагина, совпадающий с main rescope; native discovery turn wait в 18.10.3 — 1500 мс и не определяет это значение.
При любой ошибке подготовки цели или policy закрываются все собственные уже подготовленные managers остальных элементов. Browser MCP не фильтруется заранее: окончательное штатное решение требует информации о tools/eval цели.

Исходные настройки и project identity фиксируются до native isolation. Временный каталог изоляции не определяет банк: B остаётся B (TASK-04).
В контексте фиксируются parent session ID, session file/artifact getters и target, чтобы замыкание родителя после move/switch не изменило работающего сабагента (TASK-03).

Для постоянной сессии `syncTaskAnchor` создаёт стабильные пути под native session root:
`<session-root>/omp-agent-nav/anchors/<SID>.jsonl` — symlink к realpath текущего JSONL родителя; `<session-root>/omp-agent-nav/anchors/<SID>/` — стабильные artifacts.
Хост требует именно пару `X.jsonl` + `X/`: из неё выводятся каталог журналов детей, ростер и restore, park/revive. Глубина выбрана из-за листингов: с 18.11.3 `/resume` по всем проектам, недавние проекты и gc сканируют `*.jsonl` прямо в каждом каталоге верхнего уровня sessions root и следуют по symlink. До 2026-10-19 якорь лежал в `<session-root>/.omp-agent-nav/` и попадал туда как сессия, причём dedupe мог оставить именно его. Resume через якорь давал ссылку на саму себя (append падал с `ELOOP`), удаление из picker уносило журналы детей. Теперь ссылка всегда ставится на realpath, на самого себя — никогда.
Старая пара переносится лениво, только для SID родителя, вызвавшего task: каталог переименовывается, старая ссылка удаляется, если сессия открыта не через неё (иначе следующая перезапись хоста создала бы на этом пути обычный файл и разветвила транскрипт). Якоря сессий, которые больше не запускают task, остаются в старом каталоге. Их можно удалить вручную при остановленном omp: `find ~/.omp/agent/sessions/.omp-agent-nav -maxdepth 1 -type l -name '*.jsonl' -delete`.
Symlink обновляется атомарным rename после релокации. Журналы сабагентов находятся в anchor, а не в перемещаемом каталоге родителя.
Новая сессия родителя получает новый SID/anchor; прежние сабагенты сохраняют цель, журнал, банк и park/revive.
В [bundled-task.test.ts](../test/bundled-task.test.ts) обычный omp вызывает зарегистрированный task через model toolCall fake provider. Отдельно проверены target B, batch A/B/worktree B, MCP/settings/skills и независимые состояния до запроса; работающий B сохраняет журнал/банк после main A → C и штатного park/revive.

<a id="memory-identity"></a>
## Принадлежность банка памяти

[Resolver](../src/navigation.ts) подтверждает worktree по Git commonDir/registry и вычисляет соответствующий путь primary для cwd внутри worktree (MEM-01).
Корень primary и два его worktree дают один bank path; подкаталог worktree отображается в соответствующий подкаталог primary.
Обычный cwd сохраняет прежний выбор по пути без произвольного подъёма до родительского Git-root.

[Memory bridge](../src/memory.ts) передаёт этот путь в native computeMnemopiBankScope. Сохраняются имя существующего primary-банка, configured prefix, global/per-project-tagged и штатное хэширование; Sharpshooter не меняется.
Старые WT-банки не подключаются к recall и не удаляются или мигрируют.

<a id="memory-lifecycle"></a>
## Собственная память сессии и startup

Банк можно разделять, но backend/state/соединение принадлежат каждой сессии отдельно (MEM-02). Для сабагента autoRetain=false; явные записи разрешены (MEM-03).
Backend и общий embedding client расширения создаются Mnemopi-библиотеками того же установленного npm-пакета. Library import не запускает CLI и не копирует исходники.

Native getter использует module-local symbol; импорт source getter сам по себе не публикует состояние для bundle. Bridge обнаруживает native slot временным dummy startup без embeddings/LLM/autoRecall, требует ровно один собственный symbol со значением, подтверждённым public getter, затем закрывает probe и удаляет временные файлы.
Публикация и снятие собственного state проверяют совпадение native getter/slot; несовпадение даёт диагностический отказ. Native tools и prompt видят то же собственное состояние; dispose закрывает только его соединения.

Source Setting handles имеют собственные индексы cache. Proxy библиотеки даёт им отдельный valueCache и canonical bank cwd, привязывая native методы к исходному settings/session; host cache не используется для source slots.
Native backend start и операции перенаправлены в собственный library backend, включая save/status/stats/recall/clear. Custom model API из host связываются с library registry, чтобы обращения Mnemopi использовали зарегистрированный провайдер.
Clear проверяет фактически открытые базы всех собственных состояний до эффекта. Startup и полная clear/rehydration проходят один сериализованный переход; новое состояние повторно публикуется и учитывается как владелец. Отказ при живом владельце описан в [behavior](behavior.md#memory-clear).

Фоновый startup SDK отслеживается как pending/error. Awaited prompt/before-model gate ждёт startup; обязательная ошибка блокирует первый запрос провайдеру.
При перевязке прежние записи завершаются; ошибка цели восстанавливает исходный backend вместе с cwd/storage/settings. Ошибка startup B не должна блокировать восстановленную A.
Закрытие одной сессии не закрывает память остальных.

Контракт общего embedding client остаётся прежним: session dispose/relink не останавливают его, финальная остановка выполняется при завершении процесса.
Native embedding client остаётся неиспользуемым: его штатный dispose не затрагивает собственный client расширения. Postmortem завершает собственный client один раз.
[bundled-memory.test.ts](../test/bundled-memory.test.ts) проверяет native явные операции, startup failure, rebind/закрытие с незавершённым embedding request и финальную остановку; качество и производительность embeddings не измерялись.

<a id="documentation"></a>
## Сопровождение

Обновлять behavior/mechanics/verification и таблицу требований вместе с кодом (DOC-01).
Допущения закрывать фактами; результаты отделять от ожиданий. Исправленный долг удалять, реализованные F-пункты переносить в контракт и проверки.
Локальная запись spec не означает разрешение на публикацию или глобальную установку.
