# House Line

A play-money sportsbook for a friend group. People create accounts, join a group with a six-character invite code, post bets with American odds or over/under lines, wager tokens, and settle results. Balances update live for everyone.

**Stack:** static HTML/CSS/JS front end + Supabase (Postgres, Auth, Realtime). There's no build step.

## How it's secured

- **Reads:** row-level security lets you see only groups you belong to, along with their bets, wagers, and members.
- **Writes:** none happen directly. Every action is a Postgres function in `supabase/schema.sql`:
  - `create_group`, `join_group`
  - `create_bet`
  - `place_wager` locks your balance row, checks funds, and deducts the stake
  - `set_bet_status` (lock or reopen)
  - `settle_bet` pays winners `stake + profit`, rounded down
  - `void_bet` refunds every stake

  These functions check membership and permissions, so nobody can edit a balance from the browser.
- **Odds:** the odds are locked into each wager when it's placed. Editing a line later doesn't change bets already made.
- **Who can lock, settle, or void:** the bet's creator or the group owner.

## Setup (about 10 minutes)

1. **Create a Supabase project** at supabase.com. The free tier is plenty.
2. **Create the database.** Open SQL Editor → New query, paste all of `supabase/schema.sql`, and click Run.
3. **Configure auth.** Go to Authentication → Sign In / Providers → Email.
   - Leave email enabled.
   - For a small friend group, you can turn off **Confirm email** so people can sign in right away.
   - If you keep confirmation on, set Authentication → URL Configuration → **Site URL** to wherever you deploy (step 5).
4. **Connect the app.** Go to Project Settings → API (or API Keys) and copy the **Project URL** and the **anon / publishable key** into `config.js`.
5. **Deploy the folder.** Any static host works:
   - **Netlify Drop:** drag this folder onto app.netlify.com/drop.
   - **Vercel:** run `vercel` in this folder.
   - **GitHub Pages:** push it to a repo and enable Pages.
6. **Start playing.** Open the site, create an account, create a group, and send friends the invite code from the Leaders tab.

## On iPhone

Open the site in Safari, then tap Share → **Add to Home Screen**. It launches full-screen with its own icon, like an app.

A native SwiftUI app could use this same Supabase backend later with no changes to the database.

## Local testing

Serve the folder with any static server, for example `python3 -m http.server 8000`, and open http://localhost:8000. Opening `index.html` directly from disk also works.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell |
| `styles.css` | Styles, with light and dark mode |
| `app.js` | Client: auth, groups, board, slip, leaderboard, live updates |
| `config.js` | Your Supabase URL and key |
| `supabase/schema.sql` | Tables, row-level security, and server-side actions |
| `manifest.webmanifest`, `icons/` | Home-screen install |
