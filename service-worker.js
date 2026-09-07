/* Mi Negocio Fácil - service worker: caché para que funcione sin conexión */
const CACHE_NAME = 'mnf-cache-v36';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-48.png',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event)=>{
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache=>
      Promise.all(ASSETS.map(url => fetch(url, {cache:'reload'}).then(resp => cache.put(url, resp))))
    ).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', (event)=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))
    )).then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', (event)=>{
  if(event.request.method !== 'GET') return;
  if(new URL(event.request.url).origin !== self.location.origin) return; // deja pasar Firebase y otros orígenes sin cachear
  event.respondWith(
    caches.match(event.request).then(cached=>{
      if(cached) return cached;
      return fetch(event.request).then(resp=>{
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(cache=>cache.put(event.request, copy));
        return resp;
      }).catch(()=> cached);
    })
  );
});
