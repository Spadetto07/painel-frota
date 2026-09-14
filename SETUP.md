# Checklist de configuração — Fase 1

Passos que só você consegue fazer (exigem login nas suas contas). Siga na ordem.
Cada item que gera um valor secreto diz exatamente onde colar depois (passo 7).

Esta é a versão mesclada: mantém `index.html`/`sw.js` do painel atual quase
intactos (lendo a planilha ao vivo via `worker.js`, sem banco de cache) e
acrescenta cadastro público + fila de aprovação + histórico permanente de
acesso no D1.

## 0. A chave da conta de serviço já existe — só falta guardar direito

Você já tinha baixado a chave JSON da conta de serviço `painel-frota-leitor`
(projeto Google Cloud `upbeat-arch-508522`). Eu a movi para fora da pasta do
projeto: agora está em
`C:\Users\vinic\OneDrive\Desktop\CHAVE-SERVICE-ACCOUNT-painel-frota-NAO-COMMITAR.json`.
Ela **nunca** deve voltar para dentro da pasta do repositório. Você só precisa
dela para copiar dois campos no passo 7 (`client_email` e `private_key`).

Se essa chave já chegou a ficar em algum momento dentro do repositório
enquanto ele era público — verifique o histórico do git antes de prosseguir.
Se tiver ficado, considere-a vazada e gere uma nova chave para essa mesma
conta de serviço no Google Cloud Console (Credenciais → a conta de serviço →
aba Chaves → apagar a antiga → criar uma nova).

## 1. APIs do Google já habilitadas?

No projeto `upbeat-arch-508522` (console.cloud.google.com), confirme em
**APIs e serviços → Biblioteca** que **Google Sheets API** e **Google Drive
API** estão ativadas. A planilha "Controle de Frota" precisa estar
compartilhada com o e-mail da conta de serviço como **Leitor** (não Editor).

## 2. Resend (envio de e-mail)

1. Crie conta gratuita em https://resend.com (sem cartão).
2. **API Keys → Create API Key** → copie o valor → vira o secret `RESEND_API_KEY`.
3. O remetente `onboarding@resend.dev` (já usado em `worker.js`) funciona sem
   verificação de domínio. Quando quiser um remetente com domínio próprio
   (ex: `painel@suaempresa.com.br`), me avise para trocarmos.

## 3. Cloudflare Turnstile (anti-spam do cadastro)

1. Dashboard do Cloudflare → **Turnstile** → **Add site**.
2. Domínio: o `*.workers.dev` que vamos usar (dá pra adicionar depois do
   primeiro deploy, se ainda não souber o domínio exato).
3. Copie o **Site Key** → vira a variável `TURNSTILE_SITE_KEY` em `wrangler.jsonc`.
4. Copie o **Secret Key** → vira o secret `TURNSTILE_SECRET_KEY`.

## 4. Cloudflare Access (protege o site inteiro, exceto /cadastro)

1. Dashboard do Cloudflare → **Zero Trust** → escolha um **Team name** (ex:
   `frota720731`) na primeira vez — isso define `ACCESS_TEAM_DOMAIN`
   (`frota720731.cloudflareaccess.com`), embora este projeto não precise mais
   verificar o JWT por conta própria (ver nota abaixo).
2. **Settings → Authentication → Login methods** → confirme que **One-time
   PIN** está habilitado.
3. **Access → Applications → Add an application → Self-hosted**:
   - **App "Site"**: domínio `painel-frota.<sua-conta>.workers.dev`, caminho
     `/*` (o site inteiro). Política `aprovados`, Action **Allow**, regra
     **Emails** começando só com `viniciusspadetto@gmail.com` (os demais
     entram automaticamente quando você aprova o cadastro deles).
   - **App "Cadastro" (bypass)**: mesmo domínio, caminho `/cadastro*`.
     Política com Action **Bypass** (sem exigir login). Como o Access resolve
     pelo caminho mais específico primeiro, `/cadastro*` fica público mesmo
     com a App "Site" cobrindo `/*`.
4. Da **App "Site"**, anote:
   - **Account ID** (barra lateral do dashboard) → `CF_ACCOUNT_ID`
   - **Application ID** → `CF_ACCESS_APP_ID`
   - **Policy ID** da política `aprovados` → `CF_ACCESS_POLICY_ID`

   > Nota técnica: como o Worker já roda **atrás** do Access (a App "Site"
   > cobre `/*`), ele não precisa verificar assinatura de JWT — confia direto
   > no cabeçalho `Cf-Access-Authenticated-User-Email`, que só o próprio
   > Access consegue definir (ele remove qualquer versão forjada pelo
   > cliente). Por isso `ACCESS_AUD` e a verificação de JWT do plano anterior
   > não são mais necessárias.

## 5. Token de API do Cloudflare (para o sistema liberar e-mails automaticamente)

1. Dashboard → ícone do perfil → **My Profile → API Tokens → Create Token**.
2. Template **Edit Cloudflare Access** (ou customizado com **Account →
   Access: Apps and Policies → Edit**).
3. Copie o token → vira o secret `CF_API_TOKEN`.

## 6. Criar o projeto Worker e conectar ao GitHub

1. Dashboard → **Workers & Pages → Create → Import a repository**.
2. Autorize o Cloudflare a acessar `Spadetto07/painel-frota`.
3. **Branch de produção:** aponte para `main` — só fazemos o merge de
   `fase-1-cloudflare-access` quando tudo estiver testado (o GitHub Pages
   atual continua servindo `main` sem alteração até lá). Configure um deploy
   de preview apontando para `fase-1-cloudflare-access` para testar antes.
4. Build command: padrão detectado (`wrangler deploy`), já que há
   `wrangler.jsonc` e `package.json` no repositório.
5. Depois do primeiro deploy, copie a URL `*.workers.dev` e me avise — preciso
   atualizar `SITE_URL` em `wrangler.jsonc` e os domínios do Turnstile/Access
   se você os configurou com um "chute" antes do deploy real.

## 7. Configurar os Secrets no Worker

**Workers & Pages → painel-frota → Settings → Variables and Secrets** →
adicione cada um como **Secret** (criptografado):

- `GOOGLE_CLIENT_EMAIL` — do arquivo da chave (passo 0), campo `client_email`
- `GOOGLE_PRIVATE_KEY` — do arquivo da chave (passo 0), campo `private_key`
- `RESEND_API_KEY`
- `TURNSTILE_SECRET_KEY`
- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `CF_ACCESS_APP_ID`
- `CF_ACCESS_POLICY_ID`

(`SHEET_ID`, `FUSO`, `ADMIN_EMAIL`, `SITE_URL`, `TURNSTILE_SITE_KEY` já estão
em `wrangler.jsonc` como variáveis normais, não secretas.)

## 8. Tornar o repositório privado

GitHub → repositório `painel-frota` → **Settings → General → Danger Zone →
Change visibility → Make private**. Só depois que o deploy estiver validado
(o GitHub Pages atual depende do repo público).

## 9. Despublicar a planilha (o último passo, só depois de tudo validado)

Google Sheets → **Arquivo → Compartilhar → Publicar na Web → Parar de
publicar**. Mata o link CSV antigo (`PUB_ID`) para sempre.

## 10. Onboarding — como as pessoas descobrem o `/cadastro`

Como o Access protege o site inteiro, quem tentar abrir a URL principal sem
estar aprovado cai direto na tela de login do Cloudflare (pede e-mail) e,
se não estiver na lista, num "Acesso negado" genérico — sem link nenhum para
`/cadastro`. Então, por enquanto, **compartilhe o link `/cadastro` diretamente**
(WhatsApp, etc.) com quem for pedir acesso pela primeira vez; a URL raiz é só
para quem já foi aprovado. Se quiser, dá pra customizar a página de "Acesso
negado" do Access (Zero Trust → Settings → Custom Pages) com um link para
`/cadastro` — não fiz isso ainda para não aumentar o escopo, me avise se quiser.

---

Me avise a cada passo concluído (ou se travar em algum) — vou seguindo a
implementação em paralelo e testando conforme os secrets forem ficando
disponíveis.
