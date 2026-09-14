/*
  Painel da frota — Cloudflare Worker
  ------------------------------------
  O que ele faz:
    - serve o painel (index.html e companhia) como assets estáticos;
    - /api/csv?gid=N       devolve a aba da planilha em CSV, lida pela Sheets API
                           com a conta de serviço. É o MESMO formato que o site já
                           sabe ler, então o index.html quase não mudou;
    - /api/carimbo         devolve {ok, data, hora} com a última vez que a planilha
                           foi salva, lido pela Drive API. Substitui o Apps Script
                           "Carimbo do painel da frota";
    - /api/saude           diagnóstico: diz se a chave e a planilha estão de pé.
    - /cadastro            página pública de solicitação de acesso (fora do Access).
    - /cadastro/api/enviar cria um pedido pendente e avisa o admin por e-mail.
    - /admin               fila de aprovação + histórico de acesso (admin only).
    - /admin/api/*         pendentes, aprovar, rejeitar, historico.

  Quem pode entrar em qualquer rota FORA de /cadastro é decidido pelo Cloudflare
  Access, na frente do Worker (ver SETUP.md — app "site" cobrindo /* com Bypass
  em /cadastro*). A aprovação de um cadastro chama a API do Cloudflare para
  liberar o e-mail na política do Access — este código nunca guarda senha.

  Segredos (wrangler secret put ou painel do Cloudflare):
    GOOGLE_CLIENT_EMAIL   e-mail da conta de serviço
    GOOGLE_PRIVATE_KEY    private_key do JSON da chave (com os \n literais ou reais)
    RESEND_API_KEY        para os e-mails de aviso de cadastro/aprovação
    TURNSTILE_SECRET_KEY  verificação do captcha do formulário de cadastro
    CF_API_TOKEN          permissão para editar a política do Access
    CF_ACCOUNT_ID, CF_ACCESS_APP_ID, CF_ACCESS_POLICY_ID  identificam a política
  Variáveis (wrangler.jsonc):
    SHEET_ID              id da Planilha Google
    FUSO                  fuso para o carimbo (America/Sao_Paulo)
    ADMIN_EMAIL           e-mail do fundador/ADM (hardcoded)
    SITE_URL              origem pública do site, usada nos links dos e-mails
    TURNSTILE_SITE_KEY    não é secreto, injetado no HTML do cadastro
*/

"use strict";

const ESCOPOS = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
].join(" ");

/* Caches vivem no isolate: sobrevivem a várias requisições, morrem sozinhos.
   Sem isso cada carregamento do painel pediria 6 tokens ao Google. */
let cacheToken = null;   // { token, expiraEm }
let cacheAbas = null;    // { mapa: {gid: titulo}, expiraEm }
const cacheCsv = new Map(); // gid -> { csv, expiraEm }

const TTL_ABAS = 10 * 60 * 1000;
const TTL_CSV = 20 * 1000;

/* ---------- base64 / base64url ---------- */

function bytesParaB64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textoParaB64url(texto) {
  return bytesParaB64url(new TextEncoder().encode(texto));
}

/* A private_key vem em PEM PKCS#8. Dependendo de como foi colada, os \n podem
   estar literais ("\\n") em vez de quebras de linha de verdade — os dois casos
   funcionam aqui. */
function pemParaBuffer(pem) {
  const limpo = String(pem)
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(limpo);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/* ---------- token do Google ---------- */

async function pegarToken(env) {
  const agora = Date.now();
  if (cacheToken && cacheToken.expiraEm > agora + 60_000) return cacheToken.token;

  if (!env.GOOGLE_CLIENT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw new Error("faltam os secrets GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY");
  }

  const seg = Math.floor(agora / 1000);
  const cabecalho = { alg: "RS256", typ: "JWT" };
  const corpo = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: ESCOPOS,
    aud: "https://oauth2.googleapis.com/token",
    iat: seg,
    exp: seg + 3600,
  };

  const parte = textoParaB64url(JSON.stringify(cabecalho)) + "." + textoParaB64url(JSON.stringify(corpo));

  const chave = await crypto.subtle.importKey(
    "pkcs8",
    pemParaBuffer(env.GOOGLE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assinatura = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    chave,
    new TextEncoder().encode(parte),
  );

  const jwt = parte + "." + bytesParaB64url(new Uint8Array(assinatura));

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.access_token) {
    const detalhe = j && (j.error_description || j.error) ? ` (${j.error_description || j.error})` : "";
    throw new Error(`o Google recusou a chave da conta de serviço${detalhe}`);
  }

  cacheToken = {
    token: j.access_token,
    expiraEm: agora + (Number(j.expires_in) || 3600) * 1000,
  };
  return cacheToken.token;
}

/* ---------- planilha ---------- */

/* O site pede as abas por GID, mas a Sheets API trabalha com o TÍTULO da aba.
   Então primeiro montamos o mapa gid -> título. */
async function pegarMapaAbas(env) {
  const agora = Date.now();
  if (cacheAbas && cacheAbas.expiraEm > agora) return cacheAbas.mapa;

  const token = await pegarToken(env);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}?fields=sheets.properties(sheetId,title)`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });

  if (r.status === 403 || r.status === 404) {
    throw new Error(
      "a conta de serviço não consegue abrir a planilha — confira se ela foi compartilhada como Leitor",
    );
  }
  if (!r.ok) throw new Error(`a Sheets API respondeu ${r.status} ao listar as abas`);

  const j = await r.json();
  const mapa = {};
  for (const s of j.sheets || []) {
    mapa[String(s.properties.sheetId)] = s.properties.title;
  }
  cacheAbas = { mapa, expiraEm: agora + TTL_ABAS };
  return mapa;
}

/* Monta CSV igual ao que o "Publicar na web" entregava, para o index.html não
   precisar aprender nada novo. */
function paraCSV(linhas) {
  const largura = linhas.reduce((m, l) => Math.max(m, l.length), 0);
  return linhas
    .map((linha) => {
      const cheia = linha.slice();
      while (cheia.length < largura) cheia.push("");
      return cheia
        .map((c) => {
          const s = c == null ? "" : String(c);
          return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join(",");
    })
    .join("\n");
}

async function pegarCsvDaAba(env, gid) {
  const agora = Date.now();
  const guardado = cacheCsv.get(gid);
  if (guardado && guardado.expiraEm > agora) return guardado.csv;

  const mapa = await pegarMapaAbas(env);
  const titulo = mapa[gid];
  if (!titulo) throw new Error(`não existe aba com gid ${gid} nessa planilha`);

  const token = await pegarToken(env);
  /* FORMATTED_VALUE devolve o texto como aparece na tela — as datas, os
     percentuais e os emojis chegam iguais aos do CSV publicado. */
  const faixa = encodeURIComponent(`'${titulo.replace(/'/g, "''")}'`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${faixa}` +
    `?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING&majorDimension=ROWS`;

  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`a Sheets API respondeu ${r.status} ao ler "${titulo}"`);

  const j = await r.json();
  const csv = paraCSV(j.values || []);
  cacheCsv.set(gid, { csv, expiraEm: agora + TTL_CSV });
  return csv;
}

/* ---------- carimbo ---------- */

/* Mesma resposta que o Apps Script dava: {ok:true, data:"13/09/2026", hora:"20:15"}.
   A hora é a da última vez que a planilha foi SALVA, não a do acesso. */
async function pegarCarimbo(env) {
  const token = await pegarToken(env);
  const url = `https://www.googleapis.com/drive/v3/files/${env.SHEET_ID}?fields=modifiedTime&supportsAllDrives=true`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`a Drive API respondeu ${r.status}`);

  const { modifiedTime } = await r.json();
  const quando = new Date(modifiedTime);
  const fuso = env.FUSO || "America/Sao_Paulo";

  const data = new Intl.DateTimeFormat("pt-BR", {
    timeZone: fuso,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(quando);

  const hora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: fuso,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(quando);

  return { ok: true, data, hora, iso: modifiedTime };
}

/* ---------- respostas ---------- */

const semCache = {
  "cache-control": "no-store, max-age=0",
};

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...semCache },
  });
}

function erro(e, status = 502) {
  return json({ ok: false, erro: String((e && e.message) || e) }, status);
}

/* ---------- cadastro, aprovação e histórico de acesso ---------- */

function emailAutenticado(request) {
  /* Confiável só porque toda rota que chama isto fica atrás do Cloudflare
     Access — o Access remove qualquer Cf-Access-* que o cliente tente forjar
     e só define este cabeçalho depois de validar a sessão. */
  return request.headers.get("cf-access-authenticated-user-email") || null;
}

async function registrarAcesso(env, { identificador, resultado, motivo, ip, userAgent }) {
  await env.DB.prepare(
    "INSERT INTO login_history (identificador, resultado, motivo, ip, user_agent) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(identificador, resultado, motivo, ip || null, userAgent || null)
    .run();
}

async function verificarTurnstile(env, token, ip) {
  if (!token) return false;
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
  });
  if (!r.ok) return false;
  const j = await r.json().catch(() => null);
  return j?.success === true;
}

const REMETENTE = "Painel de Frota <onboarding@resend.dev>"; // trocar quando tiver domínio verificado no Resend

async function enviarEmail(env, { para, assunto, html }) {
  if (!env.RESEND_API_KEY) return; // sem secret configurado ainda, não trava o cadastro
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: REMETENTE, to: [para], subject: assunto, html }),
  });
  if (!r.ok) console.error("falha ao enviar e-mail:", r.status, await r.text().catch(() => ""));
}

async function avisarAdminDeCadastroPendente(env, c) {
  await enviarEmail(env, {
    para: env.ADMIN_EMAIL,
    assunto: `Novo cadastro pendente: ${c.nome}`,
    html: `
      <p>Novo pedido de acesso ao Painel de Frota 720/731:</p>
      <ul>
        <li><b>Nome:</b> ${c.nome}</li>
        <li><b>E-mail:</b> ${c.email}</li>
        <li><b>Telefone:</b> ${c.telefone || "não informado"}</li>
        <li><b>Obra:</b> ${c.obra || "não informado"}</li>
      </ul>
      <p><a href="${env.SITE_URL}/admin">Abrir painel de aprovação</a></p>
    `,
  });
}

async function avisarUsuarioAprovado(env, c) {
  await enviarEmail(env, {
    para: c.email,
    assunto: "Seu acesso ao Painel de Frota foi liberado",
    html: `
      <p>Olá, ${c.nome}.</p>
      <p>Seu acesso ao Painel de Frota 720/731 foi aprovado.</p>
      <p><a href="${env.SITE_URL}/">Acessar o painel</a></p>
      <p>Você vai receber um código por e-mail a cada vez que entrar — não é necessário senha.</p>
    `,
  });
}

/* Libera o e-mail aprovado na política do Cloudflare Access, sem sobrescrever
   quem já estava liberado. GET + PUT porque a API do Access não tem "adicionar
   um e-mail", só "substituir a lista inteira". */
async function liberarEmailNoAccess(env, email) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/apps/${env.CF_ACCESS_APP_ID}/policies/${env.CF_ACCESS_POLICY_ID}`;
  const headers = { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" };

  const getResp = await fetch(base, { headers });
  if (!getResp.ok) throw new Error(`falha ao ler política do Access: ${getResp.status}`);
  const atual = (await getResp.json()).result;

  const jaTem = (atual.include || []).some((regra) => regra.email?.email === email);
  const novoInclude = jaTem ? atual.include : [...(atual.include || []), { email: { email } }];

  const putResp = await fetch(base, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: atual.name,
      decision: atual.decision,
      include: novoInclude,
      exclude: atual.exclude || [],
      require: atual.require || [],
    }),
  });
  if (!putResp.ok) {
    throw new Error(`falha ao atualizar política do Access: ${putResp.status} ${await putResp.text()}`);
  }
}

async function tratarCadastro(request, env) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return json({ ok: false, erro: "Corpo inválido" }, 400);
  }

  const nome = String(corpo.nome || "").trim();
  const email = String(corpo.email || "").trim().toLowerCase();
  const telefone = corpo.telefone ? String(corpo.telefone).trim() : null;
  const obra = corpo.obra ? String(corpo.obra).trim() : null;
  const ip = request.headers.get("CF-Connecting-IP");

  if (!nome || !email || !email.includes("@")) {
    return json({ ok: false, erro: "Nome e e-mail válido são obrigatórios" }, 400);
  }

  if (!(await verificarTurnstile(env, corpo.turnstileToken, ip))) {
    return json({ ok: false, erro: "Verificação de segurança falhou, tente novamente" }, 400);
  }

  const jaAprovado = await env.DB.prepare("SELECT 1 FROM usuarios_aprovados WHERE email = ? AND ativo = 1")
    .bind(email)
    .first();
  if (jaAprovado) return json({ ok: false, erro: "Este e-mail já tem acesso liberado." }, 409);

  const jaPendente = await env.DB.prepare("SELECT 1 FROM pending_registrations WHERE email = ? AND status = 'pendente'")
    .bind(email)
    .first();
  if (jaPendente) {
    return json({ ok: true, mensagem: "Seu cadastro já está pendente de aprovação." });
  }

  await env.DB.prepare("INSERT INTO pending_registrations (nome, email, telefone, obra) VALUES (?, ?, ?, ?)")
    .bind(nome, email, telefone, obra)
    .run();

  await avisarAdminDeCadastroPendente(env, { nome, email, telefone, obra });

  return json({ ok: true, mensagem: "Cadastro enviado. Você vai receber um e-mail quando for aprovado." });
}

function exigirAdmin(request, env) {
  const email = emailAutenticado(request);
  if (!email) return { erro: json({ ok: false, erro: "Não autenticado" }, 401) };
  if (email.toLowerCase() !== String(env.ADMIN_EMAIL || "").toLowerCase()) {
    return { erro: json({ ok: false, erro: "Acesso restrito ao administrador" }, 403) };
  }
  return { email };
}

async function listarPendentes(request, env) {
  const { erro: err } = exigirAdmin(request, env);
  if (err) return err;
  const { results } = await env.DB.prepare(
    "SELECT id, nome, email, telefone, obra, criado_em FROM pending_registrations WHERE status = 'pendente' ORDER BY criado_em ASC",
  ).all();
  return json({ ok: true, pendentes: results });
}

async function aprovarCadastro(request, env) {
  const { erro: err, email: adminEmail } = exigirAdmin(request, env);
  if (err) return err;

  const { id } = await request.json();
  const pendente = await env.DB.prepare("SELECT * FROM pending_registrations WHERE id = ? AND status = 'pendente'")
    .bind(id)
    .first();
  if (!pendente) return json({ ok: false, erro: "Cadastro pendente não encontrado" }, 404);

  await liberarEmailNoAccess(env, pendente.email);

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE pending_registrations SET status = 'aprovado', decidido_em = datetime('now'), decidido_por = ? WHERE id = ?",
    ).bind(adminEmail, id),
    env.DB.prepare(
      "INSERT INTO usuarios_aprovados (nome, email, telefone, obra, aprovado_por) VALUES (?, ?, ?, ?, ?)",
    ).bind(pendente.nome, pendente.email, pendente.telefone, pendente.obra, adminEmail),
  ]);

  await avisarUsuarioAprovado(env, pendente);

  return json({ ok: true });
}

async function rejeitarCadastro(request, env) {
  const { erro: err, email: adminEmail } = exigirAdmin(request, env);
  if (err) return err;

  const { id } = await request.json();
  await env.DB.prepare(
    "UPDATE pending_registrations SET status = 'rejeitado', decidido_em = datetime('now'), decidido_por = ? WHERE id = ? AND status = 'pendente'",
  )
    .bind(adminEmail, id)
    .run();
  return json({ ok: true });
}

async function historicoDeLogin(request, env) {
  const { erro: err } = exigirAdmin(request, env);
  if (err) return err;
  const url = new URL(request.url);
  const limite = Math.min(Number(url.searchParams.get("limite")) || 200, 1000);
  const { results } = await env.DB.prepare(
    "SELECT quando, identificador, resultado, motivo, ip, user_agent FROM login_history ORDER BY quando DESC LIMIT ?",
  )
    .bind(limite)
    .all();
  return json({ ok: true, registros: results });
}

/* Registra a navegação em página protegida (não sub-recursos como css/imagens),
   permanentemente — diferente do log nativo do Access, que só guarda 24h no
   plano gratuito e só registra tentativas que completaram o PIN. */
async function registrarNavegacaoProtegida(request, env) {
  const aceita = request.headers.get("Accept") || "";
  if (request.method !== "GET" || !aceita.includes("text/html")) return;

  const email = emailAutenticado(request);
  const ip = request.headers.get("CF-Connecting-IP");
  const userAgent = request.headers.get("User-Agent");

  if (!email) {
    await registrarAcesso(env, { identificador: "desconhecido", resultado: "falha", motivo: "sem_email_access", ip, userAgent });
    return;
  }
  await registrarAcesso(env, { identificador: email, resultado: "sucesso", motivo: "ok", ip, userAgent });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rota = url.pathname;

    try {
      // ---- dados da planilha (existente) ----
      if (rota.startsWith("/api/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json({ ok: false, erro: "só GET" }, 405);
        }

        if (rota === "/api/csv") {
          const gid = url.searchParams.get("gid");
          if (!gid || !/^\d+$/.test(gid)) return json({ ok: false, erro: "gid inválido" }, 400);
          const csv = await pegarCsvDaAba(env, gid);
          return new Response(csv, {
            headers: { "content-type": "text/csv; charset=utf-8", ...semCache },
          });
        }

        if (rota === "/api/carimbo") {
          return json(await pegarCarimbo(env));
        }

        if (rota === "/api/quemsou") {
          return json({ ok: true, email: emailAutenticado(request) });
        }

        if (rota === "/api/saude") {
          const conferencia = { ok: true, segredos: {}, planilha: null, carimbo: null };
          conferencia.segredos.GOOGLE_CLIENT_EMAIL = env.GOOGLE_CLIENT_EMAIL ? "presente" : "FALTANDO";
          conferencia.segredos.GOOGLE_PRIVATE_KEY = env.GOOGLE_PRIVATE_KEY ? "presente" : "FALTANDO";
          conferencia.segredos.SHEET_ID = env.SHEET_ID || "FALTANDO";
          try {
            const mapa = await pegarMapaAbas(env);
            conferencia.planilha = { abas: Object.keys(mapa).length, mapa };
          } catch (e) {
            conferencia.ok = false;
            conferencia.planilha = { erro: String(e.message || e) };
          }
          try {
            conferencia.carimbo = await pegarCarimbo(env);
          } catch (e) {
            conferencia.ok = false;
            conferencia.carimbo = { erro: String(e.message || e) };
          }
          return json(conferencia, conferencia.ok ? 200 : 502);
        }

        return json({ ok: false, erro: "rota desconhecida" }, 404);
      }

      // ---- cadastro público (fora do Access — ver SETUP.md) ----
      if (rota === "/cadastro/api/enviar" && request.method === "POST") {
        return await tratarCadastro(request, env);
      }

      // ---- administração (atrás do Access + checagem de ADMIN_EMAIL) ----
      if (rota === "/admin/api/pendentes" && request.method === "GET") {
        return await listarPendentes(request, env);
      }
      if (rota === "/admin/api/aprovar" && request.method === "POST") {
        return await aprovarCadastro(request, env);
      }
      if (rota === "/admin/api/rejeitar" && request.method === "POST") {
        return await rejeitarCadastro(request, env);
      }
      if (rota === "/admin/api/historico" && request.method === "GET") {
        return await historicoDeLogin(request, env);
      }
    } catch (e) {
      return erro(e);
    }

    // ---- páginas ----
    // Tudo que chegar aqui e não for /cadastro* já passou pelo Cloudflare
    // Access (ver SETUP.md), então é seguro registrar como acesso autenticado.
    if (!rota.startsWith("/cadastro")) {
      await registrarNavegacaoProtegida(request, env);
    }

    // O site de cadastro precisa da site key do Turnstile injetada no HTML.
    if (rota === "/cadastro" || rota === "/cadastro/" || rota === "/cadastro/index.html") {
      const resp = await env.ASSETS.fetch(request);
      const html = await resp.text();
      return new Response(html.replace("__TURNSTILE_SITE_KEY__", env.TURNSTILE_SITE_KEY || ""), {
        status: resp.status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
