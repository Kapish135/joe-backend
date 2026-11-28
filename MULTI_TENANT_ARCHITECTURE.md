# Multi-tenant product design

## Product model

Joe is installed behind **each organization’s own WhatsApp Business number**. Customers continue to message the business they recognize; Joe qualifies the request, keeps context for that organization, and converts qualified conversations into confirmed meetings.

```text
Customer → Company WhatsApp number → Joe workspace → Company Make workflow → Company calendar
```

Joe is not intended to use one shared public number for every firm, except as a demo or concierge offering.

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

For the current Baileys prototype, persistent storage is required to keep the linked-device session after an application restart. Without it, the number must be linked again with a QR code.

Use durable PostgreSQL for customer and lead data in every environment. If Baileys remains temporarily in use, attach a persistent disk only for per-workspace `auth_info` session data. Do not share one authentication directory across organizations.

## Recommended production architecture

Use the official WhatsApp Cloud API for multi-organization production. It avoids QR linking and persistent WhatsApp Web sessions.

```text
Official WhatsApp Cloud API webhooks
              ↓
Joe API and workspace router
              ↓
PostgreSQL (joe schema) + durable job queue
              ↓
Per-workspace Make / Calendar integration
```

The workspace router resolves the inbound business phone-number ID to a workspace before handling the message. That ID then scopes every database read and write.

## Rollout path

1. Keep the current linked Joe number as the case-demo experience.
2. Set `DATABASE_URL` on the Joe service to enable durable workspace data.
3. Purchase a persistent disk only if continuing with Baileys for the demo.
4. For customer handover, onboard each firm’s own WhatsApp Business number through Cloud API and create one workspace plus integration configuration per firm.
