# Coding agent: этапы 0–4 и review изменений

Реализация продолжает [план ZCode](research/zcode-implementation-plan.md), сохраняя PiAgentRuntime, PostgreSQL, действующие permissions, исполнители и общий Gravity UI. Миграция `038_coding_foundation` добавляется после `037_agent_files`; существующие миграции не меняются.

## Что включено

| Этап | Реализация                                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Сравнение профилей через настоящие `PiAgentRuntime` и `executeRun`; синтетические репозитории; fault cases; отчёт JSON/JSONL после каждого случая; opt-in live runner с явными ценами и бюджетом; UI baseline на 1 000 сообщениях |
| 1    | Секции prompt, версия и SHA-256 на run, разделение server/desktop и code/chat; `execute.checkLabel`; результат проверки выводится из сохранённого статуса и exit code                                                             |
| 2    | Общая проекция состояния для истории и панели над composer; переход к текущему действию; компактные approvals; ресурс, место и scope; сохранение черновика/фокуса; EN/RU; адаптивные контролы                                     |
| 3    | `workspace_search`, exact `edit_file`, атомарные managed writes на server/desktop; журнал before/after revisions, ACL proxy и retention; ограниченное наблюдение shell                                                            |
| 4    | Microcompaction сохранённых результатов перед платным summary; токенный/символьный/байтовый бюджет; защита от повторных failures и быстрого повторного заполнения контекста; context meter и существующая ручная compaction       |

Этапы 5–12, полноценный diff review, rewind, очередь и субагенты не входят в эту поставку.

## Включение и откат

Новые runs сохраняют `coding_config` при создании. Перезапуск worker или изменение переменной окружения не меняет уже сохранённый профиль. Runs без конфигурации сохраняют legacy prompt и отключённые новые tools/microcompaction/guards. Live ACL и состояние устройства проверяются независимо от snapshot.

| Переменная API/worker    | По умолчанию         | Значение `false`                                                                                   |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------- |
| `RUNOZA_CODING_PROMPT`   | `coding-sections-v1` | Legacy prompt                                                                                      |
| `RUNOZA_CODING_TOOLS`    | Включено             | Не добавлять search/edit и новые revisions/наблюдение shell для новых runs                         |
| `RUNOZA_MICROCOMPACTION` | Включено             | Отключить microcompaction и адаптивный токенный бюджет tool results; прежний char ceiling остаётся |
| `RUNOZA_LOOP_GUARD`      | Включено             | Отключить новые guards; прежние max steps и timeout остаются                                       |

Дополнительно в этапе 10 добавлен opt-in `RUNOZA_READ_BATCH=true` для ограниченного batch сохранённых страниц и метаданных. По умолчанию выключен; `false` сохраняет прежний путь для новых runs. Результаты полного runtime и ограничения — в [отчёте этапа 10](research/zcode-read-batch-results.md).

Настройки надо задавать процессу, создающему run, включая API и scheduler worker. Атомарная запись, исправления ACL, UI и чтение сохранённой истории не отключаются. Обычный откат поведения — флаги для новых runs, а не удаление evidence. При откате самой схемы новые поля/журнал теряются; migration down предназначена для проверенной процедуры отката с backup, а не для обычного выключения функции. Применение миграции к рабочей установке в рамках этой задачи не выполняется.

## Файловый контракт

`workspace_search` принимает относительный корень (пустая строка означает workspace), literal query, простой glob с `*`/`?`, число совпадений и бюджет байтов. Максимум — 100 совпадений, 1 MiB, 200 посещений; возвращаются строки, SHA-256, фактический объём и `truncated`. По умолчанию исключаются symlinks, secret/internal paths, зависимости и build outputs. Это отдельный инструмент от `files_search`, работающего с виртуальными файлами беседы. Пустой частичный результат не доказывает отсутствие строки.

`edit_file` заменяет единственный exact fragment при совпадении `expectedHash`. Ноль или несколько совпадений — `FILE_EDIT_MATCH`; устаревший hash — `FILE_CONFLICT`. Нет fuzzy или multi-file patch. Предел файла — 1 MiB, каждого фрагмента — 60 000 UTF-8 bytes. BOM, CRLF и Unicode сохраняются. После конфликта нужны новое чтение, новые аргументы и действующее разрешение.

Server text writes и `installResource` используют общую advisory-блокировку открытого root, staging в родительском каталоге, `fsync`, повторную проверку версии/пути и atomic link/replace. Desktop использует общую очередь managed writers в процессе host, staging и повторные проверки отмены/пути/hash. Существующий mode сохраняется. `expectedHash: null` остаётся exclusive create. Транспортный обрыв после возможного commit не превращается в безопасный retry.

Это сериализация сотрудничающих writers Runóza, **не универсальный filesystem CAS** с внешними редакторами и не OS sandbox. После принудительного завершения процесса может остаться скрытый staging-файл. Катастрофическое отключение питания и конкретные Windows/Linux desktop hosts не моделировались macOS-тестами.

## Журнал изменений и хранение

Для `write_file`, `edit_file`, `files_export` и `skills_copy` сохраняются run/action, snapshot workspace, path, digest и ссылка на immutable JSON bundle с lossless base64 before/after. Bundle подготавливается до mutation. Отсутствующая revision из-за policy, лимита или storage error получает `content_unavailable`; текущий файл не подставляется вместо исторического. Подтверждённый commit остаётся отдельным фактом. Незавершённые prepared entries при завершении run переходят в `unknown`.

Контент не сохраняется для secret/internal paths и пары revisions больше 2 MiB. Старое содержимое большого destination может быть недоступно для snapshot, но atomic installer всё равно проверяет ожидаемый hash. Revision blobs используют существующий storage lifecycle/квоту; скрыты из пользовательского списка файлов и экспорта. Обычные file endpoints не дают доступа к `is_revision`, даже владельцу файла: читать его можно только с актуальным ACL беседы через journal proxy.

- `GET /api/v1/runs/:id/changes?offset=0&actionId=<uuid>` — до 100 entries, `nextOffset` и текущий статус run. Фильтр `actionId` необязателен и ограничен тем же run.
- `GET /api/v1/runs/:id/changes/:change/content` — proxied JSON bundle, без прямой S3-ссылки. ACL проверяется до чтения storage и повторно перед отдачей.
- `GET /api/v1/runs/:id/changes/:change/diff` — ограниченный unified diff сохранённых версий. Проверяются SHA-256 bundle и обеих revisions; ACL повторно проверяется после чтения. Бинарные или слишком большие сравнения получают `binary`/`too_large`; нарушение целостности — `409 REVISION_INVALID`, отсутствие сохранённой revision — `404 REVISION_UNAVAILABLE`. Ответ не кэшируется HTTP-кэшем.
- Revision blobs удаляются стандартным cleanup спустя 30 дней; осиротевшие — спустя час. Исторические path/digest/status остаются, `content_available` становится false. Удаление беседы каскадно удаляет entries; orphan cleanup удаляет её blobs.

Shell observation ограничена 20 файлами, 256 KiB и 10 каталогами, без secret/internal paths и generated folders. Сравниваются только файлы, прочитанные в обеих выборках. Выпадение из бюджета не считается удалением. `observed_shell` означает наблюдаемое изменение, без обещания авторства; `bounded_shell_observation/partial` явно отмечает неполное покрытие, включая создание/удаление и внешние изменения. Read-only UI этапа 6 показывает эти ограничения отдельно от подтверждённых managed writes; описание — в [отчёте review](research/zcode-readonly-review-results.md).

## Ссылки на строки revisions

Миграция `039_revision_references` добавляет структурированные ссылки и проверенные сервером excerpts к сообщениям. `revisionReferences` в запросе нового run — до четырёх `{runId, changeId, side, hash, startLine, endLine}`; каждый диапазон ограничен 100 строками и 16 KiB. Предварительное разрешение: `POST /api/v1/conversations/:id/revision-references/resolve`. При отправке проверка и извлечение повторяются. Публичная история содержит метаданные, а excerpt включается в модельный контекст только при доступном источнике. Контракт live ACL, fork, compaction и rollout описан в [отчёте ссылок](research/zcode-revision-references-results.md).

## Контекст и завершение

Microcompaction очищает только старые успешные text results, для которых найден полный durable `code_actions.output` в той же беседе. Сохраняются calls/results, последние пять tool groups, ошибки, unknown, media и несохранённые результаты, user/system сообщения. Marker содержит `actionId` и `history_read`; он не просит повторять действие. Проекция хранится как checkpoint; полный журнал и UI transcript не переписываются. Ручная compaction использует прежний endpoint и summary, а не молча подменяет запрос пользователя microcompaction.

На трёх одинаковых failures модель получает предупреждение, на пяти run останавливается с `AGENT_LOOP_LIMIT`. Сравниваются tool, нормализованные аргументы и результат. Успешный polling, другое действие или изменённые данные сбрасывают счётчик. Stop отменяет и оставшуюся часть tool batch. После двух быстрых повторных заполнений в пределах двух model turns предупреждается о меньших страницах вывода; следующее быстрое повторение останавливается с `AGENT_CONTEXT_LOOP`. Состояние guards сохраняется в БД, включая обычные шаги между compactions.

Context meter показывает **оценку подготовленного запроса**, отдельно от reported input последнего ответа провайдера. Черновик не включён; это не live preflight следующего сообщения. При смене модели прежняя оценка не используется. Видны входной бюджет, резерв, источник чисел, compaction state и счётчики. Неизвестные cache counts не подставляются как подтверждённые нули.

`checkLabel` — название фактически предложенной проверочной команды. `passed/failed` выводится из завершённого действия с exit code; pending/denied/cancelled показываются как not_run, неопределённый результат — unknown. Успешная команда не объявляет всю пользовательскую задачу выполненной. Это не универсальная детекция всех shell-тестов: команды без label остаются в обычном журнале.

## Воспроизводимые проверки

Нужны Node 24.22.1, npm 11.6.x и отдельные PostgreSQL/S3 fixtures по существующему testing runbook. Runner создаёт случайную тестовую БД и отдельный bucket, затем удаляет fixture objects и БД. Не передавать production endpoints. Значения credentials в отчёт не записываются.

```sh
npm run check
npm run test:integration
npm run eval:coding -- --output=work/zcode/my-evaluation
```

Используются `TEST_DATABASE_URL`, `TEST_S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`. Рабочие packages должны быть собраны: `eval:coding` делает это автоматически; прямой запуск integration требует предварительного `npm run build:packages`.

Профили `legacy` и `coding` проходят один и тот же актуальный runtime. Legacy отключает новые prompt/tools/guards; это не исполняемый checkout старого commit. Отдельно сохранён исходный полный baseline до изменений: 76 unit, 114 UI; integration 134 PASS, 6 штатных SKIP. Source digest, git commit/dirty, модель/лимиты, prompt version/fingerprint записываются в каждый эксперимент.

Deterministic cases проверяют exact и Unicode правки, stale hash, неоднозначный фрагмент, retry до streaming, повторяющиеся failures, stop внутри одного tool batch, передачу context guard error через Pi, unknown без replay, сохранение большого вывода и отказ в approval. Корректность исправления проверяется независимо на четырёх арифметических входах и сохранности остального содержимого. Все вызовы проходят PiAgentRuntime/executeRun, permissions, БД и storage. Синтетический executor — ограниченный репозиторий и проверка `verify`, **не произвольный host shell**; реальные atomic filesystem paths отдельно проверяются unit tests. Fault-case PASS означает выполнение ожидаемого контракта профиля, а не успешно решённую coding task.

`summary.json` содержит версию, результаты и ограничения; `cases.jsonl` дописывается и fsync-ится после каждого случая. Уже завершённые случаи переживают прерывание. Для следующего эксперимента нужен новый output directory. Метрики включают model calls, HTTP requests/retries, input/output/cache при наличии, compactions, повторные чтения, конфликты, simulated approval wait и время. Deterministic usage — scripted; он не измеряет качество реальной модели и не доказывает экономию стоимости.

UI baseline запускается в `npm run test:ui` и сохраняется в `work/zcode/ui-baseline.json`: 1 000 сообщений, commits/render duration, geometry reads, scroll anchor и bottom-follow. Это jsdom, без порогов «ускорения» и без утверждений о реальной browser latency. Тестируются EN/RU, light/dark, focus/scope, SSE, старые transcripts и сохранение черновика при manual compaction.

## Opt-in реальные модели

Обычные проверки не вызывают платные модели. Для live runner нужен JSON profile; секрет берётся только из указанной переменной окружения:

```json
{
  "baseUrl": "https://your-provider.example/v1",
  "model": "your-model",
  "apiKeyEnv": "RUNOZA_EVAL_API_KEY",
  "maxUsd": 1,
  "inputUsdPerMillion": 1,
  "outputUsdPerMillion": 2,
  "contextTokens": 32768,
  "outputTokens": 2048,
  "maxCalls": 12,
  "repeats": 2
}
```

Цены выше — пример конфигурации, а не актуальный прайс провайдера. Подставить свои подтверждённые цены и лимит. Запуск:

```sh
npm run eval:coding -- --live=/absolute/path/profile.json --output=work/zcode/live-comparison
```

До каждого HTTP-вызова резервируется верхняя оценка по полному context window и output cap с ценами профиля. Новый вызов не отправляется, если он превысит `maxUsd` или call limit. Резерв сохраняется до отправки, включая неуспешные attempts. `reservedUsdUpperBound` и его отношение к числу успешных coding tasks не выдаются за реальный invoice: фактические тарифы, reasoning/cache semantics и биллинг определяет провайдер. Неизвестная actual cost остаётся null. Невыполненные случаи имеют `not_run` с причиной; они не считаются PASS. Реальные модели сравниваются на одинаковых задачах/профилях/repeats и с указанием размера выборки.

## Границы проведённой проверки

Точная итоговая статистика текущего прогона находится в отчёте рядом с планом и в `work/zcode/`. Native Electron smoke, геометрия 390 px в настоящем браузере, desktop Windows/Linux, live Open Terminal cases и платные модели должны отмечаться `not_run`, если соответствующая среда не запускалась. Сборка обоих UI targets и component tests не подменяют эти проверки.
