// Shell cache + Web Push. Never touches /api/* or /auth/*. Versioned: BUILD is stamped at build time (scripts/sw-version.mjs),
// so each deploy has its own cache; a new worker waits until the page says SKIP_WAITING (auto when idle, else the update banner).
const BUILD = "__BUILD_ID__";
const COMMIT = "__COMMIT__";   // stamped at build time (scripts/sw-version.mjs); "unknown" when git was unavailable. No wall-clock stamp here: sw.js stays a pure function of content + commit
const PREFIX = "vc-shell-";
const CACHE = PREFIX + BUILD;
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/theme.js", "/appearance.js"];
const ASSETS = ["__ASSETS__"]; // stamped at build time with every hashed js/css bundle (the code-split screens are not referenced from index.html), so any screen opens offline

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache:"reload" = bypass the HTTP cache, so an install can never pin stale HTML / bundles from a cached response.
    await c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })));
    // Precache the hashed bundles the shell references so the app starts offline, not just the HTML.
    const html = await (await c.match("/")).text();
    const assets = [...new Set([...(html.match(/\/assets\/[^"'\s)]+/g) ?? []), ...ASSETS.filter((a) => a.startsWith("/assets/"))])];
    await c.addAll(assets.map((u) => new Request(u, { cache: "reload" })));
  })());
});
self.addEventListener("message", (e) => {
  const d = e.data;
  if (!d) return;
  if (d.t === "SKIP_WAITING") self.skipWaiting();
  else if (d.t === "VERSION") { // the page asks which build this worker is (BUILD here is the single source of truth)
    const r = { t: "VERSION", build: BUILD, commit: COMMIT };
    if (e.ports && e.ports[0]) e.ports[0].postMessage(r); else if (e.source) e.source.postMessage(r);
  }
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/af/")) return;
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); } return res; })
        .catch(() => caches.match("/")),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && url.pathname.startsWith("/assets/")) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});

// ---- Web Push ----
// Every push must show a notification (browsers, iOS especially, drop subscriptions that push silently).
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  const url = typeof d.url === "string" && d.url.startsWith("/") ? d.url : "/";
  e.waitUntil(self.registration.showNotification(d.title || "Vertex Client", {
    body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const mine = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (mine) { await mine.focus(); mine.postMessage({ t: "nav", url }); return; }
    await self.clients.openWindow(url);
  })());
});
