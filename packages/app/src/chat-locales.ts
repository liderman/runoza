export const chatDictionaries = {
  en: {
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
    RUN_ACTIVE: "This conversation already has a response in progress.",
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
      "Pinned extension schemas exceed the context budget. Unpin some tools.",
    MCP_INVALID: "The MCP server returned an invalid response.",
    MCP_OUTPUT_LIMIT: "The MCP response is too large.",
    MCP_TOOL_LIMIT: "The MCP server exposes too many tools.",
    MCP_VERSION: "This MCP protocol version is not supported yet.",
    SKILL_LIMIT: "Too many instructions selected. Use fewer skills.",
    RUN_LIMIT:
      "The concurrent response limit has been reached. Wait or stop one. An administrator can change the limit in assistant settings.",
    CONTEXT_LIMIT:
      "The conversation exceeds the context limit. Start a new conversation.",
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
    RUN_ACTIVE: "В этой беседе уже генерируется ответ.",
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
      "Закреплённые схемы расширений превышают бюджет контекста. Открепите часть инструментов.",
    MCP_INVALID: "MCP-сервер вернул некорректный ответ.",
    MCP_OUTPUT_LIMIT: "Ответ MCP превышает допустимый размер.",
    MCP_TOOL_LIMIT: "Сервер MCP возвращает слишком много инструментов.",
    MCP_VERSION: "Версия протокола MCP пока не поддерживается.",
    SKILL_LIMIT: "Выбрано слишком много инструкций. Уменьшите число скиллов.",
    RUN_LIMIT:
      "Достигнут лимит одновременных ответов. Дождитесь завершения или остановите один. Администратор может изменить лимит в настройках ассистента.",
    CONTEXT_LIMIT: "Превышен лимит контекста беседы. Начните новую.",
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
