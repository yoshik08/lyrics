// api/auth/callback.js — Spotify OAuth PKCE callback.
// Validates state, exchanges code + verifier for tokens (PKCE public client:
// client_id only, no client secret), then stores an encrypted session cookie
// (30 days, httpOnly) and redirects into the app.
import {
  parseCookies,
  addCookie,
  clearOAuthCookie,
  setSessionCookie,
  OAUTH_COOKIE,
} from "../_session.js";

export default async function handler(req, res) {
  const { code, state, error } = req.query || {};
  clearOAuthCookie(res); // single-use

  const appRoot = "/lyrics/";
  if (error) return res.redirect(appRoot + "?error=" + encodeURIComponent(error));

  let saved = null;
  try {
    saved = JSON.parse(parseCookies(req)[OAUTH_COOKIE] || "null");
  } catch {
    saved = null;
  }
  if (!code || !saved || saved.s !== state) {
    return res.redirect(appRoot + "?error=bad_state");
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri =
    process.env.SPOTIFY_REDIRECT_URI ||
    "https://yoshik.xyz/lyrics/api/auth/callback";
  if (!clientId) return res.status(500).send("SPOTIFY_CLIENT_ID is not configured");

  let tokens = null;
  try {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: saved.v,
      }),
    });
    tokens = await r.json().catch(() => null);
  } catch {
    tokens = null;
  }
  if (!tokens || !tokens.access_token || !tokens.refresh_token) {
    return res.redirect(appRoot + "?error=token_exchange");
  }

  // premium check for playback-control visibility (cached in the session)
  let premium = false;
  try {
    const me = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const meJson = await me.json().catch(() => null);
    premium = !!(meJson && meJson.product === "premium");
  } catch {
    premium = false;
  }

  setSessionCookie(res, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
    premium,
    premium_at: Date.now(),
  });
  res.redirect(appRoot);
}
