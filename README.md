# Joe — WhatsApp Scheduling Assistant

Joe turns a WhatsApp scheduling request into a Google Calendar event. It uses Azure OpenAI to understand natural-language meeting requests and asks for explicit confirmation before it creates anything.

## Core user flow

1. A user messages Joe on WhatsApp.
2. On first contact, Joe collects their name and work email once.
3. The user shares a meeting topic, attendee email, date, time, and duration.
4. Joe extracts the details, asks for any missing information, and shows a preview.
5. Only after the user replies `confirm`, Joe sends the event payload to Make.com.
6. Make.com creates the Google Calendar event and sends invitations from the shared organizer calendar.

Users do not need Google OAuth or their own WhatsApp QR. The single Joe WhatsApp account is linked by the service administrator.

## What is implemented

- WhatsApp-first onboarding and scheduling conversation.
- Azure OpenAI-powered intent extraction and conversational responses.
- Topic, attendee, date, time, duration, and timezone collection.
- Per-chat profile and short rolling context while the service is running.
- Explicit confirmation before any event creation.
- Make.com webhook integration for Google Calendar event creation.

## Run locally

```bash
cd "/Users/kapishchawla/Desktop/joe-backend"
npm install
npm run dev
```

Link the **single Joe account** by scanning the terminal QR in WhatsApp: **Settings → Linked devices → Link a device**.

Then send a request such as:

```text
Schedule a product demo with alex@example.com tomorrow at 3 PM for 30 minutes.
```

Joe will show the proposed event. Reply `confirm` to create it, or `cancel` to discard it.

## Configuration

Copy `.env.example` to `.env` and set the following values:

| Variable | Purpose |
| --- | --- |
| `MAKE_WEBHOOK_URL` | Make.com custom webhook that creates the calendar event. |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key. |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint. |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | Azure deployment name. |
| `ADMIN_WHATSAPP_JID` | WhatsApp JID of the Joe account owner. |
| `DASHBOARD_TOKEN` | Protects the QR-linking page in deployed environments. |
| `TIMEZONE` | Default scheduling timezone, such as `Asia/Kolkata`. |

## Make.com payload

On confirmation, Joe posts this shape to the configured Make webhook:

```json
{
  "meeting_title": "Product demo",
  "attendees": [{ "email": "alex@example.com" }],
  "attendee_emails": ["alex@example.com"],
  "start_time": "2026-11-27T15:00:00+05:30",
  "end_time": "2026-11-27T15:30:00+05:30"
}
```

In Make, map `meeting_title`, `start_time`, and `end_time` to **Google Calendar → Create an Event**. Map `attendees[]` to the module’s **Attendees** collection.

## Prototype boundaries

- This is a case-study prototype using Baileys, an unofficial WhatsApp Web connector.
- The free Render deployment does not persist the WhatsApp session after a restart or redeploy, so Joe may need to be linked again.
- Local profile and conversation context are session-level in the demo; a database is required for durable customer memory.
- For a production rollout, replace Baileys with the official WhatsApp Cloud API and add durable storage, job processing, consent controls, and audit logs.

## Future direction

The next product layer is opt-in proactive assistance: availability checks, reminders, rescheduling, and identifying missed commitments from user-authorized conversations. These capabilities should remain user-controlled and request confirmation before any external change.
