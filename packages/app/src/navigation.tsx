import { RouteErrorPage } from "./RouteErrorPage.tsx";
import { historyBounds } from "./history-bounds.ts";
import {
  createBrowserHistory,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useBlocker,
  useRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { useSyncExternalStore, type ReactNode } from "react";
import { useNavigationGuard } from "./NavigationGuard.tsx";
import type { AppPage } from "./AppShell.tsx";
export type AppDestination = {
  page: AppPage;
  chatId?: string | null;
  projectId?: string;
  section?: string;
};
export function destinationPath(value: AppDestination) {
  if (value.page === "chat")
    return value.chatId
      ? "/chats/" + encodeURIComponent(value.chatId)
      : "/" +
          (value.projectId
            ? "?project=" + encodeURIComponent(value.projectId)
            : "");
  if (value.page === "resources")
    return value.projectId
      ? "/projects/" + encodeURIComponent(value.projectId)
      : "/projects";
  if (value.page === "account" || value.page === "admin")
    return (
      "/" +
      value.page +
      "/" +
      encodeURIComponent(
        value.section ?? (value.page === "admin" ? "users" : "profile"),
      )
    );
  return "/" + value.page;
}
export function parseDestination(href: string): AppDestination {
  const url = new URL(href, "http://navigation.local");
  const [page, id] = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  if (page === "chats" && id) return { page: "chat", chatId: id };
  if (page === "projects") return { page: "resources", projectId: id ?? "" };
  if (page === "account" || page === "admin")
    return { page, section: id ?? (page === "admin" ? "users" : "profile") };
  if (["extensions", "schedules", "providers", "models"].includes(page ?? ""))
    return { page: page as AppPage };
  return { page: "chat", projectId: url.searchParams.get("project") ?? "" };
}
const persistedHistories = new WeakSet<RouterHistory>();
export function createAppRouter(
  render: () => ReactNode,
  history?: RouterHistory,
) {
  const appHistory =
    history ??
    (window.runozaDesktop ? createHashHistory() : createBrowserHistory());
  if (!history) persistedHistories.add(appHistory);
  monitorHistory(appHistory);
  const root = createRootRoute({ component: render });
  const paths = [
    "/",
    "/chats/$chatId",
    "/projects",
    "/projects/$projectId",
    "/account/$section",
    "/admin/$section",
    "/extensions",
    "/schedules",
    "/providers",
    "/models",
  ] as const;
  const routeTree = root.addChildren(
    paths.map((path) => createRoute({ getParentRoute: () => root, path })),
  );
  return createRouter({
    routeTree,
    defaultErrorComponent: RouteErrorPage,
    history: appHistory,
    defaultPendingMs: 0,
    scrollRestoration: false,
  });
}
export function RouteDirtyGuard() {
  const guard = useNavigationGuard();
  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: () =>
      new Promise<boolean>((resolve) =>
        guard.navigate(
          () => resolve(false),
          undefined,
          () => resolve(true),
        ),
      ),
  });
  return null;
}
type HistorySnapshot = { index: number; maximum: number };
const historyMonitors = new WeakMap<
  RouterHistory,
  { subscribe: (fn: () => void) => () => void; snapshot: () => HistorySnapshot }
>();
function monitorHistory(history: RouterHistory) {
  const existing = historyMonitors.get(history);
  if (existing) return existing;
  let storage: Storage | undefined;
  try {
    if (persistedHistories.has(history)) storage = window.sessionStorage;
  } catch {}
  const bounds = historyBounds(storage, {
    index: history.location.state.__TSR_index,
    key: history.location.state.__TSR_key ?? "",
  });
  let snapshot = {
    index: history.location.state.__TSR_index,
    maximum: bounds.maximum,
  };
  const listeners = new Set<() => void>();
  history.subscribe(({ action, location }) => {
    const index = location.state.__TSR_index;
    snapshot = {
      index,
      maximum: bounds.record(
        index,
        location.state.__TSR_key ?? "",
        action.type === "PUSH",
      ),
    };
    listeners.forEach((fn) => fn());
  });
  const monitor = {
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    snapshot: () => snapshot,
  };
  historyMonitors.set(history, monitor);
  return monitor;
}
export function useNavigationHistory() {
  const history = useRouter().history;
  const monitor = monitorHistory(history);
  const { index, maximum } = useSyncExternalStore(
    monitor.subscribe,
    monitor.snapshot,
  );
  return {
    canBack: index > 0,
    canForward: index < maximum,
    back: () => history.back(),
    forward: () => history.forward(),
  };
}
