# Runóza: результат реализации этапов 0–4

27 ноября 2026. Изменения находятся в рабочем checkout поверх `921cb0adbfaa7ca1e9e3b4340232c29d358bdd56`, без commit/push/deploy. Реализованы этапы 0–4 [общего плана](zcode-implementation-plan.md); эксплуатационные контракты и команды — в [coding-evaluation.md](../coding-evaluation.md).

Этот отчёт фиксирует поставку 0–4. Последующая read-only часть этапа 6 и актуальная регрессия описаны в [отчёте просмотра изменений](zcode-readonly-review-results.md).

## Результат

- **0:** воспроизводимый evaluation через `PiAgentRuntime`/`executeRun`, два профиля, синтетические coding/fault cases, независимая проверка результата, JSON/JSONL, opt-in live profile с резервированием бюджета до запроса. Отдельный UI baseline на 1 000 сообщений.
- **1:** модульный prompt с сохранённой версией и fingerprint; разные инструкции для code/chat и server/desktop; `checkLabel` и проверяемые состояния результата команды.
- **2:** одна проекция статуса для истории и панели над composer; приоритет актуального approval, отдельное предупреждение unknown, переходы к действиям; компактные details/resource/scope; сохранение черновика, caret и focus, в том числе при manual compaction; EN/RU и narrow CSS.
- **3:** bounded `workspace_search`, exact `edit_file`, атомарные writes и installs на server/desktop; version conflicts; immutable before/after revisions, snapshot workspace, live ACL proxy и retention. Shell evidence явно частична и не приписывает агенту чужие изменения.
- **4:** microcompaction только сохранённых успешных results с доступным `history_read`; защитные бюджеты; guard повторных ошибок и повторного заполнения контекста; persist/cold restore; оценка подготовленного запроса отдельно от reported usage.

Новая схема — `038_coding_foundation`. Flags фиксируются на каждом новом run; legacy runs остаются читаемыми. Зависимости и lockfile не менялись. Новые идеи реализованы в существующем стеке, исходники и зависимости ZCode не копировались.

## Проверки

| Проверка                                    |   Исходный baseline |                        После изменений |
| ------------------------------------------- | ------------------: | -------------------------------------: |
| Unit                                        |             76 PASS |                                88 PASS |
| UI                                          | 114 PASS, 20 файлов |                     134 PASS, 22 файла |
| Полная интеграция                           |    134 PASS, 6 SKIP |                       142 PASS, 6 SKIP |
| Дополнительный live-budget fixture          |                   — | 1 PASS; только локальный fake provider |
| Deterministic evaluation                    |                   — |         22/22 PASS; 10/10 coding tasks |
| TypeScript, dependency boundaries, Prettier |                PASS |                                   PASS |
| Server/web/desktop builds                   |                PASS |                                   PASS |
| License policy                              |                PASS |              PASS, 781 locked packages |
| `git diff --check`                          |                   — |                                   PASS |

Полный `npm run check` завершился с exit 0. Полный `npm run test:integration` завершился с exit 0. Budget fixture добавлен после полного интеграционного прогона и выполнен отдельно; после него повторно прошли lint/typecheck. Итого выполнено 143 успешных интеграционных теста, 6 инфраструктурных пропусков. Сборка предупреждает о размере web chunk; UI tests сохраняют известное ограничение jsdom `Window.scrollTo`. Ошибок тестов нет.

Полная интеграция проверяет прежние auth, project ACL, provider controls, streaming/branches, permissions/reviewer, desktop protocol, workspace/leases, files/storage, skills/MCP, schedules и recovery. Новые regression cases дополнительно проверяют:

- Два managed writers с одним hash, exclusive create, append, Unicode/mode, symlink substitution, отмену, fsync/write/rename failure, hard-killed writer и потерю ответа после возможного commit.
- Exact edit с CRLF/BOM/Unicode, stale hash и несколькими совпадениями; сохранность before/after по digest и read-only proxy.
- Запрет обычного file GET/DELETE для revisions, включая бывшего project member; повторную проверку ACL после storage.get; скрытие revisions из file list/export; retention и сохранение metadata после удаления blob.
- Migration 038 down/up без изменения старых messages/actions.
- Microcompaction с полной копией результатов, protected batches/errors/unknown/media; cold restore и live history ACL; lease fencing; rapid guard/cooldown после восстановления manager.
- Stop после пятой одинаковой ошибки **внутри одного tool batch**: следующий mutation не исполняется; `AGENT_CONTEXT_LOOP` сохраняется на границе Pi вместо общей provider error.
- Сжатие при активном и завершённом run не удаляет несвязанный draft; следующий approval сбрасывает scope; old unknown не скрывает новое разрешение.

## Что показывает сравнение профилей

Отчёт `work/zcode/evaluation-1795733679945/summary.json`, source digest `cfd8493899b97e1ec9b58e2d59ae67935cc8bc89c47f4d2c102e36314843ce5b`.

| Сценарий                           | Legacy                                              | Coding                                                                         |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Exact fix                          | 4 model calls, проверка пройдена                    | 5 calls с дополнительным bounded search, проверка пройдена; revision сохранена |
| Unicode/BOM/CRLF                   | Сохранены                                           | Сохранены; revision проверена                                                  |
| Stale hash                         | Конфликт и успешная новая попытка                   | Конфликт и успешная новая попытка                                              |
| Повторный failure                  | Остановка по step budget после 10 calls             | Остановка по loop guard после 5 calls                                          |
| Одна batch с 5 failures и mutation | Legacy выполняет следующий tool                     | Coding останавливает batch до mutation                                         |
| Unknown outcome                    | 1 execution, свежий approval для отдельной проверки | То же, без replay                                                              |
| Retry до streaming                 | 4 calls, 5 HTTP requests                            | 5 calls, 6 HTTP requests                                                       |
| Большой вывод                      | Полный журнал и paged history read                  | Полный журнал и paged history read                                             |

Это детерминированное сравнение контрактов профилей на текущем runtime. Для обычного исправления coding fixture намеренно выполняет дополнительный search; его scripted token count выше. **Ускорение, экономия реальных моделей и улучшение их качества не доказаны этим прогоном.** Microcompaction отдельно подтверждена на большом durable контексте: проекция сокращается, исходные evidence и ссылки сохраняются. Реальные модели в этом запуске имеют `not_run`.

UI baseline (`work/zcode/ui-baseline.json`): 1 000 сообщений, mount 1 commit, streamed update 1 commit, 0 `getBoundingClientRect`; reader anchor, jump и bottom-follow проходят. Время зависит от машины и jsdom, это не browser performance claim.

## Ограничения проверки

Шесть исходных optional integration cases остались SKIP: реальный Open Terminal workflow; real container isolation/network; real workspace PTY/files; persistent real MCP stdio; restart storage container; real shared terminal upstream. Они требуют отдельной инфраструктуры и не заменены утверждением PASS.

Платные модели не вызывались. Настоящая геометрия 390 px, native Electron smoke, screen-reader/contrast audit и desktop Windows/Linux здесь не выполнялись. Проверены сборки обеих оболочек, EN/RU light/dark component tests, реальные Python filesystem operations и desktop host operations в macOS test process. Для UI использован локальный [Gravity skill](../../.agents/skills/gravity-ui/SKILL.md); его правило routine verification: “Do not install browsers or screenshot tooling, and do not start a dev server for routine verification, unless the user explicitly requests visual or browser verification.” Новый dev server/браузер для визуальной проверки не запускался.

Managed write locks не делают CAS относительно внешнего редактора; частичный shell scan не доказывает полного отсутствия изменений. Context meter не включает текущий draft. Полноценный diff review, возврат revisions, очередь и субагенты относятся к последующим этапам.

## Артефакты

В рабочем checkout сохранены `work/zcode/final-check.log`, `final-integration.log`, `budget-integration.log`, `final-lint.log`, `final-typecheck.log`, `ui-baseline.json`, `evaluation-1795733679945/summary.json` и append-only `cases.jsonl`. Исходный baseline — `baseline-check.log` и `baseline-integration.log`. В этих отчётах нет provider keys, DB/S3 credentials или пользовательских бесед.
