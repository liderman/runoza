import { Flex, Label, Text } from "@gravity-ui/uikit";
import type { ExtensionEntry } from "./SkillCommands.tsx";

export function extensionExample(item: ExtensionEntry, locale: "en" | "ru") {
  return item.kind === "skill"
    ? locale === "ru"
      ? `Примени навык «${item.name}» к моей задаче: опиши подход и необходимые проверки.`
      : `Apply the “${item.name}” skill to my task: explain the approach and the checks needed.`
    : locale === "ru"
      ? `Найди через «${item.name}» информацию по моей задаче и укажи источники.`
      : `Find information for my task through “${item.name}” and cite the sources.`;
}
export function extensionUnavailable(
  item: ExtensionEntry,
  workspace?: boolean,
) {
  return (
    !item.enabled ||
    !item.available ||
    (workspace === false && item.transport === "stdio")
  );
}
export function extensionReason(
  item: ExtensionEntry,
  locale: "en" | "ru",
  workspace?: boolean,
) {
  const ru = locale === "ru";
  switch (item.reason) {
    case "disabled_by_administrator":
      return ru ? "Запрещено администратором" : "Disabled by administrator";
    case "device_workspace_required":
      return ru
        ? "Нужна рабочая область на подключённом устройстве"
        : "Workspace on the connected device required";
    case "device_offline":
      return ru ? "Устройство отключено" : "Device offline";
    case "version_unavailable":
      return ru ? "Версия навыка недоступна" : "Skill version unavailable";
  }
  if (!item.enabled) return ru ? "Не включено" : "Not enabled";
  if (!item.available)
    return ru ? "Недоступно в этом контексте" : "Unavailable in this context";
  if (workspace === false && item.transport === "stdio")
    return ru ? "Нужна рабочая область" : "Workspace required";
  return null;
}
/** Availability is distinct from authentication and permission to execute tools. */
export function ExtensionDetails({
  item,
  locale,
  workspace,
}: {
  item: ExtensionEntry;
  locale: "en" | "ru";
  workspace?: boolean;
}) {
  const ru = locale === "ru",
    unavailable = extensionUnavailable(item, workspace);
  return (
    <Flex direction="column" gap="spacing-2">
      <Flex gap="spacing-2" wrap="wrap">
        <Label size="s">
          {item.kind === "skill"
            ? ru
              ? "Установлено"
              : "Installed"
            : ru
              ? "Подключение настроено"
              : "Connection configured"}
        </Label>
        <Label size="s" theme={item.enabled ? "success" : "unknown"}>
          {item.enabled
            ? ru
              ? "Включено"
              : "Enabled"
            : ru
              ? "Выключено"
              : "Disabled"}
        </Label>
        <Label size="s" theme={unavailable ? "unknown" : "info"}>
          {unavailable
            ? ru
              ? "Недоступно"
              : "Unavailable"
            : ru
              ? "Доступно в этом контексте"
              : "Available in this context"}
        </Label>
      </Flex>
      {extensionReason(item, locale, workspace) && (
        <Text variant="caption-2" color="secondary">
          {extensionReason(item, locale, workspace)}
        </Text>
      )}
      {item.kind === "mcp" && (
        <Text variant="caption-2" color="secondary">
          {ru
            ? "Авторизация проверяется при подключении. Выполнение инструментов подчиняется текущим разрешениям."
            : "Authorization is checked when connecting. Tool execution follows current permissions."}
        </Text>
      )}
      <Text variant="caption-2" color="secondary">
        {ru
          ? "Пример — уточните задачу перед отправкой:"
          : "Example — specify your task before sending:"}
      </Text>
      <Text>{extensionExample(item, locale)}</Text>
    </Flex>
  );
}
