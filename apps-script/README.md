# Scripts da planilha (Google Apps Script)

Cópia versionada dos dois scripts do Google que sustentam o painel. O código
de verdade roda no Google; esta pasta existe para guardar o histórico e poder
voltar atrás. Quando mudar um script no editor do Apps Script, copie o código
novo para cá no mesmo commit/PR.

## `movimentacoes/` — gera a aba MOVIMENTAÇÕES

- **Onde vive:** projeto "Movimentacoes da frota", vinculado à planilha
  *1 Controle Manutencao Disponibilidade Frota* (Extensões > Apps Script).
- **Gatilho:** `registrarMovimentacoes`, da planilha, "Ao alterar" (onChange).
  Instalado pela função `preparar()`.
- **Como funciona:** a cada mudança, lê a aba "Controle de Frota", compara com
  o último estado guardado na aba oculta `_ESTADO` e insere no topo da aba
  MOVIMENTAÇÕES uma linha para cada equipamento que ficou parado, voltou a
  operar, mudou de status ou teve o motivo da parada atualizado. A data/hora
  gravada é a do momento em que o script rodou.
- **Equipamento novo** na planilha não gera linha; só entra no estado guardado.
- **Período 13 a 22/11:** não existe regra no código para isso. As linhas já
  gravadas ficam como estão porque o script só **insere** linhas novas no topo
  e nunca reescreve as antigas.
- **Cuidado com `refazerSemente()`:** apaga TODAS as linhas da aba MOVIMENTAÇÕES
  e recria só as paradas atuais, com a data da coluna DATA PARADA à meia-noite.
  Rodar isso perde o histórico real, inclusive 13 a 22/11.
- `preparar()` só semeia o histórico se a aba MOVIMENTAÇÕES estiver vazia.

## `carimbo/` — data e hora da última alteração

- **Onde vive:** projeto avulso "Carimbo do painel da frota" no Google Drive.
- **Publicado como app da Web** (executa como o dono, acesso para qualquer um).
  O painel chama a URL `/exec` dessa implantação (constante `CARIMBO` no
  `index.html`).
- **O que devolve:** JSON com `ok`, `data` (dd/MM/yyyy), `hora` (HH:mm), `iso`
  e `arquivo`, a partir da data de última modificação da planilha no Drive.
- `appsscript.json` é o manifesto do projeto (fuso, permissões, app da Web).

## Como atualizar esta cópia

1. Abra o projeto no Apps Script, selecione todo o código e copie.
2. Cole por cima do arquivo correspondente aqui e faça commit.
