/* Sentinel push enrollment (vanilla JS, no build step).
 *
 * Drives the "Enable notifications" button on the console. Handles the iOS
 * reality that Web Push only works inside an installed (Home Screen) PWA, and
 * that iOS may silently drop a subscription — so on every standalone launch we
 * re-check and re-register the subscription (idempotent upsert server-side). */

(function () {
  const root = document.getElementById("push-setup");
  if (!root) return;

  const vapidKey = root.dataset.vapidKey;
  const csrfToken = root.dataset.csrf;
  const statusEl = document.getElementById("push-status");
  const enableBtn = document.getElementById("push-enable");
  const disableBtn = document.getElementById("push-disable");
  const iosHint = document.getElementById("push-ios-hint");

  const supported = "serviceWorker" in navigator && "PushManager" in window;
  // iOS only fires push in a Home-Screen ("standalone") install, never a tab.
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  function show(el, on) {
    if (el) el.style.display = on ? "" : "none";
  }
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function urlBase64ToUint8Array(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify(body),
    });
  }

  async function register() {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    return reg;
  }

  async function subscribe() {
    setStatus("Enabling…");
    const reg = await register();
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      setStatus("Permission denied. Enable notifications for this app in Settings.");
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    const resp = await post("/push/subscribe", sub.toJSON());
    if (resp.ok) {
      setStatus("Notifications on for this device ✓");
      show(enableBtn, false);
      show(disableBtn, true);
    } else {
      setStatus("Could not register this device. Try again.");
    }
  }

  async function unsubscribe() {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      await post("/push/unsubscribe", { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    setStatus("Notifications off for this device.");
    show(enableBtn, true);
    show(disableBtn, false);
  }

  // Re-assert the subscription on launch: iOS can drop it without warning, and
  // the server upsert is idempotent, so this self-heals a stale registration.
  async function refresh() {
    try {
      const reg = await register();
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await post("/push/subscribe", sub.toJSON());
        setStatus("Notifications on for this device ✓");
        show(enableBtn, false);
        show(disableBtn, true);
      }
    } catch (e) {
      /* best-effort; the button still works */
    }
  }

  if (!supported) {
    setStatus("This browser doesn't support notifications.");
    show(enableBtn, false);
    return;
  }
  if (isIOS && !isStandalone) {
    // The button can't work until the app is installed to the Home Screen.
    show(iosHint, true);
    show(enableBtn, false);
    setStatus("");
  } else {
    if (enableBtn) enableBtn.addEventListener("click", () => subscribe().catch(() => setStatus("Something went wrong.")));
    if (disableBtn) disableBtn.addEventListener("click", () => unsubscribe().catch(() => setStatus("Something went wrong.")));
    refresh();
  }
})();
