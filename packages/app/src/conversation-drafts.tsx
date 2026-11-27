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
  const versions = new Map<string, number>();
  const listeners = new Set<() => void>();
  return {
    copy: (from: string, to: string) => {
      for (const [key, value] of [...values])
        if (key.startsWith(from + ":")) {
          const target = to + key.slice(from.length);
          values.set(target, value);
          versions.set(target, (versions.get(target) ?? 0) + 1);
        }
      listeners.forEach((f) => f());
    },
    version: (key: string) => versions.get(key) ?? 0,
    has: (key: string) => values.has(key),
    get: <T,>(key: string, fallback: T): T =>
      values.has(key) ? (values.get(key) as T) : fallback,
    set: (key: string, value: unknown) => {
      values.set(key, value);
      versions.set(key, (versions.get(key) ?? 0) + 1);
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

// An ACK applies only to the exact draft revisions that were submitted, even if
// another mounted composer replaced them with identical text while HTTP waited.
export function useDraftAcknowledgement(
  prefix: string,
  fields = ["prompt", "revision-references"],
) {
  const store = useContext(Drafts);
  return () => {
    const versions = new Map(
      fields.map((field) => [field, store?.version(prefix + ":" + field)]),
    );
    return {
      unchanged: () =>
        [...versions].every(
          ([field, version]) =>
            store?.version(prefix + ":" + field) === version,
        ),
      acknowledge: (values: Record<string, unknown>) => {
        for (const [field, value] of Object.entries(values)) {
          const key = prefix + ":" + field;
          if (store && store.version(key) === versions.get(field)) {
            store.set(key, value);
            versions.set(field, store.version(key));
          }
        }
      },
    };
  };
}
