# Peer Pressure Prototype

A static prototype for private friend-group prediction markets. The shared MVP uses Supabase auth, invite-only markets, realtime updates, and fake AUD test credits so friends can place and resolve test bets without moving real money.

## Run locally

Open `index.html` directly for local demo mode. In this mode, markets and entries are saved to browser local storage and are not shared between users.

For shared multiplayer testing, serve the folder from a local web server or GitHub Pages after configuring Supabase.

## Shared Supabase setup

1. Create a Supabase project.
2. Open the SQL editor and run `supabase-schema.sql`.
3. Copy `supabase-config.example.js` to `supabase-config.js`.
4. Fill in your Supabase project URL, publishable anon key, and auth redirect URL.
5. In Supabase Auth settings, add your local/deployed `auth.html` URL as an allowed redirect URL.
6. Redeploy the static site.

The committed `supabase-config.js` is intentionally blank so the public repo is not tied to a specific Supabase project. Until values are set, the app stays in local demo mode.

## Test wallet mode

Signed-in shared-mode users receive `$1,000` in fake test credits through `ensure_test_wallet`. Stakes are debited by `place_test_bet`, and settlement credits or void refunds are handled by `resolve_market_with_test_wallets`.

The browser does not directly insert entries or settle markets in shared mode. Supabase RPCs validate access, stake size, wallet balance, side-switching, market status, cutoff, owner-only resolution, and idempotent settlement.

## Stripe direction

Stripe is deferred for this prototype. A later test-mode Stripe flow could simulate buying demo credits through Checkout and credit the Supabase wallet from a webhook, but real-money betting or payouts require legal/compliance review and payment-provider approval before implementation.

## Publish flow

This copy is intended to live at `reefrandep-sudo/peer-pressure`. Changes should go through a draft PR first so the original project remains untouched.

## Checks

Run the payout math tests with:

```bash
npm test
```
