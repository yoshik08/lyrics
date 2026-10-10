// api/auth/status.js — { loggedIn, premium } for the frontend boot check.
// Refreshes the access token server-side when expired.
import { getSession } from "../_session.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const sess = await getSession(req, res);
    if (!sess) return res.status(200).json({ loggedIn: false });
    return res.status(200).json({ loggedIn: true, premium: !!sess.premium });
  } catch {
    return res.status(200).json({ loggedIn: false });
  }
}
