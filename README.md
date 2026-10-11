# Midwest FC — members sign-up app

Website: **https://signup.midwestfc.workers.dev**
Status check: https://signup.midwestfc.workers.dev/api/health — every line should say `ok` (never shows any keys).

## How it works (the rules)
- **Members only.** New people sign in, enter their name, tick the waiver and pick the group(s) they want
  (Friday Games and/or Wednesday Games). The organizer gets an email and approves or declines each request.
  Until approved they only see a "request pending" screen. Badges (FRI / WED) show who is in which group.
- **Friday Games:** every Friday, 10:00–11:30 PM CT at Ackerman Soccer. 18 spots, $8.05.
  Games are scheduled Oct 16 – Dec 25, 2026 (add more any time: Organizer → Games → Add weekly games).
- **Wednesday Games:** the group exists for memberships; no games yet.
- Sign-ups open Monday 2:00 PM CT of game week and close 2 hours before kickoff. Approved members of that group get an email when they open.
- "Sign up & pay" holds your spot for 10 minutes while you pay (card, Apple Pay, Google Pay).
- Before Thursday 8 PM your card is only *held*; it's charged at Thursday 8 PM. Sign-ups after that are charged right away.
- Drop before Thursday 8 PM → full refund (the hold is released). Drop after → refunded only if someone takes the spot.
- When full, players join the waitlist for free. When a spot opens, the next person gets an email and 2 hours to pay
  (30 minutes on game day). The clock pauses 10 PM–9 AM. If they don't pay, it goes to the next person.
- Game-day reminder at 9 AM Friday.
- **Man of the Match:** after each game, everyone who played gets a notification to vote (not for themselves) until
  the next Monday 10 AM CT; a reminder goes out a day before. The winner (ties: all tied players) gets a 🏆 MOTM badge
  and a spot saved in the next game, which they still have to pay for (within 2 hours of sign-ups opening, or it goes to
  the waitlist). Past winners and a leaderboard: 🏆 MOTM link at the bottom of the app.

## Organizer (Organizer button at the top of the app)
- **Games**: every scheduled game per group. Tap one for its board: who's playing, waitlist, money collected/on hold;
  move people ↑↓; remove (with or without refund); "Add a player" saves them a spot that they must pay for
  (they get an email; unpaid saved spots are released and you're told); change location, max players, kickoff;
  cancel the game (refunds everyone); delete an empty game. "Add weekly games" / "Add one game" create new slots.
- **Members**: join requests at the top (Approve / Decline). Filter by group, search, and "Manage" a person to
  approve/remove them per group, make them organizer, or block them.
- **Message**: email + notify everyone on a chosen game's list.
- **Settings**: per group — price, spots, location, kickoff, sign-up opening day/time, drop deadline; club-wide —
  hold/offer lengths, overnight pause (applies to games added afterwards).
- To start Wednesday games: Settings → Wednesday Games (set location/time/price) → Games → Add weekly games.
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
