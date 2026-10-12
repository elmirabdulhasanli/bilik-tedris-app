// Qabıq fayllarının siyahısı dəyişəndə bu ad da artırılmalıdır — `activate`
// yalnız adı fərqli olan keşləri silir, ona görə ad eyni qalsa köhnə
// istifadəçilər yeni faylı heç vaxt keşə götürmür.
const CACHE_NAME = 'btm-shell-v4';
const SHELL_FILES = ['./', './index.html', './styles.css', './app.js', './logo.png', './logo.jpg', './manifest.json', './manifest-xaric.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Yalnız öz statik fayllarımızı keşləyirik — Supabase (auth/data/storage) sorğularına toxunmuruq,
// yoxsa köhnəlmiş tələbə məlumatı və ya sessiya vəziyyəti keşdən qayıda bilər.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  const url = new URL(req.url);
  // index.html / sw.js / manifest — HƏMİŞƏ əvvəlcə şəbəkədən götürülür.
  // Əks halda Netlify-ə yeni versiya yüklədikdən sonra əvvəllər saytı açmış
  // istifadəçilər köhnə keşlənmiş səhifəni görür və sayt "pozulmuş" görünür.
  const isDocument = req.mode === 'navigate' ||
    /\.(html|json|js|css)$/i.test(url.pathname) ||
    url.pathname === '/' || url.pathname.endsWith('/');

  if (isDocument) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        // Şəbəkə yoxdursa (offline) keşdəki nüsxəyə qayıt
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Şəkil və digər statik fayllar — sürət üçün əvvəlcə keşdən
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
