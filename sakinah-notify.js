// Vercel Serverless Function — Halal Bridge email notifications.
//
// Supabase calls this whenever something happens that a person should hear
// about. It sits beside send-email.js and reuses the same Gmail credentials,
// so there is nothing new to set up on the sending side.
//
// What it sends:
//   • new row in matches                    -> both members: "you have a new match"
//   • matches updated, both asked for intro  -> YOU: "open a conversation for these two"
//   • new conversation participant (member)  -> that member: "your conversation is open"
//   • new row in messages                    -> the other participants, at most
//                                               one email every 30 minutes each
//   • profile id_status changed              -> that member: ID approved or
//                                               rejected, with the reason
//
// Extra Vercel Environment Variables (Project Settings -> Environment Variables):
//   SUPABASE_URL               https://<your-ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  Supabase -> Project Settings -> API -> service_role
//                              SECRET. It bypasses every security policy, so it
//                              belongs here on the server and NEVER in a web page.
//   SAKINAH_WEBHOOK_SECRET     any long random string; paste the same value into
//                              the webhook header in Supabase
//   SAKINAH_APP_URL            (optional) where the member app is hosted
//
// GMAIL_USER and GMAIL_APP_PASSWORD are already set for send-email.js.

const crypto = require('crypto');

const SB_URL     = process.env.SUPABASE_URL;
const SB_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET     = process.env.SAKINAH_WEBHOOK_SECRET;
const APP_URL    = process.env.SAKINAH_APP_URL || 'https://sakinah-nine-gamma.vercel.app';
const ADMIN_EMAIL = process.env.GMAIL_USER || 'admin@nikkahpathways.com.au';

// Don't email someone twice about the same conversation inside this window.
// A back-and-forth exchange should feel like a conversation, not an inbox flood.
const QUIET_MINUTES = 30;

let _transporter;
function getTransporter() {
  if (!_transporter) {
    const nodemailer = require('nodemailer');
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return _transporter;
}

// Compare without leaking how much of the secret matched.
function secretOk(given) {
  if (!SECRET || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Supabase REST ──────────────────────────────────────────────────────────
// Plain fetch rather than @supabase/supabase-js, so this stays a zero-extra-
// dependency function. The service_role key bypasses row-level security,
// which is what lets us look up the email addresses members never see.
async function sb(path, options = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const one = async path => (await sb(path))?.[0] || null;
const profileOf = id => one(`profiles?id=eq.${id}&select=id,name,email`);

// ── email ──────────────────────────────────────────────────────────────────
function shell(heading, lines, cta) {
  return `<meta charset="utf-8">
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;color:#232736;font-size:15px;line-height:1.7">
  <div style="background:#1b2240;padding:30px;text-align:center;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:20px;letter-spacing:.3em;font-weight:400">HALAL BRIDGE</h1>
    <p style="color:#d9bc8c;margin:8px 0 0;font-size:13px;font-style:italic">by Nikkah Pathways</p>
  </div>
  <div style="background:#fff;padding:30px;border:1px solid #e6e1d8">
    <h2 style="color:#1b2240;font-size:18px;margin:0 0 16px;font-weight:600">${heading}</h2>
    ${lines.map(l => `<p style="margin:0 0 14px">${l}</p>`).join('')}
    <div style="text-align:center;margin:28px 0 8px">
      <a href="${APP_URL}" style="background:#d9bc8c;color:#1b2240;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block">${cta}</a>
    </div>
  </div>
  <div style="background:#1b2240;padding:20px;text-align:center;border-radius:0 0 8px 8px">
    <p style="color:#fff;margin:0;font-size:14px"><strong>The Nikkah Pathways Team</strong></p>
    <a href="mailto:${ADMIN_EMAIL}" style="color:#d9bc8c;text-decoration:none;font-size:13px">${ADMIN_EMAIL}</a>
  </div>
</div>`;
}

async function send(to, subject, html) {
  if (!to) return false;
  await getTransporter().sendMail({
    from: `"Halal Bridge — Nikkah Pathways" <${ADMIN_EMAIL}>`,
    to, replyTo: ADMIN_EMAIL, subject, html,
  });
  console.log('sakinah-notify ->', subject, to);
  return true;
}

// ── handlers ───────────────────────────────────────────────────────────────

// A new match. Deliberately says nothing about who they are — the whole point
// of the app is that details are seen there, after both sides agree, not
// scattered through an inbox someone else might be reading over.
async function onNewMatch(rec) {
  let sent = 0;
  for (const id of [rec.member_a, rec.member_b]) {
    const p = await profileOf(id);
    if (!p?.email) continue;
    const ok = await send(p.email, 'You have a new match on Halal Bridge',
      shell(`Assalamu alaykum ${p.name || ''},`.trim(),
        ['We\'ve found someone we believe you may be genuinely compatible with, based on your questionnaire.',
         'Sign in to Halal Bridge to see their profile. If you\'d like us to introduce you, let us know there &mdash; nothing is shared with them until you do.'],
        'View your match'));
    if (ok) sent++;
  }
  return `new match -> ${sent} email(s)`;
}

// Both sides have said yes. This one is for you, not them — it's the point
// where a human has to step in and open the conversation.
async function onBothRequested(rec, old) {
  // Two separate rungs, and the email for each says what is actually waiting
  // on you: opening a conversation, or arranging a meeting.
  const chatBefore = (old?.chat_requested_by || []).length;
  const chatAfter  = (rec.chat_requested_by  || []).length;
  const meetBefore = (old?.meeting_requested_by || []).length;
  const meetAfter  = (rec.meeting_requested_by  || []).length;

  if (meetBefore < 2 && meetAfter >= 2) {
    const [a, b] = await Promise.all([profileOf(rec.member_a), profileOf(rec.member_b)]);
    await send(ADMIN_EMAIL, 'Halal Bridge: an introduction to arrange',
      shell('Both have asked to meet',
        [`<strong>${a?.name || rec.member_a}</strong> and <strong>${b?.name || rec.member_b}</strong> have both asked for an introduction.`,
         'They are waiting on a time and a place from you. Neither has been told the other asked.',
         `<span style="color:#6b7186;font-size:13px">Match ID: ${rec.id}</span>`],
        'Arrange it in Halal Bridge'));
    return 'admin notified: introduction to arrange';
  }

  if (chatBefore < 2 && chatAfter >= 2) {
    const [a, b] = await Promise.all([profileOf(rec.member_a), profileOf(rec.member_b)]);
    await send(ADMIN_EMAIL, 'Halal Bridge: two members are ready to message',
      shell('Both sides have asked to message',
        [`<strong>${a?.name || rec.member_a}</strong> and <strong>${b?.name || rec.member_b}</strong> have both asked to message each other.`,
         'Re-check them both, then open a supervised conversation.',
         `<span style="color:#6b7186;font-size:13px">Match ID: ${rec.id}</span>`],
        'Open Halal Bridge'));
    return 'admin notified: ready to open a conversation';
  }

  return 'nothing crossed a threshold — nothing to do';
}

// A member has reported someone. This one is always for the team, never for
// either member — the person reported is not told, and the reporter gets a
// moderator rather than an automated reply.
async function onReport(rec) {
  const [who, them] = await Promise.all([
    profileOf(rec.reporter), rec.reported ? profileOf(rec.reported) : null
  ]);
  const urgent = rec.severity === 'urgent';
  await send(ADMIN_EMAIL,
    (urgent ? 'URGENT — ' : '') + 'Halal Bridge: a member has been reported',
    shell(urgent ? 'A report that needs looking at today' : 'A new report',
      [`<strong>${them?.name || 'A member'}</strong> was reported by ` +
       `<strong>${who?.name || 'a member'}</strong>.`,
       rec.reason ? `Reason given: <strong>${escapeHtml(rec.reason)}</strong>` : 'No reason was given.',
       rec.note ? `In their words: &ldquo;${escapeHtml(rec.note)}&rdquo;` : '',
       'Open the Reports tab to read the conversation alongside it.',
       `<span style="color:#6b7186;font-size:13px">Report ID: ${rec.id}</span>`].filter(Boolean),
      'Open the moderator queue'));
  return `admin notified of ${rec.severity} report`;
}

// Report text is written by a member, so it is escaped before it goes into
// an HTML email rather than trusted.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Someone was added to a conversation.
async function onParticipantAdded(rec) {
  if (rec.role !== 'member') return `role ${rec.role} — no email`;
  const p = await profileOf(rec.user_id);
  if (!p?.email) return 'no email on file';
  await send(p.email, 'Your Halal Bridge conversation is open',
    shell(`Assalamu alaykum ${p.name || ''},`.trim(),
      ['Your conversation has been opened. You can now message each other in Halal Bridge.',
       'A member of our team is part of the conversation and can see every message, as always.'],
      'Open your conversation'));
  return 'participant notified';
}

// An ID check was decided. Only fires when the status actually changed, so
// an admin editing something else on the profile doesn't re-send it.
async function onIdReviewed(rec, old) {
  if (!old || rec.id_status === old.id_status) return 'id_status unchanged';
  if (!['approved','rejected'].includes(rec.id_status)) return 'not a decision';
  if (!rec.email) return 'no email on file';

  const name = `Assalamu alaykum ${rec.name || ''}`.trim() + ',';
  if (rec.id_status === 'approved') {
    await send(rec.email, 'Your Halal Bridge ID check is complete',
      shell(name,
        ['Your age has been verified. Your document has been deleted now that we\'ve checked it.',
         'If you haven\'t finished your profile yet, that\'s the next step.'],
        'Open Halal Bridge'));
    return 'approval emailed';
  }
  await send(rec.email, 'We need a clearer copy of your ID',
    shell(name,
      ['We weren\'t able to verify your ID from what you sent.',
       `<strong>${escapeHtml(rec.id_reason || 'Please send a clearer photo.')}</strong>`,
       'Sign in and send another photo whenever you\'re ready &mdash; it only takes a moment.'],
      'Send another photo'));
  return 'rejection emailed';
}

// Profile rows carry member-entered text, so anything from them that lands
// in an email is escaped rather than trusted.
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// A new message. Skips the sender, skips anyone already reading, and skips
// anyone emailed recently.
async function onNewMessage(rec) {
  const parts = await sb(
    `conversation_participants?conversation_id=eq.${rec.conversation_id}` +
    `&select=user_id,role,last_read,last_notified_at`);

  const sender = await profileOf(rec.sender_id);
  const cutoff = Date.now() - QUIET_MINUTES * 60 * 1000;
  const posted = new Date(rec.created_at || Date.now());
  const notes = [];

  for (const p of parts || []) {
    if (p.user_id === rec.sender_id) continue;          // don't email the author
    if (p.role === 'admin') continue;                   // you watch the panel
    if (p.last_read && new Date(p.last_read) >= posted) { notes.push('already read'); continue; }
    if (p.last_notified_at && new Date(p.last_notified_at).getTime() > cutoff) {
      notes.push('recently emailed'); continue;
    }

    const who = await profileOf(p.user_id);
    if (!who?.email) continue;

    await send(who.email, 'You have a new message on Halal Bridge',
      shell(`Assalamu alaykum ${who.name || ''},`.trim(),
        [`<strong>${sender?.name || 'Someone'}</strong> has sent you a message in your Halal Bridge conversation.`,
         'Sign in to read and reply.'],
        'Read your message'));

    await sb(`conversation_participants?conversation_id=eq.${rec.conversation_id}` +
             `&user_id=eq.${p.user_id}`,
      { method: 'PATCH', body: JSON.stringify({ last_notified_at: new Date().toISOString() }) });
    notes.push('emailed ' + (who.name || who.email));
  }
  return notes.length ? notes.join('; ') : 'nobody to notify';
}

// ── entry point ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Use POST' });
  }
  if (!secretOk(req.headers['x-sakinah-secret'])) {
    // Say nothing useful — this endpoint can send email, so an attacker
    // shouldn't learn whether the secret is the thing that's wrong.
    return res.status(401).json({ status: 'error' });
  }
  if (!SB_URL || !SB_KEY) {
    console.error('sakinah-notify: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ status: 'error', message: 'Server not configured' });
  }

  const body = req.body || {};
  const { table, type, record, old_record } = body;

  try {
    let result;
    if (table === 'matches' && type === 'INSERT')                   result = await onNewMatch(record);
    else if (table === 'matches' && type === 'UPDATE')              result = await onBothRequested(record, old_record);
    else if (table === 'conversation_participants' && type === 'INSERT') result = await onParticipantAdded(record);
    else if (table === 'messages' && type === 'INSERT')             result = await onNewMessage(record);
    else if (table === 'profiles' && type === 'UPDATE')             result = await onIdReviewed(record, old_record);
    else if (table === 'reports' && type === 'INSERT')              result = await onReport(record);
    else result = `ignored ${type} on ${table}`;

    res.status(200).json({ status: 'ok', result });
  } catch (err) {
    console.error('sakinah-notify error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
};
