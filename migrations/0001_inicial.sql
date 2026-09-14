-- Esquema do banco "painel-frota-db" (D1) — cadastro, aprovação e histórico de acesso.
-- Já aplicado manualmente no banco de produção. Mantido aqui para reprodutibilidade.
--
-- Não há tabela de cache da frota: a planilha é lida ao vivo pela Sheets API a cada
-- carregamento (ver worker.js, /api/csv), então o D1 só guarda o que não vem do Sheets.

CREATE TABLE pending_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL,
  telefone TEXT,
  obra TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  decidido_em TEXT,
  decidido_por TEXT
);

CREATE UNIQUE INDEX idx_pending_email_ativo ON pending_registrations(email) WHERE status = 'pendente';

CREATE TABLE usuarios_aprovados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  telefone TEXT,
  obra TEXT,
  aprovado_em TEXT NOT NULL DEFAULT (datetime('now')),
  aprovado_por TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE login_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quando TEXT NOT NULL DEFAULT (datetime('now')),
  identificador TEXT NOT NULL,
  resultado TEXT NOT NULL,
  motivo TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX idx_login_history_quando ON login_history(quando);
