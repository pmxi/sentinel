/* Sentinel service worker — Web Push delivery.
 *
 * iOS is strict: if a push event arrives and we do NOT display a notification,
 * Safari treats it as an abusive "silent push" and, after a few strikes,
 * revokes the subscription. So every push handler MUST call showNotification
 * inside event.waitUntil(), and we ALWAYS show something — even if the payload
 * is missing or unparseable — via a fallback. */

const FALLBACK = {
  title: "Sentinel",
  body: "You have a new important email.",
  url: "",
};

self.addEventListener("push", (event) => {
  let data = FALLBACK;
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = {
        title: parsed.title || FALLBACK.title,
        body: parsed.body || FALLBACK.body,
        url: parsed.url || "",
      };
    }
  } catch (e) {
    // Malformed payload — fall back rather than skip (skipping = silent push).
    data = FALLBACK;
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: data.url },
      tag: "sentinel-alert",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  if (!url) return;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if (win.url === url && "focus" in win) return win.focus();
      }
      return clients.openWindow(url);
    })
  );
});
