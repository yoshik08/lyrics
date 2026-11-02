import test from "node:test";
import assert from "node:assert";

process.env.SESSION_SECRET = "test-secret-not-the-real-one";
const { encryptSession, SESSION_COOKIE } = await import("./_session.js");
const { default: handler } = await import("./player.js");

// a valid, unexpired, premium session (so getSession never touches the network)
const cookie = SESSION_COOKIE + "=" + encodeURIComponent(encryptSession({
  access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600e3, premium: true, premium_at: Date.now(),
}));

function call(routes, { withCookie = true } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url); calls.push(u);
    for (const [needle, fn] of routes) if (u.includes(needle)) return fn();
    return { status: 404, ok: false, json: async () => ({}), headers: new Map() };
  };
  const out = { status: 200, body: null, calls };
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; },
  };
  const req = { headers: withCookie ? { cookie } : {} };
  return handler(req, res).then(() => { globalThis.fetch = realFetch; return out; });
}
const ok = (body, status = 200) => () => ({ status, ok: status < 400, json: async () => body, headers: new Map() });
const item = (id, extra = {}) => ({ id, name: "Song " + id, artists: [{ name: "A", external_urls: { spotify: "u" } }], album: { images: [{ url: "img" }] }, external_urls: { spotify: "s" }, duration_ms: 200000, ...extra });

test("no session cookie -> 401", async () => {
  const r = await call([], { withCookie: false });
  assert.strictEqual(r.status, 401);
});

test("playing: ISRC is looked up when the player item has none, and cached for the next poll", async () => {
  const routes = [
    ["/v1/me/player", ok({ is_playing: true, progress_ms: 5000, timestamp: 111, device: { id: "d", type: "Computer" }, item: item("t1") })],
    ["/v1/tracks/t1", ok({ external_ids: { isrc: "USXX12345678" } })],
  ];
  const r1 = await call(routes);
  assert.strictEqual(r1.body.isrc, "USXX12345678");
  assert.strictEqual(r1.body.playing, true);
  assert.strictEqual(r1.body.spotifyTs, 111);
  assert.strictEqual(r1.body.premium, true);
  assert.ok(r1.calls.some((u) => u.includes("/v1/tracks/t1")));
  const r2 = await call(routes);
  assert.strictEqual(r2.body.isrc, "USXX12345678");
  assert.ok(!r2.calls.some((u) => u.includes("/v1/tracks/t1")), "second poll must use the cache");
});

test("playing: an ISRC already on the item needs no extra request", async () => {
  const r = await call([["/v1/me/player", ok({ is_playing: true, progress_ms: 1, item: item("t2", { external_ids: { isrc: "GBAAA0000001" } }) })]]);
  assert.strictEqual(r.body.isrc, "GBAAA0000001");
  assert.ok(!r.calls.some((u) => u.includes("/v1/tracks/")));
});

test("nothing playing: falls back to recently-played (playing:false) with the isrc", async () => {
  const r = await call([
    ["/v1/me/player/recently-played", ok({ items: [{ track: item("t3", { external_ids: { isrc: "FRBBB0000002" } }) }] })],
    ["/v1/me/player", () => ({ status: 204, ok: true, json: async () => ({}), headers: new Map() })],
  ]);
  assert.strictEqual(r.body.playing, false);
  assert.strictEqual(r.body.isrc, "FRBBB0000002");
  assert.strictEqual(r.body.trackId, "t3");
});

test("an upstream failure is flagged transient (the client must keep the current lyrics, not show 'nothing playing')", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  const out = { body: null };
  const res = { headers: {}, setHeader() {}, getHeader() {}, status() { return this; }, json(b) { out.body = b; return this; } };
  await handler({ headers: { cookie } }, res);
  globalThis.fetch = realFetch;
  assert.strictEqual(out.body.transient, true);
  assert.strictEqual(out.body.premium, true);
});

test("rate limited -> rateLimited with retryAfter", async () => {
  const r = await call([["/v1/me/player", () => ({ status: 429, ok: false, json: async () => ({}), headers: { get: () => "7" } })]]);
  assert.strictEqual(r.body.rateLimited, true);
  assert.strictEqual(r.body.retryAfter, 7);
});
