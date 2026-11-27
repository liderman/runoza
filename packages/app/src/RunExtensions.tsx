import { Flex, Text } from "@gravity-ui/uikit";
import type { ChatRun } from "@runoza/contracts";

/** Read only the saved run, never today's catalog or bindings. */
export function RunExtensions({
  run,
  locale,
}: {
  run: ChatRun;
  locale: "en" | "ru";
}) {
  const ru = locale === "ru";
  const skills =
    run.extensions?.skills ??
    run.skill_versions?.map((s) => ({ ...s, preloaded: true })) ??
    [];
  const mcp =
    run.extensions?.mcp ??
    run.mcp_connections?.map((id) => ({
      id,
      name: id,
      preloadedToolCount: 0,
    })) ??
    [];
  if (!skills.length && !mcp.length) return null;
  return (
    <Flex direction="column" gap="spacing-2">
      <Text variant="subheader-1">
        {ru ? "Расширения на старте запуска" : "Extensions at run start"}
      </Text>
      <Text variant="caption-2" color="secondary">
        {ru
          ? "Сохранённый набор доступных расширений. Фактические вызовы показаны в действиях; текущие разрешения проверяются при выполнении."
          : "Saved set of available extensions. Actual calls appear in actions; current permissions are checked at execution."}
      </Text>
      {skills.map((skill) => (
        <Text key={skill.id}>
          {skill.name} · v{skill.version} ·{" "}
          {skill.preloaded
            ? ru
              ? "Инструкции загружены заранее"
              : "Instructions preloaded"
            : ru
              ? "По запросу"
              : "On demand"}
        </Text>
      ))}
      {mcp.map((connection) => (
        <Text key={connection.id}>
          MCP · {connection.name} ·{" "}
          {run.extensions
            ? connection.preloadedToolCount
              ? `${ru ? "Схем загружено заранее" : "Preloaded schemas"}: ${connection.preloadedToolCount}`
              : ru
                ? "Схемы по запросу"
                : "Schemas on demand"
            : ru
              ? "Старый запуск: сохранён только ID"
              : "Legacy run: only ID recorded"}
        </Text>
      ))}
    </Flex>
  );
}
