import { ExtensionDetails } from "./ExtensionDetails.tsx";
import { ExtensionImport } from "./ExtensionImport.tsx";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Flex,
  Label,
  Switch,
  Select,
  Tab,
  TabList,
  TabProvider,
  Text,
  TextInput,
} from "@gravity-ui/uikit";
import type { ProjectView } from "@runoza/contracts";
import type { IdentityClient } from "@runoza/api-client";
import type { ExtensionEntry } from "./SkillCommands.tsx";
export function ExtensionsCatalog({
  api,
  locale,
  admin = false,
  projects = [],
}: {
  api: IdentityClient;
  locale: "ru" | "en";
  admin?: boolean;
  projects?: ProjectView[];
}) {
  const ru = locale === "ru",
    s = (a: string, b: string) => (ru ? a : b);
  const [tab, setTab] = useState("catalog"),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  const [scope, setScope] = useState("user"),
    [project, setProject] = useState("");
  const projectView = projects.find((p) => p.id === project);
  const canEdit =
    scope === "project"
      ? Boolean(projectView && projectView.role !== "viewer")
      : scope !== "organization" || admin;
  const client = useQueryClient();
  const catalog = useQuery({
    queryKey: ["extensions", "catalog", null, project],
    queryFn: ({ signal }) =>
      api.request<{ extensions: ExtensionEntry[] }>(
        "/extensions/catalog" + (project ? "?projectId=" + project : ""),
        "GET",
        undefined,
        { signal },
      ),
    refetchOnWindowFocus: true,
  });
  async function update(
    item: ExtensionEntry,
    enabled: boolean,
    pinned = item.pinned,
  ) {
    setBusy(item.id);
    setError("");
    try {
      await api.request("/extensions/bindings", "PUT", {
        kind: item.kind,
        resourceId: item.id,
        scope,
        ...(scope === "project"
          ? { scopeId: project }
          : scope === "user" && project
            ? { contextProjectId: project }
            : {}),
        enabled,
        pinned,
        ...(pinned && item.kind === "skill"
          ? { versionId: item.versionId }
          : {}),
      });
      await client.invalidateQueries({ queryKey: ["extensions"] });
    } catch {
      setError(
        s(
          "Не удалось сохранить настройку расширения.",
          "Could not save extension settings.",
        ),
      );
    } finally {
      setBusy(null);
    }
  }
  const items = (catalog.data?.extensions ?? []).filter(
    (x) =>
      (tab !== "installed" || x.enabled) &&
      (x.name + " " + x.description)
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  return (
    <Flex direction="column" gap="spacing-4">
      <TabProvider value={tab} onUpdate={setTab}>
        <TabList>
          <Tab value="catalog">{s("Каталог", "Catalog")}</Tab>
          <Tab value="installed">{s("Включено", "Enabled")}</Tab>
          <Tab value="sources">{s("Локальные источники", "Local sources")}</Tab>
        </TabList>
      </TabProvider>
      {error && (
        <Alert theme="danger" message={error} onClose={() => setError("")} />
      )}
      {tab === "sources" ? (
        <>
          <ExtensionImport api={api} locale={locale} local />
          <Card view="outlined" padding="spacing-4">
            <Flex direction="column" gap="spacing-3">
              <Text variant="subheader-2">SKILL.md</Text>
              <Text>
                {s(
                  "Установите пакет через локальный CLI. Вход и импорт используют ваш сервер и обычные права доступа; файлы не исполняются при чтении.",
                  "Install a package using the local CLI. Sign-in and import use your server and normal access controls; reading files never executes them.",
                )}
              </Text>
              <pre className="skill-preview">
                npm run runoza -- auth login --server{" "}
                {new URL(api.url("/status")).origin}
                {"\n"}npm run runoza -- skill add ./my-skill --scope user
              </pre>
              <Text color="secondary">
                {s(
                  "Личный каталог: <configDir>/skills. Проектный: .agents/skills. Сторонние каталоги подключаются явно.",
                  "User directory: <configDir>/skills. Project directory: .agents/skills. Third-party directories require explicit import.",
                )}
              </Text>
            </Flex>
          </Card>
        </>
      ) : (
        <>
          <ExtensionImport api={api} locale={locale} />
          <Flex gap="spacing-3" wrap="wrap" alignItems="center">
            <Select
              aria-label={s("Проект каталога", "Catalog project")}
              value={[project]}
              onUpdate={(values) => {
                setProject(values[0] ?? "");
                setScope("user");
              }}
              options={[
                { value: "", content: s("Без проекта", "No project") },
                ...projects.map((p) => ({ value: p.id, content: p.name })),
              ]}
            />
            <Select
              aria-label={s("Область настройки", "Settings scope")}
              value={[scope]}
              onUpdate={(values) => setScope(values[0] ?? "user")}
              options={[
                { value: "user", content: s("Для меня", "For me") },
                ...(project
                  ? [
                      {
                        value: "project",
                        content: s("Для проекта", "For the project"),
                        disabled: projectView?.role === "viewer",
                      },
                    ]
                  : []),
                ...(admin
                  ? [
                      {
                        value: "organization",
                        content: s("Для организации", "For the organization"),
                      },
                    ]
                  : []),
              ]}
            />
          </Flex>
          <Text variant="caption-2" color="secondary">
            {s(
              "Показана итоговая доступность для вас. Личные настройки имеют приоритет над проектными; запрет организации обойти нельзя.",
              "Showing your effective availability. Personal preferences override project preferences; organization restrictions always apply.",
            )}
          </Text>
          <TextInput
            value={query}
            onUpdate={setQuery}
            hasClear
            placeholder={s(
              "Поиск скиллов и инструментов…",
              "Search skills and tools…",
            )}
            controlProps={{
              "aria-label": s("Поиск каталога", "Search catalog"),
            }}
          />
          {catalog.isPending ? (
            <Text>{s("Загрузка…", "Loading…")}</Text>
          ) : catalog.isError ? (
            <Alert
              theme="danger"
              message={s("Каталог недоступен.", "Catalog unavailable.")}
              actions={
                <Button onClick={() => void catalog.refetch()}>
                  {s("Повторить", "Retry")}
                </Button>
              }
            />
          ) : !items.length ? (
            <Text color="secondary">
              {s(
                "Здесь пока нет расширений. Создайте скилл или подключите MCP.",
                "No extensions here yet. Create a skill or connect MCP.",
              )}
            </Text>
          ) : (
            items.map((x) => (
              <Card key={x.kind + x.id} view="outlined" padding="spacing-4">
                <Flex direction="column" gap="spacing-3">
                  <Flex
                    justifyContent="space-between"
                    gap="spacing-3"
                    alignItems="center"
                  >
                    <Flex gap="spacing-2" alignItems="center" wrap="wrap">
                      <Text variant="subheader-2">{x.name}</Text>
                      <Label size="s">
                        {x.kind === "skill"
                          ? "Skill · v" + x.version
                          : "MCP · " + x.transport}
                      </Label>
                      <Label size="s" theme="unknown">
                        {x.source === "personal"
                          ? s("Личное", "Personal")
                          : x.source === "project"
                            ? s("Проект", "Project")
                            : s("Организация", "Organization")}
                      </Label>
                    </Flex>
                    <Switch
                      checked={x.enabled}
                      disabled={
                        !canEdit ||
                        (scope === "organization" &&
                          x.source !== "organization") ||
                        (scope === "project" && x.source === "personal") ||
                        (!x.available && !x.enabled) ||
                        busy === x.id
                      }
                      onUpdate={(value) => void update(x, value)}
                      aria-label={s("Включить ", "Enable ") + x.name}
                    />
                  </Flex>
                  {x.description && (
                    <Text color="secondary">{x.description}</Text>
                  )}
                  <ExtensionDetails item={x} locale={locale} />
                  {x.enabled && x.available && (
                    <Flex gap="spacing-3" alignItems="center">
                      <Button
                        view={x.pinned ? "outlined" : "flat"}
                        size="s"
                        loading={busy === x.id}
                        disabled={
                          !canEdit ||
                          (scope === "organization" &&
                            x.source !== "organization") ||
                          (scope === "project" && x.source === "personal") ||
                          x.manifest?.manualOnly === true ||
                          (x.kind === "mcp" && !x.cachedToolCount)
                        }
                        onClick={() => void update(x, true, !x.pinned)}
                      >
                        {x.pinned
                          ? s("Открепить", "Unpin")
                          : s("Закрепить", "Pin")}
                      </Button>
                      <Text variant="caption-2" color="secondary">
                        {x.manifest?.manualOnly
                          ? s(
                              "Только ручной вызов через /",
                              "Manual invocation with / only",
                            )
                          : x.kind === "mcp"
                            ? x.pinned
                              ? s(
                                  "Схемы загружаются заранее",
                                  "Schemas are preloaded",
                                )
                              : s(
                                  "Схемы доступны по запросу",
                                  "Schemas are available on demand",
                                )
                            : x.pinned
                              ? s(
                                  "Инструкции загружаются заранее",
                                  "Instructions are preloaded",
                                )
                              : s(
                                  "Доступен через / и поиск агента",
                                  "Available through / and agent discovery",
                                )}
                      </Text>
                    </Flex>
                  )}
                  {x.kind === "mcp" && (
                    <Flex gap="spacing-2" alignItems="center" wrap="wrap">
                      <Text variant="caption-2" color="secondary">
                        {x.allowedToolCount ?? 0} {s("разрешено", "allowed")} ·{" "}
                        {x.cachedToolCount ?? 0}{" "}
                        {s("схем в вашем кеше", "schemas in your cache")}
                      </Text>
                      {x.transport === "http" && (
                        <Button
                          size="s"
                          view="flat"
                          loading={busy === x.id}
                          onClick={() => {
                            setBusy(x.id);
                            setError("");
                            void api
                              .request("/mcp/" + x.id + "/discover", "POST")
                              .then(() =>
                                client.invalidateQueries({
                                  queryKey: ["extensions"],
                                }),
                              )
                              .catch(() =>
                                setError(
                                  s(
                                    "Не удалось получить инструменты. Проверьте подключение и личную авторизацию.",
                                    "Could not load tools. Check the connection and your credentials.",
                                  ),
                                ),
                              )
                              .finally(() => setBusy(null));
                          }}
                        >
                          {s("Обновить инструменты", "Refresh tools")}
                        </Button>
                      )}
                    </Flex>
                  )}
                  {x.kind === "skill" && x.instructionChars != null && (
                    <Text variant="caption-2" color="secondary">
                      ≈{" "}
                      {Math.ceil(x.instructionChars / 4).toLocaleString(locale)}{" "}
                      {s("токенов инструкций", "instruction tokens")}
                      {typeof x.manifest?.license === "string"
                        ? " · " + x.manifest.license
                        : ""}
                    </Text>
                  )}
                  {Boolean(x.manifest?.unsupported?.length) && (
                    <Text variant="caption-2" color="secondary">
                      {s("Поля без выполнения: ", "Non-executable fields: ") +
                        x.manifest!.unsupported!.join(", ")}
                    </Text>
                  )}
                </Flex>
              </Card>
            ))
          )}
        </>
      )}
    </Flex>
  );
}
