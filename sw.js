// Emergency Cache Purge & Service Worker Reset (v7.8.16)
self.addEventListener("install", e => {
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(keys.map(k => caches.delete(k)));
    }).then(() => {
      return self.registration.unregister();
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// ห้ามดักจับ static assets ให้ปล่อยผ่านไปยังเน็ตเวิร์ก/เซิร์ฟเวอร์โดยตรงทั้งหมด
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request));
});
