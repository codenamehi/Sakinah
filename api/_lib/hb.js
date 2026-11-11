// Shared helpers for the Halal Bridge serverless functions.
// Files in api/_lib are not exposed as web addresses by Vercel.
//
// Environment variables (Vercel → this project → Settings → Environment Variables):
//   SUPABASE_URL               https://gejqqyilfuaunfinqjit.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  Supabase → Project Settings → API keys → the secret
//                              (service_role) key. Server only, never in a web page.
//   HB_EMAIL_USER              the Halal Bridge email address that sends, e.g. hello@halalbridge.com.au
//   HB_EMAIL_PASSWORD          that account's App Password (Google: myaccount.google.com/apppasswords)
//   HB_SMTP_HOST               optional. Leave empty for Gmail / Google Workspace.
//   HB_SMTP_PORT               optional, default 465
//   HB_APP_URL                 optional fallback for the app link in emails

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL_USER = process.env.HB_EMAIL_USER;
const EMAIL_PASS = process.env.HB_EMAIL_PASSWORD;

function emailConfigured() { return Boolean(EMAIL_USER && EMAIL_PASS); }
function supabaseConfigured() { return Boolean(SB_URL && SB_KEY); }

// Legacy service_role keys are JWTs and go in both headers; the newer
// sb_secret_ keys go in the apikey header only.
function sbHeaders(extra) {
  const h = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  if (String(SB_KEY || '').startsWith('eyJ')) h.Authorization = `Bearer ${SB_KEY}`;
  return { ...h, ...(extra || {}) };
}

async function sb(path, options = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { ...options, headers: sbHeaders(options.headers) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// How many rows match a filter, without downloading them.
async function sbCount(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'HEAD', headers: sbHeaders({ Prefer: 'count=exact', Range: '0-0' })
  });
  const range = res.headers.get('content-range') || '';
  return Number(range.split('/')[1] || 0);
}

// Who is calling? Checks the signed-in user's token with Supabase, then that
// they are in the admins table.
async function requireAdmin(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const res = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;
  const rows = await sb(`admins?id=eq.${encodeURIComponent(user.id)}&select=id`);
  return rows && rows.length ? user : null;
}

async function getSettings() {
  const rows = await sb('site_settings?select=key,value');
  return Object.fromEntries((rows || []).map(r => [r.key, r.value]));
}

let _transporter;
function transporter() {
  if (!_transporter) {
    const nodemailer = require('nodemailer');
    _transporter = process.env.HB_SMTP_HOST
      ? nodemailer.createTransport({
          host: process.env.HB_SMTP_HOST,
          port: Number(process.env.HB_SMTP_PORT || 465),
          secure: Number(process.env.HB_SMTP_PORT || 465) === 465,
          auth: { user: EMAIL_USER, pass: EMAIL_PASS } })
      : nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
  }
  return _transporter;
}

// Every email goes to exactly one person, never a group.
async function sendEmail(to, subject, html, text) {
  const list = String(to || '').split(/[,;\s]+/).filter(Boolean);
  if (list.length !== 1) throw new Error('Each email must go to exactly one address.');
  await transporter().sendMail({
    from: `"Halal Bridge" <${EMAIL_USER}>`,
    to: list[0], replyTo: EMAIL_USER, subject, html, text,
  });
}

const TITLES = ['br', 'brother', 'sr', 'sister', 'mr', 'mrs', 'ms', 'miss', 'dr', 'sheikh', 'shaikh'];
function firstName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  const i = parts.findIndex(w => !TITLES.includes(w.toLowerCase().replace(/[.,]/g, '')));
  return parts[i < 0 ? 0 : i] || '';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Plain text from the admin page → a branded HTML email. A line that is just
// the link becomes a button.
function brandedEmail(bodyText, link, buttonLabel) {
  const button = `<div style="text-align:center;margin:22px 0 26px">
        <a href="${escapeHtml(link)}" style="background:#c9a45c;color:#1f0f33;padding:14px 30px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">${escapeHtml(buttonLabel || 'Open Halal Bridge')}</a></div>`;
  const blocks = String(bodyText || '').split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const html = blocks.map(b => {
    // Any line that is just the link becomes the button; the rest stays text.
    const lines = b.split('\n');
    const out = [];
    let para = [];
    const flush = () => { if (para.length) out.push(`<p style="margin:0 0 16px">${para.map(escapeHtml).join('<br>')}</p>`); para = []; };
    for (const line of lines) {
      if (link && line.trim() === link) { flush(); out.push(button); }
      else para.push(line);
    }
    flush();
    return out.join('');
  }).join('');
  return `<meta charset="utf-8">
<div style="background:#f5efe3;padding:24px 12px">
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;color:#2a1a3f;font-size:15px;line-height:1.7">
  <div style="background:#2a1248;padding:28px;text-align:center;border-radius:12px 12px 0 0">
    <div style="color:#dcbb7c;font-family:Georgia,serif;font-size:20px;letter-spacing:.32em">HALAL BRIDGE</div>
  </div>
  <div style="background:#fffdf8;padding:30px;border:1px solid #e6dac4;border-top:0">${html}</div>
  <div style="background:#2a1248;padding:18px;text-align:center;border-radius:0 0 12px 12px">
    <a href="mailto:${escapeHtml(EMAIL_USER)}" style="color:#dcbb7c;text-decoration:none;font-size:13px">${escapeHtml(EMAIL_USER)}</a>
  </div>
</div></div>`;
}

function fill(text, row, link) {
  return String(text || '')
    .replace(/\{\{\s*firstname\s*\}\}/gi, firstName(row.name))
    .replace(/\{\{\s*name\s*\}\}/gi, row.name || '')
    .replace(/\{\{\s*link\s*\}\}/gi, link || '');
}

module.exports = {
  sb, sbCount, requireAdmin, getSettings, sendEmail, brandedEmail, fill, firstName,
  emailConfigured, supabaseConfigured,
};
