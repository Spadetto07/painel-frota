/**
 * Devolve a data e a hora em que a planilha da frota foi modificada pela ultima vez.
 * Publicado como aplicativo da Web para a pagina do painel poder ler.
 */
const ID_DA_PLANILHA = "1I8CSxPKxye2YlGOC_1F0fNJg9NCqvQO2H6DMcY-eYoo";
const FUSO = "America/Sao_Paulo";

function doGet() {
  var corpo;
  try {
    var arquivo = DriveApp.getFileById(ID_DA_PLANILHA);
    var quando = arquivo.getLastUpdated();
    corpo = {
      ok: true,
      data: Utilities.formatDate(quando, FUSO, "dd/MM/yyyy"),
      hora: Utilities.formatDate(quando, FUSO, "HH:mm"),
      iso: quando.toISOString(),
      arquivo: arquivo.getName()
    };
  } catch (e) {
    corpo = { ok: false, erro: String(e) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(corpo))
    .setMimeType(ContentService.MimeType.JSON);
}
