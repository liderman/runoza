import {
  ConversationQueuePanel,
  useConversationQueue,
  useQueueSubmission,
} from "./ConversationQueue.tsx";
import type { QueuedInputContent } from "@runoza/contracts";
import { RunPlanPanel } from "./RunPlan.tsx";
import {
  RevisionComposerContext,
  ReferenceChips,
} from "./revision-composer.tsx";
import {
  referenceInput,
  MAX_REVISION_REFERENCES,
  type RevisionReference,
} from "@runoza/contracts";
import {
  useConversationDraft,
  useDraftAcknowledgement,
  useAdoptConversationDraft,
  useDraftPatch,
} from "./conversation-drafts.tsx";
import { useCapabilities } from "./capabilities.tsx";
import { LoadingPanel } from "@runoza/ui";
import { ChatHistory } from "./ChatHistory.tsx";
import { useEventCallback } from "./useEventCallback.ts";
import { useQuery } from "@tanstack/react-query";
import { ExtensionPicker } from "./ExtensionPicker.tsx";
import { useCollections } from "./ProjectCollections.tsx";
import { SourceEvidence, type SourceSelection } from "./SourceEvidence.tsx";
import { ComposerAddMenu } from "./ComposerAddMenu.tsx";
import { useSkillCommands, SkillCommandList } from "./SkillCommands.tsx";
import { ConversationHeader } from "./ConversationHeader.tsx";
import { ReasoningControl } from "./ReasoningControl.tsx";
import { ConversationInfo } from "./ConversationInfo.tsx";
import { ModelLogo, modelSummary } from "./ModelFacts.tsx";
import { CodeWorkspace } from "./CodeWorkspace.tsx";
import { RunStatusStrip } from "./RunStatusStrip.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import {
  Xmark,
  ArrowUp,
  CircleStop,
  ChevronDown,
  LayoutSplitSideContentRight,
  CircleInfo,
} from "@gravity-ui/icons";
import { useDirtyGuard, useNavigationGuard } from "./NavigationGuard.tsx";
import { uxText } from "./ux-locales.ts";
import { FilesPanel } from "./Resources.tsx";
import { resourceText } from "./resource-locales.ts";
import type { ProjectView } from "@runoza/contracts";
import { useContext, useEffect, useRef, useState, type Ref } from "react";
import {
  Portal,
  Checkbox,
  Button,
  Select,
  Flex,
  Alert,
  Dialog,
  TextInput,
  TextArea,
  Text,
  Menu,
  MenuItem,
  MenuTrigger,
  Box,
  Icon,
  Tooltip,
  Card,
  FilePreview,
} from "@gravity-ui/uikit";
import type {
  ChatSnapshot,
  ChatRun,
  Conversation,
  ModelChoice,
  ChatMessage,
  FileView,
} from "@runoza/contracts";
import { IdentityApiError, type IdentityClient } from "@runoza/api-client";
import { chatText } from "./chat-locales.ts";
export function ChatWorkspace({
  api,
  locale,
  onExpired,
  onConfigure,
  initialChat,
  initialProject = "",
  onConversationsChange,
  onSelect,
}: {
  api: IdentityClient;
  locale: "en" | "ru";
  onExpired: () => void;
  onConfigure?: () => void;
  initialChat: string | null;
  initialProject?: string;
  onConversationsChange: (chats: Conversation[]) => void;
  onSelect: (id: string | null) => void;
}) {
  const draftKey = initialChat ?? "new:" + initialProject;
  const capabilities = useCapabilities(api);
  const adoptDraft = useAdoptConversationDraft(draftKey);
  const patchDraft = useDraftPatch();
  const captureDraft = useDraftAcknowledgement(draftKey);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const selectConversation = (next: string | null) => {
    if (next && !initialChat) adoptDraft(next);
    onSelect(next);
  };
  const [selected, setSelected, hasChoice] = useConversationDraft(
    draftKey + ":model",
    "",
  );
  const [reasoning, setReasoning] = useConversationDraft(
    draftKey + ":reasoning",
    "default",
  );
  const [planning, setPlanning] = useConversationDraft(
    draftKey + ":planning",
    false,
  );
  const [prompt, setPrompt] = useConversationDraft(draftKey + ":prompt", "");
  const [revisionReferences, setRevisionReferences] = useConversationDraft<
    RevisionReference[]
  >(draftKey + ":revision-references", []);
  const promptControl = useRef<HTMLTextAreaElement>(null);
  const [searchProject, setSearchProject] = useConversationDraft(
    draftKey + ":search-project",
    false,
  );
  const [collectionId, setCollection] = useConversationDraft(
    draftKey + ":collection",
    "",
  );
  const [source, setSource] = useState<SourceSelection | null>(null);
  const sourceTrigger = useRef<HTMLElement | null>(null);
  function openSource(selection: SourceSelection, trigger: HTMLElement) {
    sourceTrigger.current = trigger;
    setSource(selection);
  }
  function closeSource() {
    const trigger = sourceTrigger.current;
    const fallback =
      source && "source-" + source.message + "-" + source.ordinal;
    setSource(null);
    requestAnimationFrame(() => {
      const inline =
        trigger?.tagName === "A" && source
          ? document.querySelector<HTMLElement>(
              `[data-citation-message="${source.message}"] a[href="#source-${source.ordinal}"]`,
            )
          : null;
      const target = trigger?.isConnected
        ? trigger
        : inline || (fallback && document.getElementById(fallback));
      if (target) target.focus({ preventScroll: true });
    });
  }
  const [fileIds, setFileIds] = useConversationDraft<string[]>(
    draftKey + ":files",
    [],
  );
  const choiceChanged = useRef(hasChoice);
  const hydrated = useRef<string | null>(null);
  const persistChoice = (value: Record<string, unknown>) => {
    choiceChanged.current = true;
    const tuple = selected
      ? (() => {
          const [providerId, model] = JSON.parse(selected);
          return { providerId, model };
        })()
      : {};
    void api
      .request(
        initialChat
          ? "/conversations/" + initialChat + "/preferences"
          : "/chat/preferences",
        "PATCH",
        { ...tuple, ...value },
      )
      .catch(report);
  };
  const [skillVersionIds, setSkillVersionIds] = useConversationDraft<string[]>(
    draftKey + ":skills",
    [],
  );
  const [mcpConnectionIds, setMcpConnectionIds] = useConversationDraft<
    string[]
  >(draftKey + ":mcp", []);
  const commands = useSkillCommands({
    api,
    conversationId: initialChat,
    projectId: initialProject,
    prompt,
    setPrompt,
    enabled: capabilities.flags.skills === true,
    enableCompaction: true,
    locale,
    onChoose: (id) => setSkillVersionIds((ids) => [...new Set([...ids, id])]),
  });
  const [approvalMode, setApprovalMode] = useState<"ask" | "arbiter" | "full">(
    "ask",
  );
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const permissionOptions = useQuery({
    queryKey: ["permissions", "options"],
    queryFn: ({ signal }) =>
      api.request<{ arbiterEnabled: boolean }>(
        "/permissions/options",
        "GET",
        undefined,
        { signal },
      ),
    staleTime: 30000,
    refetchInterval: 30000,
  });
  const effectiveApprovalMode =
    approvalMode === "arbiter" &&
    permissionOptions.data?.arbiterEnabled === false
      ? "ask"
      : approvalMode;
  const approvalUnavailable =
    approvalMode === "arbiter" && !permissionOptions.data;
  const fullAccessLabel = locale === "ru" ? "Полный доступ" : "Full access";
  useEffect(() => {
    setApprovalMode("ask");
    setConfirmFullAccess(false);
  }, [initialChat, initialProject]);
  const approvalConversation = useRef<string | null>(null);
  const u = uxText(locale);
  const t = chatText(locale),
    rt = resourceText(locale);
  const [projects, setProjects] = useState<ProjectView[]>([]),
    [projectId] = useState(initialProject),
    [attachmentDraft, setAttachmentDraft] = useState<string[]>([]),
    [showFiles, setShowFiles] = useState(false),
    [extensionKind, setExtensionKind] = useState<"skill" | "mcp" | null>(null);

  const [chats, setChats] = useState<Conversation[]>([]),
    [providerFilter, setProviderFilter] = useState(""),
    [keyboardMode, setKeyboardMode] = useState(false),
    [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null),
    [id, setId] = useState(initialChat),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [contextError, setContextError] = useState(""),
    [reconnecting, setReconnecting] = useState(false);
  const defaultsQuery = useQuery({
    queryKey: ["chat", "preferences"],
    queryFn: ({ signal }) =>
      api.request<{
        preferences: import("@runoza/contracts").ConversationPreferences;
      }>("/chat/preferences", "GET", undefined, { signal }),
    enabled: !initialChat,
    staleTime: 0,
  });
  useEffect(() => {
    const prefs = defaultsQuery.data?.preferences;
    if (
      !initialChat &&
      !choiceChanged.current &&
      prefs?.providerId &&
      prefs.model
    ) {
      setSelected(JSON.stringify([prefs.providerId, prefs.model]));
      setReasoning(prefs.reasoning ?? "default");
    }
  }, [defaultsQuery.data]);
  const modelsQuery = useQuery({
    queryKey: ["models", "enabled"],
    queryFn: ({ signal }) =>
      api.request<{ models: ModelChoice[] }>("/models", "GET", undefined, {
        signal,
      }),
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });
  const models = modelsQuery.data?.models ?? [];
  const selectedModel = models.find(
    (model) => JSON.stringify([model.providerId, model.id]) === selected,
  );
  const modelAvailable = Boolean(
    selected &&
      models.some((m) => JSON.stringify([m.providerId, m.id]) === selected),
  );
  useEffect(() => {
    if (
      !selected &&
      models[0] &&
      ((!initialChat && defaultsQuery.isSuccess) || (initialChat && snapshot))
    )
      setSelected(JSON.stringify([models[0].providerId, models[0].id]));
  }, [modelsQuery.data, selected, Boolean(snapshot), defaultsQuery.isSuccess]);
  const [dialog, setDialog] = useState<"rename" | "delete" | "edit" | null>(
      null,
    ),
    [draft, setDraft] = useState(""),
    [editing, setEditing] = useState<ChatMessage | null>(null);
  useEffect(() => {
    if (
      snapshot?.conversation.id &&
      approvalConversation.current !== snapshot.conversation.id
    ) {
      approvalConversation.current = snapshot.conversation.id;
      setApprovalMode(
        snapshot.preferences?.approvalMode ??
          snapshot.conversation.approval_mode ??
          "ask",
      );
    }
  }, [snapshot?.conversation.id]);
  const scopeProject = id
    ? (snapshot?.conversation.project_id ?? "")
    : projectId;
  const collectionQuery = useCollections(api, scopeProject, searchProject);
  const readOnly =
    snapshot?.conversation.accessRole === "viewer" ||
    (!id && projects.find((p) => p.id === projectId)?.role === "viewer");
  const [panelOpen, setPanelOpen] = useConversationDraft(
    draftKey + ":panel",
    false,
  );
  const [infoOpen, setInfoOpen] = useState(false),
    fileGuard = useRef<object | undefined>(undefined),
    infoTrigger = useRef<HTMLButtonElement>(null),
    navigation = useNavigationGuard();
  const localTarget = Boolean(snapshot?.conversation.desktop_workspace_id);
  const targetLabel = localTarget
    ? (locale === "ru" ? "Локально: " : "Local: ") +
      (snapshot?.conversation.desktop_workspace_name ?? "")
    : locale === "ru"
      ? "Сервер Runóza"
      : "Runóza server";
  async function chooseTarget(local: boolean) {
    await action(async () => {
      const folder = local ? await window.runozaDesktop?.chooseFolder() : null;
      if (local && !folder) return;
      let conversationId = id;
      if (!conversationId) {
        const c = await api.request<Conversation>("/conversations", "POST", {
          title: t("newChat"),
          ...(projectId ? { projectId } : {}),
        });
        conversationId = c.id;
        current.current = c.id;
        setId(c.id);
      }
      await api.request(
        "/conversations/" + conversationId + "/target",
        "POST",
        { workspaceId: folder?.id ?? null },
      );
      await load(conversationId);
      await list();
      selectConversation(conversationId);
    });
  }

  const attachmentQuery = useQuery({
    queryKey: ["files", scopeProject],
    queryFn: ({ signal }) =>
      api
        .request<{
          files: FileView[];
        }>(
          "/files" + (scopeProject ? "?projectId=" + scopeProject : ""),
          "GET",
          undefined,
          { signal },
        )
        .then((x) => x.files),
    enabled: fileIds.length > 0 || searchProject,
  });
  const [compactWorkspace, setCompactWorkspace] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1050px)");
    const update = () => setCompactWorkspace(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const codeEnabled = capabilities.flags.code === true;
  const executionEnabled =
    codeEnabled &&
    (localTarget || capabilities.runtime?.serverConfigured !== false);
  const composerGuard = useDirtyGuard(
    Boolean(
      prompt.trim() ||
        fileIds.length ||
        revisionReferences.length ||
        searchProject ||
        (dialog === "edit" && draft !== (editing?.content ?? "")) ||
        (dialog === "rename" && draft !== (snapshot?.conversation.title ?? "")),
    ),
    () => {
      setPrompt("");
      setFileIds([]);
      setRevisionReferences([]);
      setSearchProject(false);
      setDialog(null);
    },
  );
  const [subscription, setSubscription] = useState(0);

  const pending = useRef<{ signature: string; requestId: string } | null>(null);
  const current = useRef(id);
  current.current = id;
  const generation = useRef(0);
  const stream = useRef<AbortController | null>(null);
  const active = snapshot?.runs.find((r) =>
    ["queued", "running"].includes(r.status),
  );
  const queue = useConversationQueue(api, id, (chatId) => {
    if (current.current === chatId) setSubscription((n) => n + 1);
  });
  const queueSubmission = useQueueSubmission(api, id, draftKey, (chatId) => {
    if (current.current === chatId) setSubscription((n) => n + 1);
  });
  const queueWaiting = queue.items.some(
    (item) => item.status === "queued" || item.status === "needs_attention",
  );
  const queueLabel = locale === "ru" ? "Добавить следующим" : "Add next";
  const queueSelection: Partial<QueuedInputContent> = {
    ...(selected
      ? {
          providerId: JSON.parse(selected)[0] as string,
          model: JSON.parse(selected)[1] as string,
        }
      : {}),
    reasoning,
    approvalMode: effectiveApprovalMode,
    mode: executionEnabled ? "code" : "chat",
    executionTarget: executionEnabled ? "server" : undefined,
    intent: executionEnabled && planning ? "plan" : "execute",
    skillVersionIds,
    mcpConnectionIds,
  };
  async function enqueueDraft(content: string) {
    if (
      !id ||
      !modelAvailable ||
      approvalUnavailable ||
      readOnly ||
      busy ||
      !content.trim()
    )
      return false;
    await queueSubmission.submit({
      ...queueSelection,
      content,
      providerId: JSON.parse(selected)[0] as string,
      model: JSON.parse(selected)[1] as string,
      searchProject,
      collectionId: searchProject ? collectionId || undefined : undefined,
      fileIds,
      revisionReferences: revisionReferences.map(referenceInput),
    });
    return undefined;
  }
  function report(e: unknown) {
    if (e instanceof IdentityApiError && e.status === 401) onExpired();
    setContextError("");
    if (
      e instanceof IdentityApiError &&
      ["CONTEXT_LIMIT", "EXTENSION_CONTEXT_LIMIT"].includes(e.code) &&
      e.details
    ) {
      const d = e.details;
      if (
        [d.inputTokens, d.inputBudget, d.contextTokens, d.outputTokens].every(
          (x) => typeof x === "number" && Number.isFinite(x),
        )
      )
        setContextError(
          locale === "ru"
            ? `Оценка входа: ${d.inputTokens} токенов; доступно: ${d.inputBudget}. Контекст модели: ${d.contextTokens}, резерв на ответ: ${d.outputTokens}. Сократите историю/схемы или проверьте настройки контекста и ответа модели.`
            : `Estimated input: ${d.inputTokens} tokens; available: ${d.inputBudget}. Model context: ${d.contextTokens}; response reserve: ${d.outputTokens}. Reduce history/schemas or check the model context and output settings.`,
        );
    }
    setError(e instanceof IdentityApiError ? e.code : "error");
  }
  async function list() {
    const data = (
      await api.request<{ conversations: Conversation[] }>("/conversations")
    ).conversations;
    setChats(data);
    onConversationsChange(data);
  }
  async function load(chatId: string) {
    const data = await api.request<ChatSnapshot>("/conversations/" + chatId);
    if (current.current === chatId) {
      setSnapshot(data);
      if (hydrated.current !== chatId) {
        hydrated.current = chatId;
        if (!choiceChanged.current) {
          const p = data.preferences;
          const last = data.runs.at(-1);
          if (p?.providerId && p.model) {
            setSelected(JSON.stringify([p.providerId, p.model]));
            setReasoning(p.reasoning ?? "default");
          } else if (last)
            setSelected(JSON.stringify([last.provider_id, last.model]));
        }
      }
    }
    return data;
  }
  async function action(fn: () => Promise<void>) {
    if (busy) return;
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
  function chooseApproval(value: "ask" | "arbiter" | "full") {
    void action(async () => {
      if (id)
        await api.request("/conversations/" + id + "/preferences", "PATCH", {
          approvalMode: value,
        });
      setApprovalMode(value);
      setConfirmFullAccess(false);
    });
  }
  useEffect(() => {
    void Promise.all([
      list(),
      api
        .request<{ projects: ProjectView[] }>("/projects")
        .then((v) => setProjects(v.projects)),
    ])
      .catch(report)
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    setSnapshot((old) => (old?.conversation.id === id ? old : null));
    setError("");
    const epoch = ++generation.current;
    const controller = new AbortController();
    stream.current?.abort();
    stream.current = controller;
    if (id)
      void (async () => {
        try {
          const data = await load(id);
          const run = data.runs.find((r) =>
            ["queued", "running"].includes(r.status),
          );
          if (!run || controller.signal.aborted) return;
          let cursor = run.seq;
          let done = false;
          while (!done && !controller.signal.aborted) {
            try {
              await api.events(
                "/runs/" + run.id + "/events",
                cursor,
                (event) => {
                  if (event.seq <= cursor || epoch !== generation.current)
                    return;
                  cursor = event.seq;
                  done = !["queued", "running"].includes(event.status);
                  setReconnecting(false);
                  setSnapshot((s) =>
                    s
                      ? {
                          ...s,
                          messages: s.messages.map((m) =>
                            m.id === run.assistant_message_id
                              ? {
                                  ...m,
                                  content: event.content,
                                  reasoning: event.reasoning ?? m.reasoning,
                                  parts: event.parts ?? m.parts,
                                }
                              : m,
                          ),
                          runs: s.runs.map((r) =>
                            r.id === run.id ? { ...r, ...event } : r,
                          ),
                        }
                      : s,
                  );
                },
                controller.signal,
              );
              if (!done && !controller.signal.aborted) {
                const latest = await load(id);
                done = !latest.runs.some(
                  (r) =>
                    r.id === run.id && ["queued", "running"].includes(r.status),
                );
                if (!done) throw Error("Reconnect");
              }
            } catch (e) {
              if (controller.signal.aborted) return;
              if (
                e instanceof IdentityApiError &&
                [401, 403, 404].includes(e.status)
              ) {
                report(e);
                return;
              }
              setReconnecting(true);
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
          }
          if (!controller.signal.aborted) {
            await load(id);
            await list();
          }
        } catch (e) {
          if (!controller.signal.aborted) report(e);
        }
      })();
    return () => {
      controller.abort();
    };
  }, [id, subscription]);
  // The run ID starts a subscription after a successful POST. Switching chats cancels only the subscriber.
  const isCompactionPrompt = /^\/compaction(?:\s|$)/.test(prompt.trim());
  async function send(
    content: string,
    retryMessageId?: string,
    parentId?: string | null,
    options: {
      preserveDraft?: boolean;
      planAcceptance?: { runId: string; version: number };
    } = {},
  ) {
    const draftAck = captureDraft();
    const command =
      !retryMessageId && /^\/compaction(?:\s+([\s\S]*))?$/.exec(content.trim());
    if (command && active && id && !busy && !readOnly) {
      let accepted = false;
      await action(async () => {
        await api.request("/conversations/" + id + "/compaction", "POST", {
          requestId: crypto.randomUUID(),
          focus: (command[1] ?? "").slice(0, 2000),
        });
        if (!options.preserveDraft) draftAck.acknowledge({ prompt: "" });
        await load(id);
        accepted = true;
      });
      return accepted ? undefined : false;
    }
    if (
      !command &&
      !retryMessageId &&
      parentId === undefined &&
      !options.planAcceptance &&
      (active || queueWaiting)
    )
      return enqueueDraft(content);
    if (
      !modelAvailable ||
      (!command && approvalUnavailable) ||
      busy ||
      active ||
      readOnly
    )
      return false;
    const sendingReferences =
      !retryMessageId && !command && !options.planAcceptance
        ? (parentId !== undefined
            ? (editing?.revision_references ?? [])
            : revisionReferences
          ).map(referenceInput)
        : [];
    let successful = false;
    await action(async () => {
      const [providerId, model] = JSON.parse(selected);
      let chatId = id;
      if (!chatId) {
        const c = await api.request<Conversation>("/conversations", "POST", {
          title: content.slice(0, 80) || t("newChat"),
          ...(projectId ? { projectId } : {}),
        });
        chatId = c.id;
        current.current = chatId;
        setId(chatId);
      }
      await api.request("/conversations/" + chatId + "/preferences", "PATCH", {
        providerId,
        model,
        reasoning,
        ...(!initialChat ? { approvalMode } : {}),
      });
      const signature = JSON.stringify([
        chatId,
        executionEnabled ? "server" : null,
        planning,
        options.planAcceptance,
        providerId,
        model,
        reasoning,
        approvalMode,
        skillVersionIds,
        mcpConnectionIds,
        content,
        retryMessageId,
        parentId,
        fileIds,
        sendingReferences,
        searchProject,
        collectionId,
      ]);
      if (pending.current?.signature !== signature)
        pending.current = { signature, requestId: crypto.randomUUID() };
      await api
        .request<ChatRun>("/conversations/" + chatId + "/runs", "POST", {
          requestId: pending.current.requestId,
          ...(executionEnabled && !command
            ? { executionTarget: "server" }
            : {}),
          ...(options.planAcceptance
            ? { planAcceptance: options.planAcceptance }
            : executionEnabled && planning && !command
              ? { intent: "plan" }
              : {}),
          providerId,
          model,
          reasoning,
          approvalMode: effectiveApprovalMode,
          skillVersionIds: options.planAcceptance ? [] : skillVersionIds,
          mcpConnectionIds: options.planAcceptance ? [] : mcpConnectionIds,
          ...(retryMessageId
            ? { retryMessageId }
            : {
                content,
                searchProject:
                  command || options.planAcceptance
                    ? false
                    : parentId !== undefined
                      ? editing?.search_project
                      : searchProject,
                collectionId:
                  command || options.planAcceptance
                    ? undefined
                    : parentId !== undefined
                      ? (editing?.search_collection ?? undefined)
                      : searchProject
                        ? collectionId || undefined
                        : undefined,
                ...(sendingReferences.length
                  ? { revisionReferences: sendingReferences }
                  : {}),
                fileIds:
                  command || options.planAcceptance
                    ? []
                    : parentId !== undefined
                      ? (editing?.attachments ?? []).map((f) => f.id)
                      : fileIds,
                ...(parentId !== undefined ? { parentId } : {}),
              }),
        })
        .catch(async (error) => {
          if (
            error instanceof IdentityApiError &&
            error.code === "APPROVAL_MODE_CHANGED"
          ) {
            const updated = await load(chatId);
            if (current.current === chatId)
              setApprovalMode(
                updated.preferences?.approvalMode ??
                  updated.conversation.approval_mode ??
                  "ask",
              );
          }
          throw error;
        });
      pending.current = null;
      if (!retryMessageId && parentId === undefined && !options.planAcceptance)
        draftAck.acknowledge({
          ...(!command ? { "revision-references": [] } : {}),
          ...(!options.preserveDraft ? { prompt: "" } : {}),
        });
      if (
        !command &&
        !retryMessageId &&
        parentId === undefined &&
        !options.planAcceptance
      ) {
        setFileIds([]);
        setSearchProject(false);
        setSkillVersionIds([]);
      }
      await load(chatId);
      setSubscription((n) => n + 1);
      await list();
      successful = true;
      if (
        !options.preserveDraft &&
        !retryMessageId &&
        parentId === undefined &&
        mounted.current &&
        current.current === chatId
      ) {
        // A later draft remains dirty after the earlier request was accepted.
        const entry = navigation.entries.get(composerGuard);
        if (
          entry &&
          draftAck.unchanged() &&
          (!command ||
            !(revisionReferences.length || fileIds.length || searchProject))
        )
          entry.dirty = false;
        selectConversation(chatId);
      }
    });
    return successful ? undefined : false;
  }
  const historyFork = useEventCallback((messageId: string) => {
    void action(async () => {
      if (!id) return;
      const next = await api.request<
        Conversation & {
          draft?: string;
          draftRevisionReferences?: RevisionReference[];
        }
      >("/conversations/" + id + "/fork", "POST", { messageId });
      current.current = next.id;
      setId(next.id);
      patchDraft(next.id, {
        prompt: next.draft ?? "",
        "revision-references": next.draftRevisionReferences ?? [],
        model: selected,
        reasoning,
        files: [],
      });
      await load(next.id);
      await list();
      selectConversation(next.id);
    });
  });
  const historyVersion = useEventCallback((headId: string) => {
    void action(async () => {
      if (id) {
        await api.request("/conversations/" + id, "PATCH", { headId });
        await load(id);
      }
    });
  });
  const historyEdit = useEventCallback((message: ChatMessage) => {
    setEditing(message);
    setDraft(message.content);
    setDialog("edit");
  });
  const historyRetry = useEventCallback((parentId?: string) => {
    void send("", parentId);
  });
  const historySource = useEventCallback(openSource);
  const historyError = useEventCallback(() => setError("error"));
  const lastRun = snapshot?.runs.find(
    (r) => r.assistant_message_id === snapshot.conversation.head_id,
  );

  async function openWorkspace() {
    await action(async () => {
      if (!id) {
        const c = await api.request<Conversation>("/conversations", "POST", {
          title: t("newChat"),
          ...(projectId ? { projectId } : {}),
        });
        current.current = c.id;
        setId(c.id);
        await list();
      }
      setInfoOpen(false);
      setPanelOpen(true);
      if (current.current) selectConversation(current.current);
    });
  }
  const headerHost = useContext(ConversationHeader);
  const toolbar = (
    <Flex
      className="conversation-toolbar"
      gap="spacing-3"
      alignItems="center"
      justifyContent="space-between"
      padding={headerHost ? "spacing-2" : "spacing-4"}
      minWidth="0"
    >
      <Flex
        direction={headerHost ? "row" : "column"}
        alignItems={headerHost ? "center" : undefined}
        minWidth="0"
        flex="1"
        gap={headerHost ? "spacing-3" : "spacing-1"}
      >
        <Text variant={headerHost ? "body-2" : "subheader-2"} ellipsis>
          {snapshot?.conversation.title || t("newChat")}
        </Text>
        {scopeProject && (
          <Text variant="caption-2" color="secondary" ellipsis>
            {projects.find((p) => p.id === scopeProject)?.name}
          </Text>
        )}
      </Flex>
      <Flex
        className="conversation-header-actions"
        gap="spacing-1"
        alignItems="center"
        flexShrink={0}
      >
        {codeEnabled && !readOnly && (
          <Button
            ref={panelTrigger}
            view="flat"
            selected={panelOpen}
            disabled={busy}
            aria-label={
              locale === "ru" ? "Файлы и терминал" : "Files & terminal"
            }
            title={locale === "ru" ? "Файлы и терминал" : "Files & terminal"}
            onClick={() =>
              panelOpen
                ? navigation.navigate(
                    () => setPanelOpen(false),
                    fileGuard.current,
                  )
                : void openWorkspace()
            }
          >
            <Icon data={LayoutSplitSideContentRight} />
          </Button>
        )}
        <Button
          ref={infoTrigger}
          view="flat"
          selected={infoOpen}
          aria-label={
            locale === "ru" ? "Информация о беседе" : "Conversation information"
          }
          title={
            locale === "ru" ? "Информация о беседе" : "Conversation information"
          }
          onClick={() => {
            const toggle = () => {
              setPanelOpen(false);
              setInfoOpen(!infoOpen);
            };
            if (panelOpen) navigation.navigate(toggle, fileGuard.current);
            else toggle();
          }}
        >
          <Icon data={CircleInfo} />
        </Button>
        {id && (
          <Menu trigger={<MenuTrigger aria-label={u("conversationActions")} />}>
            <MenuItem
              disabled={readOnly || busy}
              onClick={() => {
                setDraft(snapshot?.conversation.title ?? "");
                setDialog("rename");
              }}
            >
              {t("rename")}
            </MenuItem>
            <MenuItem
              theme="danger"
              disabled={readOnly || busy || Boolean(active)}
              onClick={() => setDialog("delete")}
            >
              {t("remove")}
            </MenuItem>
          </Menu>
        )}
      </Flex>
    </Flex>
  );
  return (
    <RevisionComposerContext.Provider
      value={
        id
          ? {
              conversationId: id,
              disabled:
                readOnly ||
                busy ||
                revisionReferences.length >= MAX_REVISION_REFERENCES,
              add: (reference) => {
                if (
                  current.current !== id ||
                  readOnly ||
                  busy ||
                  revisionReferences.length >= MAX_REVISION_REFERENCES
                )
                  return false;
                setRevisionReferences((refs) =>
                  refs.some(
                    (r) =>
                      JSON.stringify(referenceInput(r)) ===
                      JSON.stringify(referenceInput(reference)),
                  )
                    ? refs
                    : [...refs, reference].slice(0, MAX_REVISION_REFERENCES),
                );
                const focusComposer = () => {
                  if (compactWorkspace) setPanelOpen(false);
                  requestAnimationFrame(() => {
                    if (mounted.current && current.current === id)
                      promptControl.current?.focus({ preventScroll: true });
                  });
                };
                if (panelOpen && compactWorkspace && fileGuard.current)
                  navigation.navigate(focusComposer, fileGuard.current);
                else focusComposer();
                return true;
              },
            }
          : null
      }
    >
      <div
        onKeyDownCapture={(e) => {
          if (e.key === "Tab") setKeyboardMode(true);
        }}
        onPointerMove={() => setKeyboardMode(false)}
        className={
          "conversation-layout" +
          (panelOpen ? " conversation-layout_panel" : "")
        }
      >
        <div
          className="chat-workspace"
          inert={(panelOpen || infoOpen) && compactWorkspace}
        >
          {headerHost ? (
            <Portal container={headerHost}>{toolbar}</Portal>
          ) : (
            toolbar
          )}
          {capabilities.error && (
            <Alert
              theme="warning"
              message={
                locale === "ru"
                  ? "Не удалось обновить доступность функций. Новые действия проверяются сервером."
                  : "Could not refresh feature availability. New actions are checked by the server."
              }
            />
          )}
          {codeEnabled && !executionEnabled && (
            <Alert
              theme="info"
              message={
                locale === "ru"
                  ? "Серверная среда выполнения не настроена. Чат и HTTP MCP доступны; для локальных команд выберите папку в десктопном клиенте."
                  : "No server execution environment is configured. Chat and HTTP MCP remain available; choose a folder in the desktop client for local commands."
              }
            />
          )}
          {readOnly && <Alert theme="info" message={rt("readOnly")} />}
          {error && (
            <Alert
              theme="danger"
              onClose={() => setError("")}
              message={
                [
                  "FILE_UNAVAILABLE",
                  "FILE_NOT_READABLE",
                  "ATTACHMENT_LIMIT",
                ].includes(error)
                  ? rt(error)
                  : ["CONTEXT_LIMIT", "EXTENSION_CONTEXT_LIMIT"].includes(
                        error,
                      ) && contextError
                    ? contextError
                    : t(error)
              }
            />
          )}
          {defaultsQuery.isError && !initialChat && (
            <Alert
              theme="warning"
              message={
                locale === "ru"
                  ? "Не удалось загрузить модель по умолчанию. Повторите загрузку или выберите модель вручную."
                  : "Could not load your default model. Retry or choose a model manually."
              }
              actions={
                <Button onClick={() => void defaultsQuery.refetch()}>
                  {locale === "ru" ? "Повторить" : "Retry"}
                </Button>
              }
            />
          )}
          {modelsQuery.isError && (
            <Alert
              theme="warning"
              message={
                locale === "ru"
                  ? "Не удалось обновить каталог моделей."
                  : "Could not refresh the model catalog."
              }
              actions={
                <Button onClick={() => void modelsQuery.refetch()}>
                  {locale === "ru" ? "Повторить" : "Retry"}
                </Button>
              }
            />
          )}
          {!modelsQuery.isPending && selected && !modelAvailable && (
            <Alert
              theme="warning"
              message={
                locale === "ru"
                  ? "Выбранная модель отключена или недоступна. Выберите замену в меню модели; ваш текст сохранён."
                  : "The selected model is disabled or unavailable. Choose a replacement; your draft is preserved."
              }
            />
          )}
          {approvalMode === "arbiter" && effectiveApprovalMode === "ask" && (
            <Alert
              theme="info"
              message={
                locale === "ru"
                  ? "Арбитр отключён администратором. Действия будут запрашивать ваше подтверждение."
                  : "The administrator disabled the reviewer. Actions will require your approval."
              }
            />
          )}
          {approvalUnavailable && permissionOptions.isError && (
            <Alert
              theme="warning"
              message={
                locale === "ru"
                  ? "Не удалось проверить доступность арбитра."
                  : "Could not verify reviewer availability."
              }
              actions={
                <Button onClick={() => void permissionOptions.refetch()}>
                  {locale === "ru" ? "Повторить" : "Retry"}
                </Button>
              }
            />
          )}
          {reconnecting && <Alert theme="info" message={t("reconnecting")} />}
          {!loading &&
            !modelsQuery.isPending &&
            !modelsQuery.isError &&
            !models.length && (
              <Alert
                theme="info"
                message={
                  <>
                    {t("noModels")}{" "}
                    {onConfigure && (
                      <Button onClick={onConfigure}>{t("configure")}</Button>
                    )}
                  </>
                }
              />
            )}
          {lastRun?.error_code && !lastRun.dismissed && (
            <Alert
              theme={lastRun.status === "failed" ? "danger" : "warning"}
              message={t(lastRun.error_code)}
              onClose={() =>
                void action(async () => {
                  await api.request(
                    "/runs/" + lastRun.id + "/dismiss-error",
                    "POST",
                  );
                  if (id) await load(id);
                })
              }
            />
          )}
          {lastRun &&
            !lastRun.dismissed &&
            ["failed", "cancelled"].includes(lastRun.status) && (
              <Flex gap="spacing-2" alignItems="center" wrap="wrap">
                {lastRun.status === "cancelled" && (
                  <Text color="secondary">{t("RUN_CANCELLED")}</Text>
                )}
                <Button
                  disabled={readOnly || busy || Boolean(active) || !selected}
                  onClick={() => void send("", lastRun.user_message_id)}
                >
                  {t("retry")}
                </Button>
              </Flex>
            )}
          {source && id && (
            <SourceEvidence
              key={source.message + source.ordinal}
              api={api}
              conversation={id}
              locale={locale}
              source={source}
              onClose={closeSource}
            />
          )}
          <Box
            flex="1"
            minHeight="0"
            className="conversation-history"
            paddingInline={{ xs: "spacing-3", m: "spacing-6" }}
          >
            {loading ? (
              <LoadingPanel label={t("loading")} />
            ) : !snapshot?.conversation.head_id ? (
              <Flex
                direction="column"
                alignItems="center"
                justifyContent="center"
                height="100%"
                padding="spacing-6"
                gap="spacing-3"
              >
                <Text as="h1" variant="display-1">
                  {locale === "ru"
                    ? "С чего начнём?"
                    : "What shall we work on?"}
                </Text>
                <Text color="secondary">
                  {scopeProject
                    ? projects.find((p) => p.id === scopeProject)?.name
                    : t("emptyHint")}
                </Text>
              </Flex>
            ) : (
              <ChatHistory
                api={api}
                snapshot={snapshot!}
                locale={locale}
                readOnly={readOnly}
                busy={busy}
                canRetry={Boolean(selected)}
                keyboardMode={keyboardMode}
                targetLabel={targetLabel}
                onFork={historyFork}
                onVersion={historyVersion}
                onEdit={historyEdit}
                onRetry={historyRetry}
                onSource={historySource}
                onError={historyError}
              />
            )}
          </Box>
          <Box
            className="conversation-composer"
            paddingInline={{ xs: "spacing-3", m: "spacing-6" }}
            paddingBlockEnd="spacing-3"
            width="100%"
            maxWidth="54rem"
            marginInline="auto"
          >
            {(active ?? lastRun) && (
              <RunStatusStrip
                key={"status-" + (active ?? lastRun)!.id}
                run={(active ?? lastRun)!}
                api={api}
                locale={locale}
                targetLabel={targetLabel}
              />
            )}
            {(active ?? lastRun)?.mode === "code" && (
              <RunPlanPanel
                key={"plan-" + (active ?? lastRun)!.id}
                api={api}
                run={(active ?? lastRun)!}
                locale={locale}
                editable={!readOnly}
                disabled={
                  busy ||
                  Boolean(active) ||
                  !modelAvailable ||
                  approvalUnavailable
                }
                onExecute={
                  snapshot?.conversation.head_id ===
                    (active ?? lastRun)?.assistant_message_id && !readOnly
                    ? (plan) =>
                        send(
                          locale === "ru"
                            ? "Приступить к выполнению плана"
                            : "Start implementation",
                          undefined,
                          undefined,
                          {
                            preserveDraft: true,
                            planAcceptance: {
                              runId: plan.runId,
                              version: plan.version,
                            },
                          },
                        )
                    : undefined
                }
              />
            )}
            <ContextMeter
              key={(active ?? lastRun)?.id ?? "empty"}
              run={active ?? lastRun}
              locale={locale}
              sameModel={Boolean(
                (active ?? lastRun) &&
                  selectedModel?.id === (active ?? lastRun)?.model &&
                  selectedModel?.providerId ===
                    (active ?? lastRun)?.provider_id,
              )}
              disabled={readOnly || busy || !modelAvailable}
              onCompact={
                id
                  ? () => {
                      void send("/compaction", undefined, undefined, {
                        preserveDraft: true,
                      });
                    }
                  : undefined
              }
            />
            {id && (
              <ConversationQueuePanel
                key={id}
                api={api}
                id={id}
                locale={locale}
                readOnly={readOnly}
                queue={queue}
                submission={queueSubmission}
                selection={modelAvailable ? queueSelection : undefined}
              />
            )}
            <Card view="outlined" padding="spacing-3">
              <Flex direction="column" gap="spacing-3">
                {executionEnabled && (
                  <Checkbox
                    checked={planning}
                    onUpdate={setPlanning}
                    disabled={busy || readOnly}
                    content={
                      locale === "ru"
                        ? "Сначала составить план"
                        : "Plan before implementing"
                    }
                  />
                )}
                {codeEnabled && (
                  <Flex>
                    <Menu
                      trigger={
                        <Button
                          view="flat"
                          disabled={busy || Boolean(active) || readOnly}
                          aria-label={
                            (locale === "ru" ? "Работать в: " : "Work in: ") +
                            targetLabel
                          }
                        >
                          <span
                            className="agent-target-label"
                            title={targetLabel}
                          >
                            {(locale === "ru" ? "Работать в: " : "Work in: ") +
                              targetLabel}
                          </span>
                          <Icon data={ChevronDown} />
                        </Button>
                      }
                    >
                      <Menu.Item
                        selected={!localTarget}
                        disabled={
                          Boolean(snapshot?.runs.length) || Boolean(active)
                        }
                        onClick={() => void chooseTarget(false)}
                      >
                        {locale === "ru" ? "Сервер Runóza" : "Runóza server"}
                      </Menu.Item>
                      {window.runozaDesktop && (
                        <Menu.Item
                          selected={localTarget}
                          disabled={
                            Boolean(snapshot?.runs.length) || Boolean(active)
                          }
                          onClick={() => void chooseTarget(true)}
                        >
                          {locale === "ru"
                            ? "Локально · выбрать папку…"
                            : "Local · choose folder…"}
                        </Menu.Item>
                      )}
                      {localTarget && !window.runozaDesktop && (
                        <Menu.Item selected disabled>
                          {targetLabel}
                        </Menu.Item>
                      )}
                      {Boolean(snapshot?.runs.length) && (
                        <Menu.Item disabled>
                          {locale === "ru"
                            ? "Для другого места создайте новую беседу"
                            : "Start a new conversation to change location"}
                        </Menu.Item>
                      )}
                      <Menu.Divider />
                      <Menu.Item onClick={() => void openWorkspace()}>
                        {locale === "ru"
                          ? "Открыть рабочую область"
                          : "Open workspace"}
                      </Menu.Item>
                    </Menu>
                  </Flex>
                )}
                {searchProject && scopeProject && (
                  <Flex alignItems="center" gap="spacing-2" wrap="wrap">
                    <Button
                      size="s"
                      view="outlined"
                      onClick={() => setSearchProject(false)}
                      aria-label={
                        locale === "ru"
                          ? "Убрать поиск по проекту"
                          : "Remove project search"
                      }
                    >
                      {locale === "ru" ? "Поиск" : "Search"} ·{" "}
                      {projects.find((p) => p.id === scopeProject)?.name ??
                        (locale === "ru" ? "Проект" : "Project")}{" "}
                      <Icon data={Xmark} />
                    </Button>
                    {Boolean(collectionQuery.data?.length || collectionId) && (
                      <Select
                        size="s"
                        aria-label={
                          locale === "ru" ? "Область поиска" : "Search scope"
                        }
                        value={[collectionId || "all"]}
                        onUpdate={(v) =>
                          setCollection(v[0] === "all" ? "" : (v[0] ?? ""))
                        }
                        options={[
                          {
                            value: "all",
                            content:
                              locale === "ru"
                                ? "Все файлы проекта"
                                : "All project files",
                          },
                          ...(collectionQuery.data ?? []).map((c) => ({
                            value: c.id,
                            content: c.name,
                          })),
                        ]}
                      />
                    )}
                    {attachmentQuery.data &&
                      attachmentQuery.data.length < 200 &&
                      !attachmentQuery.data.some((f) => f.searchable) && (
                        <Text color="secondary">
                          {locale === "ru"
                            ? "Для поиска включите файл через меню «Проект → Файлы»."
                            : "Make a file searchable in Project → Files first."}
                        </Text>
                      )}
                  </Flex>
                )}
                {fileIds.length > 0 && (
                  <Flex
                    gap="spacing-2"
                    wrap="wrap"
                    className="composer-attachments"
                  >
                    {fileIds.map((fileId) => {
                      const f = attachmentQuery.data?.find(
                        (f) => f.id === fileId,
                      );
                      return (
                        <FilePreview
                          key={fileId}
                          file={
                            new File(
                              [],
                              f?.name ??
                                (locale === "ru" ? "Вложение" : "Attachment"),
                              { type: f?.mediaType },
                            )
                          }
                          description={
                            f
                              ? new Intl.NumberFormat(locale).format(f.size) +
                                " B"
                              : undefined
                          }
                          actions={[
                            {
                              id: "remove",
                              icon: <Icon data={Xmark} />,
                              title:
                                locale === "ru"
                                  ? "Убрать вложение"
                                  : "Remove attachment",
                              disabled: busy || Boolean(active),
                              onClick: () =>
                                setFileIds((ids) =>
                                  ids.filter((id) => id !== fileId),
                                ),
                            },
                          ]}
                        />
                      );
                    })}
                  </Flex>
                )}
                {active?.compaction_state &&
                  ["pending", "running"].includes(active.compaction_state) && (
                    <Alert
                      theme="info"
                      message={
                        locale === "ru"
                          ? active.compaction_state === "pending"
                            ? "Сжатие запланировано после текущего шага."
                            : "Сжимаю контекст. История и результаты инструментов сохраняются."
                          : active.compaction_state === "pending"
                            ? "Compaction queued after the current step."
                            : "Compacting context. History and tool results are preserved."
                      }
                    />
                  )}
                <SkillCommandList commands={commands} locale={locale} />
                {skillVersionIds.length > 0 && (
                  <Flex gap="spacing-1" wrap="wrap">
                    {skillVersionIds.map((id) => (
                      <Button
                        key={id}
                        view="outlined"
                        size="s"
                        disabled={busy || readOnly}
                        onClick={() =>
                          setSkillVersionIds((ids) =>
                            ids.filter((x) => x !== id),
                          )
                        }
                      >
                        {commands.catalog.data?.extensions.find(
                          (x) => x.versionId === id,
                        )?.name ?? (locale === "ru" ? "Скилл" : "Skill")}{" "}
                        <Icon data={Xmark} size={12} />
                      </Button>
                    ))}
                  </Flex>
                )}
                {mcpConnectionIds.length > 0 && (
                  <Flex gap="spacing-1" wrap="wrap">
                    {mcpConnectionIds.map((connectionId) => (
                      <Button
                        key={connectionId}
                        view="outlined"
                        size="s"
                        disabled={busy || readOnly}
                        aria-label={
                          (locale === "ru"
                            ? "Убрать ссылку MCP: "
                            : "Remove MCP reference: ") +
                          (commands.catalog.data?.extensions.find(
                            (x) => x.kind === "mcp" && x.id === connectionId,
                          )?.name ?? connectionId)
                        }
                        onClick={() =>
                          setMcpConnectionIds((ids) =>
                            ids.filter((id) => id !== connectionId),
                          )
                        }
                      >
                        MCP ·{" "}
                        {commands.catalog.data?.extensions.find(
                          (x) => x.kind === "mcp" && x.id === connectionId,
                        )?.name ??
                          (locale === "ru" ? "Подключение" : "Connection")}
                        <Icon data={Xmark} size={12} />
                      </Button>
                    ))}
                  </Flex>
                )}
                {revisionReferences.length > 0 && (
                  <ReferenceChips
                    references={revisionReferences}
                    locale={locale}
                    disabled={busy || readOnly}
                    remove={(index) =>
                      setRevisionReferences((refs) =>
                        refs.filter((_, i) => i !== index),
                      )
                    }
                  />
                )}
                <TextArea
                  controlRef={promptControl}
                  value={prompt}
                  onUpdate={setPrompt}
                  placeholder={t("prompt")}
                  minRows={2}
                  maxRows={8}
                  view="clear"
                  disabled={readOnly || busy || !selected}
                  controlProps={{
                    ...commands.inputProps,
                    "aria-label": t("prompt"),
                    maxLength: 32000,
                  }}
                  onKeyDown={(e) => {
                    if (commands.onKeyDown(e)) return;
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      if (prompt.trim()) void send(prompt);
                    }
                  }}
                />
                <Flex
                  className="agent-composer-toolbar"
                  gap="spacing-2"
                  alignItems="flex-end"
                  justifyContent="space-between"
                  minWidth="0"
                >
                  <Flex
                    className="agent-composer-controls"
                    gap="spacing-2"
                    alignItems="center"
                    minWidth="0"
                    wrap="wrap"
                  >
                    <ComposerAddMenu
                      locale={locale}
                      onSearchProject={
                        scopeProject &&
                        capabilities.flags.projectSearch !== false &&
                        !searchProject
                          ? () => {
                              setCollection("");
                              setSearchProject(true);
                            }
                          : undefined
                      }
                      attachmentCount={fileIds.length}
                      disabled={readOnly || busy}
                      onChoose={(item) => {
                        if (item === "attachments") {
                          setAttachmentDraft(fileIds);
                          setShowFiles(true);
                        } else setExtensionKind(item);
                      }}
                    />
                    <Select
                      aria-label={t("model")}
                      value={selected ? [selected] : []}
                      filterable
                      filterPlaceholder={
                        locale === "ru" ? "Найти модель…" : "Find a model…"
                      }
                      popupWidth={320}
                      popupClassName="model-picker-popup"
                      options={[
                        ...new Set(models.map((m) => m.group || "Other")),
                      ]
                        .sort()
                        .map((group) => ({
                          label:
                            group === "Other" && locale === "ru"
                              ? "Другие"
                              : group,
                          options: models
                            .filter(
                              (m) =>
                                (m.group || "Other") === group &&
                                (!providerFilter ||
                                  m.providerId === providerFilter),
                            )
                            .map((m) => ({
                              value: JSON.stringify([m.providerId, m.id]),
                              content: m.name || m.id,
                              data: m,
                            })),
                        }))
                        .filter((g) => g.options.length)}
                      renderPopup={({ renderFilter, renderList }) => (
                        <Flex
                          direction="column"
                          className="model-picker-content"
                        >
                          <Flex
                            className="model-provider-filters"
                            padding="spacing-2"
                            gap="spacing-1"
                          >
                            <Button
                              size="s"
                              view={providerFilter ? "flat" : "outlined"}
                              onClick={() => setProviderFilter("")}
                            >
                              {locale === "ru" ? "Все" : "All"}
                            </Button>
                            {[
                              ...new Map(
                                models.map((m) => [m.providerId, m] as const),
                              ).entries(),
                            ].map(([provider, model]) => (
                              <Button
                                key={provider}
                                size="s"
                                view={
                                  providerFilter === provider
                                    ? "outlined"
                                    : "flat"
                                }
                                onClick={() => setProviderFilter(provider)}
                              >
                                {model.providerName}
                              </Button>
                            ))}
                          </Flex>
                          {renderFilter()}
                          {renderList()}
                        </Flex>
                      )}
                      onUpdate={(v) => {
                        setSelected(v[0] ?? "");
                        setReasoning("default");
                        if (v[0]) {
                          const [providerId, model] = JSON.parse(v[0]);
                          persistChoice({
                            providerId,
                            model,
                            reasoning: "default",
                          });
                        }
                      }}
                      filterOption={(option, filter) => {
                        const model = option.data;
                        return [
                          option.content,
                          model?.id,
                          model?.providerName,
                          ...modelSummary(model?.reference, locale),
                        ]
                          .join(" ")
                          .toLocaleLowerCase(locale)
                          .includes(filter.trim().toLocaleLowerCase(locale));
                      }}
                      getOptionHeight={() => 52}
                      renderOption={(option) => (
                        <Flex alignItems="center" gap="spacing-2" minWidth="0">
                          <ModelLogo
                            brand={option.data?.reference?.modelBrand}
                            fallback={option.data?.providerBrand}
                          />
                          <Flex direction="column" minWidth="0">
                            <Text ellipsis>{option.content}</Text>
                            <Text
                              ellipsis
                              variant="caption-2"
                              color="secondary"
                            >
                              {[
                                option.data?.providerName,
                                ...modelSummary(option.data?.reference, locale),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </Text>
                          </Flex>
                        </Flex>
                      )}
                      renderControl={({ triggerProps, ref }) => (
                        <Button
                          {...triggerProps}
                          ref={ref as Ref<HTMLButtonElement>}
                          view="flat"
                          className="model-trigger"
                        >
                          <span className="model-trigger-label">
                            {selectedModel?.name ||
                              selectedModel?.id ||
                              t("model")}
                          </span>
                          <Icon data={ChevronDown} size={12} />
                        </Button>
                      )}
                    />
                    <ReasoningControl
                      profile={selectedModel?.reasoning}
                      value={reasoning}
                      onChange={(value) => {
                        setReasoning(value);
                        persistChoice({ reasoning: value });
                      }}
                      locale={locale}
                      disabled={busy || readOnly}
                    />
                    {(codeEnabled || capabilities.flags.mcp === true) && (
                      <Select
                        aria-label={
                          locale === "ru"
                            ? "Подтверждение действий"
                            : "Action approval"
                        }
                        value={[active?.approval_mode ?? effectiveApprovalMode]}
                        disabled={
                          busy ||
                          Boolean(active) ||
                          readOnly ||
                          Boolean(id && snapshot?.conversation.id !== id)
                        }
                        options={[
                          {
                            value: "ask",
                            content: locale === "ru" ? "Спрашивать" : "Ask me",
                          },
                          ...(permissionOptions.data?.arbiterEnabled
                            ? [
                                {
                                  value: "arbiter",
                                  content:
                                    locale === "ru"
                                      ? "Подтверждать за меня"
                                      : "Approve for me",
                                },
                              ]
                            : []),
                          { value: "full", content: fullAccessLabel },
                        ]}
                        onUpdate={(v) => {
                          if (v[0] === "full") {
                            if (approvalMode !== "full")
                              setConfirmFullAccess(true);
                            return;
                          }
                          const value = v[0] === "arbiter" ? "arbiter" : "ask";
                          chooseApproval(value);
                        }}
                        renderOption={(option) =>
                          option.value === "full" ? (
                            <Text color="danger">{option.content}</Text>
                          ) : (
                            <Text>{option.content}</Text>
                          )
                        }
                        renderSelectedOptions={(options) =>
                          options[0]?.value === "full" ? (
                            <Text color="danger">{fullAccessLabel}</Text>
                          ) : (
                            options[0]?.content
                          )
                        }
                      />
                    )}
                  </Flex>
                  {active && !isCompactionPrompt && (
                    <Button
                      view="action"
                      size="l"
                      disabled={
                        readOnly ||
                        busy ||
                        !modelAvailable ||
                        approvalUnavailable ||
                        !prompt.trim() ||
                        Boolean(queueSubmission.pending)
                      }
                      loading={Boolean(
                        queueSubmission.pending &&
                          !queueSubmission.pending.uncertain,
                      )}
                      onClick={() => void enqueueDraft(prompt)}
                    >
                      {queueLabel}
                    </Button>
                  )}
                  <Tooltip
                    content={
                      active ? t("stop") : queueWaiting ? queueLabel : t("send")
                    }
                  >
                    <Button
                      className="agent-composer-submit"
                      view="action"
                      size="l"
                      aria-label={
                        active && !isCompactionPrompt
                          ? t("stop")
                          : queueWaiting
                            ? queueLabel
                            : t("send")
                      }
                      disabled={
                        readOnly ||
                        busy ||
                        (!active &&
                          (Boolean(queueSubmission.pending) ||
                            !modelAvailable ||
                            approvalUnavailable ||
                            !prompt.trim()))
                      }
                      onClick={() => {
                        if (active && !isCompactionPrompt)
                          void action(async () => {
                            await api.request(
                              "/runs/" + active.id + "/cancel",
                              "POST",
                            );
                            if (id) await load(id);
                          });
                        else void send(prompt);
                      }}
                    >
                      <Icon
                        data={
                          active && !isCompactionPrompt ? CircleStop : ArrowUp
                        }
                      />
                    </Button>
                  </Tooltip>
                </Flex>
              </Flex>
            </Card>
            <Flex justifyContent="center" paddingBlockStart="spacing-2">
              <Text variant="caption-2" color="secondary">
                {t("disclaimer")}
              </Text>
              {lastRun?.usage && lastRun.usage.reported !== false && (
                <Tooltip
                  content={t("tokens") + ": " + lastRun.usage.totalTokens}
                >
                  <Text variant="caption-2" color="secondary">
                    {" "}
                    · {lastRun.usage.totalTokens}
                  </Text>
                </Tooltip>
              )}
            </Flex>
          </Box>
          <ExtensionPicker
            api={api}
            locale={locale}
            projectId={scopeProject}
            conversationId={id ?? initialChat}
            workspace={codeEnabled}
            disabled={readOnly}
            onTry={(item, example) => {
              if (item.kind === "skill" && item.versionId)
                setSkillVersionIds((ids) => [
                  ...new Set([...ids, item.versionId!]),
                ]);
              if (item.kind === "mcp")
                setMcpConnectionIds((ids) => [...new Set([...ids, item.id])]);
              setPrompt((text) =>
                text.trim() ? text + "\n\n" + example : example,
              );
              requestAnimationFrame(() => promptControl.current?.focus());
            }}
            selection={{
              kind: extensionKind,
              onClose: () => setExtensionKind(null),
            }}
          />
          <Dialog
            open={confirmFullAccess}
            onOpenChange={setConfirmFullAccess}
            maxWidth="s"
          >
            <Dialog.Header caption={fullAccessLabel} />
            <Dialog.Body>
              <Alert
                theme="warning"
                message={
                  locale === "ru"
                    ? "Режим сохранится для этой беседы, пока вы его не переключите. Агент сможет выполнять команды и вызывать доступные инструменты без подтверждения. В локальной рабочей области команды выполняются на вашем компьютере."
                    : "This mode stays on for this conversation until you change it. The agent can execute commands and invoke available tools without confirmation. In a local workspace, commands run on your computer."
                }
              />
            </Dialog.Body>
            <Dialog.Footer
              textButtonCancel={locale === "ru" ? "Отмена" : "Cancel"}
              textButtonApply={
                locale === "ru"
                  ? "Включить для беседы"
                  : "Enable for this conversation"
              }
              propsButtonApply={{ disabled: busy }}
              onClickButtonCancel={() => setConfirmFullAccess(false)}
              onClickButtonApply={() => chooseApproval("full")}
            />
          </Dialog>
          <Dialog open={showFiles} maxWidth="l" onOpenChange={setShowFiles}>
            <Dialog.Header caption={rt("attachments")} />
            <Dialog.Body>
              {(!id || snapshot) && (
                <FilesPanel
                  key={scopeProject + ":" + (id ?? "new")}
                  api={api}
                  locale={locale}
                  onExpired={onExpired}
                  projectId={scopeProject}
                  readOnly={readOnly}
                  selected={attachmentDraft}
                  onSelect={setAttachmentDraft}
                />
              )}
            </Dialog.Body>
            <Dialog.Footer
              textButtonCancel={rt("cancel")}
              textButtonApply={
                u("choose") +
                (attachmentDraft.length ? ` (${attachmentDraft.length})` : "")
              }
              onClickButtonCancel={() => setShowFiles(false)}
              onClickButtonApply={() => {
                setFileIds(attachmentDraft);
                setShowFiles(false);
              }}
            />
          </Dialog>
          <Dialog
            open={dialog !== null}
            onOpenChange={(open) => {
              if (!open) setDialog(null);
            }}
          >
            <Dialog.Header
              caption={t(
                dialog === "rename"
                  ? "rename"
                  : dialog === "delete"
                    ? "remove"
                    : "branch",
              )}
            />
            <Dialog.Body>
              {error && <Alert theme="danger" message={t(error)} />}
              {dialog === "delete" ? (
                <Text>{t("removeHint")}</Text>
              ) : dialog === "edit" ? (
                <div className="stack">
                  <Text>{t("branchHint")}</Text>
                  <TextArea
                    minRows={5}
                    aria-label={t("prompt")}
                    value={draft}
                    onUpdate={setDraft}
                    controlProps={{ maxLength: 32000 }}
                  />
                </div>
              ) : (
                <TextInput
                  aria-label={t("title")}
                  value={draft}
                  onUpdate={setDraft}
                  controlProps={{ maxLength: 200 }}
                />
              )}
            </Dialog.Body>
            <Dialog.Footer
              textButtonCancel={t("cancel")}
              textButtonApply={t(dialog === "delete" ? "remove" : "save")}
              loading={busy}
              propsButtonApply={{
                disabled: dialog !== "delete" && !draft.trim(),
              }}
              onClickButtonCancel={() => setDialog(null)}
              onClickButtonApply={() => {
                if (dialog === "edit") {
                  void send(draft, undefined, editing?.parent_id ?? null).then(
                    (v) => {
                      if (v !== false) setDialog(null);
                    },
                  );
                } else
                  void action(async () => {
                    if (!id) return;
                    if (dialog === "delete") {
                      await api.request("/conversations/" + id, "DELETE");
                      setId(null);
                      setSnapshot(null);
                      selectConversation(null);
                    } else {
                      await api.request("/conversations/" + id, "PATCH", {
                        title: draft,
                      });
                      await load(id);
                    }
                    await list();
                    setDialog(null);
                  });
              }}
            />
          </Dialog>
        </div>
        {infoOpen && (
          <ConversationInfo
            snapshot={snapshot}
            selectedModel={selectedModel}
            locale={locale}
            onClose={() => {
              setInfoOpen(false);
              infoTrigger.current?.focus();
            }}
          />
        )}
        {panelOpen && id && (
          <CodeWorkspace
            key={id}
            api={api}
            conversationId={id}
            guardKeyRef={fileGuard}
            reviewRun={lastRun?.mode === "code" ? lastRun : undefined}
            locale={locale}
            onClose={() => {
              setPanelOpen(false);
              panelTrigger.current?.focus();
            }}
          />
        )}
      </div>
    </RevisionComposerContext.Provider>
  );
}
