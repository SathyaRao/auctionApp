# Cricket Auction

A self-contained cricket auction web app (4-8 teams) with live bidding, a teams
dashboard, a player pool, GitHub-backed storage, a view-only spectator mode, and
an admin password gate. Plain HTML/CSS/JS - no build step.

Live (GitHub Pages): https://SathyaRao.github.io/auctionApp/
Spectator link: https://SathyaRao.github.io/auctionApp/?mode=view

## Features

- Setup 4-8 teams, per-team purse, and min/max squad sizes.
- Live auction: bring a player, bid per team, sell to leader, or mark unsold.
  Bid increments: 1,000 / 2,000 / 5,000 / 10,000. Default purse: 100,000.
- Teams dashboard: purse left, spent, roster, squad progress.
- Player pool: seed players plus add / remove / re-list.
- GitHub-backed storage (same mechanism as the IronWill gym app): data is saved
  to `data/data.json` in this repo via the GitHub API, with a localStorage
  fallback so the app still works offline.
- View-only spectator mode (`?mode=view`): read-only, auto-refreshes every few
  seconds. All admin controls are hidden.
- Admin password gate on every non-spectator view. Default password: `admin123`
  (change it under Settings). Note: this is a client-side soft gate, not
  server-enforced security.

## Storage setup

1. Create a GitHub Personal Access Token with `repo` scope:
   https://github.com/settings/tokens/new
2. Open the app, go to the **Settings** tab, and paste the token. Owner/repo are
   pre-filled to `SathyaRao/auctionApp`.
3. Click **Test connection**, then **Save & sync**.

For remote spectators to see live updates, this repo must be **public** (so
anonymous polling works) or spectators need read access.

## GitHub Pages

The app is static and served from the repo root, so Pages can deploy directly:

1. Repo **Settings -> Pages**.
2. **Build and deployment -> Source: Deploy from a branch**.
3. Branch: `main`, folder: `/ (root)`. Save.
4. After a minute it will be live at `https://SathyaRao.github.io/auctionApp/`.

Serving over `https://` also enables real SHA-256 password hashing (the
`file://` fallback hash is only used when opening the files locally).

## Local use

Just open `index.html` in a browser. For the admin gate to use SHA-256 hashing,
serve it over http(s) (e.g. `npx serve` or GitHub Pages); opening via `file://`
uses a weaker fallback hash.

## Project structure

```
index.html          # markup and views
css/styles.css      # styling
js/store.js         # GitHub-backed JSON store (+ localStorage fallback)
js/app.js           # auction engine, rendering, auth gate, spectator mode
data/data.json      # persisted auction state
```
