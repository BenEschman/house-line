// House Line service worker: shows push notifications and opens the app when one is tapped.
// No offline caching, so the app always loads the latest version.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "House Line", body: e.data ? e.data.text() : "" }; }
  const shown = self.registration.showNotification(d.title || "House Line", {
    body: d.body || "",
    tag: d.tag,
    renotify: !!d.tag,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: d.url || "./" },
  });
  const badge = self.navigator && self.navigator.setAppBadge ? self.navigator.setAppBadge(d.badge || 1).catch(() => {}) : null;
  e.waitUntil(Promise.all([shown, badge]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.postMessage({ type: "open", url }); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
