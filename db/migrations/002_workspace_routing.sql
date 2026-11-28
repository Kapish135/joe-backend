-- A WhatsApp contact can have one active business workspace at a time.
-- The session is changed only when they use another business's entry code.

BEGIN;

CREATE TABLE IF NOT EXISTS joe.workspace_sessions (
  whatsapp_jid text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES joe.workspaces(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_sessions_workspace_idx
  ON joe.workspace_sessions(workspace_id, updated_at DESC);

COMMIT;
