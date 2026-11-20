export async function registerShellWorker() {
  if (!("serviceWorker" in navigator)) return;
  let previous = navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const current = navigator.serviceWorker.controller;
    if (previous && current !== previous && !reloading) {
      reloading = true;
      window.location.reload();
    }
    previous = current;
  });
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    const update = () => {
      void registration.update().catch(() => {});
    };
    update();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") update();
    });
  } catch {}
}
