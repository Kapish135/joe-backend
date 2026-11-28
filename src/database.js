import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const DEFAULT_WORKSPACE_ID = 'b7abfc76-5f38-4b28-a5fa-2db9b5c282ef';

export class JoeDatabase {
  constructor() {
    this.workspaceId = process.env.JOE_WORKSPACE_ID || DEFAULT_WORKSPACE_ID;
    this.workspaceSlug = process.env.JOE_WORKSPACE_SLUG || 'joe-demo';
    this.workspaceName = process.env.JOE_WORKSPACE_NAME || 'Joe Demo';
    this.pool = process.env.DATABASE_URL
      ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : undefined })
      : null;
  }

  get enabled() {
    return Boolean(this.pool);
  }

  async initialize() {
    if (!this.pool) return false;
    await this.pool.query('SELECT 1');
    await this.pool.query(
      `INSERT INTO joe.workspaces (id, slug, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
      [this.workspaceId, this.workspaceSlug, this.workspaceName]
    );
    return true;
  }

  async defaultWorkspace() {
    if (!this.pool) return { id: this.workspaceId, slug: this.workspaceSlug, name: this.workspaceName };
    const result = await this.pool.query(
      'SELECT id, slug, name FROM joe.workspaces WHERE id = $1',
      [this.workspaceId]
    );
    return result.rows[0] || null;
  }

  async activateWorkspace(jid, slug) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      'SELECT id, slug, name FROM joe.workspaces WHERE slug = $1 AND status = $2',
      [slug.toLowerCase(), 'active']
    );
    const workspace = result.rows[0];
    if (!workspace) return null;
    await this.pool.query(
      `INSERT INTO joe.workspace_sessions (whatsapp_jid, workspace_id)
       VALUES ($1, $2)
       ON CONFLICT (whatsapp_jid) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, updated_at = now()`,
      [jid, workspace.id]
    );
    return workspace;
  }

  async activeWorkspace(jid) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `SELECT w.id, w.slug, w.name FROM joe.workspace_sessions s
       JOIN joe.workspaces w ON w.id = s.workspace_id
       WHERE s.whatsapp_jid = $1 AND w.status = 'active'`,
      [jid]
    );
    return result.rows[0] || null;
  }

  async workspaceForJid(jid) {
    return (await this.activeWorkspace(jid)) || this.defaultWorkspace();
  }

  async loadProfiles() {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `SELECT whatsapp_jid AS jid, display_name AS name, email, created_at AS "createdAt"
       FROM joe.contacts WHERE workspace_id = $1 AND email IS NOT NULL`,
      [this.workspaceId]
    );
    return result.rows;
  }

  async loadProfile(jid) {
    if (!this.pool) return null;
    const workspace = await this.workspaceForJid(jid);
    const result = await this.pool.query(
      `SELECT whatsapp_jid AS jid, display_name AS name, email, created_at AS "createdAt"
       FROM joe.contacts WHERE workspace_id = $1 AND whatsapp_jid = $2 AND email IS NOT NULL`,
      [workspace.id, jid]
    );
    return result.rows[0] || null;
  }

  async loadMemories() {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `SELECT c.whatsapp_jid AS jid, s.summary, s.updated_at AS "updatedAt"
       FROM joe.conversation_summaries s
       JOIN joe.contacts c ON c.id = s.contact_id
       WHERE c.workspace_id = $1`,
      [this.workspaceId]
    );
    return result.rows;
  }

  async loadMemory(jid) {
    if (!this.pool) return null;
    const workspace = await this.workspaceForJid(jid);
    const result = await this.pool.query(
      `SELECT c.whatsapp_jid AS jid, s.summary, s.updated_at AS "updatedAt"
       FROM joe.conversation_summaries s JOIN joe.contacts c ON c.id = s.contact_id
       WHERE c.workspace_id = $1 AND c.whatsapp_jid = $2`,
      [workspace.id, jid]
    );
    return result.rows[0] || null;
  }

  async upsertContact({ jid, name, email, stage }) {
    if (!this.pool) return null;
    const workspace = await this.workspaceForJid(jid);
    const result = await this.pool.query(
      `INSERT INTO joe.contacts (id, workspace_id, whatsapp_jid, display_name, email, lifecycle_stage, last_message_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'new'), now())
       ON CONFLICT (workspace_id, whatsapp_jid) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, joe.contacts.display_name),
         email = COALESCE(EXCLUDED.email, joe.contacts.email),
         lifecycle_stage = COALESCE($6, joe.contacts.lifecycle_stage),
         last_message_at = now(), updated_at = now()
       RETURNING id`,
      [randomUUID(), workspace.id, jid, name || null, email || null, stage || null]
    );
    return result.rows[0].id;
  }

  async recordMessage({ jid, sender, text, direction, at }) {
    if (!this.pool) return;
    const workspace = await this.workspaceForJid(jid);
    const contactId = await this.upsertContact({ jid, name: sender || null });
    await this.pool.query(
      `INSERT INTO joe.messages (id, workspace_id, contact_id, direction, body, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), workspace.id, contactId, direction, text, at]
    );
  }

  async saveProfile(profile) {
    await this.upsertContact({ jid: profile.jid, name: profile.name, email: profile.email, stage: 'qualifying' });
  }

  async setLifecycleStage(jid, stage) {
    if (!this.pool) return;
    const workspace = await this.workspaceForJid(jid);
    await this.pool.query(
      `UPDATE joe.contacts SET lifecycle_stage = $3, updated_at = now()
       WHERE workspace_id = $1 AND whatsapp_jid = $2`,
      [workspace.id, jid, stage]
    );
  }

  async saveMeetingDraft(jid, event, status = 'awaiting_confirmation') {
    if (!this.pool) return;
    const workspace = await this.workspaceForJid(jid);
    const contactId = await this.upsertContact({ jid });
    await this.pool.query(
      `INSERT INTO joe.meeting_drafts (id, workspace_id, contact_id, title, attendee_emails, starts_at, ends_at, timezone, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
      [randomUUID(), workspace.id, contactId, event.meeting_title, JSON.stringify(event.attendees), event.start_time, event.end_time, process.env.TIMEZONE || 'Asia/Kolkata', status]
    );
  }

  async cancelActiveDrafts(jid) {
    if (!this.pool) return;
    const workspace = await this.workspaceForJid(jid);
    await this.pool.query(
      `UPDATE joe.meeting_drafts d SET status = 'cancelled', updated_at = now()
       FROM joe.contacts c
       WHERE d.contact_id = c.id AND c.workspace_id = $1 AND c.whatsapp_jid = $2
         AND d.status IN ('collecting', 'awaiting_confirmation')`,
      [workspace.id, jid]
    );
  }

  async saveCalendarEvent(jid, event) {
    if (!this.pool) return;
    const workspace = await this.workspaceForJid(jid);
    const contactId = await this.upsertContact({ jid, stage: 'meeting_booked' });
    await this.pool.query(
      `INSERT INTO joe.calendar_events (id, workspace_id, contact_id, title, attendee_emails, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [randomUUID(), workspace.id, contactId, event.meeting_title, JSON.stringify(event.attendees), event.start_time, event.end_time]
    );
  }

  async saveLeadProfile(jid, profile) {
    if (!this.pool) return;
    const contactId = await this.upsertContact({ jid, stage: 'qualifying' });
    await this.pool.query(
      `INSERT INTO joe.lead_profiles (contact_id, company_name, role_title, use_case, budget_signal, timeline_signal, qualification_notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (contact_id) DO UPDATE SET
         company_name = COALESCE(EXCLUDED.company_name, joe.lead_profiles.company_name),
         role_title = COALESCE(EXCLUDED.role_title, joe.lead_profiles.role_title),
         use_case = COALESCE(EXCLUDED.use_case, joe.lead_profiles.use_case),
         budget_signal = COALESCE(EXCLUDED.budget_signal, joe.lead_profiles.budget_signal),
         timeline_signal = COALESCE(EXCLUDED.timeline_signal, joe.lead_profiles.timeline_signal),
         qualification_notes = COALESCE(EXCLUDED.qualification_notes, joe.lead_profiles.qualification_notes),
         updated_at = now()`,
      [contactId, profile.companyName || null, profile.roleTitle || null, profile.useCase || null, profile.budgetSignal || null, profile.timelineSignal || null, profile.notes || null]
    );
  }

  async saveMemory(memory) {
    if (!this.pool) return;
    const contactId = await this.upsertContact({ jid: memory.jid });
    await this.pool.query(
      `INSERT INTO joe.conversation_summaries (contact_id, summary, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (contact_id) DO UPDATE SET summary = EXCLUDED.summary, updated_at = EXCLUDED.updated_at`,
      [contactId, memory.summary, memory.updatedAt]
    );
  }

  async forgetContact(jid) {
    if (!this.pool) return;
    const workspace = await this.workspaceForJid(jid);
    await this.pool.query('DELETE FROM joe.contacts WHERE workspace_id = $1 AND whatsapp_jid = $2', [workspace.id, jid]);
  }

  async close() {
    await this.pool?.end();
  }
}
