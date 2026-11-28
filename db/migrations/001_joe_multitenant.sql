-- Joe owns only the `joe` schema. Existing application tables in `public`
-- are intentionally not read, altered, or referenced by this migration.

BEGIN;

CREATE SCHEMA IF NOT EXISTS joe;

CREATE TABLE IF NOT EXISTS joe.workspaces (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  default_timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS joe.workspace_integrations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES joe.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('make', 'google_calendar', 'whatsapp')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  external_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS joe.contacts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES joe.workspaces(id) ON DELETE CASCADE,
  whatsapp_jid text NOT NULL,
  display_name text,
  email text,
  lifecycle_stage text NOT NULL DEFAULT 'new' CHECK (lifecycle_stage IN ('new', 'qualifying', 'qualified', 'meeting_booked', 'nurture', 'closed')),
  lead_score smallint NOT NULL DEFAULT 0 CHECK (lead_score BETWEEN 0 AND 100),
  source text NOT NULL DEFAULT 'whatsapp',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  UNIQUE (workspace_id, whatsapp_jid)
);

CREATE TABLE IF NOT EXISTS joe.lead_profiles (
  contact_id uuid PRIMARY KEY REFERENCES joe.contacts(id) ON DELETE CASCADE,
  company_name text,
  role_title text,
  use_case text,
  budget_signal text,
  timeline_signal text,
  qualification_notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS joe.conversation_summaries (
  contact_id uuid PRIMARY KEY REFERENCES joe.contacts(id) ON DELETE CASCADE,
  summary text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS joe.messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES joe.workspaces(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES joe.contacts(id) ON DELETE SET NULL,
  whatsapp_message_id text,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, whatsapp_message_id)
);

CREATE TABLE IF NOT EXISTS joe.meeting_drafts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES joe.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES joe.contacts(id) ON DELETE CASCADE,
  title text,
  attendee_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  status text NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting', 'awaiting_confirmation', 'confirmed', 'cancelled', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

CREATE TABLE IF NOT EXISTS joe.calendar_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES joe.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES joe.contacts(id) ON DELETE CASCADE,
  meeting_draft_id uuid REFERENCES joe.meeting_drafts(id) ON DELETE SET NULL,
  external_event_id text,
  title text NOT NULL,
  attendee_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'cancelled', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, external_event_id)
);

CREATE TABLE IF NOT EXISTS joe.reminders (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES joe.workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES joe.contacts(id) ON DELETE CASCADE,
  calendar_event_id uuid REFERENCES joe.calendar_events(id) ON DELETE CASCADE,
  reminder_type text NOT NULL CHECK (reminder_type IN ('meeting', 'follow_up')),
  scheduled_for timestamptz NOT NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_workspace_stage_idx ON joe.contacts(workspace_id, lifecycle_stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_contact_sent_idx ON joe.messages(contact_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS drafts_contact_status_idx ON joe.meeting_drafts(contact_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON joe.reminders(scheduled_for) WHERE sent_at IS NULL;

COMMIT;
