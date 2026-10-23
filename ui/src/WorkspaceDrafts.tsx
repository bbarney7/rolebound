import { createContext, useContext, useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

type DraftStore = { values: Map<string, unknown>; dirty: Set<string> };
const Context = createContext<DraftStore | null>(null);
export function WorkspaceDraftProvider({ children }: { children: ReactNode }) {
  const store = useRef<DraftStore>({ values: new Map(), dirty: new Set() }).current;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!store.dirty.size) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
/** Tab-lifetime, memory-only state. Never use for passwords, keys or login codes. */
export function useWorkspaceState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(Context);
  const [state, setState] = useState<T>(() => store?.values.has(key) ? store.values.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial);
  const latest = useRef(state);
  latest.current = state;
  const update: Dispatch<SetStateAction<T>> = useCallback(next => {
    // Resolve against the shared draft even if a save finishes after unmount.
    const previous = store?.values.has(key) ? store.values.get(key) as T : latest.current;
    const value = typeof next === "function" ? (next as (old: T) => T)(previous) : next;
    latest.current = value;
    store?.values.set(key, value);
    setState(value);
  }, [store,key]);
  return [state, update];
}
export function useUnsavedChanges(key: string, dirty: boolean, retainOnUnmount = true) {
  const store = useContext(Context);
  useEffect(() => { if (dirty) store?.dirty.add(key); else store?.dirty.delete(key); return () => { if (!retainOnUnmount) store?.dirty.delete(key); }; }, [store, key, dirty, retainOnUnmount]);
}
