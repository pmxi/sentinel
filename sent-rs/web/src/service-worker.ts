const reloadGuards = new Set<() => Promise<void>>();
const reloadChecks = new Set<() => void>();

export function holdShellReload(flush: () => Promise<void>) {
  reloadGuards.add(flush);
  return () => {
    void flush()
      .then(() => {
        reloadGuards.delete(flush);
        for (const check of reloadChecks) check();
      })
      .catch(() => {});
  };
}

export async function registerShellWorker() {
  if (!("serviceWorker" in navigator)) return;
  let previous = navigator.serviceWorker.controller;
  let reloading = false;
  let pending = false;
  let disposed = false;
  const check = () => {
    if (!pending || reloading || disposed) return;
    if (reloadGuards.size) {
      for (const flush of reloadGuards) void flush().catch(() => {});
      return;
    }
    reloading = true;
    window.location.reload();
  };
  const controllerChange = () => {
    const current = navigator.serviceWorker.controller;
    if (previous && current !== previous) pending = true;
    previous = current;
    check();
  };
  reloadChecks.add(check);
  navigator.serviceWorker.addEventListener("controllerchange", controllerChange);
  let visible: (() => void) | undefined;
  const dispose = () => {
    disposed = true;
    reloadChecks.delete(check);
    navigator.serviceWorker.removeEventListener?.("controllerchange", controllerChange);
    if (visible) document.removeEventListener("visibilitychange", visible);
  };
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    const update = () => {
      void registration.update().catch(() => {});
    };
    update();
    visible = () => {
      if (document.visibilityState === "visible") update();
    };
    document.addEventListener("visibilitychange", visible);
  } catch {
    dispose();
    return;
  }
  return dispose;
}
