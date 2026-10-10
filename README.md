# lyrics — standalone synced-lyrics + karaoke app

Standalone version of the synced-lyrics overlay from the personal site
(`yoshik08/personal`). Same UI, same lyrics pipeline (`/api/lyrics`), same
karaoke word-sync engine — but with **per-user Spotify OAuth (PKCE)** instead
of a single server-side account, plus playback controls.

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
  `url`, `trackId`, `deviceId`, `premium`, timing fields) — 401 when logged
  out. Falls back to recently-played when nothing is playing.
- **Playback**: `api/playback.js?action=play|pause|next|previous` — Premium
  only (403 `{error:'premium_required'}` otherwise). All Spotify calls stay
  server-side; tokens never reach the browser.
- **Lyrics**: `api/lyrics.js` + `api/_karaoke-calib.js` are copied verbatim
  from the personal site (lrcmux word timestamps → LRCLIB → interpolation).
- **Frontend**: karaoke mode ON by default (falls back to line view when a
  track has no word timing), sync offset defaults to 0ms (nudge ±50ms kept,
  persisted per track/device in localStorage). Same 2s poll interval and
  drift-correcting playback clock as the original.

## Required env vars (Vercel → this project's Environment Variables)

| var | purpose |
|---|---|
| `SPOTIFY_CLIENT_ID` | Spotify app client id (PKCE public client — no secret needed) |
| `SESSION_SECRET` | random 32+ char string for AES-256-GCM session encryption |
| `SPOTIFY_REDIRECT_URI` | optional override; defaults to `https://yoshik.xyz/lyrics/api/auth/callback` |
| `APPLE_MEDIA_USER_TOKEN` | reserved for the lyrics pipeline if a provider needs it (current `api/lyrics.js` does not consume it) |

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

Set the env vars in `.env` (or `vercel env pull`) and use a Spotify app
redirect URI of `http://localhost:3000/api/auth/callback` via
`SPOTIFY_REDIRECT_URI` for local testing.

## Notes / assumptions

- Karaoke display fonts (`karaoke-fonts.css`) reference
  `/assets/fonts/karaoke-fonts_*.woff2` with absolute paths — these resolve
  to the **main personal site**, which already serves all 185 files. Same
  for the `HankenGrotesk-400.woff2` `@font-face` in `style.css`. No font
  binaries are duplicated in this repo.
- Frontend API calls use **relative** URLs (`api/player`, …) so the app
  works under the `/lyrics/` mount path.
- Post-login/logout redirects target `/lyrics/` (the production mount).
- `api/lyrics.js` edge-caches per query+mode (`s-maxage=3600,
  stale-while-revalidate=86400`) exactly as on the personal site.
