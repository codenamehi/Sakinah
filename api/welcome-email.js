// POST /api/welcome-email  { email }
//
// Called by the coming-soon page right after someone joins the waitlist, to
// send them a "you're on the list" confirmation.
//
// Because anyone can call this, it only ever emails an address that joined
// the waitlist in the last 15 minutes and hasn't had a welcome email yet. So
// it can't be used to send email to random people, and nobody gets it twice.
// If the email account isn't set up yet, it quietly does nothing.

const { sb, sendEmail, brandedEmail, fill, emailConfigured, supabaseConfigured } = require('./_lib/hb');

const WELCOME = `Assalamu alaykum {{firstname}},

JazakAllah khair for joining the Halal Bridge waitlist. You're one of our founding members.

Halal Bridge is a supervised matchmaking service for single Muslims. Every member is verified, every introduction is arranged by our team, and every conversation happens with us present, with your wali welcome to join.

We're opening once 1,000 founding members have joined. We'll email you the moment we're live, inshallah.

If you know someone who is looking for marriage, please share Halal Bridge with them. The sooner we reach 1,000, the sooner we open.

JazakAllah khair,
The Halal Bridge Team`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!emailConfigured() || !supabaseConfigured()) return res.status(200).json({ ok: true, skipped: 'not set up' });

  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(200).json({ ok: true });

    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const rows = await sb(`waitlist?email=eq.${encodeURIComponent(email)}&welcome_emailed_at=is.null`
      + `&created_at=gte.${encodeURIComponent(since)}&select=id,name,email&limit=1`);
    const row = rows && rows[0];
    if (!row) return res.status(200).json({ ok: true });

    // Mark first, so a double-click can't send two.
    const claimed = await sb(`waitlist?id=eq.${row.id}&welcome_emailed_at=is.null`, { method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ welcome_emailed_at: new Date().toISOString() }) });
    if (!claimed || !claimed.length) return res.status(200).json({ ok: true });

    const text = fill(WELCOME, row, '');
    await sendEmail(row.email, "You're on the Halal Bridge waitlist", brandedEmail(text), text);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('welcome-email error:', err);
    return res.status(200).json({ ok: true });
  }
};
