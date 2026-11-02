import test from "node:test";
import assert from "node:assert";
import { parseAppleTTML, ttmlTime } from "./_apple-ttml.js";

test("ttmlTime parsing", () => {
  assert.strictEqual(ttmlTime("12.345s"), 12345);
  assert.strictEqual(ttmlTime("1:02.345"), 62345);
  assert.strictEqual(ttmlTime("00:01:02.5"), 62500);
  assert.strictEqual(ttmlTime("95"), 95000);
});

test("parseAppleTTML - word sync", () => {
  const FIXTURE = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"><body><div><p begin="12.000" end="14.500" itunes:key="L1"><span begin="12.000" end="12.300">Hel</span><span begin="12.300" end="12.700">lo</span> <span begin="12.800" end="13.400">dar</span><span begin="13.400" end="14.500">ling</span></p><p begin="1:00.100" end="1:02.900" itunes:key="L2"><span begin="1:00.100" end="1:00.600">Don&apos;t </span><span begin="1:00.600" end="1:01.200">go</span><span ttm:role="x-bg" begin="1:01.500" end="1:02.900"><span begin="1:01.500" end="1:02.900">(stay)</span></span></p></div></body></tt>`;
  
  const res = parseAppleTTML(FIXTURE);
  assert.deepStrictEqual(res, [
    { time: 12000, text: "Hello darling", words: [12000, 12800], ends: [12700, 14500] },
    { time: 60100, text: "Don't go", words: [60100, 60600], ends: [60600, 61200] }
  ]);
});

test("parseAppleTTML - line timed returns null", () => {
  const FIXTURE = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Line"><body><div><p begin="12.000" end="14.500">Hello</p></div></body></tt>`;
  const res = parseAppleTTML(FIXTURE);
  assert.strictEqual(res, null);
});

test("parseAppleTTML - garbage returns empty array", () => {
  assert.deepStrictEqual(parseAppleTTML('<tt itunes:timing="Word">garbage</tt>'), []);
  assert.deepStrictEqual(parseAppleTTML(''), []);
});

test("multi-word background vocals never leak into the main line", () => {
  const X = `<tt itunes:timing="Word"><body><div><p begin="5.0" end="9.0"><span begin="5.0" end="5.5">Hold</span> <span begin="5.5" end="6.0">on</span> <span ttm:role="x-bg"><span begin="6.0" end="6.4">(ooh</span> <span begin="6.4" end="6.9">aah)</span></span> <span begin="7.0" end="8.0">tight</span></p></div></body></tt>`;
  const res = parseAppleTTML(X);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].text, "Hold on tight");
  assert.deepStrictEqual(res[0].words, [5000, 5500, 7000]);
});

test("translation spans are stripped from word lines and surfaced in line mode", () => {
  const X = `<tt itunes:timing="Word"><body><div><p begin="1.0" end="3.0"><span begin="1.0" end="2.0">Hola</span> <span ttm:role="x-translation" xml:lang="en">Hello &amp; welcome</span></p></div></body></tt>`;
  assert.strictEqual(parseAppleTTML(X)[0].text, "Hola");
  const l = parseAppleTTML(X, "line");
  assert.strictEqual(l[0].text, "Hola");
  assert.strictEqual(l[0].translation, "Hello & welcome");
});

test("entities decode once and numeric entities work", () => {
  const X = `<tt itunes:timing="Word"><body><div><p begin="1.0" end="3.0"><span begin="1.0" end="2.0">AT&amp;lt;T</span> <span begin="2.0" end="3.0">it&#39;s&#x2019;</span></p></div></body></tt>`;
  assert.strictEqual(parseAppleTTML(X)[0].text, "AT&lt;T it's’");
});

test("span attribute order does not matter", () => {
  const X = `<tt itunes:timing="Word"><body><div><p itunes:key="L1" begin="2.0" end="3.0"><span end="2.5" begin="2.0">swap</span> <span ttm:agent="v1" end="3.0" begin="2.5">order</span></p></div></body></tt>`;
  assert.deepStrictEqual(parseAppleTTML(X)[0].words, [2000, 2500]);
});
