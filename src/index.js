import 'dotenv/config';
import OpenAI from 'openai';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';
import http from 'node:http';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const logger = pino({ level: 'silent' });
const port = Number(process.env.PORT || 3030);
const webhookUrl = process.env.MAKE_WEBHOOK_URL;
const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
const adminJid = process.env.ADMIN_WHATSAPP_JID || '';
const mainUserEmail = process.env.MAIN_USER_EMAIL?.trim().toLowerCase() || '';
const dashboardToken = process.env.DASHBOARD_TOKEN || '';
const pairingPhoneNumber = (process.env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, '');
const pendingEvents = new Map();
const pendingDrafts = new Map();
let qrDataUrl = null;
let pairingCode = null;
let pairingCodeRequested = false;
const messageLog = [];
const scheduledReminders = [];
const persistentDataDirectory = process.env.PERSISTENT_DATA_DIR
  ? path.resolve(process.env.PERSISTENT_DATA_DIR)
  : process.cwd();
const dataDirectory = path.join(persistentDataDirectory, 'data');
const authDirectory = path.join(persistentDataDirectory, 'auth_info');
const messagesPath = path.join(dataDirectory, 'messages.jsonl');
const remindersPath = path.join(dataDirectory, 'scheduled-reminders.json');
let whatsappSocket = null;
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/+$/, '');
const usesAzure = Boolean(process.env.AZURE_OPENAI_API_KEY && azureEndpoint);
const openai = usesAzure
  ? new OpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      baseURL: `${azureEndpoint}/openai/v1/`
    })
  : process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;
const aiModel = usesAzure
  ? process.env.AZURE_OPENAI_DEPLOYMENT_NAME
  : process.env.OPENAI_MODEL || 'gpt-4.1-mini';

if (!webhookUrl) {
  throw new Error('MAKE_WEBHOOK_URL is missing. Add it to .env before starting Joe.');
}

function replyText(message) {
  return message.message?.conversation
    || message.message?.extendedTextMessage?.text
    || message.message?.imageMessage?.caption
    || '';
}

function dayKey(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(value));
}

async function loadMessageLog() {
  await mkdir(dataDirectory, { recursive: true });
  try {
    const lines = (await readFile(messagesPath, 'utf8')).trim().split('\n').filter(Boolean);
    messageLog.push(...lines.slice(-1000).map((line) => JSON.parse(line)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function loadScheduledReminders() {
  try {
    const saved = JSON.parse(await readFile(remindersPath, 'utf8'));
    if (Array.isArray(saved)) scheduledReminders.push(...saved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function saveScheduledReminders() {
  await writeFile(remindersPath, JSON.stringify(scheduledReminders, null, 2));
}

async function queueMeetingReminders(jid, event) {
  if (!jid || !event.start_time) return;
  const startsAt = new Date(event.start_time).getTime();
  if (Number.isNaN(startsAt)) return;
  for (const minutesBefore of [60, 10]) {
    const remindAt = startsAt - minutesBefore * 60_000;
    if (remindAt <= Date.now()) continue;
    const id = `${event.external_id || event.meeting_title}-${startsAt}-${minutesBefore}-${jid}`;
    if (scheduledReminders.some((reminder) => reminder.id === id)) continue;
    scheduledReminders.push({
      id,
      jid,
      event,
      minutesBefore,
      remindAt,
      sentAt: null
    });
  }
  await saveScheduledReminders();
}

async function sendDueReminders() {
  if (!whatsappSocket) return;
  let changed = false;
  for (const reminder of scheduledReminders) {
    if (reminder.sentAt || new Date(reminder.remindAt).getTime() > Date.now()) continue;
    const label = reminder.minutesBefore >= 60 ? '1 hour' : `${reminder.minutesBefore} minutes`;
    try {
      await whatsappSocket.sendMessage(reminder.jid, {
        text: `Reminder ⏰ “${reminder.event.meeting_title}” starts in ${label}, at ${formatForUser(reminder.event.start_time)}. Invitees: ${reminder.event.attendees.join(', ')}.`
      });
      reminder.sentAt = new Date().toISOString();
      changed = true;
    } catch (error) {
      console.error('WhatsApp reminder failed:', error.message);
    }
  }
  if (changed) await saveScheduledReminders();
}

async function logMessage(record) {
  messageLog.push(record);
  if (messageLog.length > 1000) messageLog.shift();
  await appendFile(messagesPath, `${JSON.stringify(record)}\n`);
}

function isCommand(text) {
  const normalized = text.toLowerCase().trim();
  return ['confirm', 'yes', 'y', 'okay', 'ok', 'go ahead', 'cancel', 'no', 'stop', 'daily brief', 'add reminders'].includes(normalized);
}

function isAdmin(jid) {
  return Boolean(adminJid) && jid === adminJid;
}

function openLoopsForToday() {
  const today = dayKey();
  const todayMessages = messageLog.filter((message) => dayKey(message.at) === today);
  return todayMessages.filter((message, index) => {
    if (message.direction !== 'inbound' || isCommand(message.text)) return false;
    return !todayMessages.slice(index + 1).some((next) => next.jid === message.jid && next.direction === 'outbound');
  });
}

function buildReminderEvents(openLoops) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return openLoops.slice(0, 6).map((message, index) => {
    const start = new Date(tomorrow.getTime() + index * 30 * 60_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    return {
      meeting_title: `Follow up: ${message.sender || 'WhatsApp contact'}`,
      attendees: [],
      start_time: toIndiaIso(start, start.getHours(), start.getMinutes()),
      end_time: toIndiaIso(end, end.getHours(), end.getMinutes()),
      duration: 30,
      source: message.text
    };
  });
}

async function summarizeDailyMessages(messages, openLoops) {
  const fallback = `${messages.filter((message) => message.direction === 'inbound').length} incoming messages observed today; ${openLoops.length} still need follow-up.`;
  if (!openai || !aiModel || !messages.length) return fallback;
  try {
    const transcript = messages.slice(-80).map((message) => `${message.direction === 'inbound' ? 'IN' : 'OUT'} | ${message.sender || message.jid} | ${message.text}`).join('\n');
    const response = await openai.responses.create({
      model: aiModel,
      instructions: 'Summarize the workday WhatsApp activity in two concise sentences. Identify only action items that still need a response. Do not invent facts, appointments, deadlines, or calendar changes.',
      input: transcript
    });
    return response.output_text.trim() || fallback;
  } catch (error) {
    console.error('Daily AI summary failed:', error.message);
    return fallback;
  }
}

function dailyBriefHtml() {
  const openLoops = openLoopsForToday();
  const rows = openLoops.map((message) => `<tr><td>${escapeHtml(message.sender || 'WhatsApp contact')}</td><td>${escapeHtml(message.text)}</td><td>Needs follow-up</td><td>Tomorrow</td></tr>`).join('') || '<tr><td colspan="4">No open messages recorded today.</td></tr>';
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Joe Daily Brief</title><style>body{font:16px system-ui;background:#f5f7fb;color:#182336;margin:40px;max-width:1000px}h1{margin-bottom:4px}p{color:#66758a}table{width:100%;border-collapse:collapse;background:white;border-radius:14px;overflow:hidden;box-shadow:0 6px 18px #17213a12}th,td{text-align:left;padding:15px;border-bottom:1px solid #e6ebf2}th{background:#10253f;color:white}td:nth-child(2){max-width:500px}code{background:#e9f7ee;padding:3px 6px;border-radius:5px}</style><h1>Joe — Daily Brief</h1><p>${openLoops.length} open conversation${openLoops.length === 1 ? '' : 's'} from messages observed today.</p><table><thead><tr><th>Contact</th><th>Message / action needed</th><th>Status</th><th>Reminder</th></tr></thead><tbody>${rows}</tbody></table><p>Send <code>daily brief</code> to Joe on WhatsApp for the summary, then <code>add reminders</code> and <code>confirm</code> to create calendar blocks.</p>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function formatForUser(value) {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone
  }).format(new Date(value));
}

function toIndiaIso(date, hour, minute) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`;
}

function parseTime(text) {
  const match = text.match(/\bat\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const suffix = (match[3] || '').replaceAll('.', '').toLowerCase();
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  if (!suffix && hour < 8) return null;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function parseScheduleRequest(rawText) {
  const text = rawText.trim().replace(/\s+/g, ' ');
  const time = parseTime(text);
  if (!time) return null;

  const lowered = text.toLowerCase();
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  if (lowered.includes('tomorrow')) date.setDate(date.getDate() + 1);
  else if (!lowered.includes('today')) return null;

  const durationMatch = text.match(/\bfor\s+(\d+)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/i);
  const duration = durationMatch
    ? Number(durationMatch[1]) * (/hour|hr/i.test(durationMatch[2]) ? 60 : 1)
    : 30;
  if (duration < 5 || duration > 480) return null;

  const attendees = [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(([email]) => email);
  let title = text
    .replace(/^(schedule|book|create|set up|setup|add)\s+(a\s+)?/i, '')
    .replace(/\b(today|tomorrow)\b.*$/i, '')
    .replace(/\bwith\s+[^,]+$/i, '')
    .trim();
  title = title.replace(/\bmeeting\s*$/i, '').trim() || 'Meeting';

  const startTime = toIndiaIso(date, time.hour, time.minute);
  const endDate = new Date(new Date(startTime).getTime() + duration * 60_000);
  const endTime = endDate.toISOString().replace('Z', '+00:00');

  return { meeting_title: title, attendees, start_time: startTime, end_time: endTime, duration };
}

function attendeeEmails(text) {
  return [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(([email]) => email.toLowerCase());
}

function normalizeAttendeeEmails(attendees) {
  if (!Array.isArray(attendees)) return [];
  return [...new Set(attendees.flatMap((attendee) => {
    if (typeof attendee === 'string') return attendeeEmails(attendee);
    if (attendee && typeof attendee === 'object') return attendeeEmails(String(attendee.email || attendee.emailAddress || ''));
    return [];
  }))];
}

function isDashboardAuthorized(request) {
  if (!dashboardToken) return true;
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  return request.headers.authorization === `Bearer ${dashboardToken}` || url.searchParams.get('token') === dashboardToken;
}

async function askForConfirmation(sock, jid, event) {
  pendingEvents.set(jid, event);
  await sock.sendMessage(jid, {
    text: `Here’s the meeting I’ll arrange:\n\n• *${event.meeting_title}*\n• ${formatForUser(event.start_time)} (${event.duration} minutes)\n• Invite: ${event.attendees.join(', ')}\n\nReply *confirm* and Joe will create it from the Joe Scheduling Calendar and send the invitations. Reply *cancel* to make no changes.`
  });
}

function isValidAiEvent(event) {
  return event
    && typeof event.meeting_title === 'string'
    && event.meeting_title.trim()
    && Array.isArray(event.attendees)
    && typeof event.start_time === 'string'
    && typeof event.end_time === 'string'
    && !Number.isNaN(Date.parse(event.start_time))
    && !Number.isNaN(Date.parse(event.end_time))
    && new Date(event.end_time) > new Date(event.start_time);
}

async function parseScheduleIntent(rawText) {
  if (!openai) return parseScheduleRequest(rawText);
  if (!aiModel) {
    console.error('AZURE_OPENAI_DEPLOYMENT_NAME is missing; using local parser.');
    return parseScheduleRequest(rawText);
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  try {
    const response = await openai.responses.create({
      model: aiModel,
      instructions: `You extract a single Google Calendar event from a WhatsApp scheduling request. Today is ${today}; timezone is ${timezone}. Return ONLY JSON with meeting_title (string), attendees (array of emails), start_time and end_time (ISO 8601 including +05:30). Resolve “today” and “tomorrow” using the supplied date. Default duration is 30 minutes. If an event cannot be scheduled confidently, return null. Never claim an event was created.`,
      input: rawText
    });
    const event = JSON.parse(response.output_text);
    if (isValidAiEvent(event)) return { ...event, duration: Math.round((new Date(event.end_time) - new Date(event.start_time)) / 60_000) };
  } catch (error) {
    console.error('OpenAI parsing failed; using local parser:', error.message);
  }
  return parseScheduleRequest(rawText);
}

async function createInCalendar(event) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        meeting_title: event.meeting_title,
        attendees: event.attendees,
        start_time: event.start_time,
        end_time: event.end_time
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Make returned ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function handleIncoming(sock, message) {
  const jid = message.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || message.key.fromMe) return;
  const text = replyText(message).trim();
  if (!text) return;
  const normalized = text.toLowerCase().replace(/[!.]/g, '').trim();

  if (['confirm', 'yes', 'y', 'okay', 'ok', 'go ahead'].includes(normalized)) {
    const pending = pendingEvents.get(jid);
    if (!pending) {
      await sock.sendMessage(jid, { text: 'There is no meeting waiting for confirmation. Try: “Schedule customer call tomorrow at 3 PM for 30 minutes”.' });
      return;
    }
    const events = Array.isArray(pending) ? pending : [pending];
    await sock.sendMessage(jid, { text: `Creating ${events.length === 1 ? 'it' : `${events.length} reminder blocks`} in your calendar…` });
    try {
      for (const event of events) await createInCalendar(event);
      pendingEvents.delete(jid);
      for (const event of events) await queueMeetingReminders(jid, event);
      const result = events.length === 1
        ? `Confirmed ✓ “${events[0].meeting_title}” is scheduled for ${formatForUser(events[0].start_time)}. Invitations were sent from the Joe Scheduling Calendar.`
        : `Confirmed ✓ ${events.length} follow-up reminder blocks were added to your calendar.`;
      await sock.sendMessage(jid, { text: result });
    } catch (error) {
      console.error('Make webhook failed:', error.message);
      await sock.sendMessage(jid, { text: 'I could not create that event. Your calendar was not changed — please try again.' });
    }
    return;
  }

  if (['cancel', 'no', 'stop'].includes(normalized)) {
    pendingEvents.delete(jid);
    pendingDrafts.delete(jid);
    await sock.sendMessage(jid, { text: 'Cancelled — I did not change your calendar.' });
    return;
  }

  if (/^(hi|hello|hey|hii+|good morning|good afternoon|good evening|start)[!,. ]*$/i.test(normalized)) {
    await sock.sendMessage(jid, {
      text: 'Hi, I’m *Joe* — your meeting coordinator. Tell me who you want to meet, their email, and a time. I’ll prepare the invite, ask for confirmation, then send it from the Joe Scheduling Calendar.\n\nTry: “Set up a customer call with alex@example.com tomorrow at 3 PM for 30 minutes.”\n\nYou never need to connect your Google Calendar to get started.'
    });
    return;
  }

  if (normalized === 'help') {
    await sock.sendMessage(jid, { text: 'To schedule: “Set up a 30-minute product demo with alex@example.com tomorrow at 3 PM.”\n\nI’ll show the details first. Nothing is created or sent until you reply *confirm*.' });
    return;
  }

  if (normalized === 'daily brief') {
    if (!isAdmin(jid)) {
      await sock.sendMessage(jid, { text: 'This command is available only to the Joe team. Send *help* to see how I can arrange a meeting for you.' });
      return;
    }
    const openLoops = openLoopsForToday();
    const todayMessages = messageLog.filter((message) => dayKey(message.at) === dayKey());
    const summary = await summarizeDailyMessages(todayMessages, openLoops);
    if (!openLoops.length) {
      await sock.sendMessage(jid, { text: `Daily brief: ${summary}\n\nNo unreplied messages recorded today. Your local table is at http://localhost:3030/daily-brief.` });
      return;
    }
    const list = openLoops.slice(0, 6).map((message, index) => `${index + 1}. ${message.sender || 'Contact'} — ${message.text.slice(0, 120)}`).join('\n');
    await sock.sendMessage(jid, { text: `Daily brief: ${summary}\n\n${openLoops.length} message${openLoops.length === 1 ? '' : 's'} need follow-up:\n${list}\n\nReply *add reminders* to propose 30-minute calendar blocks for tomorrow. Table: http://localhost:3030/daily-brief` });
    return;
  }

  if (normalized === 'add reminders') {
    if (!isAdmin(jid)) {
      await sock.sendMessage(jid, { text: 'This command is available only to the Joe team. Send *help* to see how I can arrange a meeting for you.' });
      return;
    }
    const reminders = buildReminderEvents(openLoopsForToday());
    if (!reminders.length) {
      await sock.sendMessage(jid, { text: 'There are no open messages to turn into reminders.' });
      return;
    }
    pendingEvents.set(jid, reminders);
    await sock.sendMessage(jid, { text: `I’ll add ${reminders.length} follow-up block${reminders.length === 1 ? '' : 's'} tomorrow, starting at 9:00 AM. Reply *confirm* to create them or *cancel* to make no changes.` });
    return;
  }

  const draft = pendingDrafts.get(jid);
  if (draft) {
    const emails = attendeeEmails(text);
    if (!emails.length) {
      await sock.sendMessage(jid, { text: 'Please send the attendee email address, for example: alex@example.com. Reply *cancel* to discard this meeting.' });
      return;
    }
    pendingDrafts.delete(jid);
    draft.attendees = emails;
    await askForConfirmation(sock, jid, draft);
    return;
  }

  const event = await parseScheduleIntent(text);
  if (!event) {
    await sock.sendMessage(jid, { text: 'I can arrange that. Send the meeting purpose, attendee email, date, and time — for example: “Set up a customer call with alex@example.com tomorrow at 3 PM for 30 minutes.”' });
    return;
  }

  if (!event.attendees.length) {
    pendingDrafts.set(jid, event);
    await sock.sendMessage(jid, { text: `I can arrange “${event.meeting_title}” for ${formatForUser(event.start_time)}. Who should I invite? Send their email address, or reply *cancel*.` });
    return;
  }

  await askForConfirmation(sock, jid, event);
}

async function startWhatsApp() {
  await loadMessageLog();
  await loadScheduledReminders();
  await mkdir(authDirectory, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDirectory);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: ['Joe Calendar Assistant', 'Chrome', '1.0.0']
  });
  whatsappSocket = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
      QRCode.toDataURL(qr, { margin: 2, width: 360 }).then((dataUrl) => { qrDataUrl = dataUrl; });
    }
    if (pairingPhoneNumber && !state.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      setTimeout(async () => {
        try {
          pairingCode = await sock.requestPairingCode(pairingPhoneNumber);
          qrDataUrl = null;
          console.log('A WhatsApp pairing code is ready at the protected /qr page.');
        } catch (error) {
          pairingCodeRequested = false;
          console.error('Could not request WhatsApp pairing code:', error.message);
        }
      }, 1_500);
    }
    if (connection === 'open') {
      qrDataUrl = null;
      pairingCode = null;
      console.log('Joe is connected to WhatsApp.');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) startWhatsApp();
      else console.log('WhatsApp logged out. Delete auth_info and restart to link again.');
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      const text = replyText(message).trim();
      const jid = message.key.remoteJid;
      if (text && jid && jid !== 'status@broadcast') {
        await logMessage({ jid, sender: message.pushName || '', text, direction: message.key.fromMe ? 'outbound' : 'inbound', at: new Date().toISOString() });
      }
      await handleIncoming(sock, message);
    }
  });
}

http.createServer(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'joe-calendar-whatsapp' }));
    return;
  }
  if (request.url === '/public-status') {
    response.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    });
    response.end(JSON.stringify({
      ok: true,
      whatsapp_connected: Boolean(whatsappSocket?.user),
      reminders_queued: scheduledReminders.filter((reminder) => !reminder.sentAt).length
    }));
    return;
  }
  if (request.url?.startsWith('/qr')) {
    if (!isDashboardAuthorized(request)) {
      response.writeHead(401).end('Dashboard authentication required');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const body = pairingCode
      ? `<main><h1>Link Joe with a phone number</h1><p>In WhatsApp, select <strong>Linked devices → Link a device → Link with phone number instead</strong>, then enter:</p><p class="code">${pairingCode}</p><p>This code expires quickly. Refresh this page if needed.</p></main>`
      : qrDataUrl
      ? `<main><h1>Link Joe to WhatsApp</h1><img src="${qrDataUrl}" alt="WhatsApp linking QR"><p>WhatsApp → Settings → Linked devices → Link a device.</p><p>Refresh if the QR expires.</p></main>`
      : '<main><h1>Joe is connected to WhatsApp ✓</h1><p>You can close this page.</p></main>';
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:18px system-ui;background:#f4f7fb;margin:0;display:grid;place-items:center;min-height:100vh}main{background:white;padding:32px;border-radius:20px;text-align:center;box-shadow:0 10px 30px #0002;max-width:520px}img{max-width:100%}p{color:#526273}.code{font:700 34px ui-monospace,monospace;letter-spacing:.08em;color:#18243a}</style>${body}`);
    return;
  }
  if (request.url?.startsWith('/daily-brief')) {
    if (!isDashboardAuthorized(request)) {
      response.writeHead(401).end('Dashboard authentication required');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(dailyBriefHtml());
    return;
  }
  if (request.method === 'POST' && request.url === '/calendar-events') {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const event = {
        external_id: String(input.event_id || input.id || ''),
        meeting_title: String(input.meeting_title || input.summary || 'Meeting'),
        attendees: normalizeAttendeeEmails(input.attendees),
        start_time: input.start_time || input.start?.dateTime,
        end_time: input.end_time || input.end?.dateTime
      };
      if (!event.start_time || !event.end_time || Number.isNaN(Date.parse(event.start_time)) || Number.isNaN(Date.parse(event.end_time))) {
        response.writeHead(400).end('start_time and end_time are required');
        return;
      }
      if (!mainUserEmail) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'MAIN_USER_EMAIL is not configured' }));
        return;
      }
      if (!event.attendees.includes(mainUserEmail)) {
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, queued: false, reason: 'main_user_not_an_attendee' }));
        return;
      }
      await queueMeetingReminders(input.reminder_jid || adminJid, event);
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, queued: true, message: 'Meeting reminders queued' }));
    } catch (error) {
      response.writeHead(400).end(`Invalid event payload: ${error.message}`);
    }
    return;
  }
  response.writeHead(404).end();
}).listen(port, () => console.log(`Joe health check: http://localhost:${port}/health`));

setInterval(() => sendDueReminders().catch((error) => console.error('Reminder scheduler failed:', error.message)), 60_000);

startWhatsApp().catch((error) => {
  console.error(error);
  process.exit(1);
});
