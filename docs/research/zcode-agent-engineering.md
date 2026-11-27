# Технические решения ZCode для агента Runóza

Главная возможность для Runóza — улучшить качество отдельных шагов агента и устойчивость длинного выполнения, сохранив Pi, серверный runtime и существующую модель доступа. Наиболее полезны точечное редактирование файлов, управление рабочим контекстом, ограниченное восстановление ответа, явные факты проверки результата и измерение стоимости успешной задачи. Перенос всего runtime ZCode дал бы вторую архитектуру и значительно больший объём сопровождения.

Срез исследования — 27 ноября 2026 года. ZCode: commit [`a4b4445141eb7d3b3e99eada9292775383bfc44e`](https://github.com/zai-org/ZCode/tree/a4b4445141eb7d3b3e99eada9292775383bfc44e), source sync v4.0.0; вложенный пакет `zcode-cli` имеет собственную версию 0.18.0. Runóza: локальный HEAD `921cb0adbfaa7ca1e9e3b4340232c29d358bdd56`. Это статический аудит исполняемых путей и тестов: приложение ZCode, его тестовый набор и сравнительные прогоны моделей в рамках исследования не запускались. Ожидаемые улучшения ниже — гипотезы для измерения, без обещаний процентов ускорения.

Связанные документы: [UI и UX](zcode-ui-ux.md), [общий план внедрения](zcode-implementation-plan.md).

## Устройство агента ZCode

Desktop-слой ZCode получает protocol client через process manager, который управляет запуском CLI runtime и его окружением. Сам agent loop находится глубже, в `apps/zcode-cli/packages/core`: подготовка запроса, модель, инструменты, сохранение истории и восстановление разделены на самостоятельные модули. Контракты инструментов и адаптеры исполнения вынесены в соседние пакеты. Это полезный пример разделения ответственности; Runóza не нужно повторять запуск отдельного локального агента, поскольку у нас агент намеренно выполняется на сервере. Источники: [process manager](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/packages/services/src/zcode-agent/zcodeAgentProcessManager.ts#L58), [основной цикл](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts#L67).

Последовательность одного нормального шага в `runRegularTurnLoop`:

1. Принять доступные уточнения и результаты фоновой работы в разрешённой точке между шагами.
2. Обновить доступные MCP-инструменты и подготовить набор tools.
3. Добавить новые объявления окружения и контекста; повторный запрос после ошибки не должен заново накапливать те же объявления.
4. Выполнить локальную microcompaction, затем при необходимости полную compaction.
5. Собрать provider-specific запрос, tool discovery и cache control.
6. Вызвать модель и продолжить цикл по результатам инструментов, завершению или восстановлению.

Особенно ценно различение «новая информация для следующего шага» и «повтор того же запроса». Оно не позволяет retry незаметно изменить prompt, инструменты или порядок истории. Для Runóza это основание выделить preparation pipeline из большого [PiAgentRuntime](../../packages/agent/src/index.ts), сохранив его интерфейс и транзакционные проверки.

## Что в Runóza уже реализовано

| Возможность | Существующая реализация | Что действительно стоит добавить |
| --- | --- | --- |
| Полная compaction | [providers/compaction.ts](../../packages/providers/src/compaction.ts), [chat/context.ts](../../packages/chat/src/context.ts): summary, сохранение последних полных tool batches, source hash, ручные запросы, восстановление checkpoint | Дешёвую локальную очистку восстановимых старых результатов перед summary и защиту от быстрого повторного заполнения |
| Большие tool results | [result-budget.ts](../../packages/agent/src/result-budget.ts), [agent-files.ts](../../packages/agent/src/agent-files.ts), [history-tools.ts](../../packages/agent/src/history-tools.ts): полный результат сохраняется, доступны страницы и поиск | Бюджет токенов и ссылки на результат в microcompaction, а не новую систему хранения |
| Защита файлов от устаревшей записи | `read_file` возвращает SHA-256, `write_file` требует `expectedHash`; есть серверный и desktop executor | Точечный edit/patch поверх существующего hash-контракта |
| Discovery расширений | [mcp-discovery.ts](../../packages/agent/src/mcp-discovery.ts), [skill-tools.ts](../../packages/agent/src/skill-tools.ts): поиск метаданных и загрузка схем/инструкций по запросу | Оценку размера экспозиции и кэш только в правильном scope; не новый marketplace |
| Разрешения | [permissions](../../packages/permissions/src/index.ts), live ACL в `authorized`, remembered grants, reviewer и full access | Описанные в контрактах свойства операций для scheduler и режима планирования |
| Восстановление исполнения | `code_actions` хранит исходы; `unknown` не считается failure с правом повторить команду | Отдельный безопасный recovery модельного потока, не автоматический replay исполнения |
| Ограничение расходов | Бюджет шагов, отдельный предел числа tool calls, timeout; учёт usage | Учёт по причинам вызова, контроль повторов и измерение стоимости завершённой задачи |

Эти гарантии уже проверяются существующими [unit-тестами compaction](../../tests/unit/compaction.test.ts), [integration-тестами compaction](../../tests/integration/compaction.test.ts), [agent files](../../tests/integration/agent-files.test.ts) и [provider recovery](../../tests/unit/provider-recovery.test.ts). Например, Runóza уже отвергает неполные пары tool call/result и не применяет оборванное summary. Это база для расширения, а не функциональность, которую нужно переносить из ZCode заново.

## Решения для переноса

Оценка S — локальная доработка одного слоя; M — несколько связанных модулей и контрактных тестов; L — изменение жизненного цикла, персистентности или обоих executors. Это относительная сложность, не календарная оценка.

| ID | Решение | Выбор | Приоритет | Размер |
| --- | --- | --- | --- | --- |
| T1 | Версионируемые секции prompt и контекст по capabilities | Адаптировать | P1 | M |
| T2 | Microcompaction с восстановимыми ссылками | Адаптировать | P1 | M |
| T3 | Точечный edit и ограниченный workspace search | Адаптировать | P1 | M–L |
| T4 | Защита от повторов и циклов заполнения контекста | Перенять принцип | P1 | S–M |
| T5 | Продолжение усечённого ответа и recovery потока | Адаптировать поэтапно | P1/P2 | M/L |
| T6 | Факты проверки результата и режим планирования | Адаптировать | P1/P2 | M |
| T7 | Ограниченный параллелизм безопасных чтений | Адаптировать | P2 | M |
| T8 | Прогон задач через реальный продуктовый runtime | Перенять принцип | P0 | M |
| T9 | Discovery и стабильная экспозиция схем | Развивать существующее | P2 | M |
| T10 | Специализированные субагенты с общим бюджетом | Отложить до измерений | P3 | L |
| T11 | Workspace checkpoints и rewind | Отложить до журнала изменений | P3 | L |
| T12 | Полный runtime, workflow engine, широкие hook permissions | Не переносить целиком | — | L |

### T1 Собирать prompt из проверяемых секций

ZCode строит отдельные identity, behavior, environment, memory и session guidance sections. Секции знают источник, размер, место инъекции и cache hint. Стабильный блок отделён от динамического; сведения об окружении и дате передаются runtime-объявлениями. Поведение строится с учётом реальных возможностей модели и поверхности продукта. Источники: [ContextBuilder](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/context/builder.ts#L80), [identity](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/context/sections/identity.ts#L22), [behavior](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/context/dynamic-sections.ts#L5).

Полезные поведенческие установки: читать и соблюдать стиль окружающего кода; после достаточного исследования переходить к действию; не пересматривать уже принятое пользователем решение без новой причины; завершать задачу, восстанавливаясь после обычных ошибок; сообщать фактический результат тестов. При этом подсказка ZCode про проактивное использование `Agent` в `buildSessionGuidanceSection` закомментирована — её нельзя считать включённым поведением продукта.

В Runóza сейчас один длинный `AGENT_SYSTEM_PROMPT` плюс `input.instructions`. Выделить builder с секциями `core`, `coding`, `execution_target`, `permissions`, `context_recovery`, `extensions`; вычислять их из серверного run snapshot. Сохранить устойчивый порядок и fingerprint версии. Инструкции инструментов должны совпадать с настоящими возможностями и политикой доступа: например, описание `execute` сейчас говорит о подтверждении каждого вызова, хотя runtime поддерживает remembered permission и full access.

Cache control переносить только через совместимый provider adapter. Стабильные байты prompt полезны для кэширования, но сами по себе не доказывают cache hit и не дают права добавлять параметры неизвестному OpenAI-compatible endpoint.

Точки изменений: новый `packages/agent/src/prompt.ts`, `packages/agent/src/index.ts`, run snapshot в `packages/chat`, model capabilities в `packages/providers`. Критерии: одинаковый snapshot даёт одинаковый prompt; в plain chat нет инструкций о недоступном executor; web и desktop получают правильные сведения; смена проекта и разрешений не переносит контекст между scopes. Prompt-version позволяет сравнить результат и откатить поведение без rollback данных.

### T2 Сначала очищать восстановимые результаты и только затем вызывать summary

В ZCode microcompaction заменяет содержимое старых текстовых tool results коротким маркером без дополнительного LLM-вызова. По умолчанию сохраняются пять последних групп результатов; ошибки и image/video/file content не очищаются. Есть минимальный выигрыш 256 оценочных токенов, триггеры по давлению контекста и времени простоя. Основной runtime включает механизм только при `microcompact.enabled === true`; наличие defaults в helper не означает включение во всех конфигурациях. Источники: [алгоритм](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/compact/microcompact.ts#L12), [runtime gate](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts#L97), [тесты защиты ошибок и медиа](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/tests/microcompact.test.ts#L246).

У Runóza лучше сохранять более полезный маркер: `actionId`, имя tool, подтверждённый исход, размер, ссылку для `history_read` или `files_read`. Очищать только тело уже сохранённого и доступного по live ACL результата; не стирать единственный экземпляр данных. Успешная запись должна остаться фактом, чтобы агент не повторял её ради вывода. Ошибки, неизвестный исход, активный план и последняя существенная инструкция остаются в контексте. Не изменять пользовательскую историю и UI-транскрипт: меняется рабочая проекция модели.

Точки изменений: новый helper в `packages/providers`, вызов перед `compactContext` в `packages/chat/src/context.ts`, метаданные сохранённого результата в `packages/agent`. Критерии: после очистки любой результат доступен по ссылке; tool call/result пары валидны; cold resume восстанавливает ту же проекцию; ошибки и медиа сохранены; summary вызывается реже на длинном чтении без ухудшения правильности задачи. Приёмка сравнивает число summary calls и итог задачи, а не только уменьшение prompt.

Дополнительно заменить единый символьный порог проекции на бюджет токенов в пределах текущего model profile, сохранив отдельные byte/char ceilings для памяти и хранения. Нынешние 50 000 символов — защитный потолок, но не одинаковая нагрузка для кода, JSON и русского текста.

### T3 Редактировать фрагмент файла вместо генерации полного содержимого

`Edit` ZCode требует прочитанную полную версию файла, проверяет уникальность старого фрагмента, обнаруживает устаревшее чтение и пишет атомарно с `expectedRevision`. Read-state может сохранять hash вместо копии тела; тесты проверяют восстановление после рестарта и rewind. Источники: [контракт Edit](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/tool/handlers/edit.ts#L54), [freshness](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/tool/handlers/edit.ts#L451), [атомарная запись](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/tool/handlers/edit.ts#L547), [hash tests](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/tests/read-file-state-content-hash.test.ts#L196).

Runóza уже имеет optimistic concurrency через `expectedHash`. Добавить `edit_file(path, expectedHash, oldText, newText, replaceAll=false)` как один инструмент с ограничением размера и обязательной проверкой hash на executor. Модель передаёт только изменяемый участок. Начать с exact-match single-file edit; multi-file patch и сложные fuzzy matchers не нужны для первого релиза. Хеш всей версии защищает и при частичном просмотре; отдельная политика должна требовать достаточный контекст для выбора правки, не вынуждая читать гигантский файл целиком.

Результат: новый hash, список изменённых диапазонов, краткая сводка diff, ссылка на полный diff для UI. Подтверждение привязано к конкретной правке и версии файла; после конфликта требуется пересчитать операцию. В текущем серверном `execution/files.ts` после проверки hash выполняются `os.write` и `ftruncate` в существующий файл; это не атомарная замена. Для нового edit проверить атомарную запись, отмену и семантику symlink в обоих executors. Сериализовать изменения от Runóza по workspace/path и повторно проверять версию в точке исполнения. Внешний редактор может не соблюдать нашу блокировку: предварительная проверка hash плюс `rename` не являются универсальным filesystem compare-and-swap. Границы защиты от внешних writers должны быть явно описаны и проверены; не обещать абсолютную защиту от любого параллельного процесса.

Добавить отдельный ограниченный `workspace_search`, поскольку существующий `files_search` ищет в conversation scratch files, а не автоматически по всему репозиторию. Параметры: относительный корень, glob, запрос, лимит совпадений и bytes; ответ с путём, строками и `truncated`. Это даёт агенту предсказуемый инструмент навигации без большого shell-вывода.

Точки изменений: `packages/agent`, [execution/files.ts](../../packages/execution/src/files.ts), [execution/desktop.ts](../../packages/execution/src/desktop.ts), desktop broker и общие contracts. Критерии: обнаруженная смена версии до commit вызывает конфликт; управляемые Runóza writers сериализуются; неоднозначный match ничего не меняет; BOM/CRLF и Unicode не повреждаются; путь за workspace отклоняется; после ошибки нет частично записанного файла; тесты проходят одинаково на серверном и desktop контракте.

### T4 Прерывать бесполезное повторение до исчерпания бюджета

ZCode считает подряд повторённые пары `tool name + stable JSON input` и при пороге по умолчанию три добавляет напоминание. Это предупреждение, не дедупликация и не блокировка инструмента. Другой guard ограничивает быстрые повторные compactions: runtime отслеживает заполнение менее чем за три tool turns и три последовательных rapid refills. Источники: [anomaly guard](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/helpers/model-anomaly.ts#L23), [rapid refill](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop-state.ts#L25).

Runóza уже ограничивает шаги и подавляет повторный неудачный proactive summary при почти неизменном размере. Не хватает сигналов о повторяющемся бессмысленном действии и цикле успешных, но быстро заполняющихся summaries. Добавить счётчики в состояние run: signature, outcome, изменение наблюдаемой версии ресурса и прогресс задачи. После повторного одинакового failure предложить модели изменить запрос; после общего лимита завершить с понятным состоянием, сохранив результаты.

Polling процесса, чтение изменившегося файла и повтор после явного уточнения пользователя не считать автоматически зацикливанием. Нельзя подменять повторный внешний вызов старым результатом только по одинаковому JSON: состояние внешнего мира могло измениться.

Точки изменений: preparation/result hooks `PiAgentRuntime`, `chat/context.ts`, события run и телеметрия. Критерии: бесконечная пара read/summary останавливается; нормальный polling работает; одинаковые tool calls с новым ресурсным hash разрешены; напоминание имеет бюджет и не раздувает контекст.

### T5 Восстанавливать ответ модели отдельно от внешних действий

У ZCode два разных механизма. Output continuation срабатывает при успешном, но усечённом ответе без tool calls и допускает максимум три продолжения. Streaming recovery выбирает границу подтверждённых tool results или предыдущего сообщения, отбрасывает незавершённый хвост assistant и создаёт новый request с собственной связью с исходным. Источники: [continuation](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/methods/turn-output-token-continuation.ts#L25), [recovery events](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/methods/streaming-recovery.ts#L155), [reasoning-only recovery test](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/tests/runtime-stream-recovery.test.ts#L54).

Runóza ограничивает retry ошибками до начала stream; `stopReason === length` переводит agent run в `OUTPUT_LIMIT`. Это консервативный и безопасный baseline. Развивать его в две поставки:

1. **Text-only recovery.** Продолжение усечённого текста с жёстким числом попыток и общим бюджетом; повтор оборванного stream до запуска любых tools. Не склеивать невалидный JSON tool call и не считать промежуточный текст завершённым ответом. UI видит отдельный attempt.
2. **Recovery после tools.** Сначала сохранить provider-safe model round: assistant call batch, результаты, committed boundary, версия prompt и tools. После сбоя продолжать только от этой границы. `code_actions` остаётся источником факта внешнего действия. Состояние `unknown` требует проверки и не разрешает повтор execution.

Простое увеличение `maxRetries` до ZCode-подобных десяти не решает задачу: оно повышает стоимость и не задаёт правильную границу. Нужен budget по времени, попыткам и расходам для всего run, включая summary. Внутренний token reminder ZCode [сбрасывается при resume и живёт в памяти](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/helpers/total-tokens-budget.ts#L3); он не заменяет серверную квоту Runóza.

Точки изменений: `packages/providers`, `packages/agent`, `packages/chat`, новые append-only migrations и события в `packages/contracts`. Критерии: fault injection до stream, после текста, между tool results и после side effect; число фактических mutations строго одно; неизвестный результат остаётся неизвестным; отмена действует во время backoff; snapshot/reconnect не дублирует текст. До второй поставки сохранять текущее прекращение неоднозначного run.

### T6 Завершение должно опираться на факты проверки

ZCode содержит отдельный tool-free запрос для проверки активной цели. Однако некоторые ошибки разбора и неожиданный tool call проверяющей модели превращаются в fail-open; `failOpenGoalCompletionVerification` возвращает `passed: true`. Это нельзя переносить как доказательство успешности. Источники: [verifier](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts#L137), [fail-open contract](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/contracts/src/tools/target.ts#L324).

Для Runóza сначала достаточно completion record: какие файлы изменены, какой action выполнил проверку, exit code, итог `passed / failed / not_run / unknown`, оставшиеся ограничения. Получать record из executor results, не только из текста модели. Проверка должна соответствовать изменению: документационный edit не требует полного integration suite, изменение recovery требует fault tests.

Режим планирования сделать отдельным серверным ограничением capabilities, зафиксированным в run snapshot. Одобрение плана выбирает следующий этап работы, но не выдаёт grants на исполнение. ZCode уже отделяет plan policy от обычной permission mode; важно, что его `auto` mode явно помечен как не реализованный, а `yolo` имеет иной порядок обхода проверок. Копировать эту семантику вместо текущих ACL Runóza нельзя. Источник: [permission service](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/permission/service.ts#L155).

Точки изменений: contracts результата run, `packages/chat`, UI списка проверок; plan capability gate в `packages/agent`. Критерии: не запущенный тест никогда не показан зелёным; verifier failure даёт `unknown`, а не успех; завершённая текстовая задача не требует лишнего LLM-review; запрет mutations в plan обеспечен сервером и не отменяется tool description или разрешением из старого run.

### T7 Параллелить только операции с известными свойствами

ZCode рекомендует независимые calls параллельно в harness и предоставляет отдельный Explore-профиль. В Runóza `toolExecution: "sequential"` устанавливается для всех tools. Первое улучшение — bounded concurrency для независимых чтений метаданных, схем и страниц сохранённых результатов, а не одновременный запуск произвольных shell-команд. Источники: [harness](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/context/sections/identity.ts#L30), [Explore](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/subagent/explore.ts#L30).

Для каждого инструмента нужен серверный descriptor: side effect, target resource, concurrency class, возможность отмены. `execute` остаётся последовательным; MCP `readOnlyHint` — подсказка внешнего сервера, а не достаточная гарантия. Операции, использующие общий lease или одну MCP-сессию, требуют дополнительной сериализации. Если Pi не предоставляет нужного scheduler hook, начать с batch-инструмента для разрешённых чтений вместо форка библиотеки.

Критерии: максимум in-flight соблюдается, ACL проверяется в каждом call, отмена распространяется на весь batch, persisted order детерминирован, writer не обгоняет зависимый read, ошибки одного чтения не уничтожают остальные результаты. Метрики: время до решения на многомодульной навигации, пиковая нагрузка и число лишних чтений.

### T8 Измерять изменения через реальный runtime

У ZCode есть отдельный provider-regression tool: он использует публичный App и продуктовые adapters, валидирует явную конфигурацию, сохраняет обезличенные snapshots при планировании и начале/конце случаев, ограничивает concurrency и останавливает запросы при ошибке сохранения. Источник: [контракт runner](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/tools/provider-regression/CONTRACT.md#L1).

Для Runóza сделать небольшой воспроизводимый coding suite поверх настоящего `PiAgentRuntime` и синтетического репозитория: точечная правка, несколько связанных файлов, failing test, устаревшая версия файла, длинный вывод, compaction в середине задачи, оборванный stream, отказ/отзыв доступа и неизвестный исход команды. Deterministic scripted provider проверяет протокол и нарушения гарантий; отдельно ограниченные оплачиваемые model runs сравнивают качество решения. Не использовать обычные пользовательские беседы как fixture.

Собирать success по внешней проверке, input/output/cache usage раздельно, model calls по назначению, tool latency, compaction calls, retries, конфликты файлов и число подтверждений. Сравнивать стоимость успешной задачи и долю успеха на одном наборе задач и model profiles; экономия токенов при падении качества не считается улучшением. Учитывать отсутствие provider usage отдельно, не выдавая оценку за биллинг.

В [telemetry allowlist](../../packages/telemetry/src/index.ts) новые числовые поля добавляются явно; prompt, команды, пути и секреты в обычные spans не попадают. Отладочные trajectories — отдельный opt-in артефакт с ACL, retention и редактированием секретов.

### T9 Улучшать discovery без потери snapshot и ACL

ZCode поддерживает local и native tool-search modes по capabilities провайдера. В экспозиции сохраняется история выданных схем, а часть уже объявленных MCP definitions фиксируется для стабильных байтов запроса. Источник: [exposure](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/tool/search/exposure.ts#L27).

У Runóza discovery уже есть. Следующий шаг — измерить размер каталогов и повторные schema reads; кэшировать ограниченный результат по organization/user/connection/version с проверкой текущего доступа. Схема, выбранная для run, должна иметь явную версию; её наличие в контексте не разрешает вызов после отзыва доступа. Native deferred-tool protocol вводить только для провайдера с проверенной поддержкой и работающим local fallback.

Критерии: недоступные инструменты не находятся и не вызываются; schema update не незаметно меняет текущий запрос; отменённый доступ действует немедленно; compaction не заставляет заново загружать весь каталог. Улучшения discovery и T2 следует измерять совместно, поскольку удаление объявлений способно обнулить экономию.

## Что отложить и что не копировать

**Субагенты.** У ZCode есть специализированный Explore и общий запрет считать сообщения родителя пользовательским согласием. Это хороший контракт для будущего Runóza, но сначала нужны parent/child runs, общий budget, cancellation, ACL и доставка approvals в основной UI. Начать с read-only исследователя и компактного результата с доказательствами. Одновременных writers в одном workspace не запускать до механизма владения изменениями. Источник: [subagent contract](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/subagent/system-prompt.ts#L1).

**Checkpoints и rewind.** ZCode связывает историю с workspace checkpoints и различает fork на сообщении и откат к состоянию до конкретной правки. Для Runóza копирование истории чата не означает откат файлов; прежде нужен журнал file changes с before/after hash и проверкой текущей версии. Rewind файлов не отменяет отправленное письмо, HTTP mutation или процесс во внешней системе. Источник: [workspace checkpoints](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/runtime/methods/workspace-checkpoints.ts#L159).

**Не переносить полный prompt дословно.** В ZCode присутствуют предположения о терминале, других инструментальных именах и иной permission semantics. Его [compaction prompt](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/compact/prompt.ts#L1) просит отдельный analysis-блок и подробные фрагменты кода; текущий Runóza checkpoint уже отделяет наблюдаемые факты от скрытого reasoning и использует восстановимые ссылки. Сохранить эту более подходящую нам модель.

**Не переносить агрессивное подавление чтения.** ZCode имеет маркер неизменённого повторного чтения `READ_FILE_UNCHANGED_STUB`. Для Runóza отказ вернуть содержимое безопасен только если оно действительно осталось в доступном рабочем контексте; после microcompaction или смены агента модель может нуждаться в нём снова. Источник: [read-text](https://github.com/zai-org/ZCode/blob/a4b4445141eb7d3b3e99eada9292775383bfc44e/apps/zcode-cli/packages/core/src/tool/handlers/read-text.ts#L16).

**Не переносить динамический workflow engine первым этапом.** Его дополнительные состояния, actors, persistence и protocol увеличивают область отказов. Сначала измерить, что bounded tools, хорошая навигация и recovery перестали быть основным ограничением. Для Runóza важнее сохранить live ACL, общий web/Electron UI и серверное выполнение агента.

## Пример адаптированных инструкций

Ниже оригинальный вариант для Runóza, а не цитата ZCode. Его следует включать только в coding-capable run и оценивать на T8.

> Before editing, read the relevant code and repository instructions. Match existing conventions and make the smallest complete change that satisfies the request. Use bounded searches and exact file references; do not reload material that is already available unless the file changed or the needed content was compacted away.
>
> Once the relevant facts are established, implement the change. Treat ordinary tool errors as information: inspect the cause and adjust the next action. Never repeat a state-changing call merely to recover its output. If its outcome is unknown, inspect the resulting state through a separately permitted operation.
>
> Validate the changed behavior with the smallest meaningful check. Record the command or check, its observed result, and any remaining limitation. A planned test is not a passed test. Report completion only to the extent supported by saved results. Continue authorized work while waiting for unrelated clarification; stop when the remaining work requires unavailable input or permission.

Эта инструкция не заменяет policy code. Режимы доступа, timeouts, квоты и запреты на повтор неизвестного внешнего действия должны работать даже при неверном ответе модели.

## Порядок технической реализации

Начать с T8 и фиксации baseline. Затем T1 и T3: они улучшают выбор действий и уменьшают объём генерируемых правок. Следом T2/T4 с проверкой восстановления истории. T6 создаёт понятный контракт результата для UI. T5 вводить двумя независимыми этапами, не обходя durable boundary. T7/T9 оптимизировать после измерений. T10/T11 остаются отдельными архитектурными проектами.

Каждая поставка имеет feature flag и сравнение с прежним поведением. Отключение оптимизации не должно лишать доступа к сохранённым tool results, истории approvals или существующим conversations. Новые migrations добавляются в конец актуальной схемы при реализации; текущие миграции и snapshots не переписываются.
