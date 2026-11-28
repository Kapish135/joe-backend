# Multi-tenant product design

## Product model

Joe uses **one shared Joe WhatsApp number** for multiple organizations. Each business shares its own entry QR or WhatsApp deep link, which identifies the workspace before Joe stores or processes a lead.

```text
Customer → Business-specific Joe entry link → Shared Joe number → Joe workspace → Business Make workflow → Business calendar
```

This model removes the need to connect, authenticate, and maintain a separate WhatsApp number for every firm during the MVP.

## Tenant isolation

Each organization has one `joe.workspaces` record. Every lead, message, AI summary, draft, calendar event, and reminder carries that workspace ID. The new `joe` PostgreSQL schema is separate from all existing `public` tables.

| Domain | Storage |
| --- | --- |
| Organization settings | `joe.workspaces` |
| Integration references | `joe.workspace_integrations` |
| WhatsApp contacts and lead stage | `joe.contacts`, `joe.lead_profiles` |
| Conversation history and AI context | `joe.messages`, `joe.conversation_summaries` |
| Scheduling state | `joe.meeting_drafts`, `joe.calendar_events`, `joe.reminders` |

Secrets such as Cloud API tokens, Make webhooks, and calendar credentials belong in a secret manager or environment configuration, never in customer-facing tables.

## Persistent storage requirement

For the current Baileys prototype, persistent storage is required to keep the **single shared Joe** linked-device session after an application restart. Without it, that number must be linked again with a QR code.

Use durable PostgreSQL for customer and lead data in every environment. If Baileys remains temporarily in use, attach one persistent disk for Joe's shared `auth_info` session data. Workspace data remains isolated in PostgreSQL, not in the session directory.

## Recommended production architecture

Use the official WhatsApp Cloud API for production scale. It avoids QR linking and persistent WhatsApp Web sessions, while still allowing a shared Joe entry point or a later upgrade to dedicated customer numbers.

```text
Official WhatsApp Cloud API webhooks
              ↓
Joe API and workspace router
              ↓
PostgreSQL (joe schema) + durable job queue
              ↓
Per-workspace Make / Calendar integration
```

The workspace router resolves an organization from its dedicated entry link or onboarding code before handling the first message. It stores that workspace ID against the contact and scopes every later database read and write to it.

## Rollout path

1. Keep the current linked Joe number as the case-demo experience.
2. Set `DATABASE_URL` on the Joe service to enable durable workspace data.
3. Purchase a persistent disk for the single Baileys-based Joe number.
4. Create one workspace, Make/calendar configuration, and unique entry QR/deep link per firm.
5. For production scale, replace Baileys with Cloud API while retaining the workspace routing model.
