// api/player.js — per-user "now playing" for the lyrics app.
// Reads the session cookie, auto-refreshes the access token server-side when
// expired, and returns the same shape the frontend sync engine expects
// (mirrors the personal site's /api/now-playing), plus `premium`.
// 401 when there is no usable session.
import { getSession, clearSessionCookie } from "./_session.js";

export default async function handler(req, res) {
  const tStart = performance.now();
  res.setHeader("Cache-Control", "no-store");

  let sess = null;
  try {
    sess = await getSession(req, res);
  } catch {
    sess = null;
  }
  if (!sess) return res.status(401).json({ error: "not_logged_in" });

  const auth = { Authorization: `Bearer ${sess.access_token}` };
  const pick = (t, outer) => ({
    trackId: t.id || null,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(", "),
    artists: (t.artists || []).map((a) => ({
      name: a.name,
      url: a.external_urls ? a.external_urls.spotify : null,
    })),
    image:
      t.album && t.album.images && t.album.images.length
        ? t.album.images[0].url
        : null,
    url: t.external_urls ? t.external_urls.spotify : null,
    progressMs: outer ? outer.progress_ms : null,
    durationMs: t.duration_ms || null,
  });

  try {
    const spSend = performance.now();
    let now = await fetch("https://api.spotify.com/v1/me/player", {
      headers: auth,
      cache: "no-store",
    });
    let spRecv = performance.now();

    if (now.status === 401 || now.status === 403) {
      now = await fetch(
        "https://api.spotify.com/v1/me/player/currently-playing",
        { headers: auth, cache: "no-store" }
      );
      spRecv = performance.now();
    }

    if (now.status === 429) {
      return res.status(200).json({
        rateLimited: true,
        retryAfter: +now.headers.get("retry-after") || 10,
        premium: !!sess.premium,
      });
    }
    if (now.status === 401 || now.status === 403) {
      // token rejected even after refresh -> refresh token is dead
      clearSessionCookie(res);
      return res.status(401).json({ error: "not_logged_in" });
    }

    if (now.status === 200) {
      const d = await now.json();
      if (d && d.item) {
        const tOut = performance.now();
        return res.status(200).json({
          playing: d.is_playing,
          timestamp: Date.now(),
          deviceId: d.device ? d.device.id : null,
          deviceType: d.device ? d.device.type : null,
          ...pick(d.item, d),
          premium: !!sess.premium,
          spotifyTs: d.timestamp || null,
          spotifyRtt: Math.round(spRecv - spSend),
          msSinceSpotifyResponse: Math.round(tOut - spRecv),
          serverHold: Math.round(tOut - tStart),
          serverNow: Date.now(),
        });
      }
    }

    // nothing playing right now: fall back to last played (playing: false)
    const recent = await fetch(
      "https://api.spotify.com/v1/me/player/recently-played?limit=1",
      { headers: auth, cache: "no-store" }
    );
    const r = await recent.json();
    if (r.items && r.items.length) {
      return res.status(200).json({
        playing: false,
        timestamp: Date.now(),
        premium: !!sess.premium,
        ...pick(r.items[0].track),
      });
    }
    return res.status(200).json({ premium: !!sess.premium });
  } catch {
    return res.status(200).json({ premium: !!sess.premium });
  }
}
