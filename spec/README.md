# Агентская навигация в omp

Агенту требуется менять проект вместе с его инструкциями, инструментами и памятью. Shell `cd` не меняет среду всей сессии и не назначает нужный проект сабагенту.

Реализовано локальное расширение с инструментами навигации/worktree и `task.cwd`, подключаемое через конфигурацию обычного установленного omp: гейт принимает версии >= 18.11.0 в мажоре 18 (проверенная матрица **18.11.0–18.12.1**; миграция с 18.10.3 2026-10-15, матрицы — 2026-10-16/17/18, диапазонная политика — 2026-10-18). Отдельный launcher удалён; копии CLI и правок ядра нет.
При переезде основной сессии загруженные JS/TS extensions/custom tools сохраняются по принятому решению пользователя; остальные проектные ресурсы обновляются. Подробности — [behavior.md](behavior.md#relocation) и [TD-01](tech-debt.md#td-01).

## Запуск

Требуются клон этого репозитория, bun ≥ 1.3.14 и установленный `@oh-my-pi/pi-coding-agent` >= 18.11.0 и ниже 19.0.0 (проверенная матрица 18.11.0–18.12.1; `npm i -g @oh-my-pi/pi-coding-agent@<version>`) с обычным `omp` в PATH. Добавь путь расширения от клона в существующий список `extensions` глобального `~/.omp/agent/config.yml`:

```yaml
extensions:
  - "~/omp-agent-nav/src/index.ts"
```

Затем из каталога начального проекта A запускается `omp --add-dir /path/to/project-b`. Без `--add-dir` навигация ограничена стартовым проектом и принятыми workspace-корнями.
Можно указать абсолютный путь к каталогу пакета: `package.json` содержит `omp.extensions: ["./src/index.ts"]`.
Проектный массив `extensions` заменяет глобальный массив; в таком проекте нужно сохранить путь навигации в его эффективной конфигурации. Это правило загрузки omp, а не способ автоматической установки.
2026-10-13 путь добавлен в пользовательский глобальный config с сохранением прежних настроек. Обычный `omp` без аргументов загрузил расширение; переходы A → B → A через `/nav-move` также проверены в TUI. Точный способ и границы — [проверка глобального подключения](verification.md#global-loading).
Для разового подключения доступен `omp -e "~/omp-agent-nav/src/index.ts"`; каталог клона можно также подключить симлинком в `~/.omp/agent/extensions/` (auto-discovery).
Локальный checkout апстрима `upstream/oh-my-pi` (в репозиторий не входит) используется только для чтения документации. Непроверенная версия того же major грузится с warning; версия ниже 18.11.0, следующий major или не-semver дают диагностический отказ с перечнем проверенных; несовместимые host exports дают диагностический отказ.
Инструменты доступны модели; человек может вызвать `/nav-move /path/to/project-b` в основной сессии, когда ответ закончен.

## Как читать

1. [Проблема и критерии успеха](problem.md).
2. [Поведение и интерфейсы](behavior.md): параметры, результаты, defaults, отказы и примеры.
3. [Механики](mechanics.md): штатная загрузка, bridge, очередь, rollback, target сабагентов и память.
4. [Допущения](assumptions.md) и [проверки](verification.md): факты, результаты и непроверенные границы.
5. [Техдолг](tech-debt.md) и [будущие возможности F1–F7](future-features.md).
6. [Ручная проверка с моделью](manual-testing.md): один готовый промт сам создаёт fixture в разрешённом cwd и проверяет навигацию, task и память.

Работать по [AGENTS.md](../AGENTS.md). Контракт хранится в behavior, способы обеспечения — в mechanics; обновлять их вместе с кодом.

## Состояние на 2026-10-16

Код находится в `src/`; тесты — в `test/`. Подключение обычного extension сохраняет контракты v1, включая lifecycle Mnemopi.
Прежний итоговый прогон launcher: 58 pass, 0 fail, 610 assertions в 9 файлах; `bun run check` успешен. Это историческая проверка исходного варианта, а не доказательство новой поставки.
Итоговый прогон текущей поставки: **69 pass, 0 fail, 802 expect() calls в 12 файлах, 51.05 s** на глобальном omp 18.11.0 — включая NAV-08 workspace grant, NAV-09 интерактивное подтверждение session_move и инъектируемый бюджет MCP-startup. `bun run check` успешен: external Bun bundle 100.17 KB.
2026-10-16 (0.2.0): матрица проверенных версий omp (18.11.0, 18.11.1) — `SUPPORTED_OMP_VERSIONS` в [runtime.ts](../src/runtime.ts), runner [bin/matrix.ts](../bin/matrix.ts); обе версии PASS за 49.86 s / 50.30 s — [V19](verification.md#v19). Пакет — локальный приватный git-репозиторий без remote, установка на другую машину — клоном (раздел «Запуск» выше).
2026-10-16 (тулинг): внедрён Biome 2.5.15 — [biome.json](../biome.json) и скрипты `lint`/`lint:fix`/`fix:unsafe`/`format`/`format:check`/`matrix` в package.json; `check` теперь сборка + biome-гейт. Dev-зависимость единственная — `@biomejs/biome`, omp объявлен optional peer, хост в `node_modules` не попадает. Разовый reformat по src/test/bin верифицирован полным прогоном (69 pass, 0 fail, 802 expect() calls, 50.04 s); lint и check — Exit 0.
2026-10-16 (строгий стиль): Biome ужесточён (`useBlockStatements`, cognitive-бюджет 15, `useSortedInterfaceMembers`) — 247 автофиксов скобок, 6 сверхсложных функций декомпозированы, host.ts (1212 строк) разрезан на [src/host/](../src/host) (`bridge`/`coordinator`/`grants`/`mcp`) с тонким реэкспортом в [src/host.ts](../src/host.ts); lint/check — 0 нарушений, итоговый прогон 69 pass / 0 fail / 802 expect() calls / 49.51 s.
2026-10-17: матрица расширена до 18.11.2/18.11.3 после обновления глобального omp пользователя до 18.11.3; `bun bin/matrix.ts` — все четыре версии PASS (49/50/52/50 s, суммарно 265.50 s), полный прогон на глобальном 18.11.3 — **69 pass / 0 fail / 804 expect() calls / 51.38 s** — [V19](verification.md#v19). Breaking change 18.11.3 `ui.approve()` (`"once" | "session" | "deny"` вместо boolean) расширение не задевает: используются только декларативные approval-уровни инструментов.
2026-10-18: глобальный omp обновлён до 18.12.1; матрица расширена до 18.12.0/18.12.1 (прогон — [V19](verification.md#v19)) и по решению пользователя гейт переведён с exact-списка на диапазон: грузится любой хост >= 18.11.0 в мажоре 18, версии вне проверенной матрицы — с warning (`host <version> is newer than the verified matrix`), ниже floor / следующий major / не-semver — отказ; peerDependencies — `>=18.11.0 <19`. Полный прогон на глобальном 18.12.1 — **69 pass / 0 fail / 812 expect() calls / 52.01 s**; `bun run check` — Exit 0 (bundle 108.33 KB); `bun test ./test/runtime.test.ts` — 5 pass / 85 expect() calls.
2026-10-19: в `check` добавлен гейт TypeScript 7 (`tsc -p .`, 0 ошибок), он нашёл обращение к `TaskTool` вне области видимости в ветке сабагента (EXT-03, исправлено). Полный прогон на глобальном 18.12.2 (вне матрицы, с warning) — **69 pass / 0 fail / 813 expect() calls / 49.80 s**; тесты версии больше не зависят от того, входит ли глобальный хост в матрицу — [результаты](verification.md#results).
Проверены обычный config print, TUI/RPC/LSP, реальные вызовы task через fake provider, main move/park/revive и собственная память расширения. Source-test harness отдельно покрывает штатные классы и инъекции ошибок. V1 проверена в описанных границах.
Глобальное подключение и обычный запуск проверены отдельно; [ручной прогон с моделью](manual-testing.md#prompt) выполнен 2026-10-13 и повторён 2026-10-15 на omp 18.11.0 (S1+M01–M07 PASS, M08 вне промта); [живые approval-диалоги](manual-testing.md#approval-prompt) проверены 2026-10-15 (M09: deny/git PASS; грант `workspace_grant` не снимал диалог session_move). Разбор 2026-10-19: причина — сравнение лексического пути цели с realpath-корнями (`/var` → `/private/var`), она же делала недостоверным «повтор без диалога» в M09-grant; исправлено и покрыто тестами, живая перепроверка M09 ожидается — [V18](verification.md#v18). Записи и пути отчётов — в [manual-testing.md](manual-testing.md) и [verification.md](verification.md#manual-model).
Коммерческий провайдер в автоматических сценариях не использовался.
Команды и точные результаты находятся в [verification.md](verification.md#results), вместе с границами проведённых проверок.

Статусы: **запланировано** — кода нет; **реализовано** — код есть, обязательная проверка ещё ожидается; **проверено** — указаны фактически выполненные проверки и их границы.

## Требования v1

Колонка «Исполнитель» описывает слои локального расширения. Bridge использует штатные объекты omp, но его API не является новым upstream API.
Ссылки ведут на фактическое покрытие; статусы относятся к текущей поставке и описанным границам проверок. Исторические результаты launcher сохранены отдельно в verification.

| ID и требование | Спецификация | Исполнитель | Код | Проверка | Статус |
|---|---|---|---|---|---|
| NAV-01: смена проекта, та же сессия и история | [Релокация](behavior.md#relocation) | bridge | [host.ts](../src/host.ts) | [V01](verification.md#v01), [runtime.test.ts](../test/runtime.test.ts) | проверено |
| NAV-02: queued → итог до следующего model call | [Результаты](behavior.md#results) | coordinator | [host.ts](../src/host.ts) | [V02](verification.md#v02), [host.test.ts](../test/host.test.ts) | проверено |
| NAV-03: одиночный пакет, запрет вложений и навигации сабагентов | [Пакеты](behavior.md#batch) | bridge + tools | [host.ts](../src/host.ts), [index.ts](../src/index.ts) | [V03](verification.md#v03), [host.test.ts](../test/host.test.ts) | проверено |
| NAV-04: контекст цели, хранилище и rollback; фабрики основной сессии сохранены | [Транзакция](mechanics.md#relocation) | bridge | [host.ts](../src/host.ts), [runtime.ts](../src/runtime.ts) | [V01](verification.md#v01), [V04](verification.md#v04), [host-mcp.test.ts](../test/host-mcp.test.ts) | проверено |
| NAV-05: BTW, конфликтующие операции и отмена | [Занятость](behavior.md#busy) | coordinator | [host.ts](../src/host.ts) | [V04](verification.md#v04), [host.test.ts](../test/host.test.ts) | проверено |
| NAV-06: canonical корни, принадлежность worktree и отзыв разрешений | [Разрешения](behavior.md#permissions) | grants + navigation | [host.ts](../src/host.ts), [navigation.ts](../src/navigation.ts) | [V05](verification.md#v05), [host-grants.test.ts](../test/host-grants.test.ts) | проверено |
| NAV-07: bridge context API в TUI/print/RPC | [API](behavior.md#core-api) | bridge | [host.ts](../src/host.ts) | [V06](verification.md#v06), [runtime.test.ts](../test/runtime.test.ts), [install-guard.test.ts](../test/install-guard.test.ts) | проверено |
| WT-01: список по реестру Git | [List](behavior.md#worktree-list) | navigation | [navigation.ts](../src/navigation.ts) | [V07](verification.md#v07), [navigation.test.ts](../test/navigation.test.ts) | проверено |
| WT-02: чистое создание от ref/HEAD | [Create](behavior.md#worktree-create) | navigation + native VCS | [navigation.ts](../src/navigation.ts) | [V08](verification.md#v08), [navigation.test.ts](../test/navigation.test.ts) | проверено |
| WT-03: точный path, относительно primary, managed base | [Пути](behavior.md#paths) | navigation | [navigation.ts](../src/navigation.ts) | [V09](verification.md#v09), [navigation.test.ts](../test/navigation.test.ts) | проверено |
| WT-04: точное local exclude и материализация внутри primary | [Создание](mechanics.md#worktree) | navigation | [navigation.ts](../src/navigation.ts) | [V08](verification.md#v08), [V09](verification.md#v09), [navigation.test.ts](../test/navigation.test.ts) | проверено |
| WT-05: enter/exit без удаления worktree | [Enter/exit](behavior.md#worktree-enter-exit) | navigation + bridge | [navigation.ts](../src/navigation.ts), [host.ts](../src/host.ts) | [V07](verification.md#v07), [navigation.test.ts](../test/navigation.test.ts) | проверено |
| WT-06: безопасное адресное удаление, ветка сохранена | [Remove](behavior.md#worktree-remove) | navigation + native VCS | [navigation.ts](../src/navigation.ts) | [V10](verification.md#v10), [navigation.test.ts](../test/navigation.test.ts) | проверено |
| TASK-01: cwd одиночного task и каждого tasks[] | [Task](behavior.md#task) | обёртка task | [task.ts](../src/task.ts) | [V11](verification.md#v11), [task.test.ts](../test/task.test.ts), [bundled-task.test.ts](../test/bundled-task.test.ts) | проверено |
| TASK-02: ресурсы цели до запроса модели | [Scope](mechanics.md#subagents) | обёртка task + SDK | [task.ts](../src/task.ts) | [V11](verification.md#v11), [task.test.ts](../test/task.test.ts), [bundled-task.test.ts](../test/bundled-task.test.ts) | проверено |
| TASK-03: цель и журнал стабильны после move/park/revive | [Anchor](mechanics.md#subagents) | обёртка task | [task.ts](../src/task.ts) | [V12](verification.md#v12), [task.test.ts](../test/task.test.ts), [bundled-task.test.ts](../test/bundled-task.test.ts) | проверено |
| TASK-04: isolated из цели с её банком | [Изоляция](behavior.md#task) | штатный исполнитель | [task.ts](../src/task.ts), [memory.ts](../src/memory.ts) | [V13](verification.md#v13), [task.test.ts](../test/task.test.ts) | проверено |
| MEM-01: общий банк primary/worktree, старые банки игнорируются | [Identity](mechanics.md#memory-identity) | memory + navigation | [memory.ts](../src/memory.ts), [navigation.ts](../src/navigation.ts) | [V14](verification.md#v14), [memory.test.ts](../test/memory.test.ts), [bundled-memory.test.ts](../test/bundled-memory.test.ts) | проверено |
| MEM-02: собственный backend и startup до запроса модели | [Lifecycle](mechanics.md#memory-lifecycle) | memory bridge | [memory.ts](../src/memory.ts) | [V15](verification.md#v15), [memory.test.ts](../test/memory.test.ts), [task.test.ts](../test/task.test.ts), [bundled-memory.test.ts](../test/bundled-memory.test.ts), [install-guard.test.ts](../test/install-guard.test.ts) | проверено |
| MEM-03: явные записи сабагента, retain off, embedding живёт до остановки процесса | [Lifecycle](mechanics.md#memory-lifecycle) | memory bridge | [memory.ts](../src/memory.ts) | [V15](verification.md#v15), [embedding-lifetime.test.ts](../test/embedding-lifetime.test.ts), [bundled-memory.test.ts](../test/bundled-memory.test.ts) | проверено |
| NAV-08: явный workspace grant с подтверждением и recovery-hint | [Разрешения](behavior.md#permissions) | bridge + tools | [host.ts](../src/host.ts), [index.ts](../src/index.ts), [navigation.ts](../src/navigation.ts) | [V17](verification.md#v17), [host-grants.test.ts](../test/host-grants.test.ts) | проверено |
| NAV-09: интерактивный session_move с подтверждением и грантом корня | [Разрешения](behavior.md#permissions) | bridge + tools | [host.ts](../src/host.ts), [index.ts](../src/index.ts) | [V18](verification.md#v18), [host-move-approval.test.ts](../test/host-move-approval.test.ts) | проверено |
| DOC-01: сопровождаемая spec, допущения, долг и будущее | [Сопровождение](mechanics.md#documentation) | проект | [AGENTS.md](../AGENTS.md), [spec](README.md) | [V16](verification.md#v16) | проверено |

## Граница первой версии

В v1 входят таблица требований и работа на выбранной опубликованной версии omp. Создание не выполняет вход и не переносит исходные изменения; сабагент получает фиксированную цель.
Основная сессия сохраняет загруженные JS/TS фабрики. Новый сабагент загружается по цели, поэтому это ограничение основной сессии не переносится на его запуск в B.
Вне v1 остаются [F1–F7](future-features.md); upstream API требуется только при необходимости для будущей совместимости.
