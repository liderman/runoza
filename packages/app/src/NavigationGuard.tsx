import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog, Text } from "@gravity-ui/uikit";
type Entry = { dirty: boolean; discard: () => void };
const Context = createContext<{
  entries: Map<object, Entry>;
  navigate: (action: () => void, only?: object, onCancel?: () => void) => void;
  pending: (() => void) | null;
  cancel: () => void;
  discard: () => void;
}>(null!);
export function NavigationGuard({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<object, Entry>()).current;
  const scope = useRef<object | undefined>(undefined);
  const cancellation = useRef<(() => void) | undefined>(undefined);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const navigate = (
    action: () => void,
    only?: object,
    onCancel?: () => void,
  ) => {
    if (
      only
        ? entries.get(only)?.dirty
        : [...entries.values()].some((e) => e.dirty)
    ) {
      cancellation.current?.();
      cancellation.current = onCancel;
      scope.current = only;
      setPending(() => action);
    } else action();
  };
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if ([...entries.values()].some((v) => v.dirty)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [entries]);
  return (
    <Context.Provider
      value={{
        entries,
        navigate,
        pending,
        cancel: () => {
          cancellation.current?.();
          cancellation.current = undefined;
          setPending(null);
        },
        discard: () => {
          cancellation.current = undefined;
          for (const [key, e] of entries) {
            if (scope.current && scope.current !== key) continue;
            if (e.dirty) e.discard();
            e.dirty = false;
          }
          setPending(null);
          pending?.();
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useNavigationGuard() {
  return useContext(Context);
}
export function useDirtyGuard(dirty: boolean, discard: () => void = () => {}) {
  const { entries } = useNavigationGuard();
  const key = useRef({}).current;
  useLayoutEffect(() => {
    entries.set(key, { dirty, discard });
    return () => {
      entries.delete(key);
    };
  }, [entries, key, dirty, discard]);
  return key;
}
export function UnsavedDialog({ locale }: { locale: "en" | "ru" }) {
  const g = useNavigationGuard();
  const ru = locale === "ru";
  return (
    <Dialog
      open={Boolean(g.pending)}
      onOpenChange={(open) => {
        if (!open) g.cancel();
      }}
      maxWidth="s"
    >
      <Dialog.Header
        caption={ru ? "Сохранить изменения?" : "Unsaved changes"}
      />
      <Dialog.Body>
        <Text>
          {ru
            ? "Есть несохранённые изменения. Вернитесь и сохраните их или продолжите без сохранения."
            : "You have unsaved changes. Go back to save them, or discard them and continue."}
        </Text>
      </Dialog.Body>
      <Dialog.Footer
        textButtonCancel={ru ? "Продолжить редактирование" : "Keep editing"}
        textButtonApply={ru ? "Не сохранять" : "Discard changes"}
        propsButtonApply={{ view: "outlined-danger" }}
        onClickButtonCancel={g.cancel}
        onClickButtonApply={g.discard}
      />
    </Dialog>
  );
}
