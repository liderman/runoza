import {
  CapabilitiesContext,
  type CapabilityResponse,
} from "./capabilities.tsx";
import { PermissionSettings, PermissionGrants } from "./PermissionSettings.tsx";
import {
  RouterProvider,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  createAppRouter,
  parseDestination,
  destinationPath,
  RouteDirtyGuard,
  type AppDestination,
} from "./navigation.tsx";
import { useScopedDataClient, AppDataProvider } from "./data-client.tsx";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Schedules } from "./Schedules.tsx";
import { ExtensionsHub } from "./ExtensionsHub.tsx";
import { BrandLogo } from "./BrandLogo.tsx";
import { AssistantSettings } from "./AssistantSettings.tsx";
import { ModelSettings } from "./ModelSettings.tsx";
import { DesktopConnect, DesktopDevices } from "./DesktopConnect.tsx";
import { UserAccessEditor } from "./UserAccessEditor.tsx";
import { SettingsLayout } from "./SettingsLayout.tsx";
import {
  NavigationGuard,
  useNavigationGuard,
  useDirtyGuard,
  UnsavedDialog,
} from "./NavigationGuard.tsx";
import { AppShell } from "./AppShell.tsx";
import { FormLocaleContext } from "@runoza/ui";
import { uxText } from "./ux-locales.ts";
import { Resources } from "./Resources.tsx";
import { resourceText } from "./resource-locales.ts";
import {
  useEffect,
  useState,
  useRef,
  lazy,
  Suspense,
  type FormEvent,
} from "react";
import {
  Provider,
  configure,
  Button,
  Flex,
  Text,
  Alert,
  Select,
  Checkbox,
  Switch,
  HelpMark,
  Box,
  Dialog,
} from "@gravity-ui/uikit";
import { Field, Panel } from "@runoza/ui";
import type { PlatformAdapter } from "@runoza/platform";
import { IdentityApiError, type IdentityClient } from "@runoza/api-client";
import type { SessionView, Conversation, ProjectView } from "@runoza/contracts";
import { translator, type Locale } from "./locales.ts";
const ChatWorkspace = lazy(() =>
  import("./ChatWorkspace.tsx").then((m) => ({ default: m.ChatWorkspace })),
);
import { ProviderSettings } from "./ProviderSettings.tsx";
import { chatText } from "./chat-locales.ts";
interface User {
  id: string;
  email: string;
  name: string;
  role: "org_admin" | "member";
  systemAdmin: boolean;
  disabled: boolean;
}
interface Session {
  id: string;
  created_at: string;
  expires_at: string;
}
interface Oidc {
  issuer: string;
  clientId: string;
  enabled: boolean;
  allowSignup: boolean;
  hasSecret?: boolean;
}
export function RunozaApp(props: {
  api: IdentityClient;
  platform: PlatformAdapter;
  initialError?: string;
}) {
  const [router] = useState(() =>
    createAppRouter(() => <RunozaAppContent {...props} />),
  );
  return (
    <NavigationGuard>
      <RouterProvider router={router} />
    </NavigationGuard>
  );
}
function RunozaAppContent({
  api,
  platform,
  initialError = "",
}: {
  api: IdentityClient;
  platform: PlatformAdapter;
  initialError?: string;
}) {
  const router = useRouter();
  const routeHref = useRouterState({ select: (state) => state.location.href });
  const destination = parseDestination(routeHref);
  const tab = destination.page,
    chatId = destination.chatId ?? null,
    resourceProject = destination.projectId ?? "",
    settingsSection =
      destination.section ??
      (destination.page === "admin" ? "users" : "profile");
  const writeDestination = (destination: AppDestination, replace = false) => {
    const path = destinationPath(destination);
    if (path !== router.state.location.href)
      void router.navigate({ to: path, replace });
  };
  const [locale, setLocale] = useState<Locale>(
    (
      platform.readPreference("locale") ?? platform.preferredLanguage
    ).startsWith("ru")
      ? "ru"
      : "en",
  );
  function applyLocale(value: Locale) {
    // Gravity components with built-in labels read global language while rendering.
    configure({ lang: value });
    setLocale(value);
  }
  const [theme, setTheme] = useState<"light" | "dark">(
    platform.readPreference("theme") === "light" ? "light" : "dark",
  );
  const [session, setSession] = useState<SessionView | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initialError),
    [navigationError, setNavigationError] = useState(""),
    [notice, setNotice] = useState("");
  const [options, setOptions] = useState({
    bootstrapRequired: false,
    ssoEnabled: false,
  });
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [org, setOrg] = useState(""),
    [setup, setSetup] = useState("");
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [sessions, setSessions] = useState<Session[]>([]);
  const [newEmail, setNewEmail] = useState(""),
    [newName, setNewName] = useState(""),
    [newPass, setNewPass] = useState(""),
    [newRole, setNewRole] = useState<"member" | "org_admin">("member");
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [oidcDefaults, setOidcDefaults] = useState<{
    oidc: Oidc;
    secret: string;
  }>({
    oidc: { issuer: "", clientId: "", enabled: false, allowSignup: false },
    secret: "",
  });
  const oidcForm = useForm({ defaultValues: oidcDefaults });
  const oidc = useStore(oidcForm.store, (state) => state.values.oidc);
  const secret = useStore(oidcForm.store, (state) => state.values.secret);
  const oidcAtBaseline = useStore(
    oidcForm.store,
    (state) => state.isDefaultValue,
  );
  const setOidc = (value: Oidc) => oidcForm.setFieldValue("oidc", value);
  const setSecret = (value: string) => oidcForm.setFieldValue("secret", value);
  const guard = useNavigationGuard();
  const dataScope = session
    ? `${session.user.organizationId}:${session.user.id}`
    : "anonymous";
  const activeDataScope = useRef(dataScope);
  activeDataScope.current = dataScope;
  const dataClient = useScopedDataClient(dataScope);
  const capabilities = useQuery(
    {
      queryKey: [dataScope, "capabilities"],
      enabled: !!session,
      queryFn: ({ signal }) =>
        api.request<CapabilityResponse>("/features", "GET", undefined, {
          signal,
        }),
      refetchInterval: 5000,
      refetchOnWindowFocus: true,
    },
    dataClient,
  );
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await api.events(
            "/features/events",
            0,
            () => {
              void dataClient.invalidateQueries({
                queryKey: [dataScope, "capabilities"],
              });
            },
            controller.signal,
          );
        } catch {}
        if (controller.signal.aborted) break;
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 5000);
          controller.signal.addEventListener("abort", finish, { once: true });
        });
      }
    })();
    return () => controller.abort();
  }, [dataScope, dataClient, api, Boolean(session)]);
  useEffect(() => {
    if (
      capabilities.data &&
      (savedFlags === "{}" || JSON.stringify(flags) === savedFlags)
    ) {
      setFlags(capabilities.data.flags);
      setSavedFlags(JSON.stringify(capabilities.data.flags));
    }
  }, [capabilities.data]);
  const unreadTasksQuery = useQuery(
    {
      queryKey: [dataScope, "schedules", "unread"],
      enabled: Boolean(session && capabilities.data?.flags.schedules),
      queryFn: ({ signal }) =>
        api.request<{ count: number }>("/schedules/unread", "GET", undefined, {
          signal,
        }),
      refetchInterval: 10000,
    },
    dataClient,
  );
  const adminQueriesEnabled =
    tab === "admin" &&
    !!session &&
    (session.user.systemAdmin || session.user.role === "org_admin");
  const usersQuery = useQuery(
    {
      queryKey: [dataScope, "admin", "users"],
      enabled: adminQueriesEnabled,
      queryFn: ({ signal }) =>
        api.request<{ users: User[] }>("/admin/users", "GET", undefined, {
          signal,
        }),
    },
    dataClient,
  );
  const auditQuery = useQuery(
    {
      queryKey: [dataScope, "admin", "audit"],
      enabled: adminQueriesEnabled,
      queryFn: ({ signal }) =>
        api.request<{
          events: { id: string; event: string; created_at: string }[];
        }>("/admin/audit", "GET", undefined, { signal }),
    },
    dataClient,
  );
  const users = usersQuery.data?.users ?? [];
  const events = auditQuery.data?.events ?? [];
  const chatsQuery = useQuery(
    {
      queryKey: [dataScope, "conversations"],
      enabled: !!session,
      queryFn: async ({ signal }) =>
        (
          await api.request<{ conversations: Conversation[] }>(
            "/conversations",
            "GET",
            undefined,
            { signal },
          )
        ).conversations,
      refetchInterval: 3000,
    },
    dataClient,
  );
  const projectsQuery = useQuery(
    {
      queryKey: [dataScope, "projects"],
      enabled: !!session,
      queryFn: async ({ signal }) =>
        (
          await api.request<{ projects: ProjectView[] }>(
            "/projects",
            "GET",
            undefined,
            { signal },
          )
        ).projects,
      refetchInterval: 3000,
    },
    dataClient,
  );
  const sidebarChats = chatsQuery.data ?? [];
  const sidebarProjects = projectsQuery.data ?? [];
  const setSidebarChats = (value: Conversation[]) => {
    if (activeDataScope.current === dataScope)
      dataClient.setQueryData([dataScope, "conversations"], value);
  };
  const [savedFlags, setSavedFlags] = useState("{}"),
    [savedOidc, setSavedOidc] = useState(
      JSON.stringify({
        issuer: "",
        clientId: "",
        enabled: false,
        allowSignup: false,
      }),
    );
  useEffect(() => {
    const values = {
      oidc: { issuer: "", clientId: "", enabled: false, allowSignup: false },
      secret: "",
    };
    setOidcDefaults(values);
    oidcForm.reset(values);
    setSavedOidc(JSON.stringify(values.oidc));
    setFlags({});
    setSavedFlags("{}");
    setNewName("");
    setNewEmail("");
    setNewPass("");
    setCurrent("");
    setNext("");
  }, [dataScope]);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [addUser, setAddUser] = useState(false);
  const resetDrafts = () => {
    setCurrent("");
    setNext("");
    setNewName("");
    setNewEmail("");
    setNewPass("");
    setNewRole("member");
    setSecret("");
    setAddUser(false);
    if (savedOidc) setOidc(JSON.parse(savedOidc));
    setFlags(JSON.parse(savedFlags));
  };
  useDirtyGuard(
    Boolean(
      current ||
        next ||
        newName ||
        newEmail ||
        newPass ||
        secret ||
        (tab === "admin" &&
          (JSON.stringify(flags) !== savedFlags || !oidcAtBaseline)),
    ),
    resetDrafts,
  );
  async function refreshNavigation() {
    if (activeDataScope.current !== dataScope) return;
    await Promise.all([
      dataClient.invalidateQueries({ queryKey: [dataScope, "conversations"] }),
      dataClient.invalidateQueries({ queryKey: [dataScope, "projects"] }),
    ]);
  }
  useEffect(() => {
    const error = chatsQuery.error ?? projectsQuery.error;
    setNavigationError(
      error ? (error instanceof IdentityApiError ? error.code : "error") : "",
    );
  }, [chatsQuery.error, projectsQuery.error]);
  const openChat = (id: string | null, project?: string) =>
    guard.navigate(() => {
      const projectId =
        project ??
        (tab === "resources"
          ? resourceProject
          : (sidebarChats.find((c) => c.id === (id ?? chatId))?.project_id ??
            destination.projectId ??
            ""));
      writeDestination({ page: "chat", chatId: id, projectId });
    });
  const openProject = (id: string) =>
    guard.navigate(() => {
      writeDestination({ page: "resources", projectId: id });
    });
  const navigate = (page: typeof tab) => {
    if (page !== tab)
      guard.navigate(() => {
        const section = page === "admin" ? "users" : "profile";
        writeDestination({
          page,
          section,
          chatId: page === "chat" ? chatId : null,
        });
      });
  };
  const ct = chatText(locale),
    u = uxText(locale);
  const t = translator(locale),
    admin = Boolean(
      session &&
        (session.user.systemAdmin || session.user.role === "org_admin"),
    );
  useEffect(() => {
    configure({ lang: locale });
    platform.writePreference("locale", locale);
    platform.setLanguage(locale);
  }, [locale]);
  useEffect(() => {
    platform.writePreference("theme", theme);
  }, [theme]);
  async function refresh() {
    setOptions(await api.request("/auth/options"));
    try {
      const value = await api.request<SessionView>("/auth/me");
      api.setCsrf(value.csrfToken);
      setSession(value);
      applyLocale(value.user.locale);
      setSessions(
        (await api.request<{ sessions: Session[] }>("/auth/sessions")).sessions,
      );
      return value;
    } catch (e) {
      if (e instanceof IdentityApiError && e.status === 401) {
        setSession(null);
        setFlags({});
        setSecret("");
        setCurrent("");
        setNext("");
        setNewPass("");
        setPassword("");
        setSetup("");
        api.setCsrf("");
        return null;
      }
      throw e;
    }
  }
  async function loadAdmin() {
    if (activeDataScope.current !== dataScope) return;
    const [u, f, a] = await Promise.all([
      dataClient.fetchQuery({
        queryKey: [dataScope, "admin", "users"],
        queryFn: () => api.request<{ users: User[] }>("/admin/users"),
        staleTime: 0,
      }),
      api.request<CapabilityResponse>("/features"),
      dataClient.fetchQuery({
        queryKey: [dataScope, "admin", "audit"],
        queryFn: () => api.request<{ events: typeof events }>("/admin/audit"),
        staleTime: 0,
      }),
    ]);
    if (activeDataScope.current !== dataScope) return;
    dataClient.setQueryData([dataScope, "capabilities"], f);
    setFlags(f.flags);
    setSavedFlags(JSON.stringify(f.flags));
    if (session?.user.systemAdmin) {
      const value = await api.request<Oidc | null>("/admin/oidc");
      if (activeDataScope.current !== dataScope) return;
      const settings = value ?? {
        issuer: "",
        clientId: "",
        enabled: false,
        allowSignup: false,
      };
      const values = { oidc: settings, secret: "" };
      setOidcDefaults(values);
      oidcForm.reset(values);
      setSavedOidc(JSON.stringify(settings));
    }
  }
  useEffect(() => {
    setNotice("");
  }, [routeHref]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof IdentityApiError ? e.code : "error");
      if (e instanceof IdentityApiError && e.status === 401) {
        setSession(null);
        setFlags({});
        setSecret("");
        setCurrent("");
        setNext("");
        setNewPass("");
        setPassword("");
        setSetup("");
        api.setCsrf("");
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh()
      .catch(() => setError("error"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (tab === "admin" && admin) void run(loadAdmin);
  }, [tab, session?.user.id]);
  function submit(event: FormEvent, action: () => Promise<void>) {
    event.preventDefault();
    void run(action);
  }
  async function sso(intent: "login" | "link") {
    const value = await api.request<{ url: string }>(
      "/auth/oidc/start",
      "POST",
      { intent },
    );
    platform.navigate(value.url);
  }
  const roleOptions = [
    { value: "member", content: t("member") },
    { value: "org_admin", content: t("orgAdmin") },
  ];
  const content = (
    <>
      {!session && (
        <Flex
          className="masthead"
          alignItems="center"
          justifyContent="space-between"
          gap="spacing-4"
          wrap="wrap"
        >
          <div>
            <BrandLogo theme={theme} />
            <div className="subtitle">
              <Text color="secondary">{t("tagline")}</Text>
            </div>
          </div>
          <Flex gap="spacing-2">
            <Button
              onClick={() =>
                void run(async () => {
                  const value = locale === "en" ? "ru" : "en";
                  if (session)
                    await api.request("/auth/profile", "PATCH", {
                      locale: value,
                    });
                  applyLocale(value);
                })
              }
            >
              EN / RU
            </Button>
            <Button
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {t("theme")}
            </Button>
          </Flex>
        </Flex>
      )}
      {error && (
        <Alert theme="danger" message={t(error)} onClose={() => setError("")} />
      )}
      {navigationError && (
        <Alert
          theme="warning"
          message={t(navigationError)}
          onClose={() => setNavigationError("")}
        />
      )}{" "}
      {notice && (
        <Alert
          theme="success"
          message={t(notice)}
          onClose={() => setNotice("")}
        />
      )}
      {loading ? (
        <Text>{t("loading")}</Text>
      ) : !session ? (
        <Panel title={t(options.bootstrapRequired ? "bootstrap" : "signIn")}>
          <form
            className="stack"
            onSubmit={(e) =>
              submit(e, async () => {
                await api.request(
                  options.bootstrapRequired ? "/auth/bootstrap" : "/auth/login",
                  "POST",
                  options.bootstrapRequired
                    ? {
                        email,
                        password,
                        name,
                        organizationName: org,
                        bootstrapToken: setup,
                      }
                    : { email, password },
                );
                setPassword("");
                setSetup("");
                await refresh();
              })
            }
          >
            {options.bootstrapRequired && (
              <>
                <Text color="secondary">{t("bootstrapHint")}</Text>
                <Field
                  label={t("name")}
                  value={name}
                  onChange={setName}
                  autoComplete="name"
                  maxLength={120}
                />
                <Field
                  label={t("organization")}
                  value={org}
                  onChange={setOrg}
                  autoComplete="organization"
                />
                <Field
                  label={t("setupToken")}
                  maxLength={256}
                  value={setup}
                  onChange={setSetup}
                  type="password"
                  autoComplete="off"
                />
              </>
            )}
            <Field
              label={t("email")}
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="username"
            />
            <Field
              label={t(options.bootstrapRequired ? "newPassword" : "password")}
              type="password"
              minLength={options.bootstrapRequired ? 12 : undefined}
              value={password}
              onChange={setPassword}
              autoComplete={
                options.bootstrapRequired ? "new-password" : "current-password"
              }
            />
            <Button type="submit" view="action" size="l" loading={busy}>
              {t(options.bootstrapRequired ? "createWorkspace" : "signIn")}
            </Button>
          </form>
          {options.ssoEnabled && !options.bootstrapRequired && (
            <Button
              size="l"
              disabled={busy}
              onClick={() => void run(() => sso("login"))}
            >
              {t("sso")}
            </Button>
          )}
        </Panel>
      ) : (
        <>
          {tab === "schedules" ? (
            <Schedules
              api={api}
              locale={locale}
              chats={sidebarChats}
              onOpenChat={openChat}
            />
          ) : tab === "extensions" ? (
            <ExtensionsHub
              api={api}
              locale={locale}
              userId={session.user.id}
              admin={session.user.systemAdmin}
              publisher={admin}
            />
          ) : tab === "resources" ? (
            <Resources
              key={resourceProject}
              initialProject={resourceProject}
              onCurrentProject={(id) => {
                if (tab === "resources")
                  writeDestination({ page: "resources", projectId: id }, true);
              }}
              onProjectsChange={refreshNavigation}
              conversations={sidebarChats}
              onOpenChat={openChat}
              api={api}
              locale={locale}
              onExpired={() => void refresh()}
            />
          ) : tab === "chat" ? (
            <Suspense fallback={<Text>{ct("loading")}</Text>}>
              <ChatWorkspace
                key={
                  session.user.id +
                  ":" +
                  (chatId ?? "new:" + (destination.projectId ?? ""))
                }
                initialProject={destination.projectId ?? ""}
                onConversationsChange={setSidebarChats}
                api={api}
                locale={locale}
                initialChat={chatId}
                onSelect={(id) => {
                  if (router.state.location.href !== routeHref) return;
                  if (!id) {
                    writeDestination({ page: "chat" }, true);
                  }
                  if (
                    id &&
                    router.state.location.pathname !==
                      "/chats/" + encodeURIComponent(id)
                  )
                    writeDestination({ page: "chat", chatId: id }, true);
                  platform.writePreference("chat." + session.user.id, id ?? "");
                }}
                onExpired={() => {
                  if (activeDataScope.current !== dataScope) return;
                  setSession(null);
                  api.setCsrf("");
                }}
                onConfigure={
                  session.user.systemAdmin
                    ? () => navigate("providers")
                    : undefined
                }
              />
            </Suspense>
          ) : tab === "providers" && session.user.systemAdmin ? (
            <ProviderSettings
              api={api}
              locale={locale}
              onModels={() => navigate("models")}
            />
          ) : tab === "models" && session.user.systemAdmin ? (
            <ModelSettings api={api} locale={locale} />
          ) : tab === "account" || !admin ? (
            <SettingsLayout
              sections={[
                {
                  id: "profile",
                  title:
                    locale === "ru" ? "Профиль и данные" : "Profile and data",
                },
                {
                  id: "security",
                  title: locale === "ru" ? "Безопасность" : "Security",
                },
                {
                  id: "permissions",
                  title:
                    locale === "ru" ? "Разрешения агента" : "Agent permissions",
                },
                { id: "sessions", title: t("sessions") },
                {
                  id: "devices",
                  title:
                    locale === "ru" ? "Desktop-устройства" : "Desktop devices",
                },
              ]}
              value={settingsSection}
              onChange={(id) =>
                guard.navigate(() => {
                  writeDestination({ page: "account", section: id });
                })
              }
            >
              {settingsSection === "permissions" && (
                <PermissionGrants api={api} locale={locale} />
              )}
              {settingsSection === "devices" && (
                <DesktopDevices api={api} locale={locale} />
              )}
              {settingsSection === "profile" && (
                <Panel title={session.user.name}>
                  <Text>{t("welcome")}</Text>
                  <Text color="secondary">{t("welcomeHint")}</Text>
                  <Flex gap="spacing-2" alignItems="center">
                    <Button href={api.url("/data/export")}>
                      {resourceText(locale)("export")}
                    </Button>
                    <HelpMark aria-label={resourceText(locale)("export")}>
                      <Box width="22rem" maxWidth="calc(100vw - 4rem)">
                        {u("exportHelp")}
                      </Box>
                    </HelpMark>
                  </Flex>
                  {options.ssoEnabled && (
                    <>
                      <Text color="secondary">{t("linkHint")}</Text>
                      <Button
                        disabled={busy}
                        onClick={() => void run(() => sso("link"))}
                      >
                        {t("linkSso")}
                      </Button>
                    </>
                  )}
                </Panel>
              )}
              {settingsSection === "sessions" && (
                <Panel title={t("sessions")}>
                  {sessions.length === 0 && <Text>{t("empty")}</Text>}
                  {sessions.map((s) => (
                    <Flex
                      key={s.id}
                      gap="spacing-3"
                      wrap="wrap"
                      alignItems="center"
                      justifyContent="space-between"
                    >
                      <Text>
                        {s.id === session.sessionId
                          ? t("currentSession")
                          : new Intl.DateTimeFormat(locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(s.created_at))}
                      </Text>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.request(
                              "/auth/sessions/" + s.id,
                              "DELETE",
                            );
                            await refresh();
                          })
                        }
                      >
                        {t("revoke")}
                      </Button>
                    </Flex>
                  ))}
                </Panel>
              )}
              {settingsSection === "security" && (
                <Panel title={t("changePassword")}>
                  <form
                    className="stack"
                    onSubmit={(e) =>
                      submit(e, async () => {
                        await api.request("/auth/password", "POST", {
                          currentPassword: current,
                          newPassword: next,
                        });
                        setCurrent("");
                        setNext("");
                        await refresh();
                        setNotice("passwordChanged");
                      })
                    }
                  >
                    <Field
                      type="password"
                      label={t("currentPassword")}
                      value={current}
                      onChange={setCurrent}
                      autoComplete="current-password"
                    />
                    <Field
                      type="password"
                      label={t("newPassword")}
                      value={next}
                      onChange={setNext}
                      autoComplete="new-password"
                      minLength={12}
                      help={u("passwordHelp")}
                    />
                    <Button type="submit" loading={busy}>
                      {t("changePassword")}
                    </Button>
                  </form>
                </Panel>
              )}
            </SettingsLayout>
          ) : (
            <SettingsLayout
              sections={[
                { id: "users", title: t("users") },
                { id: "features", title: t("flags") },
                ...(session.user.systemAdmin
                  ? [
                      { id: "sso", title: t("oidc") },
                      {
                        id: "permissions",
                        title:
                          locale === "ru"
                            ? "Разрешения агента"
                            : "Agent permissions",
                      },
                      {
                        id: "assistant",
                        title: locale === "ru" ? "Ассистент" : "Assistant",
                      },
                    ]
                  : []),
                { id: "audit", title: t("audit") },
              ]}
              value={settingsSection}
              onChange={(id) =>
                guard.navigate(() => {
                  writeDestination({ page: "admin", section: id });
                  setAddUser(false);
                })
              }
            >
              {settingsSection === "permissions" &&
                session.user.systemAdmin && (
                  <PermissionSettings api={api} locale={locale} />
                )}
              {settingsSection === "assistant" && session.user.systemAdmin && (
                <AssistantSettings api={api} locale={locale} />
              )}
              {settingsSection === "users" && (
                <Flex justifyContent="flex-end" marginBlockEnd="spacing-4">
                  <Button view="action" onClick={() => setAddUser(true)}>
                    {t("createUser")}
                  </Button>
                </Flex>
              )}
              <Dialog
                open={addUser}
                maxWidth="s"
                onOpenChange={(open) => {
                  if (!open) guard.navigate(() => setAddUser(false));
                }}
              >
                <Dialog.Header caption={t("createUser")} />
                <Dialog.Body>
                  {error && <Alert theme="danger" message={t(error)} />}
                  <form
                    className="stack"
                    onSubmit={(e) =>
                      submit(e, async () => {
                        await api.request("/admin/users", "POST", {
                          email: newEmail,
                          password: newPass,
                          name: newName,
                          role: newRole,
                        });
                        setNewEmail("");
                        setNewName("");
                        setNewPass("");
                        await loadAdmin();
                        setNotice("created");
                        setAddUser(false);
                      })
                    }
                  >
                    <Field
                      label={t("name")}
                      maxLength={120}
                      value={newName}
                      onChange={setNewName}
                    />
                    <Field
                      type="email"
                      label={t("email")}
                      value={newEmail}
                      onChange={setNewEmail}
                    />
                    <Field
                      type="password"
                      label={t("newPassword")}
                      value={newPass}
                      onChange={setNewPass}
                      autoComplete="new-password"
                      minLength={12}
                      help={u("passwordHelp")}
                    />
                    <Text>{t("role")}</Text>
                    <Select
                      aria-label={t("role")}
                      value={[newRole]}
                      options={roleOptions}
                      onUpdate={(v) => setNewRole(v[0] as typeof newRole)}
                    />
                    <Button type="submit" view="action" loading={busy}>
                      {t("createUser")}
                    </Button>
                  </form>
                </Dialog.Body>
              </Dialog>
              {settingsSection === "features" && (
                <Panel title={t("flags")} description={u("flagsHelp")}>
                  {Object.entries(flags).map(([key, value]) => (
                    <Checkbox
                      key={key}
                      checked={value}
                      disabled={busy || capabilities.isPending}
                      onUpdate={(value) => setFlags({ ...flags, [key]: value })}
                    >
                      {t(key)}
                    </Checkbox>
                  ))}
                  <Button
                    disabled={
                      busy ||
                      capabilities.isPending ||
                      JSON.stringify(flags) === savedFlags
                    }
                    onClick={() =>
                      void run(async () => {
                        await api.request("/admin/features", "PUT", flags);
                        await loadAdmin();
                        setNotice("saved");
                      })
                    }
                  >
                    {t("save")}
                  </Button>
                </Panel>
              )}
              {settingsSection === "users" && (
                <Panel title={t("users")}>
                  {users.map((user) => (
                    <div className="user-row" key={user.id}>
                      <div>
                        <Text variant="subheader-2">{user.name}</Text>
                        <div className="subtitle">
                          <Text color="secondary">{user.email}</Text>
                        </div>
                      </div>
                      <Text color="secondary">
                        {t(
                          user.systemAdmin
                            ? "systemAdmin"
                            : user.role === "org_admin"
                              ? "orgAdmin"
                              : "member",
                        )}
                        {user.disabled ? " · " + t("disabled") : ""}
                      </Text>
                      <Button
                        view="flat"
                        disabled={
                          busy ||
                          user.id === session.user.id ||
                          (!session.user.systemAdmin && user.systemAdmin)
                        }
                        onClick={() => setEditingUser(user)}
                      >
                        {locale === "ru"
                          ? "Управлять доступом"
                          : "Manage access"}
                      </Button>
                    </div>
                  ))}
                </Panel>
              )}
              {settingsSection === "sso" && session.user.systemAdmin && (
                <Panel title={t("oidc")} description={u("oidcHelp")}>
                  <form
                    className="stack"
                    onSubmit={(e) =>
                      submit(e, async () => {
                        await api.request("/admin/oidc", "PUT", {
                          issuer: oidc.issuer,
                          clientId: oidc.clientId,
                          enabled: oidc.enabled,
                          allowSignup: oidc.allowSignup,
                          ...(secret ? { clientSecret: secret } : {}),
                        });
                        setSecret("");
                        await loadAdmin();
                        await refresh();
                        setNotice("saved");
                      })
                    }
                  >
                    <Field
                      type="url"
                      label={t("issuer")}
                      help={u("issuerHelp")}
                      value={oidc.issuer}
                      onChange={(value) => setOidc({ ...oidc, issuer: value })}
                    />
                    <Field
                      label={t("clientId")}
                      help={u("clientIdHelp")}
                      value={oidc.clientId}
                      onChange={(value) =>
                        setOidc({ ...oidc, clientId: value })
                      }
                    />
                    <Field
                      type="password"
                      label={t("clientSecret")}
                      help={u("clientSecretHelp")}
                      maxLength={4096}
                      value={secret}
                      onChange={setSecret}
                      required={false}
                      autoComplete="off"
                    />
                    <Switch
                      checked={oidc.enabled}
                      onUpdate={(enabled) => setOidc({ ...oidc, enabled })}
                    >
                      {t("enabled")}
                    </Switch>
                    <Switch
                      checked={oidc.allowSignup}
                      onUpdate={(allowSignup) =>
                        setOidc({ ...oidc, allowSignup })
                      }
                    >
                      {t("allowSignup")}
                    </Switch>
                    <Button type="submit" loading={busy}>
                      {t("save")}
                    </Button>
                  </form>
                </Panel>
              )}
              {settingsSection === "audit" && (
                <Panel title={t("audit")}>
                  {events.map((event) => (
                    <Flex
                      key={event.id}
                      gap="spacing-4"
                      justifyContent="space-between"
                      wrap="wrap"
                    >
                      <Text>{t(event.event)}</Text>
                      <Text color="secondary">
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(event.created_at))}
                      </Text>
                    </Flex>
                  ))}
                </Panel>
              )}
            </SettingsLayout>
          )}
        </>
      )}
    </>
  );
  return (
    <AppDataProvider key={dataScope}>
      <CapabilitiesContext.Provider
        value={{
          flags: capabilities.data?.flags ?? {},
          runtime: capabilities.data?.runtime,
          loading: capabilities.isPending,
          error: capabilities.isError,
        }}
      >
        <Provider theme={theme} lang={locale}>
          <FormLocaleContext.Provider value={locale}>
            {!session && window.runozaDesktop?.platform === "darwin" && (
              <div className="desktop-titlebar">Runóza</div>
            )}
            <RouteDirtyGuard />
            <UnsavedDialog locale={locale} />
            {session && <DesktopConnect api={api} locale={locale} />}
            {editingUser && (
              <UserAccessEditor
                user={editingUser}
                api={api}
                locale={locale}
                canSystem={Boolean(session?.user.systemAdmin)}
                onClose={() => setEditingUser(null)}
                onSaved={loadAdmin}
              />
            )}
            {session ? (
              <AppShell
                unreadTasks={unreadTasksQuery.data?.count ?? 0}
                page={tab}
                onNavigate={navigate}
                chats={sidebarChats}
                projects={sidebarProjects}
                activeChat={chatId}
                onOpenChat={openChat}
                onOpenProject={openProject}
                locale={locale}
                email={session.user.email}
                admin={admin}
                systemAdmin={session.user.systemAdmin}
                theme={theme}
                busy={busy}
                onTheme={() => setTheme(theme === "light" ? "dark" : "light")}
                onLanguage={() =>
                  void run(async () => {
                    const value = locale === "en" ? "ru" : "en";
                    await api.request("/auth/profile", "PATCH", {
                      locale: value,
                    });
                    applyLocale(value);
                  })
                }
                onLogout={() =>
                  guard.navigate(
                    () =>
                      void run(async () => {
                        await api.request("/auth/logout", "POST");
                        setSession(null);
                        writeDestination({ page: "chat" }, true);
                        await refresh();
                      }),
                  )
                }
              >
                {content}
              </AppShell>
            ) : (
              <main className="entry">{content}</main>
            )}
          </FormLocaleContext.Provider>
        </Provider>
      </CapabilitiesContext.Provider>
    </AppDataProvider>
  );
}
