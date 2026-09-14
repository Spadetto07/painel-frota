/* Painel da frota — cache leve para o painel abrir mesmo sem sinal na obra.
   Regra: rede primeiro. O cache só entra quando a rede falha.

   Mudou na v3.0: os dados não vêm mais do docs.google.com, vêm do próprio
   Worker em /api/. E como a página agora fica atrás do Cloudflare Access,
   resposta redirecionada (a tela de login) nunca pode ir para o cache. */
const CACHE = "frota-v3.1";
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

/* Guardar a tela de login do Access no lugar do painel seria um problema
   difícil de entender depois: a página abriria "vazia" sem motivo aparente. */
function podeGuardar(r) {
  return r && r.ok && r.type !== "opaque" && !r.redirected;
}

function guardar(req, r) {
  if (!podeGuardar(r)) return;
  const copia = r.clone();
  caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
}

self.addEventListener("fetch", ev => {
  const req = ev.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const daCasa = url.origin === self.location.origin;

  if (daCasa) {
    /* As chamadas de dados levam um ?_=<agora> para furar cache de rede, então
       o endereço nunca repete. Na hora de servir do cache, ignorar a query é o
       que faz a última leitura guardada ser encontrada. */
    const api = url.pathname.startsWith("/api/");
    ev.respondWith(
      fetch(req).then(r => {
        guardar(req, r);
        return r;
      }).catch(() => caches.match(req, { ignoreSearch: api }))
    );
    return;
  }

  /* fontes e afins: cache primeiro, que é o que raramente muda */
  ev.respondWith(
    caches.match(req).then(r => r || fetch(req).then(x => {
      guardar(req, x);
      return x;
    }))
  );
});
