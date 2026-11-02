// api/_karaoke-calib.test.mjs — run: node --test api/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normLine,
  matchLines,
  estimateOffset,
  calibrate,
  alignWordCount,
  yrcEnds,
} from "./_karaoke-calib.js";

// ───────────────────────── helpers ──────────────────────────────────
function makeSong(numLines, baseTime, gap) {
  const lyrics = [
    "I been wakin up in the morning",
    "Feeling like a brand new person",
    "Running through the city lights",
    "Dancing in the pouring rain",
    "Singing every word out loud",
    "Holding on to everything",
    "Breaking through the walls tonight",
    "Living like there is no end",
    "Dreaming with my eyes wide open",
    "Falling but I keep on going",
    "Climbing up to higher ground",
    "Searching for the golden sound",
    "Whisper in the midnight hour",
    "Chasing all the shooting stars",
    "Nothing gonna bring me down",
  ];
  const lines = [];
  for (let i = 0; i < numLines && i < lyrics.length; i++) {
    lines.push({ time: baseTime + i * gap, text: lyrics[i] });
  }
  return lines;
}

function makeCandWithWords(refLines, offsetMs, jitterFn) {
  return refLines.map((ln, i) => {
    const jitter = jitterFn ? jitterFn(i) : 0;
    const time = ln.time + offsetMs + jitter;
    const words = ln.text.split(/\s+/);
    const wordTimes = words.map((_, wi) => time + wi * 50);
    return { time, text: ln.text, words: wordTimes };
  });
}

// ───────────────────────── normLine ────────────────────────────────
describe("normLine", () => {
  it("lowercases and strips accents", () => {
    assert.equal(normLine("Café"), "cafe");
    assert.equal(normLine("naïve résumé"), "naive resume");
  });

  it("replaces dashes with spaces", () => {
    assert.equal(normLine("word-level—timing"), "word level timing");
  });

  it("strips punctuation, collapses whitespace", () => {
    assert.equal(normLine("  hello,   world!  "), "hello world");
    assert.equal(normLine("don't"), "dont");
  });

  it("handles empty/null", () => {
    assert.equal(normLine(""), "");
    assert.equal(normLine(null), "");
    assert.equal(normLine(undefined), "");
  });
});

// ───────────────────────── matchLines ──────────────────────────────
describe("matchLines", () => {
  it("matches identical lines within time window", () => {
    const ref = makeSong(8, 10000, 4000);
    const cand = makeCandWithWords(ref, 250, () => 0);
    const pairs = matchLines(cand, ref);
    assert.equal(pairs.length, 8);
    pairs.forEach((p) => assert.equal(p.ci, p.ri));
  });

  it("matches by first 4 words when full text differs", () => {
    const ref = [
      { time: 5000, text: "I been wakin up in the morning yeah" },
    ];
    const cand = [
      { time: 5200, text: "I been wakin up in the evening", words: [5200] },
    ];
    const pairs = matchLines(cand, ref);
    assert.equal(pairs.length, 1);
  });

  it("skips non-matching lines on both sides", () => {
    const ref = [
      { time: 5000, text: "unmatched ref line" },
      { time: 9000, text: "Dancing in the pouring rain" },
    ];
    const cand = [
      { time: 5100, text: "extra candidate line", words: [5100] },
      { time: 9200, text: "Dancing in the pouring rain", words: [9200] },
    ];
    const pairs = matchLines(cand, ref);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].ci, 1);
    assert.equal(pairs[0].ri, 1);
  });

  it("rejects matches outside 3000ms window", () => {
    const ref = [{ time: 5000, text: "Hello world again today" }];
    const cand = [
      { time: 8500, text: "Hello world again today", words: [8500] },
    ];
    const pairs = matchLines(cand, ref);
    assert.equal(pairs.length, 0);
  });

  it("uses words[0] for delta when available", () => {
    const ref = [{ time: 10000, text: "Singing every word out loud" }];
    const cand = [
      { time: 10100, text: "Singing every word out loud", words: [10150, 10250, 10350, 10450, 10550] },
    ];
    const pairs = matchLines(cand, ref);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].delta, 150); // 10150 - 10000
  });

  it("falls back to cand.time when words is empty", () => {
    const ref = [{ time: 10000, text: "Singing every word out loud" }];
    const cand = [{ time: 10200, text: "Singing every word out loud" }];
    const pairs = matchLines(cand, ref);
    assert.equal(pairs[0].delta, 200); // 10200 - 10000
  });
});

// ───────────────────────── estimateOffset ──────────────────────────
describe("estimateOffset", () => {
  it("returns null with fewer than 6 pairs", () => {
    const pairs = [0, 1, 2, 3, 4].map((i) => ({ ci: i, ri: i, delta: 100 }));
    assert.equal(estimateOffset(pairs), null);
  });

  it("computes median and MAD for 6+ pairs", () => {
    // deltas: 240, 245, 250, 255, 260, 265
    const pairs = [240, 245, 250, 255, 260, 265].map((d, i) => ({
      ci: i, ri: i, delta: d,
    }));
    const est = estimateOffset(pairs);
    assert.notEqual(est, null);
    assert.equal(est.pairs, 6);
    // median of [240,245,250,255,260,265] = (250+255)/2 = 252.5
    assert.equal(est.offsetMs, 252.5);
  });

  it("outliers don't move the median significantly", () => {
    // 8 normal deltas ~250 + 2 outlier deltas ~2000
    const deltas = [240, 245, 248, 250, 252, 255, 258, 260, 2000, 2100];
    const pairs = deltas.map((d, i) => ({ ci: i, ri: i, delta: d }));
    const est = estimateOffset(pairs);
    // median of sorted [240,245,248,250,252,255,258,260,2000,2100]
    // mid = 5, (252+255)/2 = 253.5... wait, n=10, mid=5
    // sorted[4]=252, sorted[5]=255 → median = (252+255)/2 = 253.5
    assert.ok(est.offsetMs >= 245 && est.offsetMs <= 260,
      `offset ${est.offsetMs} should be near 250 despite outliers`);
  });
});

// ───────────────────────── calibrate ───────────────────────────────
describe("calibrate", () => {
  it("single ref with ~250ms offset gives medium confidence", () => {
    const ref = makeSong(10, 10000, 4000);
    const jitter = (i) => (i % 3 - 1) * 30; // -30, 0, +30
    const candLines = makeCandWithWords(ref, 250, jitter);
    const result = calibrate(
      { lines: candLines },
      [{ name: "lrclib", lines: ref }],
      { provider: "netease" }
    );
    assert.ok(!result.rejected, "should not be rejected");
    assert.equal(result.calib.confidence, "medium");
    assert.ok(Math.abs(result.calib.offsetMs - 250) < 50,
      `offset ${result.calib.offsetMs} should be ~250`);
    // lines should be shifted
    assert.ok(result.lines.length === candLines.length);
    assert.ok(result.lines[0].time < candLines[0].time);
  });

  it("two agreeing refs give high confidence when MAD low", () => {
    const ref1 = makeSong(10, 10000, 4000);
    const ref2 = makeSong(10, 10000, 4000); // same timing
    const candLines = makeCandWithWords(ref1, 200, () => 0);
    const result = calibrate(
      { lines: candLines },
      [
        { name: "lrclib", lines: ref1 },
        { name: "netease", lines: ref2 },
      ],
      { provider: "lrcmux" }
    );
    assert.ok(!result.rejected);
    assert.equal(result.calib.confidence, "high");
    // offset should be ~200 (average of two identical estimates)
    assert.ok(Math.abs(result.calib.offsetMs - 200) < 10);
  });

  it("two refs disagreeing by 300ms picks lower MAD, doesn't average", () => {
    const ref1 = makeSong(10, 10000, 4000);
    // ref2 has different timing: shifted 300ms from ref1
    const ref2 = makeSong(10, 10300, 4000);
    const candLines = makeCandWithWords(ref1, 200, () => 0);
    const result = calibrate(
      { lines: candLines },
      [
        { name: "lrclib", lines: ref1 },
        { name: "netease", lines: ref2 },
      ],
      { provider: "lrcmux" }
    );
    assert.ok(!result.rejected);
    assert.equal(result.calib.confidence, "medium");
    // should use ref1 (lower mad, offset ~200) not an average
    assert.ok(Math.abs(result.calib.offsetMs - 200) < 10,
      `offset ${result.calib.offsetMs} should be ~200, not an average`);
  });

  it("KuGou with no refs gives +220 prior", () => {
    const candLines = makeCandWithWords(makeSong(10, 10000, 4000), 220, () => 0);
    const result = calibrate(
      { lines: candLines },
      [], // no refs
      { provider: "kugou" }
    );
    assert.ok(!result.rejected);
    assert.equal(result.calib.confidence, "prior");
    assert.equal(result.calib.offsetMs, 220);
  });

  it("non-kugou with no refs gives 0 none", () => {
    const candLines = makeCandWithWords(makeSong(10, 10000, 4000), 100, () => 0);
    const result = calibrate(
      { lines: candLines },
      [],
      { provider: "netease" }
    );
    assert.ok(!result.rejected);
    assert.equal(result.calib.confidence, "none");
    assert.equal(result.calib.offsetMs, 0);
  });

  it("candidate whose lines don't match a provided reference -> calibrate rejected", () => {
    const ref = makeSong(10, 10000, 4000); // 10 lines
    const wrongCandLines = [
      { time: 10000, text: "Totally different lyrics", words: [10000] },
      { time: 14000, text: "Not even close", words: [14000] },
      { time: 18000, text: "Wrong song", words: [18000] },
      { time: 22000, text: "Still wrong", words: [22000] },
      { time: 26000, text: "Blah blah", words: [26000] },
      { time: 30000, text: "Another bad line", words: [30000] },
    ];
    const result = calibrate(
      { lines: wrongCandLines },
      [{ name: "lrclib", lines: ref }],
      { provider: "kugou" }
    );
    assert.ok(result.rejected);
    assert.equal(result.reason, "no overlap with reference (wrong song?)");
  });

  it("rejects huge offset > 1500ms", () => {
    const ref = makeSong(10, 10000, 4000);
    const candLines = makeCandWithWords(ref, 1600, () => 0);
    const result = calibrate(
      { lines: candLines },
      [{ name: "ref", lines: ref }],
      { provider: "x" }
    );
    assert.ok(result.rejected);
    assert.ok(result.reason.includes("offset too large"));
  });

  it("does not mutate input candidate lines", () => {
    const ref = makeSong(8, 10000, 4000);
    const candLines = makeCandWithWords(ref, 200, () => 0);
    // deep copy to compare after
    const origTime0 = candLines[0].time;
    const origWord0 = candLines[0].words[0];
    const origEnds = candLines.map(l => l.ends);
    calibrate(
      { lines: candLines },
      [{ name: "ref", lines: ref }],
      { provider: "test" }
    );
    assert.equal(candLines[0].time, origTime0, "input time must not be mutated");
    assert.equal(candLines[0].words[0], origWord0, "input words must not be mutated");
  });

  it("works with ends[] arrays", () => {
    const ref = makeSong(8, 10000, 4000);
    const candLines = ref.map((ln) => {
      const words = ln.text.split(/\s+/);
      const time = ln.time + 200;
      return {
        time,
        text: ln.text,
        words: words.map((_, i) => time + i * 50),
        ends: words.map((_, i) => time + i * 50 + 40),
      };
    });
    const origEnd0 = candLines[0].ends[0];
    const result = calibrate(
      { lines: candLines },
      [{ name: "ref", lines: ref }],
      { provider: "test" }
    );
    assert.ok(!result.rejected);
    // ends should be shifted
    assert.ok(result.lines[0].ends[0] < origEnd0);
    // input not mutated
    assert.equal(candLines[0].ends[0], origEnd0);
  });
});

// ───────────────────────── alignWordCount ──────────────────────────
describe("alignWordCount", () => {
  it("returns starts/ends when counts already match", () => {
    const textWords = ["hello", "world"];
    const providerWords = [
      { text: "hello", start: 100, end: 300 },
      { text: "world", start: 400, end: 600 },
    ];
    const result = alignWordCount(textWords, providerWords);
    assert.deepEqual(result, { starts: [100, 400], ends: [300, 600] });
  });

  it("drops punctuation-only tokens", () => {
    const textWords = ["hello", "world"];
    const providerWords = [
      { text: "hello", start: 100, end: 300 },
      { text: ",", start: 310, end: 320 },
      { text: "world", start: 400, end: 600 },
    ];
    const result = alignWordCount(textWords, providerWords);
    assert.deepEqual(result, { starts: [100, 400], ends: [300, 600] });
  });

  it("merges don + 't into don't", () => {
    const textWords = ["don't", "stop"];
    const providerWords = [
      { text: "don", start: 100, end: 200 },
      { text: "'t", start: 210, end: 250 },
      { text: "stop", start: 300, end: 500 },
    ];
    const result = alignWordCount(textWords, providerWords);
    assert.notEqual(result, null);
    assert.equal(result.starts.length, 2);
    assert.equal(result.starts[0], 100);
    assert.equal(result.ends[0], 250); // merged end
    assert.equal(result.starts[1], 300);
  });

  it("returns null when counts can't be reconciled", () => {
    const textWords = ["a", "b", "c"];
    const providerWords = [
      { text: "x", start: 0, end: 100 },
      { text: "y", start: 200, end: 300 },
    ];
    assert.equal(alignWordCount(textWords, providerWords), null);
  });

  it("drops empty tokens", () => {
    const textWords = ["hello"];
    const providerWords = [
      { text: "", start: 0, end: 50 },
      { text: "hello", start: 100, end: 300 },
      { text: "", start: 310, end: 320 },
    ];
    const result = alignWordCount(textWords, providerWords);
    assert.deepEqual(result, { starts: [100], ends: [300] });
  });

  it("handles trailing-space tokens gracefully", () => {
    const textWords = ["I'm", "good"];
    const providerWords = [
      { text: "I", start: 100, end: 150 },
      { text: "'m", start: 160, end: 200 },
      { text: "good", start: 300, end: 500 },
    ];
    const result = alignWordCount(textWords, providerWords);
    assert.notEqual(result, null);
    assert.equal(result.starts.length, 2);
  });
});

// ───────────────────────── yrcEnds ─────────────────────────────────
describe("yrcEnds", () => {
  it("computes end = start + dur for each chunk", () => {
    const chunks = [
      { start: 100, dur: 200, text: "hel" },
      { start: 300, dur: 150, text: "lo" },
      { start: 500, dur: 300, text: "world" },
    ];
    assert.deepEqual(yrcEnds(chunks), [300, 450, 800]);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(yrcEnds([]), []);
    assert.deepEqual(yrcEnds(null), []);
  });
});
