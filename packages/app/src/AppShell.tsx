import { HistoryControls } from "./HistoryControls.tsx";
import { brandMark } from "./BrandLogo.tsx";
import { ConversationHeader } from "./ConversationHeader.tsx";
import type { Conversation, ProjectView } from "@runoza/contracts";
import { useState, type ReactNode } from "react";
import {
  PageLayout,
  PageLayoutAside,
  MobileHeader,
  type AsideHeaderItem,
} from "@gravity-ui/navigation";
import {
  Comments,
  ChevronDown,
  ChevronRight,
  Clock,
  PencilToSquare,
  Folder,
  Cpu,
  Person,
  Gear,
  Moon,
  Sun,
  ArrowRightFromSquare,
} from "@gravity-ui/icons";
import {
  Box,
  Flex,
  Text,
  Button,
  Icon,
  Tooltip,
  TextInput,
  Menu,
  MenuItem,
  Label,
  useLayoutContext,
} from "@gravity-ui/uikit";
import { translator } from "./locales.ts";
import { chatText } from "./chat-locales.ts";
import { resourceText } from "./resource-locales.ts";
import { uxText } from "./ux-locales.ts";
type NavigationItem = Omit<AsideHeaderItem, "onItemClick"> & {
  onItemClick: () => void;
};
export type AppPage =
  | "chat"
  | "extensions"
  | "schedules"
  | "resources"
  | "providers"
  | "models"
  | "account"
  | "admin";
export function AppShell({
  children,
  chats,
  projects,
  activeChat,
  onOpenChat,
  onOpenProject,
  page,
  onNavigate,
  locale,
  email,
  admin,
  systemAdmin,
  onLanguage,
  onTheme,
  onLogout,
  theme,
  busy,
  unreadTasks = 0,
}: {
  unreadTasks?: number;
  children: ReactNode;
  chats: Conversation[];
  projects: ProjectView[];
  activeChat: string | null;
  onOpenChat: (id: string | null, project?: string) => void;
  onOpenProject: (id: string) => void;
  page: AppPage;
  onNavigate: (page: AppPage) => void;
  locale: "en" | "ru";
  email: string;
  admin: boolean;
  systemAdmin: boolean;
  onLanguage: () => void;
  onTheme: () => void;
  onLogout: () => void;
  theme: "light" | "dark";
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("runoza:sidebar-groups") ?? "{}");
    } catch {
      return {};
    }
  });
  const [compact, setCompact] = useState(
      localStorage.getItem("runoza:sidebar-compact") === "true",
    ),
    { isMediaActive } = useLayoutContext(),
    t = translator(locale),
    ct = chatText(locale),
    rt = resourceText(locale),
    u = uxText(locale);
  const pages = [
    {
      id: "schedules" as const,
      title: locale === "ru" ? "Задания" : "Tasks",
      icon: Clock,
    },
    { id: "chat" as const, title: ct("chat"), icon: Comments },
    {
      id: "extensions" as const,
      title: locale === "ru" ? "Расширения" : "Extensions",
      icon: Cpu,
    },
    { id: "resources" as const, title: rt("resources"), icon: Folder },
    ...(systemAdmin
      ? [
          { id: "providers" as const, title: ct("providers"), icon: Cpu },
          {
            id: "models" as const,
            title: locale === "ru" ? "Модели" : "Models",
            icon: Cpu,
          },
        ]
      : []),
    { id: "account" as const, title: t("account"), icon: Person },
    ...(admin ? [{ id: "admin" as const, title: t("admin"), icon: Gear }] : []),
  ];
  const ru = locale === "ru";
  const matches = (value: string) =>
    value.toLocaleLowerCase(locale).includes(query.toLocaleLowerCase(locale));
  const matchingProjects = projects.filter(
    (p) =>
      matches(p.name) ||
      chats.some((c) => c.project_id === p.id && matches(c.title)),
  );
  const groups = [
    ...matchingProjects.map((p) => ({
      id: p.id,
      title: p.name,
      icon: Folder,
      onItemClick: () => onOpenProject(p.id),
    })),
    {
      id: "personal",
      title: ru ? "Личные беседы" : "Your chats",
      icon: Comments,
    },
  ];
  const activityLabel = (state: string) =>
    ({
      queued: ru ? "В очереди" : "Queued",
      waiting_input: ru ? "Нужен ваш ответ" : "Needs your input",
      waiting_approval: ru ? "Ждёт разрешения" : "Awaiting approval",
    })[state] ?? (ru ? "Выполняется" : "Working");
  const activity = (c: Conversation) =>
    c.active_state ? (
      <Tooltip content={activityLabel(c.active_state)}>
        <span
          role="img"
          aria-label={activityLabel(c.active_state)}
          className={`chat-activity-dot chat-activity-dot--${c.active_state}`}
        />
      </Tooltip>
    ) : undefined;
  const items: NavigationItem[] = [
    ...matchingProjects.flatMap((p) => [
      {
        id: "new:" + p.id,
        title: ru ? "Новая беседа" : "New chat",
        groupId: p.id,
        icon: PencilToSquare,
        onItemClick: () => onOpenChat(null, p.id),
      },
      ...chats
        .filter(
          (c) => c.project_id === p.id && (matches(c.title) || matches(p.name)),
        )
        .map((c) => ({
          id: c.id,
          title: <span className="sidebar-chat">{c.title}</span>,
          tooltipText: c.title,
          rightAdornment: activity(c),
          groupId: p.id,
          current: page === "chat" && activeChat === c.id,
          onItemClick: () => onOpenChat(c.id, p.id),
        })),
    ]),
    ...chats
      .filter((c) => !c.project_id && matches(c.title))
      .map((c) => ({
        id: c.id,
        title: <span className="sidebar-chat">{c.title}</span>,
        tooltipText: c.title,
        rightAdornment: activity(c),
        groupId: "personal",
        current: page === "chat" && activeChat === c.id,
        onItemClick: () => onOpenChat(c.id),
      })),
  ];
  const toggleGroup = (id: string) =>
    setCollapsed((v) => {
      const next = { ...v, [id]: !v[id] };
      localStorage.setItem("runoza:sidebar-groups", JSON.stringify(next));
      return next;
    });
  const flatItems: NavigationItem[] = groups.flatMap((group) => {
    const expanded = Boolean(query) || !collapsed[group.id];
    const rows = items
      .filter((item) => item.groupId === group.id)
      .map(({ groupId: _groupId, ...item }) => item);
    return [
      {
        id: "group:" + group.id,
        title: group.title,
        icon: group.icon,
        onItemClick: () =>
          "onItemClick" in group
            ? group.onItemClick?.()
            : toggleGroup(group.id),
        itemWrapper: () => (
          <Flex
            alignItems="center"
            minWidth="0"
            className="sidebar-group"
            width="100%"
          >
            <Button
              view="flat-secondary"
              width="max"
              className="sidebar-group-link"
              title={group.title}
              onClick={() =>
                "onItemClick" in group
                  ? group.onItemClick?.()
                  : toggleGroup(group.id)
              }
            >
              <span className="sidebar-group-title">{group.title}</span>
            </Button>
            <Button
              view="flat-secondary"
              size="s"
              aria-label={
                (expanded ? u("collapse") : u("expand")) + " · " + group.title
              }
              aria-expanded={expanded}
              onClick={() => toggleGroup(group.id)}
            >
              <Icon data={expanded ? ChevronDown : ChevronRight} size={16} />
            </Button>
          </Flex>
        ),
      },
      ...(expanded ? rows : []),
    ];
  });
  const primary: NavigationItem[] = [
    {
      id: "new",
      title: ct("newChat"),
      icon: PencilToSquare,
      onItemClick: () => onOpenChat(null),
    },
    {
      id: "projects",
      title: ru ? "Проекты" : "Projects",
      icon: Folder,
      onItemClick: () => onOpenProject(""),
    },
  ];
  primary.push({
    id: "extensions",
    title: ru ? "Расширения" : "Extensions",
    icon: Cpu,
    current: page === "extensions",
    onItemClick: () => onNavigate("extensions"),
  });
  primary.push({
    id: "schedules",
    title: ru ? "Задания" : "Tasks",
    icon: Clock,
    rightAdornment:
      unreadTasks > 0 ? (
        <Label theme="info" size="xs">
          {unreadTasks}
        </Label>
      ) : undefined,
    tooltipText:
      unreadTasks > 0
        ? (ru ? "Новые результаты: " : "New results: ") + unreadTasks
        : undefined,
    current: page === "schedules",
    onItemClick: () => onNavigate("schedules"),
  });
  const search = (
    <Box padding="spacing-3">
      <TextInput
        value={query}
        onUpdate={setQuery}
        placeholder={ru ? "Поиск в списке…" : "Search this list…"}
        controlProps={{ "aria-label": ru ? "Поиск бесед" : "Search chats" }}
        hasClear
      />
    </Box>
  );
  const [mobileMenuEpoch, setMobileMenuEpoch] = useState(0);
  const footer = (small = false) => (
    <Flex direction="column" gap="spacing-2" padding="spacing-2" minWidth="0">
      <Menu
        trigger={
          <Button
            view="flat"
            width="max"
            className={small ? undefined : "settings-trigger"}
            aria-label={u("settings")}
          >
            <Icon data={Gear} />
            {!small && u("settings")}
          </Button>
        }
      >
        {pages
          .filter(
            (p) =>
              !["chat", "resources", "extensions", "schedules"].includes(p.id),
          )
          .map((p) => (
            <MenuItem
              key={p.id}
              onClick={() => {
                setMobileMenuEpoch((v) => v + 1);
                onNavigate(p.id);
              }}
            >
              {p.title}
            </MenuItem>
          ))}
      </Menu>
      {!small && (
        <Text variant="caption-2" color="secondary" ellipsis title={email}>
          {email}
        </Text>
      )}
      <Flex gap="spacing-2" direction={small ? "column" : "row"} wrap="wrap">
        <Tooltip content="English / Русский">
          <Button
            view="flat"
            aria-label="English / Русский"
            onClick={onLanguage}
            disabled={busy}
          >
            {locale.toUpperCase()}
          </Button>
        </Tooltip>
        <Tooltip content={t("theme")}>
          <Button view="flat" aria-label={t("theme")} onClick={onTheme}>
            <Icon data={theme === "light" ? Moon : Sun} />
          </Button>
        </Tooltip>
        <Tooltip content={t("logout")}>
          <Button
            view="flat"
            aria-label={t("logout")}
            disabled={busy}
            onClick={onLogout}
          >
            <Icon data={ArrowRightFromSquare} />
          </Button>
        </Tooltip>
      </Flex>
    </Flex>
  );
  const content = () =>
    page === "chat" ? (
      children
    ) : (
      <Box
        padding={{ xs: "spacing-4", m: "spacing-8" }}
        minWidth="0"
        maxWidth="100%"
      >
        <Flex
          direction="column"
          gap="spacing-6"
          maxWidth="76rem"
          marginInline="auto"
        >
          {!["extensions", "schedules"].includes(page) && (
            <Flex direction="column" gap="spacing-2">
              <Text as="h1" variant="header-2">
                {pages.find((p) => p.id === page)?.title}
              </Text>
              {
                <Text color="secondary">
                  {page === "models"
                    ? ru
                      ? "Доступность моделей и параметры рассуждений."
                      : "Model availability and reasoning settings."
                    : u(
                        page === "resources"
                          ? "projectsHint"
                          : page === "providers"
                            ? "providersHint"
                            : page === "admin"
                              ? "adminHint"
                              : "accountHint",
                      )}
                </Text>
              }
            </Flex>
          )}
          {children}
        </Flex>
      </Box>
    );
  const desktop = isMediaActive("m");
  return (
    <ConversationHeader.Provider value={headerHost}>
      <PageLayout
        menuDensity="compact"
        compact={compact}
        topAlert={
          window.runozaDesktop?.platform === "darwin"
            ? {
                render: () => (
                  <div className="desktop-titlebar">
                    <HistoryControls locale={locale} />
                    <div
                      className="desktop-titlebar-content"
                      ref={setHeaderHost}
                    />
                    {page !== "chat" && (
                      <Text color="secondary" ellipsis>
                        {pages.find((p) => p.id === page)?.title || "Runóza"}
                      </Text>
                    )}
                  </div>
                ),
              }
            : undefined
        }
      >
        {desktop && (
          <PageLayoutAside
            logo={{
              text: "Runóza",
              iconSrc: brandMark,
              iconSize: 32,
              textSize: 20,
              href: "/",
              "aria-label": ru ? "Runóza · Главная" : "Runóza · Home",
              onClick: (event) => {
                event.preventDefault();
                onNavigate("chat");
              },
            }}
            onChangeCompact={(value) => {
              setCompact(value);
              localStorage.setItem("runoza:sidebar-compact", String(value));
            }}
            collapseTitle={u("collapse")}
            expandTitle={u("expand")}
            subheaderItems={primary}
            aboveMenuContent={
              !compact && (
                <>
                  {search}
                  {query && !items.length && (
                    <Box padding="spacing-3">
                      <Text color="secondary">
                        {ru ? "Ничего не найдено" : "No matches"}
                      </Text>
                    </Box>
                  )}
                </>
              )
            }
            hideSectionDividers
            menuItems={compact ? items : flatItems}
            menuGroups={compact ? groups : undefined}
            menuOverflow="scroll"
            renderFooter={() => footer(compact)}
          />
        )}
        <Flex
          as="main"
          direction="column"
          flex="1"
          marginBlockStart={
            window.runozaDesktop?.platform === "darwin"
              ? "var(--gn-top-alert-height, 44px)"
              : "0"
          }
          minWidth="0"
          className={page === "chat" ? "conversation-main" : undefined}
        >
          {!desktop && (
            <MobileHeader
              key={mobileMenuEpoch}
              logo={{
                text: "Runóza",
                iconSrc: brandMark,
                iconSize: 28,
                href: "/",
                onClick: (event) => {
                  event.preventDefault();
                  onNavigate("chat");
                },
              }}
              burgerOpenTitle={u("openMenu")}
              burgerCloseTitle={u("closeMenu")}
              burgerMenu={{
                items: [...primary, ...items].map((item) => ({
                  id: item.id,
                  title:
                    item.groupId && item.groupId !== "personal"
                      ? projects.find((p) => p.id === item.groupId)?.name +
                        " · " +
                        (chats.find((c) => c.id === item.id)?.title ??
                          item.title)
                      : item.title,
                  current: item.current,
                  onItemClick: item.onItemClick,
                  closeMenuOnClick: true,
                })),
                renderFooter: () => footer(),
              }}
            />
          )}
          {content()}
        </Flex>
      </PageLayout>
    </ConversationHeader.Provider>
  );
}
