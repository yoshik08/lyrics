import test from "node:test";
import assert from "node:assert";
import handler from "./lyrics.js";

// drive the real handler with a stubbed fetch; no network
function run(query, routes) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [needle, body] of routes) {
      if (u.includes(needle)) return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "", headers: new Map() };
  };
  const headers = {};
  let out = null, status = 200;
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    status(c) { status = c; return this; },
    json(b) { out = b; return this; },
  };
  return handler({ query }, res).then(() => { globalThis.fetch = realFetch; return { out, status, headers }; });
}

const NE_SEARCH = ["music.163.com/api/cloudsearch", { result: { songs: [{ id: 1, name: "Test Song", ar: [{ name: "Tester" }], dt: 200000 }] } }];

test("YRC: lyric text containing '(' is not truncated", async () => {
  const yrc = "[1000,2500](1000,500,0)Hello (1500,500,0)(oh) (2000,800,0)world";
  const { out, headers } = await run({ artist: "Tester", title: "Test Song", mode: "word" },
    [NE_SEARCH, ["music.163.com/api/song/lyric", { yrc: { lyric: yrc }, lrc: { lyric: "" } }]]);
  assert.strictEqual(out.wordSync, true);
  assert.strictEqual(out.lines[0].text, "Hello (oh) world");
  assert.strictEqual(out.lines[0].words.length, 3);
  assert.match(headers["Cache-Control"], /s-maxage=3600/);
});

test("an empty answer is only cached briefly (provider timeouts must not stick for an hour)", async () => {
  for (const mode of ["line", "word"]) {
    const { out, headers } = await run({ artist: "Nobody", title: "Nothing", mode }, []);
    assert.strictEqual(out.source, "none");
    assert.match(headers["Cache-Control"], /s-maxage=30\b/);
    assert.doesNotMatch(headers["Cache-Control"], /stale-while-revalidate/);
  }
});

test("LRCLIB: asking for 'Alive' must not accept '... (Live)' just because 'alive' contains 'live'", async () => {
  const live = [{ trackName: "Alive (Live)", duration: 200, syncedLyrics: "[00:01.00]hello there" }];
  const { out } = await run({ artist: "Band", title: "Alive", mode: "line" }, [["lrclib.net/api/search", live]]);
  assert.strictEqual(out.source, "none");
});

test("LRCLIB: a live version is still allowed when the listener is playing the live version", async () => {
  const live = [{ trackName: "Alive (Live)", duration: 200, syncedLyrics: "[00:01.00]hello there" }];
  const { out } = await run({ artist: "Band", title: "Alive (Live)", mode: "line" }, [["lrclib.net/api/search", live]]);
  assert.strictEqual(out.source, "lrclib");
  assert.strictEqual(out.lines[0].text, "hello there");
});
