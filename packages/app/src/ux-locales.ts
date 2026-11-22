const en = {
  collapse: "Collapse navigation",
  expand: "Expand navigation",
  openMenu: "Open navigation",
  closeMenu: "Close navigation",
  workspace: "Workspace",
  settings: "Settings",
  accountHint: "Profile, sign-in methods and active sessions.",
  adminHint: "Manage people, access and organization settings.",
  providersHint:
    "Connect model services and choose which models people can use.",
  projectsHint:
    "Keep related conversations, instructions and files in one place.",
  providerType: "Provider type",
  providerKey: "API key",
  keyNew:
    "Enter a key from your provider. It is stored encrypted on the Runóza server.",
  keyKeep:
    "Leave blank to keep the saved key. Enter a new key only to replace it.",
  keyLocal: "Optional if your local server does not require authentication.",
  keyChanged:
    "The address has changed. Re-enter a key for this server, or explicitly select “No authentication”. The old key will not be sent to a new address.",
  noAuth: "This server does not require authentication",
  endpointHelp:
    "The server address including /v1. Requests are sent from the Runóza server, not from your browser. For a service on the Docker host, use host.docker.internal.",
  modelsHelp:
    "One model ID per line. Only these models appear in chat. You can retrieve IDs from a saved connection or enter them manually.",
  modelsInvalid: "Use at most 100 model IDs, each up to 200 characters.",
  nameRequired: "Enter a name.",
  keyRequired: "Enter an API key.",
  valueTooLong: "This value is too long.",
  urlInvalid:
    "Enter an HTTP(S) address without credentials, query or fragment.",
  openrouterUrl: "For OpenRouter use https://openrouter.ai/api/v1.",
  saveProvider: "Save provider",
  providerSaved: "Provider saved.",
  savedTest: "Test saved connection",
  saveBeforeTest: "Save your changes before testing the connection.",
  noProviders: "No providers yet",
  noProvidersHint:
    "Add OpenRouter or connect your own OpenAI-compatible service.",
  selectProvider: "Select a provider to edit its connection.",
  optional: "Optional",
  instructionsHelp:
    "A reusable prompt for this project. It is sent with every new response and applies to all its conversations. Describe the role, language, tone or rules you want the model to follow. This field is optional.",
  instructionsExample:
    "For example: You help our support team. Answer in Russian, keep replies concise and ask for missing details instead of guessing.",
  instructionsShort: "Applied to every new model response in this project.",
  projectFiles: "Project files",
  personalFiles: "Personal files",
  projectFilesHint:
    "A shared library for project members. Uploading does not send files to a model. In a project chat, open Attachments and select the files to include in a message.",
  personalFilesHint:
    "Only you can access these files. Select them in Attachments when you want to include them in a personal chat.",
  filePrivacy:
    "When you attach a file and send a message, its supported text is sent to the selected model provider. Files are not automatically indexed or included in all conversations.",
  formats:
    "Text and source code can be read by the model. PDF, images and other formats are download-only for now.",
  uploadShort: "Drop files here or choose them on your device.",
  fileLimits: "File size and supported formats",
  fileCancelled: "Upload cancelled. You can upload the file again.",
  uploadFile: "Uploading",
  loading: "Loading…",
  settingsTab: "Instructions",
  filesTab: "Files",
  membersTab: "Members",
  membersHelp:
    "Add an existing member of your organization by email. Editors can change instructions, files and conversations. Viewers can only read and download.",
  noMembers: "This project has no invited members yet.",
  memberMissing:
    "No active user with this email was found in your organization.",
  emailInvalid: "Enter a valid email address.",
  saved: "Changes saved.",
  createProjectHelp:
    "Give the project a name. Instructions are optional; you can add them later.",
  danger: "Delete project",
  dangerHelp:
    "Deletes this project, its conversations and files for all members. This cannot be undone.",
  cancel: "Cancel",
  discard: "Discard changes",
  unsaved: "Discard unsaved changes?",
  unsavedHint: "Your edits have not been saved.",
  edit: "Edit",
  projectScope: "Conversation space",
  projectScopeHelp:
    "Choose a project before starting a conversation. Its instructions and shared files will be available here. An existing conversation keeps its original space.",
  personalChat: "Personal conversation",
  projectLocked: "To choose a different project, start a new conversation.",
  conversationActions: "Conversation actions",
  exportHelp:
    "Exports available conversations and metadata. File contents are downloaded separately.",
  oidcHelp:
    "Connect an OpenID Connect identity provider to let people sign in through your organization.",
  issuerHelp:
    "The issuer URL from your identity provider, not its sign-in page. Runóza uses it to discover the SSO configuration.",
  clientIdHelp:
    "The application client ID registered with your identity provider.",
  clientSecretHelp:
    "Leave blank to keep the saved secret. A new public client may not need a secret.",
  flagsHelp: "Controls feature availability across the organization.",
  notAvailable: "Not available yet",
  choose: "Choose",
  fileActions: "File actions",
  membersCount: "Members",
  refresh: "Refresh",
  projectSaved: "Project saved.",
  createChat: "Open a project chat",
  invalid: "Check the highlighted fields.",
  passwordHelp:
    "Use 12–128 characters. Changing the password signs out active sessions.",
  signinHelp: "Sign in with your organization account.",
  nameHelp: "The name other people in your organization will see.",
};
const ru: Record<keyof typeof en, string> = {
  collapse: "Свернуть меню",
  expand: "Развернуть меню",
  openMenu: "Открыть меню",
  closeMenu: "Закрыть меню",
  workspace: "Рабочее пространство",
  settings: "Настройки",
  accountHint: "Профиль, способы входа и активные сессии.",
  adminHint: "Пользователи, права доступа и настройки организации.",
  providersHint:
    "Подключите сервисы моделей и выберите модели, доступные в чатах.",
  projectsHint: "Объединяйте связанные беседы, инструкции и файлы.",
  providerType: "Тип провайдера",
  providerKey: "API-ключ",
  keyNew:
    "Введите ключ из кабинета провайдера. Он хранится на сервере Runóza в зашифрованном виде.",
  keyKeep:
    "Оставьте пустым, чтобы сохранить текущий ключ. Введите новый только для замены.",
  keyLocal: "Необязательно, если ваш локальный сервер не требует авторизации.",
  keyChanged:
    "Адрес изменён. Введите ключ для нового сервера или явно выберите «Без авторизации». Старый ключ не будет отправлен на новый адрес.",
  noAuth: "Этот сервер работает без авторизации",
  endpointHelp:
    "Адрес сервера, включая /v1. Запросы отправляет сервер Runóza, а не браузер. Для сервиса на хосте Docker используйте host.docker.internal.",
  modelsHelp:
    "По одному ID модели на строку. Только эти модели появятся в чате. ID можно получить из сохранённого подключения или ввести вручную.",
  modelsInvalid: "Не более 100 моделей, до 200 символов в каждом ID.",
  nameRequired: "Введите название.",
  keyRequired: "Введите API-ключ.",
  valueTooLong: "Слишком длинное значение.",
  urlInvalid:
    "Введите HTTP(S)-адрес без логина, пароля, параметров и фрагмента.",
  openrouterUrl: "Для OpenRouter используйте https://openrouter.ai/api/v1.",
  saveProvider: "Сохранить провайдера",
  providerSaved: "Провайдер сохранён.",
  savedTest: "Проверить сохранённое подключение",
  saveBeforeTest: "Сначала сохраните изменения, затем проверьте подключение.",
  noProviders: "Провайдеров пока нет",
  noProvidersHint:
    "Добавьте OpenRouter или подключите свой OpenAI-совместимый сервис.",
  selectProvider: "Выберите провайдера, чтобы изменить подключение.",
  optional: "Необязательно",
  instructionsHelp:
    "Общий промпт проекта. Передаётся при каждом новом ответе модели и действует во всех беседах проекта. Опишите роль, язык, стиль ответа или правила, которым должна следовать модель. Поле можно оставить пустым.",
  instructionsExample:
    "Например: Ты помогаешь нашей службе поддержки. Отвечай на русском, кратко и по делу. Если данных недостаточно, уточни их, а не придумывай.",
  instructionsShort:
    "Применяются к каждому новому ответу модели в этом проекте.",
  projectFiles: "Файлы проекта",
  personalFiles: "Личные файлы",
  projectFilesHint:
    "Общая библиотека для участников проекта. Загрузка сама по себе не отправляет файлы модели. В чате проекта откройте «Вложения» и выберите файлы для конкретного сообщения.",
  personalFilesHint:
    "Эти файлы доступны только вам. Выбирайте их во «Вложениях», когда хотите добавить к сообщению в личном чате.",
  filePrivacy:
    "Когда вы прикрепляете файл и отправляете сообщение, поддерживаемый текст передаётся выбранному провайдеру модели. Файлы не индексируются автоматически и не добавляются во все беседы.",
  formats:
    "Модель может читать текст и исходный код. PDF, изображения и другие форматы пока доступны только для скачивания.",
  uploadShort: "Перетащите файлы сюда или выберите на устройстве.",
  fileLimits: "Размер и поддерживаемые форматы",
  fileCancelled: "Загрузка отменена. Можно загрузить файл заново.",
  uploadFile: "Загружается",
  loading: "Загрузка…",
  settingsTab: "Инструкции",
  filesTab: "Файлы",
  membersTab: "Участники",
  membersHelp:
    "Добавьте существующего пользователя вашей организации по email. Редактор может менять инструкции, файлы и беседы. Читатель — только просматривать и скачивать.",
  noMembers: "В проект пока не приглашены участники.",
  memberMissing: "В организации не найден активный пользователь с таким email.",
  emailInvalid: "Введите корректный email.",
  saved: "Изменения сохранены.",
  createProjectHelp:
    "Дайте проекту название. Инструкции необязательны — их можно добавить позже.",
  danger: "Удалить проект",
  dangerHelp:
    "Проект, его беседы и файлы будут удалены для всех участников. Отменить это действие нельзя.",
  cancel: "Отмена",
  discard: "Не сохранять",
  unsaved: "Не сохранять изменения?",
  unsavedHint: "Внесённые изменения ещё не сохранены.",
  edit: "Редактировать",
  projectScope: "Пространство беседы",
  projectScopeHelp:
    "Выберите проект до начала беседы: здесь будут доступны его инструкции и общие файлы. Пространство существующей беседы изменить нельзя.",
  personalChat: "Личная беседа",
  projectLocked: "Чтобы выбрать другой проект, начните новую беседу.",
  conversationActions: "Действия с беседой",
  exportHelp:
    "Экспортирует доступные беседы и метаданные. Содержимое файлов скачивается отдельно.",
  oidcHelp:
    "Подключите OpenID Connect, чтобы пользователи могли входить через учётную запись организации.",
  issuerHelp:
    "Адрес издателя (issuer) из настроек провайдера идентификации, а не страница входа. Runóza получает по нему конфигурацию SSO.",
  clientIdHelp:
    "Идентификатор приложения, зарегистрированного у провайдера идентификации.",
  clientSecretHelp:
    "Оставьте пустым, чтобы сохранить прежний секрет. Для нового публичного клиента секрет может не требоваться.",
  flagsHelp: "Управляет доступностью функций в организации.",
  notAvailable: "Пока недоступно",
  choose: "Выбрать",
  fileActions: "Действия с файлом",
  membersCount: "Участники",
  refresh: "Обновить",
  projectSaved: "Проект сохранён.",
  createChat: "Открыть чат проекта",
  invalid: "Проверьте выделенные поля.",
  passwordHelp: "От 12 до 128 символов. Смена пароля завершит активные сессии.",
  signinHelp: "Войдите с учётной записью вашей организации.",
  nameHelp: "Это имя увидят другие пользователи вашей организации.",
};
export const uxLocales = { en, ru };
export const uxText = (locale: "en" | "ru") => (key: keyof typeof en) =>
  uxLocales[locale][key];
