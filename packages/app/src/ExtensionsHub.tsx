import { useQueryClient } from "@tanstack/react-query";
import { skillDiff } from "./skill-diff.ts";
import { ExtensionsCatalog } from "./ExtensionsCatalog.tsx";
import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Dialog,
  Flex,
  Label,
  Select,
  Tab,
  TabList,
  TabProvider,
  Text,
  TextArea,
  TextInput,
} from "@gravity-ui/uikit";
import { Field, FieldLabel } from "@runoza/ui";
import type { IdentityClient } from "@runoza/api-client";
import type { ProjectView } from "@runoza/contracts";
import { useDirtyGuard, useNavigationGuard } from "./NavigationGuard.tsx";
export type HubSkill = {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  visibility: string;
  project_id: string | null;
  versions: { id: string; version: number; content?: string }[];
};
export type HubMcp = {
  owner_id?: string;
  visibility?: string;
  id: string;
  name: string;
  transport: "http" | "stdio";
  endpoint: string;
  command: string[];
  allowed_tools: string[];
  enabled: boolean;
  hasSecret: boolean;
  hasOAuth?: boolean;
  project_id?: string | null;
};
const blankSkill = {
  id: "",
  name: "",
  description: "",
  visibility: "personal",
  projectId: "",
  content: "",
};
const blankMcp = {
  id: "",
  name: "",
  transport: "http" as "http" | "stdio",
  endpoint: "",
  command: "",
  tools: "",
  enabled: true,
  visibility: "personal",
  projectId: "",
};
export function ExtensionsHub({
  api,
  locale,
  userId,
  admin,
  publisher = admin,
}: {
  api: IdentityClient;
  locale: "ru" | "en";
  userId: string;
  admin: boolean;
  publisher?: boolean;
}) {
  const cache = useQueryClient();
  const ru = locale === "ru",
    s = (ruText: string, en: string) => (ru ? ruText : en),
    guard = useNavigationGuard();
  const [tab, setTab] = useState("catalog"),
    [query, setQuery] = useState(""),
    [skills, setSkills] = useState<HubSkill[]>([]),
    [connections, setConnections] = useState<HubMcp[]>([]),
    [projects, setProjects] = useState<ProjectView[]>([]),
    [skill, setSkill] = useState<typeof blankSkill | null>(null),
    [mcp, setMcp] = useState<typeof blankMcp | null>(null),
    [credential, setCredential] = useState<HubMcp | null>(null),
    [token, setToken] = useState(""),
    [baseline, setBaseline] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [view, setView] = useState<HubSkill | null>(null),
    [version, setVersion] = useState(""),
    [discovered, setDiscovered] = useState<string[]>([]),
    [versionContent, setVersionContent] = useState<string | null>(null),
    [versionManifest, setVersionManifest] = useState<Record<string, unknown>>(
      {},
    ),
    [oauthUrl, setOauthUrl] = useState<string | null>(null),
    [compare, setCompare] = useState(false),
    [previousContent, setPreviousContent] = useState<string | null>(null);
  useEffect(() => {
    if (!view || !version) return;
    const controller = new AbortController();
    setVersionContent(null);
    setVersionManifest({});
    setPreviousContent(null);
    const currentVersion =
      view.versions.find((v) => v.id === version)?.version ?? 0;
    const previous = view.versions
      .filter((v) => v.version < currentVersion)
      .sort((a, b) => b.version - a.version)[0];
    void Promise.all([
      api.request<{ content: string; manifest: Record<string, unknown> }>(
        "/skills/versions/" + version,
        "GET",
        undefined,
        { signal: controller.signal },
      ),
      compare && previous
        ? api.request<{ content: string }>(
            "/skills/versions/" + previous.id,
            "GET",
            undefined,
            { signal: controller.signal },
          )
        : Promise.resolve(null),
    ])
      .then(([value, old]) => {
        if (!controller.signal.aborted) {
          setVersionContent(value.content);
          setVersionManifest(value.manifest ?? {});
          setPreviousContent(old?.content ?? null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            s("Не удалось загрузить версию.", "Could not load version."),
          );
      });
    return () => controller.abort();
  }, [view?.id, version, compare]);

  const draft = skill ?? mcp;
  useDirtyGuard(
    Boolean((draft && JSON.stringify(draft) !== baseline) || token),
    () => {
      setSkill(null);
      setMcp(null);
      setToken("");
      setCredential(null);
    },
  );
  const close = () =>
    guard.navigate(() => {
      setSkill(null);
      setMcp(null);
      setCredential(null);
      setToken("");
      setError("");
    });
  async function load() {
    const [a, b, c] = await Promise.all([
      api.request<{ skills: HubSkill[] }>("/skills"),
      api.request<{ connections: HubMcp[] }>("/mcp"),
      api.request<{ projects: ProjectView[] }>("/projects"),
    ]);
    setSkills(a.skills);
    setConnections(b.connections);
    setProjects(c.projects);
  }
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      await cache.invalidateQueries({ queryKey: ["extensions"] });
    } catch {
      setError(
        s(
          "Не удалось выполнить действие. Проверьте поля, права и доступность подключения.",
          "Could not complete the action. Check the fields, permissions and connection.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void act(load);
  }, []);
  function editSkill(d: typeof blankSkill) {
    setBaseline(JSON.stringify(d));
    setSkill(d);
    setError("");
  }
  function editMcp(d: typeof blankMcp) {
    setBaseline(JSON.stringify(d));
    setMcp(d);
    setError("");
  }
  const err = error ? (
    <Alert theme="danger" message={error} onClose={() => setError("")} />
  ) : null;
  return (
    <Flex direction="column" gap="spacing-5">
      <Flex
        justifyContent="space-between"
        alignItems="center"
        wrap="wrap"
        gap="spacing-3"
      >
        <Flex direction="column" gap="spacing-2">
          <Text as="h1" variant="header-2">
            {s("Расширения", "Extensions")}
          </Text>
          <Text color="secondary">
            {s(
              "Общие инструкции и инструменты для ваших бесед.",
              "Shared instructions and tools for your conversations.",
            )}
          </Text>
        </Flex>
        <Button
          view="action"
          disabled={busy}
          onClick={() =>
            tab !== "mcp"
              ? editSkill({ ...blankSkill })
              : editMcp({ ...blankMcp })
          }
        >
          {tab !== "mcp"
            ? s("Создать скилл", "Create skill")
            : s("Добавить MCP", "Add MCP")}
        </Button>
      </Flex>
      <TabProvider value={tab} onUpdate={setTab}>
        <TabList>
          <Tab value="catalog">{s("Обзор", "Overview")}</Tab>
          <Tab value="skills">{s("Скиллы", "Skills")}</Tab>
          <Tab value="mcp">MCP</Tab>
        </TabList>
      </TabProvider>
      {!skill && !mcp && !credential && err}
      {tab !== "catalog" && (
        <TextInput
          value={query}
          onUpdate={setQuery}
          hasClear
          placeholder={s("Поиск расширений…", "Search extensions…")}
          controlProps={{
            "aria-label": s("Поиск расширений", "Search extensions"),
          }}
        />
      )}
      {tab === "catalog" ? (
        <ExtensionsCatalog
          api={api}
          locale={locale}
          admin={admin}
          projects={projects}
        />
      ) : tab === "skills" ? (
        <Flex direction="column" gap="spacing-3">
          {!skills.length && (
            <Text color="secondary">
              {s(
                "Создайте первый скилл: инструкции, которые можно повторно использовать и опубликовать для коллег.",
                "Create your first skill: reusable instructions you can share with colleagues.",
              )}
            </Text>
          )}
          {skills
            .filter((x) =>
              (x.name + " " + x.description)
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((x) => (
              <Card key={x.id} view="outlined" type="container">
                <Box padding="spacing-4">
                  <Flex
                    justifyContent="space-between"
                    gap="spacing-4"
                    alignItems="center"
                    wrap="wrap"
                  >
                    <Flex direction="column" gap="spacing-2" minWidth="0">
                      <Flex gap="spacing-2" alignItems="center" wrap="wrap">
                        <Text variant="subheader-2">{x.name}</Text>
                        <Label size="s">v{x.versions[0]?.version}</Label>
                        <Label size="s" theme="unknown">
                          {x.visibility === "personal"
                            ? s("Личный", "Personal")
                            : x.visibility === "project"
                              ? s("Проект", "Project")
                              : s("Организация", "Organization")}
                        </Label>
                      </Flex>
                      <Text color="secondary">{x.description}</Text>
                    </Flex>
                    <Flex gap="spacing-2">
                      <Button
                        onClick={() => {
                          setView(x);
                          setVersion(x.versions[0]?.id ?? "");
                        }}
                      >
                        {s("Версии", "Versions")}
                      </Button>
                      {x.owner_id === userId && (
                        <Button
                          onClick={() =>
                            void act(async () => {
                              const latest = x.versions[0]?.id;
                              const body = latest
                                ? await api.request<{ content: string }>(
                                    "/skills/versions/" + latest,
                                  )
                                : { content: "" };
                              editSkill({
                                ...blankSkill,
                                id: x.id,
                                name: x.name,
                                content: body.content,
                              });
                            })
                          }
                        >
                          {s("Новая версия", "New version")}
                        </Button>
                      )}
                    </Flex>
                  </Flex>
                </Box>
              </Card>
            ))}
        </Flex>
      ) : (
        <Flex direction="column" gap="spacing-3">
          <Text color="secondary">
            {s(
              "Администратор настраивает подключения и разрешённые инструменты. Ключ доступа — личный для каждого пользователя. Каждый вызов требует подтверждения в беседе.",
              "Administrators configure connections and allowed tools. Credentials belong to each user. Every call requires approval in the conversation.",
            )}
          </Text>
          {!connections.length && (
            <Text>{s("Подключений пока нет.", "No connections yet.")}</Text>
          )}
          {connections
            .filter((x) => x.name.toLowerCase().includes(query.toLowerCase()))
            .map((x) => (
              <Card key={x.id} type="container" view="outlined">
                <Box padding="spacing-4">
                  <Flex
                    gap="spacing-4"
                    justifyContent="space-between"
                    alignItems="center"
                    wrap="wrap"
                  >
                    <Flex direction="column" gap="spacing-2" minWidth="0">
                      <Flex alignItems="center" gap="spacing-2">
                        <Text variant="subheader-2">{x.name}</Text>
                        <Label
                          size="s"
                          theme={x.enabled ? "success" : "unknown"}
                        >
                          {x.enabled
                            ? s("Включено", "Enabled")
                            : s("Отключено", "Disabled")}
                        </Label>
                        <Label size="s">
                          {x.transport === "http" ? "HTTP" : "stdio"}
                        </Label>
                      </Flex>
                      <Text color="secondary">
                        {x.allowed_tools.length}{" "}
                        {s("разрешённых инструментов", "allowed tools")}
                      </Text>
                    </Flex>
                    <Flex gap="spacing-2" wrap="wrap">
                      {x.transport === "http" && (
                        <>
                          <Button
                            onClick={() =>
                              void act(async () => {
                                const result = await api.request<{
                                  url?: string;
                                  connected?: boolean;
                                }>("/mcp/" + x.id + "/oauth/start", "POST");
                                if (result.url) setOauthUrl(result.url);
                              })
                            }
                          >
                            {x.hasOAuth
                              ? s("Подключить OAuth заново", "Reconnect OAuth")
                              : s("Подключить OAuth", "Connect OAuth")}
                          </Button>
                          {x.hasOAuth && (
                            <Button
                              onClick={() =>
                                void act(async () => {
                                  await api.request(
                                    "/mcp/" + x.id + "/oauth",
                                    "DELETE",
                                  );
                                })
                              }
                            >
                              {s("Отключить OAuth", "Disconnect OAuth")}
                            </Button>
                          )}
                        </>
                      )}
                      {x.transport === "http" && (
                        <Button
                          onClick={() => {
                            setCredential(x);
                            setToken("");
                            setError("");
                          }}
                        >
                          {x.hasSecret
                            ? s("Изменить мой ключ", "Change my key")
                            : s("Мой ключ", "My key")}
                        </Button>
                      )}
                      {(publisher ||
                        (x.owner_id === userId &&
                          x.visibility !== "organization")) && (
                        <Button
                          onClick={() =>
                            editMcp({
                              id: x.id,
                              visibility: x.visibility ?? "organization",
                              projectId: x.project_id ?? "",
                              name: x.name,
                              transport: x.transport,
                              endpoint: x.endpoint,
                              command: x.command.join("\n"),
                              tools: x.allowed_tools.join("\n"),
                              enabled: x.enabled,
                            })
                          }
                        >
                          {s("Настроить", "Configure")}
                        </Button>
                      )}
                    </Flex>
                  </Flex>
                </Box>
              </Card>
            ))}
        </Flex>
      )}
      <Dialog
        open={Boolean(oauthUrl)}
        onOpenChange={(open) => {
          if (!open) setOauthUrl(null);
        }}
        maxWidth="m"
        fullWidth
      >
        <Dialog.Header caption={s("Авторизация MCP", "MCP authorization")} />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-3">
            <Text>
              {s(
                "Продолжите авторизацию на сайте провайдера. После завершения вернитесь в Runóza. Токены сохраняются отдельно для вашей учётной записи.",
                "Continue on the provider website, then return to Runóza. Tokens are stored separately for your account.",
              )}
            </Text>
            {oauthUrl && (
              <Button
                href={oauthUrl}
                target="_blank"
                rel="noopener noreferrer"
                view="action"
              >
                {s("Открыть авторизацию", "Open authorization")}
              </Button>
            )}
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Готово", "Done")}
          onClickButtonCancel={() => {
            setOauthUrl(null);
            void act(load);
          }}
        />
      </Dialog>
      <Dialog
        open={Boolean(skill)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        maxWidth="m"
        fullWidth
      >
        <Dialog.Header
          caption={
            skill?.id
              ? s("Новая версия скилла", "New skill version")
              : s("Создать скилл", "Create skill")
          }
        />
        <Dialog.Body>
          {skill && (
            <Flex direction="column" gap="spacing-4">
              {err}
              {!skill.id && (
                <>
                  <Field
                    label={s("Название", "Name")}
                    value={skill.name}
                    maxLength={100}
                    onChange={(name) => setSkill({ ...skill, name })}
                  />
                  <Field
                    label={s("Описание", "Description")}
                    required={false}
                    value={skill.description}
                    maxLength={500}
                    onChange={(description) =>
                      setSkill({ ...skill, description })
                    }
                  />
                  <FieldLabel label={s("Кому доступен", "Who can use it")} />
                  <Select
                    aria-label={s("Кому доступен", "Who can use it")}
                    value={[skill.visibility]}
                    onUpdate={(v) => setSkill({ ...skill, visibility: v[0]! })}
                    options={[
                      {
                        value: "personal",
                        content: s("Только мне", "Only me"),
                      },
                      {
                        value: "project",
                        content: s("Участникам проекта", "Project members"),
                      },
                      {
                        value: "organization",
                        content: s("Всей организации", "Organization"),
                      },
                    ]}
                  />
                  {skill.visibility === "project" && (
                    <Select
                      aria-label={s("Проект", "Project")}
                      placeholder={s("Выберите проект", "Select a project")}
                      value={skill.projectId ? [skill.projectId] : []}
                      onUpdate={(v) => setSkill({ ...skill, projectId: v[0]! })}
                      options={projects
                        .filter((p) => p.role !== "viewer")
                        .map((p) => ({ value: p.id, content: p.name }))}
                    />
                  )}
                </>
              )}
              <FieldLabel
                label={s("Инструкции", "Instructions")}
                help={s(
                  "Текст добавляется к инструкциям модели при выборе этой версии в чате. Скилл сам по себе не устанавливает и не запускает программы. Старые версии сохраняются.",
                  "This text is added to model instructions when the version is selected in chat. Skills do not install or run programs by themselves. Older versions are preserved.",
                )}
              />
              <TextArea
                minRows={10}
                maxRows={18}
                value={skill.content}
                onUpdate={(content) => setSkill({ ...skill, content })}
                controlProps={{
                  "aria-label": s("Инструкции", "Instructions"),
                  maxLength: 32000,
                }}
              />
            </Flex>
          )}
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Отмена", "Cancel")}
          textButtonApply={s("Опубликовать", "Publish")}
          onClickButtonCancel={close}
          loading={busy}
          propsButtonApply={{
            disabled:
              !skill?.name.trim() ||
              !skill.content.trim() ||
              (!skill.id && skill.visibility === "project" && !skill.projectId),
          }}
          onClickButtonApply={() =>
            void act(async () => {
              if (!skill) return;
              await api.request(
                skill.id ? "/skills/" + skill.id + "/versions" : "/skills",
                "POST",
                skill.id
                  ? { content: skill.content }
                  : {
                      name: skill.name,
                      description: skill.description,
                      visibility: skill.visibility,
                      ...(skill.visibility === "project"
                        ? { projectId: skill.projectId }
                        : {}),
                      content: skill.content,
                    },
              );
              setSkill(null);
            })
          }
        />
      </Dialog>
      <Dialog
        open={Boolean(view)}
        onOpenChange={(open) => {
          if (!open) setView(null);
        }}
        maxWidth="m"
        fullWidth
      >
        <Dialog.Header caption={view?.name} />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-4">
            {err}
            <Select
              aria-label={s("Версия скилла", "Skill version")}
              value={[version]}
              onUpdate={(v) => setVersion(v[0]!)}
              options={
                view?.versions.map((v) => ({
                  value: v.id,
                  content: "v" + v.version,
                })) ?? []
              }
            />
            <Checkbox checked={compare} onUpdate={setCompare}>
              {s(
                "Сравнить с предыдущей версией",
                "Compare with previous version",
              )}
            </Checkbox>
            <pre className="skill-preview">
              {compare && previousContent !== null && versionContent !== null
                ? skillDiff(previousContent, versionContent).map((line, i) => (
                    <Text
                      as="span"
                      key={i}
                      color={
                        line.kind === "added"
                          ? "positive"
                          : line.kind === "removed"
                            ? "danger"
                            : "primary"
                      }
                    >
                      {(line.kind === "added"
                        ? "+ "
                        : line.kind === "removed"
                          ? "− "
                          : "  ") +
                        line.text +
                        "\n"}
                    </Text>
                  ))
                : (versionContent ?? s("Загрузка…", "Loading…"))}
            </pre>
            <Button
              disabled={
                busy || !view || !version || versionManifest.manualOnly === true
              }
              onClick={() =>
                void act(async () => {
                  if (!view) return;
                  await api.request("/extensions/bindings", "PUT", {
                    kind: "skill",
                    resourceId: view.id,
                    scope: "user",
                    ...(view.project_id
                      ? { contextProjectId: view.project_id }
                      : {}),
                    enabled: true,
                    pinned: true,
                    versionId: version,
                  });
                  setView(null);
                })
              }
            >
              {s("Закрепить эту версию для меня", "Pin this version for me")}
            </Button>
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Закрыть", "Close")}
          onClickButtonCancel={() => setView(null)}
        />
      </Dialog>
      <Dialog
        open={Boolean(mcp)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        maxWidth="m"
        fullWidth
      >
        <Dialog.Header
          caption={
            mcp?.id
              ? s("Настройка MCP", "Configure MCP")
              : s("Добавить MCP", "Add MCP")
          }
        />
        <Dialog.Body>
          {mcp && (
            <Flex direction="column" gap="spacing-4">
              {err}
              {!mcp.id && (
                <>
                  <FieldLabel label={s("Кому доступно", "Who can use it")} />
                  <Select
                    aria-label={s("Область MCP", "MCP scope")}
                    value={[mcp.visibility]}
                    onUpdate={(v) =>
                      setMcp({
                        ...mcp,
                        visibility: v[0] ?? "personal",
                        projectId: "",
                      })
                    }
                    options={[
                      {
                        value: "personal",
                        content: s("Лично мне", "Personal"),
                      },
                      {
                        value: "project",
                        content: s("Участникам проекта", "Project members"),
                      },
                      ...(publisher
                        ? [
                            {
                              value: "organization",
                              content: s("Организации", "Organization"),
                            },
                          ]
                        : []),
                    ]}
                  />
                  {mcp.visibility === "project" && (
                    <Select
                      aria-label={s("Проект для MCP", "MCP project")}
                      value={mcp.projectId ? [mcp.projectId] : []}
                      onUpdate={(v) =>
                        setMcp({ ...mcp, projectId: v[0] ?? "" })
                      }
                      options={projects
                        .filter((p) => p.role !== "viewer")
                        .map((p) => ({ value: p.id, content: p.name }))}
                    />
                  )}
                </>
              )}

              <Field
                label={s("Название", "Name")}
                value={mcp.name}
                maxLength={100}
                onChange={(name) => setMcp({ ...mcp, name })}
              />
              <Select
                aria-label={s("Транспорт", "Transport")}
                value={[mcp.transport]}
                onUpdate={(v) =>
                  setMcp({
                    ...mcp,
                    transport: v[0] as "http" | "stdio",
                    endpoint: "",
                    command: "",
                  })
                }
                options={[
                  { value: "http", content: "Streamable HTTP" },
                  {
                    value: "stdio",
                    content: s(
                      "stdio · в рабочей области",
                      "stdio · in workspace",
                    ),
                  },
                ]}
              />
              {mcp.transport === "http" ? (
                <Field
                  label={s("Адрес MCP", "MCP endpoint")}
                  value={mcp.endpoint}
                  onChange={(endpoint) => setMcp({ ...mcp, endpoint })}
                  placeholder="https://example.com/mcp"
                  help={s(
                    "Публичный HTTPS-адрес без ключа в URL. Внутренние адреса разрешает оператор установки. Перенаправления запрещены.",
                    "Public HTTPS endpoint without credentials in the URL. Internal origins require operator configuration. Redirects are denied.",
                  )}
                />
              ) : (
                <>
                  <FieldLabel
                    label={s("Команда и аргументы", "Command and arguments")}
                    help={s(
                      "Каждый аргумент с новой строки. Запускается только в выбранной рабочей области после подтверждения. Нужен Python 3. Программу устанавливают в среде заранее; автоматической установки нет.",
                      "One argument per line. Runs only in the selected workspace after approval. Python 3 is required. Install the program in the environment beforehand; there is no automatic installation.",
                    )}
                  />
                  <TextArea
                    minRows={4}
                    value={mcp.command}
                    onUpdate={(command) => setMcp({ ...mcp, command })}
                    controlProps={{
                      "aria-label": s(
                        "Команда и аргументы",
                        "Command and arguments",
                      ),
                    }}
                  />
                </>
              )}
              <FieldLabel
                label={s("Разрешённые инструменты", "Allowed tools")}
                help={s(
                  "Точные имена, каждое с новой строки. Пустой список запрещает все вызовы. Обнаружение списка не включает инструменты автоматически.",
                  "Exact names, one per line. Empty means no tools are allowed. Discovery does not enable tools automatically.",
                )}
              />
              {discovered.length ? (
                <Select
                  multiple
                  filterable
                  hasClear
                  aria-label={s("Разрешённые инструменты", "Allowed tools")}
                  value={mcp.tools
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean)}
                  options={[
                    ...new Set([
                      ...discovered,
                      ...mcp.tools
                        .split("\n")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    ]),
                  ].map((name) => ({ value: name, content: name }))}
                  onUpdate={(tools) =>
                    setMcp({ ...mcp, tools: tools.join("\n") })
                  }
                />
              ) : (
                <TextArea
                  minRows={4}
                  maxRows={8}
                  value={mcp.tools}
                  onUpdate={(tools) => setMcp({ ...mcp, tools })}
                  controlProps={{
                    "aria-label": s("Разрешённые инструменты", "Allowed tools"),
                  }}
                />
              )}
              {mcp.id && mcp.transport === "http" && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const result = await api.request<{
                          tools: { name: string }[];
                        }>("/mcp/" + mcp.id + "/discover", "POST");
                        setDiscovered(result.tools.map((t) => t.name));
                      })
                    }
                  >
                    {s(
                      "Получить список с моим ключом",
                      "Discover using my key",
                    )}
                  </Button>
                  {discovered.length > 0 && (
                    <Flex direction="column" gap="spacing-2">
                      <Text color="secondary">{discovered.join(", ")}</Text>
                      <Button
                        onClick={() =>
                          setMcp({ ...mcp, tools: discovered.join("\n") })
                        }
                      >
                        {s(
                          "Разрешить все найденные инструменты",
                          "Allow all discovered tools",
                        )}
                      </Button>
                    </Flex>
                  )}
                </>
              )}
              <Checkbox
                checked={mcp.enabled}
                onUpdate={(enabled) => setMcp({ ...mcp, enabled })}
              >
                {s("Доступно для выбора в чате", "Available in chat")}
              </Checkbox>
              <Text color="secondary">
                {s(
                  "Смена адреса или команды требует повторной привязки ключей. Переименование и отключение сохраняют ключи. Сохранение не запускает программы.",
                  "Changing endpoint or command requires reauthorizing credentials. Renaming or disabling preserves them. Saving does not execute programs.",
                )}
              </Text>
            </Flex>
          )}
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Отмена", "Cancel")}
          textButtonApply={s("Сохранить", "Save")}
          loading={busy}
          onClickButtonCancel={close}
          propsButtonApply={{
            disabled:
              !mcp?.name.trim() ||
              (!mcp.id && mcp.visibility === "project" && !mcp.projectId) ||
              (mcp.transport === "http"
                ? !mcp.endpoint.trim()
                : !mcp.command.trim()),
          }}
          onClickButtonApply={() =>
            void act(async () => {
              if (!mcp) return;
              const command = mcp.command
                  ? mcp.command.split("\n").filter(Boolean)
                  : [],
                tools = mcp.tools
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean);
              if (mcp.id)
                await api.request("/mcp/" + mcp.id, "PUT", {
                  name: mcp.name,
                  transport: mcp.transport,
                  endpoint: mcp.endpoint,
                  command,
                  allowed_tools: tools,
                  enabled: mcp.enabled,
                });
              else
                await api.request("/mcp/install", "POST", {
                  name: mcp.name,
                  transport: mcp.transport,
                  ...(mcp.transport === "http"
                    ? { endpoint: mcp.endpoint }
                    : { command }),
                  allowedTools: tools,
                  enabled: mcp.enabled,
                  visibility: mcp.visibility,
                  ...(mcp.visibility === "project"
                    ? { projectId: mcp.projectId }
                    : {}),
                });
              setMcp(null);
              setDiscovered([]);
            })
          }
        />
      </Dialog>
      <Dialog
        open={Boolean(credential)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        maxWidth="s"
        fullWidth
      >
        <Dialog.Header caption={s("Личный ключ MCP", "Personal MCP key")} />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-3">
            {err}
            <Text color="secondary">
              {s(
                "Этот ключ используется только вашими запросами. Пустое значение удаляет ключ.",
                "This key is used only by your requests. An empty value removes it.",
              )}
            </Text>
            <Field
              label="Bearer token"
              required={false}
              type="password"
              value={token}
              onChange={setToken}
            />
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={s("Отмена", "Cancel")}
          textButtonApply={s("Сохранить", "Save")}
          loading={busy}
          onClickButtonCancel={close}
          onClickButtonApply={() =>
            void act(async () => {
              await api.request(
                "/mcp/" + credential!.id + "/credential",
                "PUT",
                { token },
              );
              setToken("");
              setCredential(null);
            })
          }
        />
      </Dialog>
    </Flex>
  );
}
