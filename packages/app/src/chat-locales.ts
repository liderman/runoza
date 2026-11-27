export const chatDictionaries = {
  en: {
    ROLLBACK_REVIEW_REQUIRED:
      "Inspect the partial or interrupted rollback before resuming queued requests.",
    ROLLBACK_APPLY_CANCELLED:
      "Remaining writes were stopped. Already acknowledged writes were not undone; inspect the journal.",
    ROLLBACK_APPLY_TIMEOUT:
      "Rollback reached its deadline. Inspect the journal before further changes.",
    ROLLBACK_APPLY_DISABLED:
      "Applying rollback is disabled. Saved journals remain available.",
    ROLLBACK_ACTIVE:
      "A rollback is pending or running in this workspace. Wait or stop its remaining writes.",
    ROLLBACK_ALREADY_USED:
      "This preview has already been confirmed. Inspect its journal instead of replaying it.",
    ROLLBACK_NOT_READY:
      "A fresh preview with only matching supported files is required.",
    ROLLBACK_CONFIRMATION:
      "The confirmation does not match this exact preview.",
    ROLLBACK_WORKSPACE_BUSY:
      "Finish workspace actions and close terminals before rollback.",
    ROLLBACK_CONFLICT:
      "Preflight found changed or unavailable files. No rollback writes were started.",
    ROLLBACK_INTERRUPTED:
      "The worker was interrupted. Dispatched writes may have an unknown outcome; inspect the journal.",
    ROLLBACK_JOURNAL:
      "The write acknowledgement could not be saved. Inspect the file before any further action.",
    ROLLBACK_DISABLED: "Rollback preview is disabled.",
    ROLLBACK_BUSY: "Wait for the active run to finish before checking files.",
    ROLLBACK_LIMIT:
      "This run exceeds the preview limit (50 changes, 25 files, 8 MiB).",
    ROLLBACK_STALE:
      "The workspace or saved evidence changed. Request a new preview.",
    ROLLBACK_EXPIRED: "The preview expired. Request a new check.",
    ROLLBACK_CANCELLED: "The preview was cancelled. Files were not changed.",
    ROLLBACK_TIMEOUT:
      "The file check reached its time limit. Retry the preview.",
    ROLLBACK_UNAVAILABLE: "Could not check files. Retry the preview.",
    RESEARCH_INPUT:
      "Use a focused task and a short context for the researcher.",
    RESEARCH_DISABLED: "The read-only research pilot is disabled for this run.",
    RESEARCH_ALREADY_STARTED:
      "This research call has already started and will not be replayed.",
    RESEARCH_LIMIT: "The run allows three researchers, one at a time.",
    RESEARCH_BUDGET:
      "The research budget is exhausted. One model attempt remains reserved for the parent.",
    RESEARCH_INTERRUPTED:
      "Research was interrupted. Saved reads remain available; no report is confirmed.",
    RESEARCH_TIMEOUT:
      "The researcher reached its time limit. The parent run was stopped too.",
    RESEARCH_TARGET_CHANGED:
      "The workspace, project or run mode changed. Research stopped.",
    RESEARCH_TOOL_DENIED:
      "This tool is outside the researcher’s read-only permissions.",
    RESEARCH_EVIDENCE_MISSING: "The research evidence could not be verified.",
    RESEARCH_NO_EVIDENCE:
      "No complete report backed by successful reads was produced.",
    RESEARCH_CONTEXT_LIMIT:
      "Research reached its context limit. Saved reads remain available.",
    RESEARCH_OUTPUT_LIMIT:
      "The research report reached the output limit and is not confirmed.",
    RESEARCH_FAILED:
      "Research failed. Inspect the saved reads before continuing.",

    MODEL_BOUNDARY_MISSING:
      "No complete model boundary is available. Saved actions need review.",
    MODEL_TOOL_UNCONFIRMED:
      "An action outcome is unconfirmed. Automatic replay is blocked.",
    MODEL_PARTIAL_RESPONSE:
      "A partial response was saved. Recovery stopped to avoid duplicating it.",
    MODEL_BATCH_INCOMPLETE:
      "Some tool results are missing. Review saved actions before continuing.",
    MODEL_RECOVERY_LIMIT: "The round recovery limit has been reached.",
    MODEL_CONFIGURATION_CHANGED:
      "The model, tools or execution context changed. Review before starting a new request.",
    MODEL_JOURNAL_LIMIT:
      "The recovery journal reached its size limit. Saved actions are preserved.",
    MODEL_BATCH_INVALID: "The model returned an invalid tool batch.",
    MODEL_BOUNDARY_INVALID: "The recovery boundary could not be verified.",
    MODEL_TOOL_ALREADY_STARTED:
      "This tool call already started. Automatic replay is blocked.",
    MODEL_JOURNAL_UNAVAILABLE:
      "The recovery journal could not be saved. Execution stopped.",

    QUEUE_INPUT_INVALID:
      "Use a regular message for the queue. Compaction commands run separately.",
    QUEUE_PENDING:
      "This conversation has queued requests. Add this request next or pause the queue.",
    QUEUE_LIMIT: "The queue already contains 100 pending requests.",
    QUEUE_CONFLICT:
      "The queue changed in another client or the request already started. Refresh before editing.",
    QUEUE_NEEDS_ATTENTION:
      "Review, update or remove the affected request, then resume the queue.",
    QUEUE_BRANCH_CHANGED:
      "The conversation branch changed. Review the queue before continuing.",
    QUEUE_TARGET_CHANGED:
      "The workspace or project changed. Edit and revalidate this request.",
    QUEUE_SELECTION_CHANGED:
      "The selected model or extension settings changed. Edit and revalidate this request.",
    QUEUE_ACK_UNKNOWN:
      "Receipt is uncertain. Your draft is preserved. Check receipt before sending again.",
    QUEUE_ACK_NOT_FOUND:
      "Receipt has not been confirmed. You can retry the same submission safely.",
    USER_PAUSED: "The queue is paused.",
    RUN_FAILED: "The previous run failed. The queue is paused.",
    UNKNOWN_ACTION:
      "An action outcome is unconfirmed. Review it before resuming the queue.",
    APPROVAL_MODE_CHANGED:
      "The conversation's approval mode changed. Review the updated mode and send again.",
    AGENT_TIMEOUT:
      "The agent reached its time limit. No command will be retried automatically.",
    CODE_DISABLED: "Code mode is disabled by the administrator.",
    CODE_NOT_CONFIGURED:
      "Code environments are not configured. Contact your administrator.",
    ENVIRONMENT_BUSY:
      "No free environment. Ask your administrator to replenish the pool.",
    EXECUTION_UNKNOWN:
      "The command outcome is unknown. It will not be retried automatically.",
    LEASE_LOST: "The environment lease expired. The run was stopped.",
    AGENT_STEP_LIMIT: "The agent reached its step limit.",
    AGENT_LOOP_LIMIT:
      "The agent stopped after five identical unsuccessful actions. Inspect the last result and adjust the request before continuing.",
    AGENT_CONTEXT_LOOP:
      "The context filled up again soon after repeated compaction. The run was stopped. Reduce the task or pinned context before continuing.",
    FILE_EDIT_MATCH:
      "The requested text was not found exactly once. Read the current file and provide a unique replacement target.",
    FILE_EDIT_INPUT:
      "The file edit parameters are invalid. Check the path, original text and replacement.",
    FILE_SEARCH_INPUT:
      "The file search parameters are invalid. Check the path and search options.",
    REVISION_UNAVAILABLE:
      "The saved revision is unavailable or access has changed. Remove its reference or select an accessible saved version.",
    REVISION_CHANGED:
      "The saved version does not match the selected hash. Reopen the diff and select the range again.",
    REVISION_INVALID:
      "Saved revisions failed integrity validation. The current file will not be substituted.",
    REVISION_RANGE_INVALID:
      "Choose an existing range of up to 100 lines on one side of the diff.",
    REVISION_REFERENCE_TOO_LARGE:
      "The selected excerpt exceeds 16 KiB or its source exceeds the text limit. Select a smaller excerpt or source.",
    REVISION_TEXT_UNAVAILABLE:
      "This revision is binary or not UTF-8; a text reference is unavailable.",
    ENVIRONMENT_FAILED: "Could not prepare the environment.",
    TERMINAL_UNAVAILABLE:
      "The terminal service is unavailable. Try again shortly.",
    TERMINAL_CONFIG_INVALID:
      "The terminal service must have multi-user mode enabled without a username prefix.",
    ARTIFACT_INVALID: "Could not save the result file.",
    ARTIFACT_PATH: "Invalid result file path.",

    chat: "Chat",
    newChat: "New conversation",
    history: "Conversations",
    empty: "Start a conversation",
    emptyHint: "Choose a model and ask your first question.",
    prompt: "Message Runóza…",
    send: "Send",
    stop: "Stop response",
    rename: "Rename",
    remove: "Delete conversation",
    removeHint: "This conversation and all its branches will be deleted.",
    cancel: "Cancel",
    save: "Save",
    title: "Conversation title",
    model: "Model",
    noModels:
      "No models are available. Ask a system administrator to configure a provider and allow models.",
    providers: "Model providers",
    addProvider: "Add provider",
    providerName: "Connection name",
    endpoint: "API base URL (including /v1)",
    key: "API key (leave blank to keep the existing key)",
    allowed: "Allowed model IDs, one per line",
    enabled: "Enabled",
    test: "Test connection and discover models",
    discovered: "Available models",
    choose: "Allow selected models",
    edit: "Edit connection",
    retry: "Generate another answer",
    branch: "Edit and branch",
    branchHint: "Creates a new branch and keeps the previous messages.",
    versions: "Response branches",
    tokens: "Reported tokens",
    reconnecting: "Reconnecting… The response continues on the server.",
    ready: "Connection successful",
    loading: "Loading…",
    error: "The request failed. Please try again.",
    copy: "Copy",
    copied: "Copied",
    disclaimer: "AI can make mistakes. Verify important information.",
    configure: "Configure providers",
    MODEL_UNAVAILABLE:
      "This model is no longer available. Select another model.",
    PROVIDER_CONNECTION_FAILED:
      "Could not connect to the model provider after retrying. Please try again shortly.",
    PROVIDER_UNAVAILABLE:
      "The provider is unavailable or rejected the request. Check the connection and try again.",
    PROVIDER_AUTH: "The provider rejected the API key.",
    PROVIDER_INVALID: "The provider returned an invalid response.",
    PROVIDER_URL_INVALID:
      "Check the API URL. OpenRouter uses https://openrouter.ai/api/v1.",
    PROVIDER_KEY_REQUIRED: "Enter a key again when changing the endpoint.",
    PROVIDERS_NOT_CONFIGURED:
      "The server provider encryption key is not configured.",
    CHAT_DISABLED: "Chat is disabled by your administrator.",
    COMPACTION_FAILED:
      "Could not create a complete checkpoint. Original context is preserved. Retry /compaction.",
    COMPACTION_FIXED_CONTEXT:
      "Fixed instructions or the current request leave too little room for compaction. Reduce pinned schemas or check model limits.",
    COMPACTION_NO_GAIN:
      "The checkpoint did not free enough space. Original context is preserved.",
    COMPACTION_TOO_LARGE:
      "The transcript is too large for one compaction. Original history is preserved.",
    COMPACTION_INVALID_HISTORY:
      "Compaction is waiting for complete tool results. Original history is preserved.",
    COMPACTION_NO_ACTIVE_RUN:
      "The run has already finished. Send /compaction again.",
    RUN_ACTIVE: "This conversation already has a response in progress.",
    RECOVERY_LIMIT:
      "Text recovery reached its attempt limit. The partial response is preserved.",
    RECOVERY_TOOL_CALL:
      "Text recovery stopped because a tool call appeared. No tool was replayed.",
    PROVIDER_TRANSIENT: "The provider is temporarily unavailable.",
    PLAN_INVALID:
      "The plan needs a summary, unique steps and a reason for each blocker.",
    PLAN_CONFLICT:
      "The plan version changed. Reload the saved plan before editing or starting.",
    PLAN_ORDER_INVALID: "Keep existing steps in their original order.",
    PLAN_UNAVAILABLE: "A completed planning run with a saved plan is required.",
    PLAN_CONTEXT_CHANGED:
      "The conversation branch changed. Prepare a new plan for the current task.",
    PLAN_TARGET_CHANGED:
      "The workspace changed. Prepare a new plan for the selected workspace.",
    PLAN_TOOL_DENIED: "This tool is unavailable in planning mode.",
    PLAN_ACCEPT_AGAIN:
      "Start a new planning request before retrying implementation.",
    MCP_UNAVAILABLE: "The MCP connection is disabled or unavailable.",
    MCP_TOOL_DENIED: "This MCP tool is not allowed by your administrator.",
    MCP_CHANGED:
      "MCP settings changed after approval was requested. Try again.",
    MCP_AUTH:
      "The MCP server rejected your personal key. Check it in Extensions.",
    MCP_HTTP: "The MCP server returned an HTTP error.",
    MCP_REMOTE_ERROR: "The MCP server rejected the tool request.",
    MCP_STDIO_FAILED:
      "Could not start stdio MCP. Check Python 3 and the installed program in your workspace.",
    MCP_DISABLED: "MCP is disabled by your administrator.",
    SKILLS_DISABLED: "Skills are disabled by your administrator.",
    MCP_URL_DENIED: "This MCP endpoint is blocked by the network policy.",
    MCP_WORKSPACE_REQUIRED: "A stdio MCP needs an execution workspace.",
    MCP_DEVICE_REQUIRED: "Choose a workspace on the device hosting this MCP.",
    MODEL_TOOLS_UNSUPPORTED:
      "This model does not support tools. Choose another enabled model.",
    EXTENSION_CONTEXT_LIMIT:
      "Input including pinned schemas exceeds the model token budget after reserving the response. Reduce history/schemas or check model context and output settings.",
    MCP_INVALID: "The MCP server returned an invalid response.",
    MCP_OUTPUT_LIMIT: "The MCP response is too large.",
    MCP_TOOL_LIMIT: "The MCP server exposes too many tools.",
    MCP_VERSION: "This MCP protocol version is not supported yet.",
    SKILL_LIMIT: "Too many instructions selected. Use fewer skills.",
    RUN_LIMIT:
      "The concurrent response limit has been reached. Wait or stop one. An administrator can change the limit in assistant settings.",
    CONTEXT_LIMIT:
      "The input exceeds the model token budget after reserving the response. Reduce history or check the model context and output settings.",
    HISTORY_LIMIT: "This conversation has reached its message limit.",
    OUTPUT_LIMIT:
      "The response reached the size limit. Try a lower reasoning effort or a smaller task.",
    REASONING_INVALID:
      "This reasoning level is no longer available. Choose the model again.",
    OUTPUT_TRUNCATED: "The response reached the output token limit.",
    WORKER_INTERRUPTED:
      "Generation was interrupted by a worker restart. The saved text is available; you can retry.",
    STREAM_INTERRUPTED: "The provider interrupted the response. You can retry.",
    RUN_CANCELLED: "Response stopped.",
    RATE_LIMITED: "Too many requests. Please wait and try again.",
    UNAUTHENTICATED: "Your session expired. Sign in again.",
    FORBIDDEN: "Access denied.",
    NOT_FOUND: "Conversation or connection not found.",
    INVALID_REQUEST: "Check the entered values.",
    IDEMPOTENCY_CONFLICT:
      "This request key was already used. Reload the conversation.",
  },
  ru: {
    ROLLBACK_REVIEW_REQUIRED:
      "Проверьте частичный или прерванный откат перед продолжением очереди запросов.",
    ROLLBACK_APPLY_CANCELLED:
      "Оставшиеся записи остановлены. Уже подтверждённые записи не отменены; проверьте журнал.",
    ROLLBACK_APPLY_TIMEOUT:
      "Откат превысил время ожидания. Проверьте журнал перед дальнейшими изменениями.",
    ROLLBACK_APPLY_DISABLED:
      "Применение отката выключено. Сохранённые журналы доступны.",
    ROLLBACK_ACTIVE:
      "В этой рабочей папке ожидает или выполняется откат. Дождитесь результата или остановите оставшиеся записи.",
    ROLLBACK_ALREADY_USED:
      "Этот предпросмотр уже подтверждён. Проверьте журнал вместо повторного выполнения.",
    ROLLBACK_NOT_READY:
      "Нужен свежий предпросмотр, в котором все файлы поддерживаются и совпадают.",
    ROLLBACK_CONFIRMATION:
      "Подтверждение не соответствует этому точному предпросмотру.",
    ROLLBACK_WORKSPACE_BUSY:
      "Завершите действия рабочей папки и закройте терминалы перед откатом.",
    ROLLBACK_CONFLICT:
      "Повторная проверка обнаружила изменённые или недоступные файлы. Записи отката не начинались.",
    ROLLBACK_INTERRUPTED:
      "Worker прерван. У отправленных записей возможен неизвестный исход; проверьте журнал.",
    ROLLBACK_JOURNAL:
      "Не удалось сохранить подтверждение записи. Проверьте файл перед дальнейшими действиями.",
    ROLLBACK_DISABLED: "Предпросмотр отката выключен.",
    ROLLBACK_BUSY:
      "Дождитесь завершения активного запуска перед проверкой файлов.",
    ROLLBACK_LIMIT:
      "Запуск превышает лимит предпросмотра (50 записей, 25 файлов, 8 МиБ).",
    ROLLBACK_STALE:
      "Рабочая папка или сохранённые версии изменились. Запросите новый предпросмотр.",
    ROLLBACK_EXPIRED: "Предпросмотр устарел. Запросите новую проверку.",
    ROLLBACK_CANCELLED: "Предпросмотр отменён. Файлы не изменены.",
    ROLLBACK_TIMEOUT:
      "Проверка файлов превысила время ожидания. Повторите предпросмотр.",
    ROLLBACK_UNAVAILABLE: "Не удалось проверить файлы. Повторите предпросмотр.",
    RESEARCH_INPUT:
      "Передайте исследователю конкретную задачу и короткий контекст.",
    RESEARCH_DISABLED: "Пилот исследователя выключен для этого запуска.",
    RESEARCH_ALREADY_STARTED:
      "Это исследование уже запускалось и не будет повторено автоматически.",
    RESEARCH_LIMIT:
      "В запуске допускаются три исследования, по одному одновременно.",
    RESEARCH_BUDGET:
      "Бюджет исследования исчерпан. Одна попытка модели зарезервирована для родителя.",
    RESEARCH_INTERRUPTED:
      "Исследование прервано. Сохранённые чтения доступны; отчёт не подтверждён.",
    RESEARCH_TIMEOUT:
      "Исследователь достиг лимита времени. Родительский запуск также остановлен.",
    RESEARCH_TARGET_CHANGED:
      "Рабочая папка, проект или режим запуска изменились. Исследование остановлено.",
    RESEARCH_TOOL_DENIED:
      "Этот инструмент выходит за пределы разрешённых исследователю чтений.",
    RESEARCH_EVIDENCE_MISSING: "Не удалось подтвердить источник исследования.",
    RESEARCH_NO_EVIDENCE:
      "Нет завершённого отчёта, подкреплённого успешными чтениями.",
    RESEARCH_CONTEXT_LIMIT:
      "Исследование достигло лимита контекста. Сохранённые чтения доступны.",
    RESEARCH_OUTPUT_LIMIT:
      "Отчёт исследователя достиг лимита ответа и не подтверждён.",
    RESEARCH_FAILED:
      "Исследование завершилось ошибкой. Проверьте сохранённые чтения перед продолжением.",

    MODEL_BOUNDARY_MISSING:
      "Нет полной границы модельного раунда. Проверьте сохранённые действия.",
    MODEL_TOOL_UNCONFIRMED:
      "Исход действия не подтверждён. Автоматический повтор заблокирован.",
    MODEL_PARTIAL_RESPONSE:
      "Сохранён частичный ответ. Восстановление остановлено, чтобы не дублировать его.",
    MODEL_BATCH_INCOMPLETE:
      "Не все результаты инструментов сохранены. Проверьте действия перед продолжением.",
    MODEL_RECOVERY_LIMIT: "Достигнут лимит восстановлений раунда.",
    MODEL_CONFIGURATION_CHANGED:
      "Модель, инструменты или контекст выполнения изменились. Проверьте их перед новым запросом.",
    MODEL_JOURNAL_LIMIT:
      "Достигнут лимит размера журнала восстановления. Записанные действия сохранены.",
    MODEL_BATCH_INVALID:
      "Модель вернула некорректный набор вызовов инструментов.",
    MODEL_BOUNDARY_INVALID: "Не удалось проверить границу восстановления.",
    MODEL_TOOL_ALREADY_STARTED:
      "Этот вызов инструмента уже начат. Автоматический повтор заблокирован.",
    MODEL_JOURNAL_UNAVAILABLE:
      "Не удалось сохранить журнал восстановления. Выполнение остановлено.",

    QUEUE_INPUT_INVALID:
      "Добавьте обычное сообщение. Команда сжатия выполняется отдельно.",
    QUEUE_PENDING:
      "В беседе есть очередь. Добавьте запрос следующим или приостановите очередь.",
    QUEUE_LIMIT: "В очереди уже 100 ожидающих запросов.",
    QUEUE_CONFLICT:
      "Очередь изменилась в другом клиенте или запрос уже запущен. Обновите её перед редактированием.",
    QUEUE_NEEDS_ATTENTION:
      "Проверьте, измените или удалите проблемный запрос, затем возобновите очередь.",
    QUEUE_BRANCH_CHANGED:
      "Ветка беседы изменилась. Проверьте очередь перед продолжением.",
    QUEUE_TARGET_CHANGED:
      "Рабочая папка или проект изменились. Отредактируйте и перепроверьте запрос.",
    QUEUE_SELECTION_CHANGED:
      "Настройки выбранной модели или расширений изменились. Отредактируйте и перепроверьте запрос.",
    QUEUE_ACK_UNKNOWN:
      "Приём запроса не подтверждён. Черновик сохранён. Проверьте приём перед повторной отправкой.",
    QUEUE_ACK_NOT_FOUND:
      "Приём пока не подтверждён. Можно безопасно повторить ту же отправку.",
    USER_PAUSED: "Очередь приостановлена.",
    RUN_FAILED: "Предыдущий запуск завершился ошибкой. Очередь приостановлена.",
    UNKNOWN_ACTION:
      "Результат действия не подтверждён. Проверьте его перед возобновлением очереди.",
    APPROVAL_MODE_CHANGED:
      "Режим подтверждений изменился. Проверьте новый режим и отправьте сообщение ещё раз.",
    AGENT_TIMEOUT:
      "Агент достиг лимита времени. Команды не будут повторяться автоматически.",
    CODE_DISABLED: "Администратор отключил режим кода.",
    CODE_NOT_CONFIGURED:
      "Окружения для кода не настроены. Обратитесь к администратору.",
    ENVIRONMENT_BUSY:
      "Нет свободного окружения. Администратору нужно пополнить пул.",
    EXECUTION_UNKNOWN:
      "Исход команды неизвестен. Она не будет повторена автоматически.",
    LEASE_LOST: "Срок аренды окружения истёк. Запуск остановлен.",
    AGENT_STEP_LIMIT: "Агент достиг лимита шагов.",
    AGENT_LOOP_LIMIT:
      "Агент остановился после пяти одинаковых неуспешных действий. Проверьте последний результат и уточните запрос перед продолжением.",
    AGENT_CONTEXT_LOOP:
      "Контекст снова переполнился вскоре после повторного сжатия. Запуск остановлен. Уменьшите задачу или закреплённый контекст перед продолжением.",
    FILE_EDIT_MATCH:
      "Искомый текст должен встречаться в файле ровно один раз. Прочитайте текущий файл и укажите уникальный фрагмент для замены.",
    FILE_EDIT_INPUT:
      "Некорректные параметры изменения файла. Проверьте путь, исходный текст и замену.",
    FILE_SEARCH_INPUT:
      "Некорректные параметры поиска файлов. Проверьте путь и параметры поиска.",
    REVISION_UNAVAILABLE:
      "Сохранённая версия недоступна или доступ изменился. Уберите ссылку либо выберите доступную сохранённую версию.",
    REVISION_CHANGED:
      "Версия не совпадает с выбранным хэшем. Откройте diff заново и выберите диапазон.",
    REVISION_INVALID:
      "Сохранённые версии не прошли проверку целостности. Текущий файл не будет подставлен вместо них.",
    REVISION_RANGE_INVALID:
      "Выберите существующий диапазон до 100 строк на одной стороне diff.",
    REVISION_REFERENCE_TOO_LARGE:
      "Фрагмент превышает 16 KiB или источник превышает лимит текста. Выберите меньший фрагмент или источник.",
    REVISION_TEXT_UNAVAILABLE:
      "Версия бинарная или не в UTF-8; текстовая ссылка недоступна.",
    ENVIRONMENT_FAILED: "Не удалось подготовить окружение.",
    TERMINAL_UNAVAILABLE:
      "Сервис терминалов недоступен. Повторите попытку чуть позже.",
    TERMINAL_CONFIG_INVALID:
      "Для сервиса терминалов нужен многопользовательский режим без префикса имён пользователей.",
    ARTIFACT_INVALID: "Не удалось сохранить файл результата.",
    ARTIFACT_PATH: "Недопустимый путь файла результата.",

    chat: "Чат",
    newChat: "Новая беседа",
    history: "Беседы",
    empty: "Начните беседу",
    emptyHint: "Выберите модель и задайте первый вопрос.",
    prompt: "Напишите Runóza…",
    send: "Отправить",
    stop: "Остановить ответ",
    rename: "Переименовать",
    remove: "Удалить беседу",
    removeHint: "Беседа и все её ветки будут удалены.",
    cancel: "Отмена",
    save: "Сохранить",
    title: "Название беседы",
    model: "Модель",
    noModels:
      "Нет доступных моделей. Системный администратор должен настроить подключение и разрешить модели.",
    providers: "Провайдеры моделей",
    addProvider: "Добавить провайдера",
    providerName: "Название подключения",
    endpoint: "Базовый URL API (включая /v1)",
    key: "API-ключ (оставьте пустым, чтобы сохранить прежний)",
    allowed: "Разрешённые ID моделей, по одному на строку",
    enabled: "Включён",
    test: "Проверить подключение и получить модели",
    discovered: "Доступные модели",
    choose: "Разрешить выбранные модели",
    edit: "Изменить подключение",
    retry: "Сгенерировать другой ответ",
    branch: "Изменить и создать ветку",
    branchHint: "Создаст новую ветку, сохранив прежние сообщения.",
    versions: "Ветки ответа",
    tokens: "Токены по данным провайдера",
    reconnecting:
      "Переподключение… Ответ продолжает генерироваться на сервере.",
    ready: "Подключение работает",
    loading: "Загрузка…",
    error: "Не удалось выполнить запрос. Попробуйте снова.",
    copy: "Скопировать",
    copied: "Скопировано",
    disclaimer: "ИИ может ошибаться. Проверяйте важную информацию.",
    configure: "Настроить провайдеров",
    MODEL_UNAVAILABLE: "Модель больше недоступна. Выберите другую.",
    PROVIDER_CONNECTION_FAILED:
      "Не удалось подключиться к провайдеру модели после повторной попытки. Попробуйте ещё раз немного позже.",
    PROVIDER_UNAVAILABLE:
      "Провайдер недоступен или отклонил запрос. Проверьте подключение и повторите попытку.",
    PROVIDER_AUTH: "Провайдер отклонил API-ключ.",
    PROVIDER_INVALID: "Провайдер вернул некорректный ответ.",
    PROVIDER_URL_INVALID:
      "Проверьте URL API. Для OpenRouter: https://openrouter.ai/api/v1.",
    PROVIDER_KEY_REQUIRED: "При смене адреса введите ключ заново.",
    PROVIDERS_NOT_CONFIGURED:
      "На сервере не настроен ключ шифрования провайдеров.",
    CHAT_DISABLED: "Администратор отключил чат.",
    COMPACTION_FAILED:
      "Не удалось получить полную сводку. Исходный контекст сохранён. Повторите /compaction.",
    COMPACTION_FIXED_CONTEXT:
      "Инструкции или текущий запрос оставляют слишком мало места для сжатия. Уменьшите закреплённые схемы или проверьте лимиты модели.",
    COMPACTION_NO_GAIN:
      "Сводка не освободила достаточно места. Исходный контекст сохранён.",
    COMPACTION_TOO_LARGE:
      "История слишком велика для одного сжатия. Исходная история сохранена.",
    COMPACTION_INVALID_HISTORY:
      "Для сжатия нужны завершённые результаты инструментов. Исходная история сохранена.",
    COMPACTION_NO_ACTIVE_RUN:
      "Задание уже завершилось. Отправьте /compaction ещё раз.",
    RUN_ACTIVE: "В этой беседе уже генерируется ответ.",
    RECOVERY_LIMIT:
      "Достигнут лимит восстановления текста. Частичный ответ сохранён.",
    RECOVERY_TOOL_CALL:
      "Восстановление остановлено из-за вызова инструмента. Инструменты не повторялись.",
    PROVIDER_TRANSIENT: "Провайдер временно недоступен.",
    PLAN_INVALID: "Укажите задачу, уникальные шаги и причины блокировок.",
    PLAN_CONFLICT:
      "Версия плана изменилась. Обновите сохранённый план перед редактированием или запуском.",
    PLAN_ORDER_INVALID: "Сохраните порядок существующих шагов.",
    PLAN_UNAVAILABLE:
      "Нужен завершённый запуск планирования с сохранённым планом.",
    PLAN_CONTEXT_CHANGED:
      "Ветка беседы изменилась. Подготовьте новый план для текущей задачи.",
    PLAN_TARGET_CHANGED:
      "Рабочая область изменилась. Подготовьте новый план для выбранной области.",
    PLAN_TOOL_DENIED: "Этот инструмент недоступен в режиме планирования.",
    PLAN_ACCEPT_AGAIN:
      "Перед повторным выполнением создайте новый запрос на планирование.",
    MCP_UNAVAILABLE: "MCP-подключение отключено или больше недоступно.",
    MCP_TOOL_DENIED: "Этот MCP-инструмент не разрешён администратором.",
    MCP_CHANGED:
      "Настройки MCP изменились после запроса разрешения. Повторите запрос.",
    MCP_AUTH:
      "MCP-сервер не принял ваш личный ключ. Проверьте его в разделе расширений.",
    MCP_HTTP: "MCP-сервер вернул ошибку.",
    MCP_REMOTE_ERROR: "MCP-сервер отклонил запрос инструмента.",
    MCP_STDIO_FAILED:
      "Не удалось запустить stdio MCP. Проверьте Python 3 и установленную программу в рабочей области.",
    MCP_DISABLED: "MCP отключён администратором.",
    SKILLS_DISABLED: "Скиллы отключены администратором.",
    MCP_URL_DENIED: "Этот адрес MCP запрещён сетевой политикой.",
    MCP_WORKSPACE_REQUIRED: "Для stdio MCP нужна рабочая область выполнения.",
    MCP_DEVICE_REQUIRED:
      "Выберите рабочую папку устройства, где подключён этот MCP.",
    MODEL_TOOLS_UNSUPPORTED:
      "Модель не поддерживает инструменты. Выберите другую включённую модель.",
    EXTENSION_CONTEXT_LIMIT:
      "Вход вместе с закреплёнными схемами превышает бюджет токенов модели с учётом ответа. Сократите историю/схемы или проверьте настройки контекста и ответа модели.",
    MCP_INVALID: "MCP-сервер вернул некорректный ответ.",
    MCP_OUTPUT_LIMIT: "Ответ MCP превышает допустимый размер.",
    MCP_TOOL_LIMIT: "Сервер MCP возвращает слишком много инструментов.",
    MCP_VERSION: "Версия протокола MCP пока не поддерживается.",
    SKILL_LIMIT: "Выбрано слишком много инструкций. Уменьшите число скиллов.",
    RUN_LIMIT:
      "Достигнут лимит одновременных ответов. Дождитесь завершения или остановите один. Администратор может изменить лимит в настройках ассистента.",
    CONTEXT_LIMIT:
      "Вход превышает бюджет токенов модели с учётом ответа. Сократите историю или проверьте настройки контекста и ответа модели.",
    HISTORY_LIMIT: "Достигнут лимит сообщений беседы.",
    OUTPUT_LIMIT:
      "Достигнут лимит ответа. Попробуйте снизить усилие рассуждений или разбить задачу.",
    REASONING_INVALID:
      "Этот уровень рассуждений больше недоступен. Выберите модель заново.",
    OUTPUT_TRUNCATED: "Достигнут лимит выходных токенов.",
    WORKER_INTERRUPTED:
      "Генерация прервана перезапуском обработчика. Полученный текст сохранён; можно повторить запрос.",
    STREAM_INTERRUPTED: "Провайдер прервал ответ. Можно повторить запрос.",
    RUN_CANCELLED: "Ответ остановлен.",
    RATE_LIMITED: "Слишком много запросов. Подождите и повторите попытку.",
    UNAUTHENTICATED: "Сессия истекла. Войдите снова.",
    FORBIDDEN: "Нет доступа.",
    NOT_FOUND: "Беседа или подключение не найдены.",
    INVALID_REQUEST: "Проверьте введённые значения.",
    IDEMPOTENCY_CONFLICT: "Ключ запроса уже использован. Перезагрузите беседу.",
  },
};
export function chatText(locale: "en" | "ru") {
  return (key: string) =>
    (chatDictionaries[locale] as Record<string, string>)[key] ??
    chatDictionaries[locale].error;
}
