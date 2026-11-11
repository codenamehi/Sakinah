# Halal Bridge

Halal Bridge is separate from Nikkah Pathways. It has its own database
(Supabase), its own hosting (Vercel) and its own email account.

## What's here

| Address | File | What it is |
|---|---|---|
| `/` | `index.html` | The public **coming-soon page**. It explains Halal Bridge and has the waitlist sign-up form. When you go live, it sends visitors to the app. |
| `/admin` | `admin.html` | The **admin panel**. It opens on the **Waitlist** tab, which shows the number of sign-ups, brothers and sisters, states, a list, CSV export, **Go live**, and **Send launch email**. The other tabs (members, matches, conversations and so on) are the existing admin. |
| `/api/welcome-email` | `api/welcome-email.js` | Sends a "you're on the list" email straight after someone joins. |
| `/api/launch-email` | `api/launch-email.js` | Sends the launch email in small batches when you press the button. |
| `/api/sakinah-notify` | `api/sakinah-notify.js` | Member notifications for the live app: matches, messages and ID checks. |
| — | `supabase/waitlist.sql` | The database setup for the waitlist. You run this once. |

To see the coming-soon page after going live (it normally redirects), open `/?preview`.
To try the admin with made-up data, open `/admin?demo=1`.

## Setup (once)

### 1. Database
Supabase → your Halal Bridge project → **SQL Editor** → **New query** → paste the
whole of `supabase/waitlist.sql` → **Run**.

### 2. Vercel environment variables
Vercel → the Halal Bridge project → **Settings → Environment Variables**:

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://gejqqyilfuaunfinqjit.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → the **secret / service_role** key. Never put this in a web page. |
| `HB_EMAIL_USER` | the Halal Bridge email address, e.g. `hello@yourdomain.com.au` |
| `HB_EMAIL_PASSWORD` | that account's **App Password** (Google: myaccount.google.com/apppasswords, needs 2-Step Verification on) |

After adding or changing these, go to **Deployments → Redeploy**.
Until the email variables are set, sign-ups still work. They just don't get a
welcome email.

### 3. Domain
Vercel → the project → **Settings → Domains** → add your Halal Bridge domain and
follow the DNS steps it shows.

### 4. Contact email on the page
Once the email exists, put it in `CONTACT_EMAIL` near the bottom of `index.html`.

## Going live
1. Admin → **Waitlist** → put the link to the live app in **Link to the live app**.
2. Check the launch email wording, then **Save changes**.
3. Press **Go live**. The coming-soon page now sends visitors to the app.
4. Press **Send launch email**. It sends in batches and shows progress.
   Gmail allows about 500 emails a day, and Google Workspace about 2,000. If the
   limit is hit, it pauses and tells you. Press the button again the next day
   and it carries on from where it stopped. Nobody gets it twice.
