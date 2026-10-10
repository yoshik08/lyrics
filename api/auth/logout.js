// api/auth/logout.js — clears the session cookie and returns to the app root.
import { clearSessionCookie } from "../_session.js";

export default async function handler(req, res) {
  clearSessionCookie(res);
  res.redirect("/lyrics/");
}
