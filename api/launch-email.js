// POST /api/launch-email — called by the admin page's "Send launch email" button.
//
// Sends the launch email to the next small batch of people on the waitlist who
// haven't had it yet, and marks each one as sent. The admin page keeps calling
// this until nobody is left, so a single call never runs long enough to time out.
// If the email account hits its daily sending limit, it stops and says so;
// pressing the button again the next day carries on where it left off.

const { sb, sbCount, requireAdmin, getSettings, sendEmail, brandedEmail, fill,
        emailConfigured, supabaseConfigured } = require('./_lib/hb');

const BATCH = 8;

function looksLikeDailyLimit(err) {
  const m = String(err && (err.response || err.message) || '');
  return /5\.4\.5|daily|quota|limit exceeded|too many/i.test(m);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST only' });
  if (!supabaseConfigured()) return res.status(500).json({ message: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set in Vercel.' });
  if (!emailConfigured()) return res.status(500).json({ message: 'HB_EMAIL_USER or HB_EMAIL_PASSWORD is not set in Vercel.' });

  try {
    const admin = await requireAdmin(req);
    if (!admin) return res.status(401).json({ message: 'Sign in as an admin first.' });

    const settings = await getSettings();
    if (settings.launched !== true) return res.status(400).json({ message: 'Go live before sending the launch email.' });
    const link = settings.app_url || process.env.HB_APP_URL || '';
    if (!/^https:\/\//.test(link)) return res.status(400).json({ message: 'Add the app link on the admin page first.' });
    const subject = settings.launch_email_subject || 'Halal Bridge is now live';
    const body = settings.launch_email_body || 'Assalamu alaykum {{firstname}},\n\nHalal Bridge is now open.\n\n{{link}}\n\nThe Halal Bridge Team';

    const pendingFilter = 'launch_emailed_at=is.null&launch_email_error=is.null';
    const batch = await sb(`waitlist?${pendingFilter}&select=id,name,email&order=created_at.asc&limit=${BATCH}`);

    let sent = 0, failed = 0, stopped = null;
    for (const row of batch || []) {
      const text = fill(body, row, link);
      try {
        await sendEmail(row.email, fill(subject, row, link), brandedEmail(text, link, 'Create your account'), text);
        await sb(`waitlist?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ launch_emailed_at: new Date().toISOString() }) });
        sent++;
      } catch (err) {
        if (looksLikeDailyLimit(err)) {
          stopped = 'the email account reached its daily sending limit. Press Send launch email again tomorrow to carry on.';
          break;
        }
        // A bad address shouldn't block everyone after it. Note it and move on.
        failed++;
        await sb(`waitlist?id=eq.${row.id}`, { method: 'PATCH',
          body: JSON.stringify({ launch_email_error: String(err.message || err).slice(0, 300) }) }).catch(() => {});
      }
    }

    const remaining = await sbCount(`waitlist?${pendingFilter}&select=id`);
    return res.status(200).json({ sent, failed, remaining, stopped });
  } catch (err) {
    console.error('launch-email error:', err);
    return res.status(500).json({ message: String(err.message || err).slice(0, 300) });
  }
};
