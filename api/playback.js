// api/playback.js — playback controls (Premium only).
// POST /api/playback?action=play|pause|next|previous
// All Spotify calls stay server-side; tokens never reach the browser.
// 401: no session. 403 {error:'premium_required'}: not a Premium account.
// 404 {error:'no_active_device'}: Spotify has no active device to control.
import { getSession, clearSessionCookie } from "./_session.js";

const ACTIONS = {
  play: ["PUT", "/v1/me/player/play"],
  pause: ["PUT", "/v1/me/player/pause"],
  next: ["POST", "/v1/me/player/next"],
  previous: ["POST", "/v1/me/player/previous"],
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const action = req.query.action;
  if (!ACTIONS[action]) {
    return res.status(400).json({ error: "bad_action" });
  }

  let sess = null;
  try {
    sess = await getSession(req, res);
  } catch {
    sess = null;
  }
  if (!sess) return res.status(401).json({ error: "not_logged_in" });
  if (!sess.premium) {
    return res.status(403).json({ error: "premium_required" });
  }

  const [method, path] = ACTIONS[action];
  try {
    const r = await fetch("https://api.spotify.com" + path, {
      method,
      headers: { Authorization: `Bearer ${sess.access_token}` },
    });
    if (r.status === 401 || r.status === 403) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "not_logged_in" });
    }
    if (r.status === 404) {
      return res.status(404).json({ error: "no_active_device" });
    }
    if (r.status === 429) {
      return res
        .status(429)
        .json({ error: "rate_limited", retryAfter: +r.headers.get("retry-after") || 10 });
    }
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(502).json({ error: "spotify_unreachable" });
  }
}
