
const CACHE_NAME = "ot-calculator-v7.8.11";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/app.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/apple-touch-icon-180.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;

  // สำหรับการเปิดหน้าเว็บ (HTML Navigation): Network First เพื่อให้ผู้ใช้ได้เวอร์ชันล่าสุดเสมอเมื่อออนไลน์
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  // สำหรับ static assets: Stale-While-Revalidate
  e.respondWith(
    caches.match(e.request).then(response => {
      if (response) {
        // โหลดจากแคช แล้วดึงของใหม่จากเซิร์ฟเวอร์ไปอัปเดตแคชเบื้องหลัง
        fetch(e.request).then(res => {
          if (res && res.status === 200) {
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, res));
          }
        }).catch(() => {});
        return response;
      }

      return fetch(e.request).catch(() => caches.match("./index.html"));
    })
  );
});
