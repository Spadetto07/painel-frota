/* Painel da frota — cache leve para o painel abrir mesmo sem sinal na obra.
   Regra: rede primeiro. O cache só entra quando a rede falha. */
const CACHE = "frota-v1.5";
const CASCA = ["./", "./index.html", "./manifest.webmanifest",
               "./icone-192.png", "./icone-512.png"];

self.addEventListener("install", ev => {
  ev.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CASCA)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", ev => {
  ev.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", ev => {
  const req = ev.request;
  if(req.method !== "GET") return;
  const url = new URL(req.url);
  const daCasa = url.origin === self.location.origin;
  const dados  = /(^|\.)docs\.google\.com$|(^|\.)script\.google(usercontent)?\.com$/.test(url.hostname);

  if(daCasa || dados){
    ev.respondWith(
      fetch(req).then(r => {
        if(r && r.ok && r.type !== "opaque"){
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
        }
        return r;
      }).catch(() => caches.match(req, { ignoreSearch: dados }))
    );
    return;
  }

  /* fontes e afins: cache primeiro, que é o que raramente muda */
  ev.respondWith(
    caches.match(req).then(r => r || fetch(req).then(x => {
      if(x && x.ok && x.type !== "opaque"){
        const copia = x.clone();
        caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
      }
      return x;
    }))
  );
});
