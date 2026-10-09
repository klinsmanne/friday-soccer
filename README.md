# Friday Soccer (Midwest FC) — sign-up app

Website: **https://signup.midwestfc.workers.dev**
Status check: https://signup.midwestfc.workers.dev/api/health — every line should say `ok` (never shows any keys).

## How it works (the rules)
- One game every Friday, 10:00–11:30 PM CT at Ackerman Soccer. 18 spots, $8.05.
- Sign-ups open Monday 9:00 AM CT and close Friday 8:00 PM CT. Everyone who has an account gets an email when they open.
- "Sign up & pay" holds your spot for 10 minutes while you pay (card, Apple Pay, Google Pay).
- Before Thursday 8 PM your card is only *held*; it's charged at Thursday 8 PM. Sign-ups after that are charged right away.
- Drop before Thursday 8 PM → full refund (the hold is released). Drop after → refunded only if someone takes the spot.
- When full, players join the waitlist for free. When a spot opens, the next person gets an email and 2 hours to pay
  (30 minutes on game day). The clock pauses 10 PM–9 AM. If they don't pay, it goes to the next person.
- Game-day reminder at 9 AM Friday.

## Organizer (Organizer button at the top of the app)
- **This game**: who's playing, waitlist, money collected/on hold; move people ↑↓; remove (with or without refund);
  "Add myself" / "Add a player" (free spot); change location, max players, kickoff; cancel the game (refunds everyone).
- **Message**: email + notify everyone on this week's list.
- **Players**: search, Make organizer, Block/Unblock.
- **Settings**: price, spots, days/times, deadlines, hold/offer lengths (applies from the next game).
- **History**: past games and a payments spreadsheet (CSV) download.

## Where things live (all free tiers)
| Service | What it does | Account |
|---|---|---|
| GitHub `klinsmanne/friday-soccer` (private) | the code | klinsmanne |
| Cloudflare Worker `signup` | website + server + every-minute schedule; redeploys on every push | (owner account) |
| Supabase project `friday-soccer` | database + sign-in | GitHub login |
| Stripe "Midwest FC" | payments → your bank | |
| Gmail ackerman.elitesoccer@gmail.com | sends sign-in codes and notifications (app password) | |

Secrets live only in Cloudflare (Worker `signup` → Settings → Variables and Secrets):
`SUPABASE_SERVICE_KEY`, `STRIPE_SECRET_KEY`, `GMAIL_APP_PASSWORD`. The Gmail app password is also in
Supabase → Authentication → Emails → SMTP Settings.

## Common fixes
- **Status page shows an error** → the named service's key changed or expired. Replace it in Cloudflare (pencil icon → paste → Deploy).
- **Nobody gets emails** → Google may have revoked the app password. Create a new one at myaccount.google.com/apppasswords and paste it in both places above.
- **A payment action failed** → the Organizer dashboard shows a warning; check the payment in the Stripe dashboard. The app retries 10 times automatically.
- **Change the website address** → add a custom domain on the Cloudflare Worker, then update `SITE_URL` in `wrangler.jsonc` and the Site URL in Supabase → Authentication → URL Configuration. Stripe updates itself.

## For developers
- `supabase/schema.sql` — all tables and game rules (safe to re-run in Supabase SQL Editor).
- `src/` — Cloudflare Worker (checkout, Stripe webhook, schedule, email, push). No dependencies.
- `public/` — the website (plain HTML/CSS/JS).
- Tests: `bash tests/run.sh` (needs local Postgres 16) and `node --import ./tests/cf-stub.mjs tests/server_test.mjs`.
  Local preview: `node tests/devserver.mjs <db>` (fake sign-in code 123456, fake payments).
