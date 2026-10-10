// api/_session.js — shared session helpers for the lyrics app.
// Underscore prefix keeps Vercel from routing it as an endpoint.
// Session = AES-256-GCM encrypted JSON in an httpOnly cookie:
//   { access_token, refresh_token, expires_at, premium, premium_at }
import crypto from "crypto";

export const SESSION_COOKIE = "lyrics_session";
export const OAUTH_COOKIE = "lyrics_oauth";
export const SESSION_MAX_AGE = 30 * 24 * 3600; // 30 days
const PREMIUM_RECHECK_MS = 24 * 3600 * 1000; // re-check premium status daily

function secretKey() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET env var is required");
  return crypto.createHash("sha256").update(String(s)).digest(); // 32 bytes
}

export function encryptSession(obj) {
  const key = secretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(obj), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64url"),
    ct.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptSession(str) {
  try {
    const parts = String(str || "").split(".");
    if (parts.length !== 3) return null;
    const key = secretKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(parts[0], "base64url")
    );
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(parts[1], "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(pt.toString("utf8"));
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const out = {};
  const header = (req.headers && req.headers.cookie) || "";
  header.split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > 0) {
      out[pair.slice(0, i).trim()] = decodeURIComponent(
        pair.slice(i + 1).trim()
      );
    }
  });
  return out;
}

function cookieString(name, value, maxAge) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ];
  if (typeof maxAge === "number") parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

// append a Set-Cookie without clobbering ones already set
export function addCookie(res, str) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) res.setHeader("Set-Cookie", str);
  else if (Array.isArray(prev)) res.setHeader("Set-Cookie", [...prev, str]);
  else res.setHeader("Set-Cookie", [prev, str]);
}

export function setSessionCookie(res, sessionObj) {
  addCookie(
    res,
    cookieString(SESSION_COOKIE, encryptSession(sessionObj), SESSION_MAX_AGE)
  );
}

export function clearSessionCookie(res) {
  addCookie(res, cookieString(SESSION_COOKIE, "", 0));
}

export function clearOAuthCookie(res) {
  addCookie(res, cookieString(OAUTH_COOKIE, "", 0));
}

async function refreshAccessToken(refreshToken) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) throw new Error("SPOTIFY_CLIENT_ID env var is required");
  // PKCE public client: refresh needs client_id only, no client secret.
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  const d = await r.json().catch(() => null);
  if (!d || !d.access_token) return null;
  return d;
}

async function fetchPremium(accessToken) {
  try {
    const r = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const me = await r.json();
    return me && me.product === "premium";
  } catch {
    return null;
  }
}

// Returns the session object with a guaranteed-fresh access token, or null.
// Refreshes the token server-side when expired and re-sets the cookie.
// Also re-checks premium status at most once per day.
export async function getSession(req, res) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const sess = decryptSession(raw);
  if (!sess || !sess.refresh_token) return null;

  if (Date.now() > (sess.expires_at || 0) - 60000) {
    const d = await refreshAccessToken(sess.refresh_token).catch(() => null);
    if (!d) return null; // refresh token revoked/expired -> logged out
    sess.access_token = d.access_token;
    if (d.refresh_token) sess.refresh_token = d.refresh_token; // rotation
    sess.expires_at = Date.now() + (d.expires_in || 3600) * 1000;
    setSessionCookie(res, sess);
  }

  if (
    typeof sess.premium !== "boolean" ||
    Date.now() - (sess.premium_at || 0) > PREMIUM_RECHECK_MS
  ) {
    const p = await fetchPremium(sess.access_token);
    if (p !== null) {
      sess.premium = p;
      sess.premium_at = Date.now();
      setSessionCookie(res, sess);
    }
  }

  return sess;
}
