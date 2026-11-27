# Runóza: просмотр сохранённых изменений

27 ноября 2026. Реализована первая, read-only часть этапа 6 [общего плана](zcode-implementation-plan.md) поверх этапов 0–4. Изменения находятся в текущем checkout; commit, push и deploy не выполнялись.

Последующая часть этапа 6 — выбор строк и контекстные ссылки — описана в [отдельном отчёте](zcode-revision-references-results.md).

## Пользовательский сценарий

«Изменения запуска» доступны из истории, панели статуса над composer и рабочей области. «Изменения действия» открывают журнал, отфильтрованный сервером по выбранному действию; можно перейти ко всем записям запуска. Повторные правки одного файла остаются отдельными записями с датой, состоянием и идентификатором действия.

Список загружается страницами по 100 записей. Содержимое запрашивается только при выборе записи. Unified diff показывает номера строк обеих версий, additions/deletions, три строки контекста, CRLF/LF, отсутствие завершающего перевода строки и BOM. Создание и удаление обозначены отдельно, включая пустой файл. Код отображается как текст, без выполнения HTML.

Источник сравнения — сохранённые immutable revisions, включая snapshot workspace из того запуска. Работающий executor, подключённый desktop и текущее состояние Git не нужны. Prepared, failed и unknown не выдаются за подтверждённую запись. Частичные shell observations не доказывают отсутствие других правок или авторство агента. Истёкшая retention, недоступные версии, бинарные данные, чрезмерный размер и нарушение целостности показаны явно.

Закрытие окна возвращает фокус без прокрутки чата. Черновик и смонтированная рабочая область/терминал сохраняются. Повторное открытие из той же кнопки восстанавливает выбор, загруженные страницы, фильтр и позицию прокрутки; содержимое заново проверяется сервером. Навигационное состояние живёт только в текущем компоненте, сбрасывается при смене API/run/conversation/action и не сохраняется между аккаунтами или перезагрузками страницы.

## Контракты и границы

- `GET /api/v1/runs/:id/changes` сохраняет прежний ответ и добавляет текущий статус run и необязательный UUID-фильтр `actionId`. Фильтр не расширяет доступ за пределы run.
- Новый `GET /api/v1/runs/:id/changes/:change/diff` читает только ready `is_revision` из этого run. Сервер проверяет текущий ACL до storage и повторно перед ответом. HTTP-ответ — `private, no-store`; прямые S3-ссылки не выдаются.
- Проверяется SHA-256 bundle, версия формата, path, канонический base64 и SHA-256 обеих revisions. Изменённые/повреждённые данные дают `409 REVISION_INVALID`; отсутствующая revision — `404 REVISION_UNAVAILABLE`.
- Чтение bundle ограничено 3 MiB фактических bytes и таймаутом 15 секунд; поток уничтожается при завершении/ошибке. Diff ограничен суммарными 256 KiB UTF-8 и 4 000 строками. Patience anchors/LIS и ограниченный LCS используют бюджет 250 000 ячеек и глубину 32. Превышение бюджета возвращает `too_large`, а не выдуманный patch. Non-UTF-8/NUL дают `binary`.
- Metadata перепроверяется каждые пять секунд при открытом окне и при возвращении фокуса. Ошибка доступа скрывает уже показанный preview. Поздние ответы другой записи не подменяют выбранную. Содержимое query cache удаляется после закрытия/смены записи; auth scope использует существующий `AppDataProvider`.
- Существующий endpoint скачивания JSON revisions, файловые инструменты, permissions, retention и terminal lifecycle сохранены. Новых зависимостей и миграций нет.

## Проверки

Окончательный `npm run check` завершился с exit 0. Полный `npm run test:integration` также завершился с exit 0; после него менялось только восстановление фокуса UI, проверенное окончательным check.

| Проверка                                    | Результат                 |
| ------------------------------------------- | ------------------------- |
| Unit                                        | 93 PASS                   |
| UI                                          | 146 PASS, 23 файла        |
| Полная интеграция                           | 149 PASS, 6 SKIP          |
| TypeScript, dependency boundaries, Prettier | PASS                      |
| Server/web/desktop builds                   | PASS                      |
| License policy                              | PASS, 781 locked packages |
| `git diff --check`                          | PASS                      |

Шесть SKIP — прежние optional scenarios: real Open Terminal workflow, real container isolation/network, real workspace PTY/files, persistent real MCP stdio, restart storage container и real shared terminal upstream. Они требуют отдельной инфраструктуры и не засчитаны как PASS. Известные предупреждения — размер web chunk и `Window.scrollTo` в jsdom.

Логи: `work/zcode/review-final-check.log`, `work/zcode/review-full-integration.log`. Отдельные проверки новых случаев: `review-unit.log`, `review-ui.log`, `review-integration.log`.

Регрессия также выявила гонку фокуса после approval: refetch и animation frame могли завершиться раньше обновления DOM. Восстановление фокуса теперь выполняется после commit React, с проверкой run и текущего focus; новые действия не меняют approval scope.

Новые unit cases проверяют создание/удаление/пустые файлы, Unicode/BOM/CRLF, distant edits, repeated lines и 120 детерминированных случайных сравнений с восстановлением точного after, а также лимиты и повреждение evidence.

Новые UI cases проверяют RU/EN и light/dark, ленивую загрузку, GET-only сценарий offline target, безопасный вывод исходников, Esc и возврат focus, сохранность draft/scroll, повторное открытие записи со второй страницы, фильтр действия, поздний ответ, смену scope, отзыв доступа, unavailable/binary/too_large/invalid и unknown.

Новая интеграция использует настоящие PostgreSQL, sessions/ACL и HTTP routes с in-memory storage fixture: owner/project owner/viewer, отказ stranger, cross-run, отзыв project membership во время чтения, проверка hash, удалённая revision, ложный Content-Length, уничтожение потока, бинарные и большие версии, creation/deletion и пагинация. Полный integration suite отдельно использует существующие disposable DB/S3 fixtures; production не затрагивается.

## Ограничения и следующий шаг

Это не весь этап 6. Ссылки на конкретный диапазон/сторону diff, «Обсудить выделенное» и context references в composer остаются следующей частью. Live Git, plan mode, очередь, rewind и субагенты не добавлены. Исторический frozen snapshot в fork не получает ссылку на чужой исходный run. Полное выделение строки в редакторе и долговременное сохранение навигации между перезагрузками не реализованы.

Narrow CSS переключает список и diff в одну колонку, длинные пути переносятся, содержимое кода прокручивается внутри preview. Настоящая геометрия узкого браузера, native Electron smoke, screen reader и contrast audit имеют `not_run`; сборки и jsdom component tests не заменяют их. Для UI применён локальный [Gravity skill](../../.agents/skills/gravity-ui/SKILL.md): “Do not install browsers or screenshot tooling, and do not start a dev server for routine verification, unless the user explicitly requests visual or browser verification.” Новый dev server и браузер для routine проверки не запускались.
