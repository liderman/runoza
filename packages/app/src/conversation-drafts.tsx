import {
  createContext,
  useContext,
  useState,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
function createDrafts() {
  const values = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  return {
    copy: (from: string, to: string) => {
      for (const [key, value] of [...values])
        if (key.startsWith(from + ":"))
          values.set(to + key.slice(from.length), value);
      listeners.forEach((f) => f());
    },
    has: (key: string) => values.has(key),
    get: <T,>(key: string, fallback: T): T =>
      values.has(key) ? (values.get(key) as T) : fallback,
    set: (key: string, value: unknown) => {
      values.set(key, value);
      listeners.forEach((f) => f());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
const Drafts = createContext<ReturnType<typeof createDrafts> | null>(null);
export function ConversationDraftProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [drafts] = useState(createDrafts);
  return <Drafts.Provider value={drafts}>{children}</Drafts.Provider>;
}
export function useConversationDraft<T>(key: string, fallback: T) {
  const initial = useRef(fallback).current;
  const shared = useContext(Drafts);
  const [local] = useState(createDrafts);
  const store = shared ?? local;
  const value = useSyncExternalStore(store.subscribe, () =>
    store.get(key, initial),
  );
  const set = (next: T | ((old: T) => T)) =>
    store.set(
      key,
      typeof next === "function"
        ? (next as (old: T) => T)(store.get(key, initial))
        : next,
    );
  return [value, set, store.has(key)] as const;
}

export function useAdoptConversationDraft(from: string) {
  const store = useContext(Drafts);
  return (to: string) => {
    if (from !== to) store?.copy(from, to);
  };
}

export function useDraftPatch() {
  const store = useContext(Drafts);
  return (key: string, values: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(values))
      store?.set(key + ":" + field, value);
  };
}
