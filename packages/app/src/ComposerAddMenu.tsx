import { Paperclip, PlugConnection, Plus, Sparkles } from "@gravity-ui/icons";
import { Button, Icon, Menu } from "@gravity-ui/uikit";

export type ComposerAddition = "attachments" | "skill" | "mcp";

export function ComposerAddMenu({
  locale,
  disabled,
  attachmentCount,
  onChoose,
  onSearchProject,
}: {
  locale: "en" | "ru";
  disabled: boolean;
  attachmentCount: number;
  onSearchProject?: () => void;
  onChoose: (item: ComposerAddition) => void;
}) {
  const ru = locale === "ru";
  const label = ru ? "Добавить к сообщению" : "Add to message";
  const attachments =
    (ru ? "Вложения" : "Attachments") +
    (attachmentCount ? ` (${attachmentCount})` : "");
  return (
    <Menu
      aria-label={label}
      disabled={disabled}
      placement="top-start"
      trigger={
        <Button
          view="flat"
          disabled={disabled}
          title={label}
          aria-label={attachmentCount ? `${label} · ${attachments}` : label}
        >
          <Icon data={Plus} />
          {attachmentCount || null}
        </Button>
      }
    >
      <Menu.Item
        icon={<Icon data={Paperclip} />}
        onClick={() => onChoose("attachments")}
      >
        {attachments}
      </Menu.Item>
      {onSearchProject && (
        <Menu.Item onClick={onSearchProject}>
          {ru ? "Поиск по файлам проекта" : "Search project files"}
        </Menu.Item>
      )}
      <Menu.Item
        icon={<Icon data={Sparkles} />}
        onClick={() => onChoose("skill")}
      >
        {ru ? "Навыки" : "Skills"}
      </Menu.Item>
      <Menu.Item
        icon={<Icon data={PlugConnection} />}
        onClick={() => onChoose("mcp")}
      >
        {ru ? "Подключения MCP" : "MCP connections"}
      </Menu.Item>
    </Menu>
  );
}
