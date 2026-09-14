# Painel de Disponibilidade da Frota 720/731

Obras 720 e 731.

**Site atual (v2.2, `main`, GitHub Pages):** `index.html` na raiz, estático, lê CSV
publicado do Google Sheets direto no navegador. Continua no ar sem alteração.

**Site novo (v3.1, branch `fase-1-cloudflare-access`):** Cloudflare Worker
(`worker.js`) servindo o mesmo `index.html`/`sw.js` (agora lendo a planilha via
Sheets API com Service Account, sem CSV publicado), atrás do Cloudflare Access
(login por PIN de e-mail — sem senha). Acrescenta:

- `/cadastro` — formulário público de solicitação de acesso (nome, e-mail,
  telefone opcional, obra), fora do Access, protegido por Turnstile.
- Fila de aprovação manual (D1) com aviso automático por e-mail (Resend) —
  aprovar libera o e-mail direto na política do Access.
- `/admin` — fila de pendentes + histórico permanente de acesso (D1), já que o
  log nativo do Access no plano gratuito só guarda 24h.

Ver [SETUP.md](SETUP.md) para o checklist de configuração (contas externas,
secrets). O corte para produção (merge para `main`) só acontece depois de
validado — os dois convivem no mesmo repositório até lá.

## Estrutura (v3.1+)

- `worker.js` — todo o backend: leitura da planilha, cadastro, aprovação,
  histórico de acesso. Ver o comentário no topo do arquivo para a lista de rotas.
- `index.html`, `sw.js`, `manifest.webmanifest`, ícones — o painel em si
  (praticamente o mesmo da v2.2, só trocando de onde vêm os dados).
- `cadastro/index.html`, `admin/index.html` — páginas novas desta fase.
- `migrations/` — esquema do banco D1 (`painel-frota-db`).
- `.assetsignore` — impede que `worker.js`, `wrangler.jsonc` e outros arquivos
  de configuração fiquem baixáveis publicamente (o Worker serve a raiz inteira
  do repositório como assets estáticos).
