# lyrics — standalone synced-lyrics + karaoke app

Standalone version of the synced-lyrics overlay from the personal site
(`yoshik08/personal`). Same UI, same lyrics pipeline (`/api/lyrics`), same
per-word karaoke engine (`karaoke.js`) — but with **per-user Spotify OAuth
(PKCE)** instead of a single server-side account, plus playback controls.

The lyrics pipeline, the sync clock and the karaoke engine are kept in step
with the personal site (the files below are copied from it; fix bugs there
first, then copy here).

Served at **https://yoshik.xyz/lyrics** (routed by the edge proxy; this repo
has no rewrites of its own).

## How it works

- **Landing** (`/`): "Connect your Spotify account" + one button. Shown only
  when there is no valid session.
- **OAuth**: `api/auth/login.js` starts Spotify PKCE
  (`code_verifier`/`code_challenge` S256 + `state` in a 10-min httpOnly
  cookie). `api/auth/callback.js` validates state, exchanges the code for
  tokens (PKCE public client — `client_id` only, no client secret), and sets
  an AES-256-GCM encrypted session cookie (`lyrics_session`, httpOnly,
  Secure, SameSite=Lax, 30-day Max-Age) holding
  `{ access_token, refresh_token, expires_at, premium }`.
- **Session**: `api/_session.js` decrypts the cookie per request and refreshes
  the access token server-side when expired (refresh token rotation handled).
  `api/auth/status.js` → `{ loggedIn, premium }`;
  `api/auth/logout.js` clears the cookie.
- **Player**: `api/player.js` returns the user's currently playing track in
  the same shape the sync engine expects
  (`playing`, `progressMs`, `durationMs`, `title`, `artist(s)`, `image`,
  `url`, `trackId`, `isrc`, `deviceId`, `premium`, timing fields incl.
  Spotify's state-change `spotifyTs`) — 401 when logged out. Falls back to
  recently-played when nothing is playing. A Spotify/network hiccup returns
  `{ transient: true }` so the page keeps the current track instead of
  flashing "nothing playing". The ISRC is fetched once per track (and cached)
  because Apple lyrics are looked up by ISRC.
- **Playback**: `api/playback.js?action=play|pause|next|previous` — Premium
  only (403 `{error:'premium_required'}` otherwise). All Spotify calls stay
  server-side; tokens never reach the browser.
- **Lyrics**: `api/lyrics.js`, `api/_apple-ttml.js` and
  `api/_karaoke-calib.js` are copied verbatim from the personal site (Apple
  syllable timings → lrcmux/NetEase word timings with LRCLIB/YTMusic
  calibration → LRCLIB lines). Misses and failures are cached for 30s only;
  real hits for an hour.
- **Karaoke** (`karaoke.js` + `karaoke.css`): Verci-style per-word display.
  One focus word on a tilted highlight box, earlier words linger in a muted
  secondary colour, upcoming words fade in small. Four styles — Ship, Fisheye,
  Fisheye Visual, Visual (keys 1-4) — and a settings bar for the lyric /
  highlight / secondary colours, remembered in localStorage. `demo.html` runs
  the engine on placeholder lyrics with a play/pause/scrub bar.
- **Frontend**: karaoke mode ON by default (falls back to line view when a
  track has no word timing). Same 2s poll interval and drift-correcting
  playback clock as the personal site; a change of Spotify's `timestamp`
  (play/pause/skip/scrub) resets the clock's sample window.
- **Sync offsets**: nothing is baked in — the automatic lead is 0 for lines
  and per word source for karaoke (Apple 0, Kugou -100, NetEase -400, others
  +150, the provider biases this code has always applied). The sync pill's
  +/- adjust **that song only** (saved per track, shown permanently on the
  pill when set; hold to reset). Mouse-wheel does nothing on purpose.
- **Headphones** (button or `H`): a manual, per-browser toggle, OFF by default,
  that shows lyrics 225 ms later to match Bluetooth audio delay. 225 ms is the
  owner's measured value (`HEADPHONES_MS` in `script.js`), not a universal one.

## Required env vars (Vercel → this project's Environment Variables)

| var | purpose |
|---|---|
| `SPOTIFY_CLIENT_ID` | Spotify app client id (PKCE public client — no secret needed) |
| `SESSION_SECRET` | random 32+ char string for AES-256-GCM session encryption |
| `SPOTIFY_REDIRECT_URI` | optional override; defaults to `https://yoshik.xyz/lyrics/api/auth/callback` |
| `APPLE_MEDIA_USER_TOKEN` | Apple Music media-user-token: enables the Apple word-sync lyrics provider |

`api/lyrics.js` also reads `APPLE_DEV_TOKEN` if set (otherwise it scrapes one)
and uses `APPLE_MEDIA_USER_TOKEN` for the Apple word-sync provider.

Never hardcode secrets — everything above comes from `process.env`.

## Spotify app setup

Add this redirect URI to the Spotify app's allowlist (Spotify Developer
Dashboard → app → Settings → Redirect URIs):

```
https://yoshik.xyz/lyrics/api/auth/callback
```

No changes to the app's client secret are needed (PKCE flow).

## Edge routing (done outside this repo)

In the main site's `vercel.json` (edge proxy):

```json
{ "source": "/lyrics", "destination": "https://<this-project>.vercel.app/" },
{ "source": "/lyrics/", "destination": "https://<this-project>.vercel.app/" },
{ "source": "/lyrics/:path*", "destination": "https://<this-project>.vercel.app/:path*" }
```

## Local dev

```bash
npm i -g vercel   # if needed
vercel dev        # serves index.html + api/ functions
```

Pull the env vars with `vercel link --project lyrics && vercel env pull .env.local`
(`.env*` and `.vercel` are gitignored) and use a Spotify app redirect URI of
`http://localhost:3000/api/auth/callback` via `SPOTIFY_REDIRECT_URI` for local
testing.

Tests (no network needed): `node --test api/`.

## Notes / assumptions

- The display face (Bricolage Grotesque, `assets/fonts/Bricolage-wdth.woff2`,
  78 KB) is bundled with the app and referenced by a **relative** url, so it
  resolves both on `*.vercel.app` and under the `/lyrics/` mount. (The old
  185-file karaoke font stylesheet is gone: the new engine uses one face.)
- Frontend API calls use **relative** URLs (`api/player`, …) so the app
  works under the `/lyrics/` mount path.
- Post-login/logout redirects target `/lyrics/` (the production mount).
- `api/lyrics.js` edge-caches per query+mode (`s-maxage=3600,
  stale-while-revalidate=86400`) exactly as on the personal site.
