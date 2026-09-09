/* 拾音 Service Worker —— 只缓存界面静态资源（转写功能走本地服务，不受影响） */
const CACHE = 'shiyin-v6'; // v6: v1.0.0 前端大改（链接蒸馏/AI 总结/热词）强制刷新 // v4: 图标重设计（麦克风+声波），修 v3 缓存残留 // v3: 图标重设计（波形条） // v2: 图标换新版（透明背景）

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(['/', '/manifest.json', '/app-icon.ico', '/app-icon.png', '/app-icon-512.png'])
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 只处理同源 GET；API 请求（/api/*）不缓存、直接走网络
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
