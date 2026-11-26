# Joe WhatsApp → Make → Google Calendar

This local Node service links the Joe WhatsApp number through Baileys. On a customer's first conversation, Joe collects their name and work email once, then automatically includes that email on future meeting invitations. Joe waits for explicit `confirm`, then POSTs the event to the Make webhook. Make owns the central Google Calendar connection and sends invitations from the service organizer account. Customers do not need Google OAuth or a WhatsApp QR.

If `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, and `AZURE_OPENAI_DEPLOYMENT_NAME` are present in `.env`, Joe uses the Azure OpenAI Responses API to understand natural-language requests. The deployment must be the Azure deployment name. Standard `OPENAI_API_KEY` is also supported as a fallback. Without either provider, the local parser still handles the documented scheduling format.

## Run it

```bash
cd "/Users/kapishchawla/Desktop/joe-backend"
npm install
npm run dev
```

Scan the terminal QR in WhatsApp: **Settings → Linked devices → Link a device**.

Message the linked account:

```text
Schedule customer call tomorrow at 3 PM for 30 minutes with alex@example.com
```

Joe sends a preview. Only `confirm` triggers the Make webhook and creates the Google Calendar event.

## Daily message brief and reminders

Joe stores only messages it observes while the service is running in a local, ignored `data/messages.jsonl` file. Send `daily brief` in WhatsApp to see inbound messages without a later recorded outbound reply. Send `add reminders`, then `confirm`, to create 30-minute follow-up blocks for the next day through Make. A browser table is available at `http://localhost:3030/daily-brief`.

Set `ADMIN_WHATSAPP_JID` in `.env` to make `daily brief` and `add reminders` available only to the Joe team; customers cannot access those internal conversation summaries.

If WhatsApp temporarily rejects QR linking, set `PAIRING_PHONE_NUMBER` to the owner's number in international digits-only format (for example `9198XXXXXXXX`). Visit the protected `/qr` page and choose **Link with phone number instead** in WhatsApp, then enter Joe's displayed pairing code.

## Product thought process and future scope

Joe is built around a business-user insight: scheduling begins inside a conversation, but the calendar is where work is finally recorded. The product uses WhatsApp as the natural-language entry point and Google Calendar as the trusted system of record. Joe never silently changes a calendar: every external action is previewed and requires explicit confirmation.

### What the prototype demonstrates today

- WhatsApp-first meeting requests with natural-language understanding.
- One-time customer onboarding for name and work email; Joe reuses the saved email on later invitations.
- Meeting-topic capture asks for a meaningful title when a request is too vague.
- Per-chat rolling memory summaries that give Azure OpenAI context about the customer, active meeting details, and unresolved questions. A customer can send `forget my memory` to erase their local profile and chat memory.
- Explicit preview and confirmation before Make creates the Google Calendar event and invitations.
- WhatsApp reminders for confirmed meetings, plus an internal daily brief that surfaces unreplied conversations.

### Next product milestones

1. **Availability and slot intelligence** — Read free/busy time and offer the best two or three options based on working hours, focus blocks, timezone, buffers, and meeting-length preferences.
2. **Full meeting lifecycle** — Let users reschedule, cancel, add guests, or change a title from WhatsApp. Each action would show a diff and require confirmation before Calendar is updated.
3. **Meeting quality** — Turn the supplied topic into a concise agenda, add it to the event description, and automatically create a Google Meet link when appropriate.
4. **Proactive assistant** — Send a morning brief, flag calendar conflicts, identify conversations with no response, and propose follow-up blocks rather than waiting for the user to notice.
5. **Team coordination** — Find overlap across multiple attendees, respect different timezones, and negotiate alternatives through a scheduling link or controlled WhatsApp follow-ups.
6. **Production architecture** — Replace the Baileys demonstration connector with the official WhatsApp Cloud API, store profiles and sessions in a database, use a durable queue for reminders, and add consent, audit logs, and role-based administration.

The key design principle is progressive trust: Joe can be proactive in finding options and identifying risks, but it remains user-controlled whenever an external calendar change or outbound invitation is involved.

> The no-cost Render deployment stores these summaries in its local filesystem, so they remain available while the instance is running but are reset after a sleep, restart, or redeploy. Connect a database through `DATABASE_URL` before relying on long-term customer memory.

## Meeting reminders

For a confirmed meeting that has attendee emails, Joe stores local WhatsApp reminders for the requester at **one hour** and **ten minutes** before the meeting. The prototype must remain running for the scheduler to deliver them; production should use a durable queue and hosted worker.

Events not created by Joe can also trigger reminders. In Make, use **Google Calendar → Watch Events**, followed by an **HTTP → Make a request** module that posts to Joe’s `POST /calendar-events` endpoint. Map `event_id`, `meeting_title`, `start_time`, `end_time`, and the event's `attendees` array.

For this one-calendar demo, set `MAIN_USER_EMAIL` to the main Joe user's email address. Joe queues a WhatsApp reminder only if that address appears in the watched event's attendees. All other events are safely ignored with `queued: false`. Reminders go only to `ADMIN_WHATSAPP_JID`; no attendee needs a QR, Google login, or Make account.

## Make input

The webhook receives:

```json
{
  "meeting_title": "Customer call",
  "attendees": [{ "email": "alex@example.com" }],
  "attendee_emails": ["alex@example.com"],
  "start_time": "2026-11-27T15:00:00+05:30",
  "end_time": "2026-11-27T15:30:00+05:30"
}
```

In Make map the four properties to the Google Calendar **Create an Event** module. Map `attendees[]` directly to its **Attendees** collection. Set the Make scenario to **On** after testing with **Run once**.

`auth_info/` is the local WhatsApp session and `.env` contains the Make webhook secret. Both are ignored by git. Baileys is an unofficial WhatsApp Web client; use this personal-demo setup only and do not use it for unsolicited messaging.

## Deploy the demo on a VPS

For a reliable demo, use a small always-on Linux VPS with Docker. Copy this folder and a populated `.env` to the server, then run:

```bash
docker compose up -d --build
docker compose logs -f joe
```

The compose volumes preserve `auth_info/` (the one Joe WhatsApp link) and `data/` (queued reminders) when the container restarts. Put an HTTPS reverse proxy in front of the service and change Make's HTTP URL to `https://your-domain/calendar-events`. Set a long `DASHBOARD_TOKEN`; the initial link page is then available only at `https://your-domain/qr?token=YOUR_DASHBOARD_TOKEN`.

For a no-cost Render case demo, the included `render.yaml` uses the free plan without a persistent disk. Joe works while the instance is live, but Render can sleep the service and any restart/redeploy requires linking the Joe WhatsApp account again. Use a persistent disk or database-backed session store before relying on reminders in production.

For real customer handover, replace Baileys with the official Meta WhatsApp Cloud API, use a database and durable job queue, and collect explicit messaging consent. This Baileys build is suitable only for a personal demo, not a customer-facing production service.
