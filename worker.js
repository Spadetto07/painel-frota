/*
  Painel da frota — Cloudflare Worker
  ------------------------------------
  O que ele faz:
    - serve o painel (public/index.html e companhia) como assets estáticos;
    - /api/csv?gid=N   devolve a aba da planilha em CSV, lida pela Sheets API
                       com a conta de serviço. É o MESMO formato que o site já
                       sabe ler, então o index.html quase não mudou;
    - /api/carimbo     devolve {ok, data, hora} com a última vez que a planilha
                       foi salva, lido pela Drive API. Substitui o Apps Script
                       "Carimbo do painel da frota";
    - /api/saude       diagnóstico: diz se a chave e a planilha estão de pé.

  Quem pode entrar é decidido pelo Cloudflare Access, na frente do Worker —
  não há login, cadastro nem lista de e-mails dentro deste código.

  Segredos (wrangler secret put ou painel do Cloudflare):
    GOOGLE_CLIENT_EMAIL   e-mail da conta de serviço
    GOOGLE_PRIVATE_KEY    private_key do JSON da chave (com os \n literais ou reais)
  Variáveis (wrangler.jsonc):
    SHEET_ID              id da Planilha Google
    FUSO                  fuso para o carimbo (America/Sao_Paulo)
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rota = url.pathname;

    if (!rota.startsWith("/api/")) {
      /* Qualquer coisa que não seja /api/ é arquivo do painel. Normalmente os
         assets já respondem antes do Worker; isso aqui é a rede de segurança. */
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ ok: false, erro: "só GET" }, 405);
    }

    try {
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
        /* O Access põe o e-mail de quem entrou neste cabeçalho. */
        return json({
          ok: true,
          email: request.headers.get("cf-access-authenticated-user-email") || null,
        });
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
    } catch (e) {
      return erro(e);
    }
  },
};
