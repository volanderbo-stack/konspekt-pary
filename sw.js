// Service Worker: застосунок працює офлайн. Оболонка — у кеші при встановленні,
// бібліотеки (ffmpeg ≈30 МБ, Claude SDK) — у кеші після першого використання.
const VERSION = 'konspekt-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/jobs.js', 'js/parsers.js', 'js/markdown.js', 'js/export.js',
  'js/player.js', 'js/recorder.js', 'js/summary.js', 'js/transcribe.js', 'js/ffmpeg.js', 'js/util.js',
  'vendor/jszip.min.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Запити до API ніколи не кешуємо
  if (/api\.openai\.com|api\.anthropic\.com/.test(url.host)) return;
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && url.host !== 'cdn.jsdelivr.net') return;

  // Код застосунку: спершу мережа (щоб оновлення приходили), офлайн — кеш
  if (sameOrigin && !url.pathname.includes('/vendor/')) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req, { ignoreSearch: true }))
          || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
      }
    })());
    return;
  }

  // Бібліотеки з фіксованою версією: спершу кеш
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
    return res;
  })());
});
