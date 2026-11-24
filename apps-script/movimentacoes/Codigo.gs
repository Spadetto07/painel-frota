/**
 * Registro automático de movimentações da frota.
 *
 * Toda vez que a planilha muda, compara o estado atual da aba "Controle de Frota"
 * com o último estado guardado e anota na aba "MOVIMENTAÇÕES" o que mudou:
 * quem ficou parado, quem voltou a operar e por qual motivo.
 *
 * Rode "preparar" uma vez para criar as abas, semear o histórico e ligar o gatilho.
 */

const ABA_FROTA  = "Controle de Frota";
const ABA_LOG    = "MOVIMENTAÇÕES";
const ABA_ESTADO = "_ESTADO";
const FUSO       = "America/Sao_Paulo";

const CABECALHO_LOG = [
  "DATA/HORA", "PREFIXO", "CATEGORIA", "MODELO",
  "MUDANÇA", "DE", "PARA", "MOTIVO", "OBRA", "LOCAL"
];

/* ---------- instalação ---------- */

function preparar() {
  const ss = SpreadsheetApp.getActive();
  criarAbas(ss);
  const atual = lerFrota(ss);

  if (abaLog(ss).getLastRow() <= 1) {
    const semente = semear(atual);
    if (semente.length) escreverLog(ss, semente);
  }
  salvarEstado(ss, atual);
  instalarGatilho();

  SpreadsheetApp.getActive().toast(
    "Registro de movimentações ligado. " + abaLog(ss).getLastRow() + " linha(s) no histórico.",
    "Pronto", 8
  );
}

function instalarGatilho() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "registrarMovimentacoes") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("registrarMovimentacoes")
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onChange()
    .create();
}

/* ---------- o que roda a cada mudança ---------- */

function registrarMovimentacoes() {
  const ss = SpreadsheetApp.getActive();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;   // duas edições ao mesmo tempo: a segunda espera

  try {
    criarAbas(ss);
    const atual = lerFrota(ss);
    const anterior = lerEstado(ss);
    const agora = new Date();
    const linhas = [];

    Object.keys(atual).forEach(function (pre) {
      const e = atual[pre];
      const a = anterior[pre];
      if (!a) return;                              // equipamento novo na planilha

      const mudouStatus = a.status !== e.status;
      const mudouMotivo = (a.defeito || "") !== (e.defeito || "");

      if (mudouStatus) {
        linhas.push([
          agora, pre, e.categoria, e.modelo,
          rotuloMudanca(a.status, e.status),
          a.status, e.status,
          e.defeito || a.defeito || "",
          e.obra, e.local
        ]);
      } else if (mudouMotivo && ehParado(e.status)) {
        linhas.push([
          agora, pre, e.categoria, e.modelo,
          "Motivo atualizado",
          a.defeito || "—", e.status,
          e.defeito || "—",
          e.obra, e.local
        ]);
      }
    });

    if (linhas.length) escreverLog(ss, linhas);
    salvarEstado(ss, atual);
  } finally {
    lock.releaseLock();
  }
}

/* ---------- leitura da frota ---------- */

function lerFrota(ss) {
  const aba = ss.getSheetByName(ABA_FROTA);
  if (!aba) throw new Error('Não achei a aba "' + ABA_FROTA + '"');

  const valores = aba.getDataRange().getDisplayValues();
  const iCab = valores.findIndex(function (l) {
    const t = l.map(String).join("|").toUpperCase();
    return t.indexOf("PREFIXO") >= 0 && t.indexOf("STATUS") >= 0 && t.indexOf("CATEGORIA") >= 0;
  });
  if (iCab < 0) throw new Error("Não achei o cabeçalho da aba " + ABA_FROTA);

  const cab = valores[iCab].map(function (c) { return String(c).trim().toUpperCase(); });
  const col = function () {
    const nomes = Array.prototype.slice.call(arguments);
    for (var i = 0; i < nomes.length; i++) {
      var j = cab.findIndex(function (c) { return c.indexOf(nomes[i]) === 0; });
      if (j >= 0) return j;
    }
    return -1;
  };
  const c = {
    item: col("ITEM", "ITE"), cat: col("CATEGORIA"), mod: col("MODELO"),
    obra: col("OBRA"), loc: col("LOCAL"), pre: col("PREFIXO"),
    st: col("STATUS"), def: col("DEFEITO"), dt: col("DATA PARADA")
  };

  const mapa = {};
  for (var i = iCab + 1; i < valores.length; i++) {
    var l = valores[i];
    var num = String(l[c.item] || "").trim();
    if (!num || isNaN(Number(num))) continue;          // linhas de separação de categoria
    var pre = String(l[c.pre] || "").trim();
    if (!pre) continue;
    mapa[pre] = {
      categoria: String(l[c.cat] || "").trim(),
      modelo: String(l[c.mod] || "").trim(),
      obra: String(l[c.obra] || "").trim(),
      local: String(l[c.loc] || "").trim(),
      status: String(l[c.st] || "").trim(),
      defeito: String(l[c.def] || "").trim(),
      dataParada: c.dt >= 0 ? String(l[c.dt] || "").trim() : ""
    };
  }
  return mapa;
}

/* ---------- histórico ---------- */

function semear(atual) {
  const linhas = [];
  Object.keys(atual).forEach(function (pre) {
    const e = atual[pre];
    if (!ehParado(e.status)) return;
    const quando = interpretarData(e.dataParada);
    linhas.push([
      quando || new Date(), pre, e.categoria, e.modelo,
      "Ficou parado", "Disponível", e.status,
      e.defeito || "Sem descrição na planilha",
      e.obra, e.local
    ]);
  });
  linhas.sort(function (a, b) { return a[0] - b[0]; });
  return linhas;
}

function escreverLog(ss, linhas) {
  const aba = abaLog(ss);
  aba.insertRowsAfter(1, linhas.length);            // mais recente sempre no topo
  aba.getRange(2, 1, linhas.length, CABECALHO_LOG.length).setValues(linhas.reverse());
  aba.getRange(2, 1, linhas.length, 1).setNumberFormat("dd/MM/yyyy HH:mm");
}

/* ---------- estado anterior ---------- */

function lerEstado(ss) {
  const aba = ss.getSheetByName(ABA_ESTADO);
  const mapa = {};
  if (!aba || aba.getLastRow() < 2) return mapa;
  aba.getRange(2, 1, aba.getLastRow() - 1, 3).getValues().forEach(function (l) {
    const pre = String(l[0] || "").trim();
    if (pre) mapa[pre] = { status: String(l[1] || ""), defeito: String(l[2] || "") };
  });
  return mapa;
}

function salvarEstado(ss, atual) {
  const aba = ss.getSheetByName(ABA_ESTADO);
  const linhas = Object.keys(atual).map(function (pre) {
    return [pre, atual[pre].status, atual[pre].defeito];
  });
  aba.clear();
  aba.getRange(1, 1, 1, 3).setValues([["PREFIXO", "STATUS", "DEFEITO"]]);
  if (linhas.length) aba.getRange(2, 1, linhas.length, 3).setValues(linhas);
}

/* ---------- auxiliares ---------- */

function criarAbas(ss) {
  if (!ss.getSheetByName(ABA_LOG)) {
    const aba = ss.insertSheet(ABA_LOG);
    aba.getRange(1, 1, 1, CABECALHO_LOG.length).setValues([CABECALHO_LOG])
       .setFontWeight("bold").setBackground("#1E5C7E").setFontColor("#FFFFFF");
    aba.setFrozenRows(1);
    aba.setColumnWidth(1, 130);
    aba.setColumnWidth(8, 320);
  }
  if (!ss.getSheetByName(ABA_ESTADO)) {
    ss.insertSheet(ABA_ESTADO).hideSheet();
  }
}

function abaLog(ss) { return ss.getSheetByName(ABA_LOG); }

function ehParado(status) {
  return String(status).toLowerCase().indexOf("indispon") === 0;
}

function rotuloMudanca(de, para) {
  const d = String(de).toLowerCase(), p = String(para).toLowerCase();
  if (d.indexOf("indispon") === 0 && p.indexOf("dispon") === 0) return "Voltou a operar";
  if (d.indexOf("dispon") === 0 && p.indexOf("indispon") === 0) return "Ficou parado";
  return "Mudou de status";
}

/** "27/08/2026" ou "8/27/2026" vindos da planilha */
function interpretarData(txt) {
  if (!txt) return null;
  const m = String(txt).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]), ano = Number(m[3]);
  const dia = a > 12 ? a : b, mes = a > 12 ? b : a;    // pt-BR d/m, en-US m/d
  // meia-noite de proposito: das paradas antigas so se sabe o dia, nao a hora.
  const d = new Date(ano, mes - 1, dia, 0, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/** Apaga o historico semeado e refaz com as datas certas. */
function refazerSemente() {
  const ss = SpreadsheetApp.getActive();
  criarAbas(ss);
  const aba = abaLog(ss);
  if (aba.getLastRow() > 1) aba.deleteRows(2, aba.getLastRow() - 1);
  const atual = lerFrota(ss);
  const semente = semear(atual);
  if (semente.length) escreverLog(ss, semente);
  salvarEstado(ss, atual);
  ss.toast("Historico refeito: " + semente.length + " movimentacoes.", "Pronto", 6);
}
