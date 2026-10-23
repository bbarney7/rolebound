import type { Page } from "@playwright/test";

export function interactions(page: Page) {
  let installPromise: Promise<void> | null = null;

  function ensureInstall() {
    if (!installPromise) {
      installPromise = (async () => {
        await page.addInitScript(() => {
          const state = window as unknown as { __rbInteractions?: number };
          state.__rbInteractions = 0;
          const bump = () => {
            state.__rbInteractions = (state.__rbInteractions ?? 0) + 1;
          };
          document.addEventListener(
            "click",
            (event) => {
              if (event.isTrusted) bump();
            },
            true,
          );
          document.addEventListener(
            "keydown",
            (event) => {
              if (!event.isTrusted) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              const target = event.target;
              if (!(target instanceof Element)) return;
              const control = target.closest(
                "button,a,input,select,textarea,summary,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='menuitem'],[role='tab']",
              );
              if (control) bump();
            },
            true,
          );
          document.addEventListener("change", () => bump(), true);
        });
      })();
    }
    return installPromise;
  }

  return {
    install: () => ensureInstall(),
    count: async () => {
      await ensureInstall();
      return page.evaluate(
        () => (window as unknown as { __rbInteractions?: number }).__rbInteractions ?? 0,
      );
    },
  };
}
