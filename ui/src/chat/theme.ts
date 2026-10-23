export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "rolebound-theme";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readTheme(): ThemeChoice {
  const store = storage();
  if (!store) return "system";
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* ignore */
  }
  return "system";
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, choice);
  } catch {
    /* ignore */
  }
}

export function resolvedTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice === "light") return "light";
  if (choice === "dark") return "dark";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function cycleTheme(choice: ThemeChoice): ThemeChoice {
  const next = resolvedTheme(choice) === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
