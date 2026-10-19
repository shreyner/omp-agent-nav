# Допущения, решения и границы проверки

Дата состояния: 2026-10-13. Первоначальные предпосылки проверены по штатным механизмам и launcher. Новый вариант использует обычное extension-подключение; прежние результаты отделены от текущих bundled проверок.
Подтверждённое поведение описано в [mechanics.md](mechanics.md); таблица сохраняет ID, результат и оставшуюся границу проверки.

## Реестр

| ID | Исходная предпосылка | Результат и источник | Статус / оставшаяся проверка |
|---|---|---|---|
| A01 | Релокацию можно завершить до следующего запроса модели. | Существующий awaited before-model hook, сохранённый итог и порядок событий; [host.test.ts](../test/host.test.ts), [runtime.test.ts](../test/runtime.test.ts). | подтверждено; механизм уточнён вместо onTurnEnd |
| A02 | Штатные move/storage допускают согласованное восстановление. | Инъекции ошибок, отказ памяти B и реальные TUI/RPC A/B/A; [host.test.ts](../test/host.test.ts), [task.test.ts](../test/task.test.ts), [integration-modes.test.ts](../test/integration-modes.test.ts). | подтверждено; инструкции чужих разрешённых проектов отделены от доступа |
| A03 | Штатный worktree backend поддерживает точный path и безопасный цикл операций. | Настоящие Git refs/worktree, пустой каталог, metadata/overlap, очистка после ошибки и сохранённый exclude; [navigation.test.ts](../test/navigation.test.ts). | подтверждено |
| A04 | Worktree соответствует primary для банка памяти, включая подкаталоги. | Resolver и Mnemopi primary + два worktree + другой проект; [navigation.test.ts](../test/navigation.test.ts), [memory.test.ts](../test/memory.test.ts). | подтверждено |
| A05 | Загрузка цели не наследует проектные ресурсы родителя. | SDK с разными agents/AGENTS/settings/skills/rules/prompts/extensions/custom tools/MCP в A/B, включая задержанный и ошибочный MCP startup; [task.test.ts](../test/task.test.ts). | подтверждено; готовность MCP проверена до модели, фабрики основной сессии сохраняются по решению |
| A06 | Каталог, журнал и банк сохраняются после main move/switch и park/revive. | Штатное восстановление, стабильный anchor и фиксированные getters родителя; [task.test.ts](../test/task.test.ts). | подтверждено |
| A07 | Несколько backend одного банка и общий embedding client допустимы. | Явные Mnemopi записи, независимые состояния, закрытие сессий и postmortem; [memory.test.ts](../test/memory.test.ts), [embedding-lifetime.test.ts](../test/embedding-lifetime.test.ts). | подтверждено для управления ресурсами; качество и нагрузка embeddings не измерены |
| A08 | LSP после переезда диагностирует нужную ветку. | Раздельные workspace checker `file:"*"` и настоящий gopls `*.go`; [integration-modes.test.ts](../test/integration-modes.test.ts). | подтверждено: ошибка в worktree и чистый primary после exit |
| A09 | Отмена и BTW не допускают позднюю мутацию. | Abort/dispose/mixed/nested и активная BTW в TUI/RPC; [host.test.ts](../test/host.test.ts), [integration-modes.test.ts](../test/integration-modes.test.ts). | подтверждено; счётчик ephemeral BTW защищает все режимы |
| A10 | Расширение может работать без изменения установленного ядра. | Обычный установленный omp 18.10.3/18.11.0 загружает полный extension из config: print/TUI/RPC; matrix-прогон 18.11.1 — [V19](verification.md#v19); [runtime.test.ts](../test/runtime.test.ts), [integration-modes.test.ts](../test/integration-modes.test.ts). | подтверждено для версий матрицы; добавление версии — процедура «Матрица версий» в [mechanics.md](mechanics.md) |
| A11 | Canonical imports расширения используют объекты bundled host. | Изолированные пробы и полный config runtime: registry/session/task/settings через штатный shim, SDK из pi.pi. | подтверждено; неизвестный host subpath отклоняется |
| A12 | Собственный Mnemopi backend расширения можно связать с native tools/prompt без правок ядра. | [bundled-memory.test.ts](../test/bundled-memory.test.ts): native save/status/stats, SQLite записи, shared bank/отдельные состояния, custom LLM, startup failure, lifetime и clear race. | подтверждено для управления ресурсами; качество/нагрузка embeddings не измерены |
| A13 | Полное расширение работает через config обычного omp во всех поддержанных режимах. | Итоговые прогоны 18.10.3 и 18.11.0: bundled print/SYSTEM, TUI/RPC/LSP, task/память/main move/park/revive; полный matrix-прогон 18.11.1 — [V19](verification.md#v19); [bundled-task.test.ts](../test/bundled-task.test.ts), [verification.md](verification.md#results). | подтверждено для 18.10.3, 18.11.0 и 18.11.1 на временных fixtures с fake provider |

## Уточнение A10

Первичная bundled print-проба показала: registry host доступен, но импорт исходных registry/Mnemopi не разделяет состояние с `dist/cli.js`.
Прежняя реализация запускала опубликованный `src/cli.ts` и проверяла тождество registry. Версия, загрузка полного расширения и print-переезды были проверены отдельными процессами.
Повторный ресёрч и интеграционные проверки подтвердили, что canonical imports используют штатный shim и получают объекты bundle: причиной расхождения был file URL обход shim, а не запрет на конфигурационное подключение расширений.
Fork ядра не требуется. Другая версия omp до проверки совместимости отклоняется.
История пробы и границы — в [verification.md](verification.md#bridge-probe).

<a id="migration"></a>
## Проверка миграции A11–A13

A11 проверен по тождеству объектов живого host, а не наличию exports в исходном файле.
A12 подтверждён отдельными процессами обычного omp: независимые состояния primary/children, shared bank, native явная запись, отказ startup до провайдера и закрытие/rebind без остановки собственного embedding client.
Slot обнаруживается через временное dummy-состояние без embeddings/LLM/autoRecall; probe закрывается и очищается. Clear защищает фактически открытые базы и сериализован с startup, включая rehydrated state.
A13 подтверждён новым интеграционным прогоном обычного omp, включая загрузку через config и реальные зарегистрированные task toolCalls, main move/park/revive. Source-test harness дополнительно проверяет ошибки и штатные классы; его configured fixture явно использует source-test runtime, а не объявляет себя bundled запуском.
SYSTEM.md/SYSTEM_TEMPLATE после переезда не перерисовываются ([граница](behavior.md#system-md)); до 2026-10-19 это делал клон рендерера, удалённый по решению пользователя.

## Принятые решения пользователя

- V1 включает инструменты навигации, точный путь worktree и task.cwd с правильным банком проекта.
- Создание не переносит исходные изменения и не выполняет вход; обычное удаление сохраняет ветку и не использует force.
- Основная сессия сохраняет загруженные JS/TS extensions/custom tools при переезде. Перезагрузка фабрик отложена в [F7](future-features.md#f7), последствие — [TD-01](tech-debt.md#td-01).
- Сабагент B заново загружает свои ресурсы и владеет собственной памятью B, даже в worktree B или при общем банке с основной сессией.
- Старые WT-банки игнорируются без миграции. Global/per-project-tagged и имя primary-банка сохраняются.
- Grants определяют доступ и не добавляют чужие AGENTS к выбранной цели.
- Работа на опубликованной выбранной версии входит в v1. Пользователь поручил перенести поставку на `extensions` обычного omp, без launcher, своей копии и правок ядра. Более широкая совместимость и упаковка — F6; upstream API рассматривается только при реальной необходимости.
- В текущей разработке разрешён основной каталог без development worktree. Продуктовый цикл worktree сохраняется.
- Спецификация поддерживается вместе с кодом; техдолг добавляется только после проверки и решения отложить.

## Непроверенные эксплуатационные границы

Проверки используют временные проекты и хранилище, штатные backend и fake provider. Коммерческий провайдер и пользовательские MCP/банки не проверялись.
Глобальное подключение и обычный TUI-запуск проверены отдельно 2026-10-13: [verification.md](verification.md#global-loading). [Ручной сценарий с моделью](manual-testing.md) подготовлен, но ещё не выполнен.
Межпроцессное владение, выигрыш prompt cache и перезагрузка фабрик входят в F1/F3/F7; это не готовые свойства v1.
При обновлении omp повторить проверки runtime identity и поведения; изменённая версия до подтверждения отклоняется.
