# Midwest FC Sign-up App

A members-only web app that runs a weekly 18-player pickup soccer game: sign-ups, payments, the waitlist,
refunds and Man of the Match voting. It replaced a WhatsApp routine where players posted their names in the
group chat and the organizer copied the list by hand and chased everyone for payment.

- **Case study, with screenshots:** https://claude.ai/artifact/3tDJ1SNFc5f94nrxSLVDVT
- **Live app (members only):** https://signup.midwestfc.workers.dev

Built by Emmanuel Klinsmann with Claude as the engineering agent. I set the rules and made the product
decisions; Claude wrote the code. See the case study for the full story.

## What it does

| When (Central Time) | What happens automatically |
|---|---|
| Monday 2:00 PM | Sign-ups open; approved members get an email and a push notification. "Sign up & pay $8.05" holds a spot for 10 minutes during checkout. |
| Any time | When the game is full, players join the waitlist for free. When a spot opens, the next person gets 2 hours to pay (paused 10 PM–9 AM), then it moves down the line. |
| Thursday 8:00 PM | Drop deadline. Cards held until now are charged. Earlier drops are refunded in full; later drops only if the spot is filled. |
| Friday 8:00 PM | Sign-ups close and unfinished payments are released. |
| Friday 10:00 PM | Kickoff. Afterwards, everyone who played is asked to vote for Man of the Match. |
| Monday 10:00 AM | Voting closes. The winner gets a trophy badge and a saved spot in next week's game (still paid). |

The organizer approves members per game group (Friday / Wednesday), and can reorder, add or remove players.
Cancelling a game refunds everyone. Organizers also see money collected and on hold, message a game's players,
and download payment history.

## How it's built

- **Front end:** installable mobile web app in plain HTML, CSS and JavaScript (`public/`), with web push.
- **Server and scheduler:** a Cloudflare Worker (`src/`) that creates Stripe Checkout sessions, verifies Stripe
  webhooks, sends email over Gmail SMTP and push notifications, and runs a job every minute. No npm dependencies.
- **Data and rules:** Supabase Postgres (`supabase/schema.sql`). All game rules live in database functions. Every
  table is locked with row-level security, so the site can only call those functions.
- **Payments:** card holds before the drop deadline, captured at the deadline; refunds and releases happen automatically.
- **Sign-in:** passwordless email codes (Supabase Auth).
- **Cost:** about $0 a month on free tiers. Players cover Stripe's fee in the $8.05 price.

## Tests

- `bash tests/run.sh`: 101 rule checks (sign-ups, holds, waitlist offers, deadlines, refunds, memberships,
  Man of the Match, permissions) plus a race test where 40 simultaneous sign-ups get exactly 18 spots.
  Needs a local Postgres 16.
- `node --import ./tests/cf-stub.mjs tests/server_test.mjs`: 15 server checks (checkout, webhook signatures, email).
- `node tests/devserver.mjs <database>`: local preview with fake sign-in (code 123456) and fake payments.

## Running your own copy

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor. Put your organizer email(s) in
   `settings.admin_email`.
2. Deploy the Worker with `wrangler deploy`. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SITE_URL` and `GMAIL_USER`
   in `wrangler.jsonc`, and add the secrets `SUPABASE_SERVICE_KEY`, `STRIPE_SECRET_KEY` and `GMAIL_APP_PASSWORD`
   in the Cloudflare dashboard. The Worker registers its own Stripe webhook and push keys on first run.
3. In Supabase Auth, set the Site URL to your site and add a custom SMTP sender.

No secret keys are stored in this repository.
