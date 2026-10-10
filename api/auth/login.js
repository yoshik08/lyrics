// api/auth/login.js — Spotify OAuth PKCE start.
// Generates code_verifier / code_challenge (S256) + state, stores them in a
// short-lived httpOnly cookie, then redirects to Spotify's authorize page.
import crypto from "crypto";
import { addCookie, OAUTH_COOKIE } from "../_session.js";

const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

export default async function handler(req, res) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send("SPOTIFY_CLIENT_ID is not configured");
  }
  const redirectUri =
    process.env.SPOTIFY_REDIRECT_URI ||
    "https://yoshik.xyz/lyrics/api/auth/callback";

  // PKCE: verifier 43-128 chars from the unreserved set; 64 random bytes -> 86 chars
  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const state = crypto.randomBytes(24).toString("base64url");

  // short-lived (10 min), httpOnly — the verifier never touches the browser JS
  const payload = encodeURIComponent(JSON.stringify({ v: verifier, s: state }));
  addCookie(
    res,
    `${OAUTH_COOKIE}=${payload}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  res.redirect("https://accounts.spotify.com/authorize?" + params.toString());
}
