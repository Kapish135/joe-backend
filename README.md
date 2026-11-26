# Joe WhatsApp → Make → Google Calendar

This local Node service links the Joe WhatsApp number through Baileys. A customer describes a meeting, Joe collects the attendee email if needed, waits for explicit `confirm`, then POSTs the event to the Make webhook. Make owns the central Google Calendar connection and sends invitations from the service organizer account. Customers do not need Google OAuth or a WhatsApp QR.

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

## Meeting reminders

For a confirmed meeting that has attendee emails, Joe stores local WhatsApp reminders for the requester at **one hour** and **ten minutes** before the meeting. The prototype must remain running for the scheduler to deliver them; production should use a durable queue and hosted worker.

Events not created by Joe can also trigger reminders. In Make, use **Google Calendar → Watch Events**, followed by an **HTTP → Make a request** module that posts to Joe’s `POST /calendar-events` endpoint with the `x-joe-secret` header. Map `event_id`, `meeting_title`, `start_time`, `end_time`, and the event's `attendees` array.

For this one-calendar demo, set `MAIN_USER_EMAIL` to the main Joe user's email address. Joe queues a WhatsApp reminder only if that address appears in the watched event's attendees. All other events are safely ignored with `queued: false`. Reminders go only to `ADMIN_WHATSAPP_JID`; no attendee needs a QR, Google login, or Make account.

## Make input

The webhook receives:

```json
{
  "meeting_title": "Customer call",
  "attendees": ["alex@example.com"],
  "start_time": "2026-11-27T15:00:00+05:30",
  "end_time": "2026-11-27T15:30:00+05:30"
}
```

In Make map the four properties to the Google Calendar **Create an Event** module. Set the Make scenario to **On** after testing with **Run once**.

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
