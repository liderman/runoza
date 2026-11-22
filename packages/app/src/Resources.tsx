import { LoadingPanel } from "@runoza/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDirtyGuard, useNavigationGuard } from "./NavigationGuard.tsx";
import { Field, FieldLabel, MultilineField, Panel } from "@runoza/ui";
import { uxText } from "./ux-locales.ts";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Text,
  Flex,
  Select,
  TextInput,
  TextArea,
  Alert,
  Dialog,
  FileDropZone,
  Box,
  HelpMark,
  Menu,
  MenuItem,
  MenuTrigger,
  Label,
  TabProvider,
  TabList,
  Tab,
  TabPanel,
  Loader,
} from "@gravity-ui/uikit";
import { IdentityApiError, type IdentityClient } from "@runoza/api-client";
import type { FileView, ProjectView, Conversation } from "@runoza/contracts";
import { resourceText } from "./resource-locales.ts";
type Props = {
  api: IdentityClient;
  locale: "en" | "ru";
  onExpired: () => void;
};
export function FilesPanel({
  api,
  locale,
  onExpired,
  projectId,
  readOnly = false,
  selected,
  onSelect,
}: Props & {
  projectId: string;
  readOnly?: boolean;
  selected?: string[];
  onSelect?: (ids: string[]) => void;
}) {
  const u = uxText(locale);
  const t = resourceText(locale),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<{ text: string; name: string } | null>(
      null,
    ),
    [remove, setRemove] = useState<FileView | null>(null);
  const controller = useRef<AbortController | null>(null);
  useDirtyGuard(Boolean(uploading), () => controller.current?.abort());
  const queryClient = useQueryClient();
  const queryKey = ["files", projectId] as const;
  const queryFn = async ({ signal }: { signal: AbortSignal }) =>
    (
      await api.request<{ files: FileView[] }>(
        "/files" + (projectId ? "?projectId=" + projectId : ""),
        "GET",
        undefined,
        { signal },
      )
    ).files;
  const fileQuery = useQuery({ queryKey, queryFn });
  const files = fileQuery.data ?? [];
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    await queryClient.fetchQuery({ queryKey, queryFn });
  };
  const report = (e: unknown) => {
    if (e instanceof IdentityApiError && e.status === 401) onExpired();
    setError(e instanceof IdentityApiError ? e.code : "error");
  };
  useEffect(() => {
    setLoading(true);
    void refresh()
      .catch(report)
      .finally(() => setLoading(false));
    return () => controller.current?.abort();
  }, [projectId]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Flex as="section" direction="column" gap="spacing-4" minWidth="0">
      <Flex gap="spacing-2" alignItems="center">
        <Text variant="subheader-1">{t("files")}</Text>
        <Button size="s" disabled={busy} onClick={() => void action(refresh)}>
          {t("refresh")}
        </Button>
      </Flex>
      <Text color="secondary">
        {u(projectId ? "projectFilesHint" : "personalFilesHint")}
      </Text>
      <Flex alignItems="center" gap="spacing-2">
        <Text variant="caption-2" color="secondary">
          {u("formats")}
        </Text>
        <HelpMark aria-label={u("fileLimits")}>
          <Box width="22rem" maxWidth="calc(100vw - 4rem)">
            {t("uploadHint")}
            <br />
            {u("filePrivacy")}
          </Box>
        </HelpMark>
      </Flex>
      {error && (
        <Alert
          theme="danger"
          message={error === "fileCancelled" ? u("fileCancelled") : t(error)}
        />
      )}
      {!readOnly && (
        <FileDropZone
          multiple
          disabled={busy}
          title={t("upload")}
          description={u("uploadShort")}
          buttonText={t("upload")}
          onUpdateAccepted={(items) =>
            void action(async () => {
              const abort = new AbortController();
              controller.current = abort;
              let ids = [...(selected ?? [])];
              try {
                for (const file of items) {
                  if (abort.signal.aborted) break;
                  if (file.size === 0 || file.size > 67108864) {
                    setError("tooLarge");
                    continue;
                  }
                  setUploading(file.name);
                  const saved = await api.request<FileView>("/files", "POST", {
                    name: file.name,
                    size: file.size,
                    mediaType: file.type || "application/octet-stream",
                    ...(projectId ? { projectId } : {}),
                  });
                  const ready = await api.upload(saved.id, file, abort.signal);
                  abort.signal.throwIfAborted();
                  if (ready.readable && onSelect && ids.length < 10) {
                    ids = [...ids, ready.id];
                    onSelect(ids);
                  }
                  await refresh();
                }
              } catch (e) {
                if (abort.signal.aborted) setError("fileCancelled");
                else throw e;
              } finally {
                setUploading("");
                controller.current = null;
              }
            })
          }
        />
      )}
      {uploading && (
        <Flex gap="spacing-2">
          <Text>
            {u("uploadFile")}: {uploading}
          </Text>
          <Button onClick={() => controller.current?.abort()}>
            {t("cancel")}
          </Button>
        </Flex>
      )}
      {loading ? (
        <LoadingPanel label={locale === "ru" ? "Загрузка" : "Loading"} />
      ) : (
        !files.length && <Text color="secondary">{t("empty")}</Text>
      )}
      {files.map((f) => (
        <Flex
          key={f.id}
          wrap="wrap"
          alignItems="center"
          gap="spacing-2"
          paddingBlock="spacing-3"
          borderColor="generic"
          borderWidth={1}
          borderRadius="m"
          paddingInline="spacing-4"
        >
          <Text className="resource-name" variant="body-2">
            {f.name} · {new Intl.NumberFormat(locale).format(f.size)} B
          </Text>
          <Text color="secondary">
            {t(
              f.status === "pending"
                ? "pending"
                : f.readable
                  ? "ready"
                  : "stored",
            )}
          </Text>
          {f.status === "ready" && (
            <>
              {!readOnly && onSelect && f.readable && (
                <Button
                  size="s"
                  view={selected?.includes(f.id) ? "action" : "normal"}
                  disabled={busy}
                  onClick={() => {
                    if (selected?.includes(f.id))
                      onSelect(selected.filter((id) => id !== f.id));
                    else if ((selected?.length ?? 0) < 10)
                      onSelect([...(selected ?? []), f.id]);
                    else setError("attachmentLimit");
                  }}
                >
                  {t(selected?.includes(f.id) ? "detach" : "attach")}
                </Button>
              )}
            </>
          )}
          <Menu
            trigger={
              <MenuTrigger
                aria-label={
                  (locale === "ru" ? "Действия с файлом " : "File actions ") +
                  f.name
                }
              />
            }
          >
            {f.status === "ready" && (
              <MenuItem href={api.url("/files/" + f.id + "/content")}>
                {t("download")}
              </MenuItem>
            )}
            {f.status === "ready" && f.readable && (
              <MenuItem
                onClick={() =>
                  void action(async () =>
                    setPreview(
                      await api.request("/files/" + f.id + "/preview"),
                    ),
                  )
                }
              >
                {t("preview")}
              </MenuItem>
            )}
            {!readOnly && (
              <MenuItem
                theme="danger"
                disabled={busy}
                onClick={() => setRemove(f)}
              >
                {t("remove")}
              </MenuItem>
            )}
          </Menu>
        </Flex>
      ))}
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <Dialog.Header caption={preview?.name ?? t("preview")} />
        <Dialog.Body>
          <pre className="resource-preview">{preview?.text}</pre>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={t("cancel")}
          onClickButtonCancel={() => setPreview(null)}
        />
      </Dialog>
      <Dialog
        open={Boolean(remove)}
        onOpenChange={(open) => {
          if (!open) setRemove(null);
        }}
      >
        <Dialog.Header caption={t("confirm")} />
        <Dialog.Body>{t("deleteFileHint")}</Dialog.Body>
        <Dialog.Footer
          textButtonCancel={t("cancel")}
          textButtonApply={t("remove")}
          loading={busy}
          onClickButtonCancel={() => setRemove(null)}
          onClickButtonApply={() =>
            void action(async () => {
              if (!remove) return;
              await api.request("/files/" + remove.id, "DELETE");
              onSelect?.((selected ?? []).filter((id) => id !== remove.id));
              setRemove(null);
              await refresh();
            })
          }
        />
      </Dialog>
    </Flex>
  );
}
function NewProject({
  api,
  locale,
  onExpired,
  onClose,
  onCreated,
}: Props & { onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const t = resourceText(locale),
    u = uxText(locale),
    [name, setName] = useState(""),
    [instructions, setInstructions] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [nameError, setNameError] = useState("");
  const guard = useNavigationGuard();
  useDirtyGuard(Boolean(name || instructions));
  return (
    <Dialog
      open
      maxWidth="m"
      onOpenChange={(open) => {
        if (!open && !busy) guard.navigate(onClose);
      }}
    >
      <Dialog.Header caption={t("newProject")} />
      <Dialog.Body>
        <Flex
          as="form"
          id="new-project-form"
          direction="column"
          gap="spacing-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) {
              setNameError(u("nameRequired"));
              return;
            }
            setBusy(true);
            setError("");
            void api
              .request<{ id: string }>("/projects", "POST", {
                name: name.trim(),
                instructions,
              })
              .then(async (c) => {
                await onCreated(c.id);
                onClose();
              })
              .catch((e) => {
                if (e instanceof IdentityApiError && e.status === 401)
                  onExpired();
                setError(
                  e instanceof IdentityApiError ? t(e.code) : t("error"),
                );
              })
              .finally(() => setBusy(false));
          }}
        >
          <Text color="secondary">{u("createProjectHelp")}</Text>
          {error && <Alert theme="danger" message={error} />}
          <Field
            label={t("name")}
            value={name}
            onChange={(v) => {
              setName(v);
              setNameError("");
            }}
            maxLength={160}
            error={nameError}
            disabled={busy}
          />
          <MultilineField
            label={t("instructions") + " · " + u("optional")}
            help={u("instructionsHelp")}
            description={u("instructionsShort")}
            placeholder={u("instructionsExample")}
            value={instructions}
            onChange={setInstructions}
            disabled={busy}
          />
        </Flex>
      </Dialog.Body>
      <Dialog.Footer
        textButtonCancel={t("cancel")}
        textButtonApply={t("newProject")}
        loading={busy}
        propsButtonApply={{ type: "submit", form: "new-project-form" }}
        onClickButtonCancel={() => guard.navigate(onClose)}
      />
    </Dialog>
  );
}
export function Resources(
  props: Props & {
    initialProject?: string;
    onProjectsChange?: () => void;
    onCurrentProject?: (id: string) => void;
    conversations?: Conversation[];
    onOpenChat?: (id: string | null, project?: string) => void;
  },
) {
  const { api, locale, onExpired } = props,
    t = resourceText(locale),
    u = uxText(locale);
  const [id, setId] = useState(props.initialProject ?? ""),
    [name, setName] = useState(""),
    [instructions, setInstructions] = useState(""),
    [creating, setCreating] = useState(false),
    [personalFiles, setPersonalFiles] = useState(false),
    [deleting, setDeleting] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("viewer"),
    [section, setSection] = useState("chats"),
    [pending, setPending] = useState<string | null>(null),
    [nameError, setNameError] = useState(""),
    [members, setMembers] = useState<
      { id: string; email: string; role: string }[]
    >([]);
  useEffect(() => {
    props.onCurrentProject?.(id);
  }, [id]);
  const queryClient = useQueryClient();
  // Editor snapshot is intentionally separate from the frequently refreshed sidebar.
  const queryKey = ["projects", "editor"] as const;
  const queryFn = async ({ signal }: { signal: AbortSignal }) =>
    (
      await api.request<{ projects: ProjectView[] }>(
        "/projects",
        "GET",
        undefined,
        { signal },
      )
    ).projects;
  const projectsQuery = useQuery({ queryKey, queryFn });
  const projects = projectsQuery.data ?? [];
  const p = projects.find((p) => p.id === id),
    dirty = Boolean(p && (name !== p.name || instructions !== p.instructions));
  const guard = useNavigationGuard();
  useDirtyGuard(dirty || Boolean(email), () => {
    setName(p?.name ?? "");
    setInstructions(p?.instructions ?? "");
    setEmail("");
  });
  async function refresh() {
    props.onProjectsChange?.();
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    await queryClient.fetchQuery({ queryKey, queryFn });
  }
  async function loadMembers() {
    setMembers(
      (
        await api.request<{ members: typeof members }>(
          "/projects/" + id + "/members",
        )
      ).members,
    );
  }
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (e instanceof IdentityApiError && e.status === 401) onExpired();
      setError(e instanceof IdentityApiError ? e.code : "error");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void action(refresh).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    setName(p?.name ?? "");
    setInstructions(p?.instructions ?? "");
    setMembers([]);
    setNotice("");
    setError("");
    setNameError("");
    if (p?.role === "owner") void action(loadMembers);
  }, [id, p?.name, p?.instructions, p?.role]);
  return (
    <Flex direction="column" gap="spacing-6" minWidth="0">
      <Flex gap="spacing-3" wrap="wrap" alignItems="flex-end">
        {id && (
          <Button view="flat" onClick={() => guard.navigate(() => setId(""))}>
            {locale === "ru" ? "← Все проекты" : "← All projects"}
          </Button>
        )}
        <Button
          size="l"
          view="action"
          disabled={busy}
          onClick={() => setCreating(true)}
        >
          {t("newProject")}
        </Button>
      </Flex>
      {error && (
        <Alert
          theme="danger"
          message={
            section === "members" && error === "NOT_FOUND"
              ? u("memberMissing")
              : t(error)
          }
        />
      )}{" "}
      {notice && <Alert theme="success" message={notice} />}
      {loading ? (
        <LoadingPanel label={locale === "ru" ? "Загрузка" : "Loading"} />
      ) : p ? (
        <>
          <Flex alignItems="center" gap="spacing-3">
            <Text variant="header-1">{p.name}</Text>
            <Label>{t(p.role)}</Label>
          </Flex>
          <TabProvider
            value={section}
            onUpdate={(value) => guard.navigate(() => setSection(value))}
          >
            <TabList>
              <Tab value="chats">{locale === "ru" ? "Беседы" : "Chats"}</Tab>
              <Tab value="instructions">{u("settingsTab")}</Tab>
              <Tab value="files">{u("filesTab")}</Tab>
              {p.role === "owner" && (
                <Tab value="members">{u("membersTab")}</Tab>
              )}
            </TabList>
            <TabPanel value="chats">
              <Flex
                direction="column"
                gap="spacing-3"
                paddingBlockStart="spacing-5"
              >
                <Flex justifyContent="space-between" alignItems="center">
                  <Text color="secondary">
                    {locale === "ru"
                      ? "Беседы этого проекта"
                      : "Conversations in this project"}
                  </Text>
                  <Button
                    view="action"
                    disabled={p.role === "viewer"}
                    onClick={() => props.onOpenChat?.(null, p.id)}
                  >
                    {locale === "ru" ? "Новая беседа" : "New chat"}
                  </Button>
                </Flex>
                {(props.conversations ?? [])
                  .filter((c) => c.project_id === p.id)
                  .map((c) => (
                    <Button
                      key={c.id}
                      view="flat"
                      size="l"
                      onClick={() => props.onOpenChat?.(c.id, p.id)}
                    >
                      {c.title}
                    </Button>
                  ))}
                {!(props.conversations ?? []).some(
                  (c) => c.project_id === p.id,
                ) && (
                  <Text color="secondary">
                    {locale === "ru"
                      ? "Пока нет бесед. Начните первую — инструкции проекта будут применены к ответам."
                      : "No chats yet. Start one to use this project's instructions."}
                  </Text>
                )}
              </Flex>
            </TabPanel>
            <TabPanel value="instructions">
              <Box paddingBlockStart="spacing-5" maxWidth="52rem">
                {p.role === "viewer" ? (
                  <Flex direction="column" gap="spacing-4">
                    <Alert theme="info" message={t("readOnly")} />
                    <Text color="secondary">{u("instructionsShort")}</Text>
                    <pre className="resource-preview">
                      {p.instructions || u("optional")}
                    </pre>
                  </Flex>
                ) : (
                  <Panel title={t("instructions")}>
                    <Flex
                      as="form"
                      direction="column"
                      gap="spacing-5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!name.trim()) {
                          setNameError(u("nameRequired"));
                          return;
                        }
                        void action(async () => {
                          await api.request("/projects/" + id, "PATCH", {
                            name: name.trim(),
                            instructions,
                          });
                          await refresh();
                          setNotice(u("projectSaved"));
                        });
                      }}
                    >
                      <Field
                        label={t("name")}
                        value={name}
                        onChange={(v) => {
                          setName(v);
                          setNameError("");
                        }}
                        maxLength={160}
                        error={nameError}
                        disabled={busy}
                      />
                      <MultilineField
                        label={t("instructions") + " · " + u("optional")}
                        help={u("instructionsHelp")}
                        description={u("instructionsShort")}
                        placeholder={u("instructionsExample")}
                        value={instructions}
                        onChange={setInstructions}
                        disabled={busy}
                      />
                      <Flex gap="spacing-3" wrap="wrap">
                        <Button
                          type="submit"
                          view="action"
                          loading={busy}
                          disabled={!dirty}
                        >
                          {t("save")}
                        </Button>
                        <Button
                          disabled={busy || !dirty}
                          onClick={() => {
                            setName(p.name);
                            setInstructions(p.instructions);
                            setNameError("");
                          }}
                        >
                          {t("cancel")}
                        </Button>
                      </Flex>
                    </Flex>
                  </Panel>
                )}
                {p.role === "owner" && (
                  <Box marginBlockStart="spacing-6">
                    <Flex
                      direction="column"
                      gap="spacing-3"
                      alignItems="flex-start"
                    >
                      <Text color="secondary">{u("dangerHelp")}</Text>
                      <Button
                        view="outlined-danger"
                        disabled={busy}
                        onClick={() => setDeleting(true)}
                      >
                        {u("danger")}
                      </Button>
                    </Flex>
                  </Box>
                )}
              </Box>
            </TabPanel>
            <TabPanel value="files">
              <Box paddingBlockStart="spacing-5">
                <FilesPanel
                  key={id}
                  {...props}
                  projectId={id}
                  readOnly={p.role === "viewer"}
                />
              </Box>
            </TabPanel>
            {p.role === "owner" && (
              <TabPanel value="members">
                <Box paddingBlockStart="spacing-5" maxWidth="52rem">
                  <Panel title={t("members")} description={u("membersHelp")}>
                    <Flex
                      as="form"
                      direction="column"
                      gap="spacing-4"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void action(async () => {
                          await api.request(
                            "/projects/" + id + "/members",
                            "PUT",
                            { email: email.trim(), role },
                          );
                          setEmail("");
                          await loadMembers();
                          setNotice(u("saved"));
                        });
                      }}
                    >
                      <Field
                        label={t("email")}
                        type="email"
                        value={email}
                        onChange={setEmail}
                        maxLength={254}
                        disabled={busy}
                      />
                      <Flex gap="spacing-3" alignItems="flex-end" wrap="wrap">
                        <Flex direction="column" gap="spacing-2">
                          <FieldLabel
                            label={t("members")}
                            help={u("membersHelp")}
                          />
                          <Select
                            aria-label={t("members")}
                            size="l"
                            disabled={busy}
                            value={[role]}
                            onUpdate={(v) => setRole(v[0] ?? "viewer")}
                            options={["viewer", "editor"].map((value) => ({
                              value,
                              content: t(value),
                            }))}
                          />
                        </Flex>
                        <Button
                          type="submit"
                          view="action"
                          size="l"
                          loading={busy}
                        >
                          {t("share")}
                        </Button>
                      </Flex>
                    </Flex>
                    {!members.length && (
                      <Text color="secondary">{u("noMembers")}</Text>
                    )}
                    {members.map((m) => (
                      <Flex
                        key={m.id}
                        gap="spacing-3"
                        alignItems="center"
                        wrap="wrap"
                      >
                        <Text>{m.email}</Text>
                        <Label>{t(m.role)}</Label>
                        <Button
                          size="s"
                          view="flat-danger"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await api.request(
                                "/projects/" + id + "/members/" + m.id,
                                "DELETE",
                              );
                              await loadMembers();
                            })
                          }
                        >
                          {t("revoke")}
                        </Button>
                      </Flex>
                    ))}
                  </Panel>
                </Box>
              </TabPanel>
            )}
          </TabProvider>
        </>
      ) : (
        <Flex direction="column" gap="spacing-6">
          <div className="grid project-grid">
            {projects.map((project) => (
              <Panel
                key={project.id}
                title={project.name}
                description={t(project.role)}
              >
                <Text color="secondary">
                  {(() => {
                    const n = (props.conversations ?? []).filter(
                      (c) => c.project_id === project.id,
                    ).length;
                    const plural = new Intl.PluralRules(locale).select(n);
                    return `${n} ${locale === "ru" ? (plural === "one" ? "беседа" : plural === "few" ? "беседы" : "бесед") : plural === "one" ? "chat" : "chats"}`;
                  })()}
                </Text>
                <Button
                  onClick={() => {
                    setId(project.id);
                    setSection("chats");
                  }}
                >
                  {locale === "ru" ? "Открыть проект" : "Open project"}
                </Button>
              </Panel>
            ))}
          </div>
          {!projects.length && (
            <Text color="secondary">
              {locale === "ru"
                ? "Создайте проект, чтобы объединить беседы, файлы и инструкции."
                : "Create a project to keep chats, files and instructions together."}
            </Text>
          )}
          <Flex>
            <Button view="outlined" onClick={() => setPersonalFiles(true)}>
              {u("personalFiles")}
            </Button>
          </Flex>
          <Dialog
            open={personalFiles}
            maxWidth="l"
            onOpenChange={setPersonalFiles}
          >
            <Dialog.Header caption={u("personalFiles")} />
            <Dialog.Body>
              <FilesPanel key="personal" {...props} projectId="" />
            </Dialog.Body>
          </Dialog>
        </Flex>
      )}
      {creating && (
        <NewProject
          {...props}
          onClose={() => setCreating(false)}
          onCreated={async (created) => {
            await refresh();
            setId(created);
            setSection("chats");
          }}
        />
      )}
      <Dialog
        open={deleting}
        onOpenChange={(v) => {
          if (!busy) setDeleting(v);
        }}
      >
        <Dialog.Header caption={t("confirm")} />
        <Dialog.Body>
          <Flex direction="column" gap="spacing-4">
            {error && <Alert theme="danger" message={t(error)} />}
            <Text>{t("deleteProjectHint")}</Text>
          </Flex>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel={t("cancel")}
          textButtonApply={t("remove")}
          propsButtonApply={{ view: "outlined-danger" }}
          loading={busy}
          onClickButtonCancel={() => setDeleting(false)}
          onClickButtonApply={() =>
            void action(async () => {
              await api.request("/projects/" + id, "DELETE");
              setId("");
              setDeleting(false);
              await refresh();
            })
          }
        />
      </Dialog>
      <Dialog
        open={pending !== null}
        onOpenChange={(v) => {
          if (!v) setPending(null);
        }}
      >
        <Dialog.Header caption={u("unsaved")} />
        <Dialog.Body>{u("unsavedHint")}</Dialog.Body>
        <Dialog.Footer
          textButtonCancel={t("cancel")}
          textButtonApply={u("discard")}
          onClickButtonCancel={() => setPending(null)}
          onClickButtonApply={() => {
            setId(pending ?? "");
            setPending(null);
          }}
        />
      </Dialog>
    </Flex>
  );
}
