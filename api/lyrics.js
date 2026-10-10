// vercel serverless: GET /api/lyrics?artist=&title=&duration=&mode=line|word
import { calibrate, alignWordCount, yrcEnds } from "./_karaoke-calib.js";

// Three providers queried in parallel, each with a 4s timeout.
// mode=line  → race: first provider with synced lyrics wins.
// mode=word  → priority: lrcmux word > netease word > wordSync:false.
// responses are edge-cached for a day per query+mode.

const LRCLIB_EXCLUDE = [
  "music video",
  "japanese",
  "jp ver",
  "remix",
  "live",
  "instrumental",
  "acoustic",
];

const STOP_WORDS = new Set(["the", "a", "an"]);

function cleanTitle(raw) {
  let s = raw;
  let prev;
  do {
    prev = s;
    s = s.replace(/\s*[\(\[](?:feat|ft|featuring|with)\.?\s+[^)\]]+[\)\]]/gi, "");
    s = s.replace(/\s*[\(\[](?:bonus(?:\s+track)?|remaster(?:ed)?.*?|\d{4}\s+remaster(?:ed)?.*?)[\]\)]/gi, "");
    s = s.replace(/\s*-\s*(?:bonus(?:\s+track)?|remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|radio\s+(?:edit|version)|single\s+(?:version|edit)|explicit(?:\s+version)?)\s*$/gi, "");
    s = s.trim();
  } while (s !== prev);
  return s || raw;
}

const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-_–—/]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

function firstSigWord(s) {
  const words = norm(s).split(/\s+/).filter(Boolean);
  return words.find((w) => !STOP_WORDS.has(w)) || words[0] || "";
}

export default async function handler(req, res) {
  const artist = String(req.query.artist || "").slice(0, 200);
  const title = String(req.query.title || "").slice(0, 200);
  const duration = parseFloat(req.query.duration) || 0; // seconds
  const mode = req.query.mode === "word" ? "word" : "line";
  if (!artist || !title)
    return res.status(400).json({ error: "artist and title required" });

  res.setHeader(
    "Cache-Control",
    "s-maxage=3600, stale-while-revalidate=86400"
  );

  const cleanedTitle = cleanTitle(title);
  const TIMEOUT = 4000;
  const ac = (ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };

  // --- Provider fetchers (all return a normalized result or null) ---

  async function fetchLrcmux(queryTitle) {
    try {
      const r = await fetch(
        "https://api.lrcmux.dev/get?artist=" +
          encodeURIComponent(artist) +
          "&title=" + encodeURIComponent(queryTitle) +
          "&duration=" + Math.round(duration),
        { headers: { "User-Agent": "yoshik.xyz/lyrics" }, signal: ac(TIMEOUT) }
      );
      if (!r.ok) return null;
      const d = await r.json();
      if (!d || !d.track || !d.meta || !Array.isArray(d.lines) || !d.lines.length) return null;

      // Fix B: verify match
      const normReqArtist = norm(artist.split(",")[0]);
      const normTrackArtist = norm(d.track.artist || "");
      if (!normReqArtist || !normTrackArtist) return null;
      if (!normTrackArtist.includes(normReqArtist) && !normReqArtist.includes(normTrackArtist)) {
        return null;
      }

      const sigClean = firstSigWord(cleanedTitle);
      const sigTrack = firstSigWord(d.track.title || "");
      if (!sigClean || !sigTrack || sigClean !== sigTrack) return null;

      const isWord = d.meta.level === "word";
      const lines = [];
      d.lines.forEach((ln) => {
        const text = (ln.text || "").trim();
        if (!text) return;
        const textWords = text.split(/\s+/);
        let wordStarts = null;
        let wordEnds = null;
        if (isWord) {
          const aligned = alignWordCount(textWords, ln.words || []);
          if (aligned) {
            wordStarts = aligned.starts;
            wordEnds = aligned.ends;
            for (let i = 0; i < wordEnds.length; i++) {
              if (wordEnds[i] == null || wordEnds[i] <= wordStarts[i]) {
                wordEnds[i] = i < wordEnds.length - 1 ? wordStarts[i + 1] : wordStarts[i] + 300;
              }
            }
          }
        }
        lines.push({ time: ln.start, text, words: wordStarts, ends: wordEnds });
      });
      if (!lines.length) return null;

      // Fix C: length sanity check
      if (duration > 0 && lines[lines.length - 1].time > (duration + 2) * 1000) return null;

      const hasWord = lines.some((l) => l.words);
      return { source: "lrcmux", wordSync: hasWord, lines, provider: d.meta?.source?.id };
    } catch { return null; }
  }

  async function fetchNetease(queryTitle) {
    try {
      const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      const hdr = { Referer: "https://music.163.com", "User-Agent": UA };

      // search
      const cleanT = queryTitle.replace(/['']/g, "'");
      const q = encodeURIComponent(cleanT + " " + artist.split(",")[0]);
      const sr = await fetch(
        "https://music.163.com/api/cloudsearch/pc?s=" + q + "&type=1&limit=10",
        { headers: hdr, signal: ac(TIMEOUT) }
      );
      if (!sr.ok) return null;
      const sd = await sr.json();
      const songs = sd.result?.songs;
      if (!songs || !songs.length) return null;

      // pick best match
      const titleN = norm(cleanT);
      const artistN = norm(artist.split(",")[0]);
      const durMs = duration * 1000;
      let bestId = null, bestScore = Infinity;
      for (const s of songs) {
        const sTitle = norm(s.name || "");
        const sArtist = norm((s.ar || s.artists || [])[0]?.name || "");
        // title must fuzzy match
        if (!sTitle.includes(titleN) && !titleN.includes(sTitle)) continue;
        // artist must fuzzy match
        if (!sArtist.includes(artistN) && !artistN.includes(sArtist)) continue;
        const sDur = s.dt || s.duration || 0;
        const score = durMs > 0 ? Math.abs(sDur - durMs) : 0;
        if (score < bestScore) { bestScore = score; bestId = s.id; }
      }
      if (!bestId || (durMs > 0 && bestScore > 3000)) return null;

      // fetch lyrics
      const lr = await fetch(
        "https://music.163.com/api/song/lyric?id=" + bestId + "&lv=-1&kv=-1&tv=-1&yv=-1",
        { headers: hdr, signal: ac(TIMEOUT) }
      );
      if (!lr.ok) return null;
      const ld = await lr.json();

      // word-level: yrc
      if (ld.yrc?.lyric) {
        const lines = parseYRC(ld.yrc.lyric);
        if (lines.length) {
          // Fix C: length sanity check
          if (!(duration > 0 && lines[lines.length - 1].time > (duration + 2) * 1000)) {
            return { source: "netease", wordSync: true, lines };
          }
        }
      }
      // line-level fallback: lrc
      if (ld.lrc?.lyric) {
        const lines = parseLRC(ld.lrc.lyric).map((l) => ({ time: l.time, text: l.text, words: null }));
        if (lines.length) {
          // Fix C: length sanity check
          if (!(duration > 0 && lines[lines.length - 1].time > (duration + 2) * 1000)) {
            return { source: "netease", wordSync: false, lines };
          }
        }
      }
      return null;
    } catch { return null; }
  }

  async function fetchLrclib(queryTitle) {
    try {
      const q = encodeURIComponent(queryTitle + " " + artist.split(",")[0]);
      const r = await fetch("https://lrclib.net/api/search?q=" + q, {
        headers: { "User-Agent": "yoshik.xyz/lyrics" },
        signal: ac(TIMEOUT),
      });
      if (r.status === 429) return { rateLimited: true };
      const arr = r.ok ? await r.json() : [];
      let bestSynced = null, bestSyncedScore = Infinity;
      let bestPlain = null, bestPlainScore = Infinity;
      const reqTitleLower = title.toLowerCase();

      (arr || []).forEach((x) => {
        const tName = (x.trackName || x.name || "").toLowerCase();
        // Fix D: skip excluded keywords unless requested title contains that word
        if (LRCLIB_EXCLUDE.some((kw) => tName.includes(kw) && !reqTitleLower.includes(kw))) return;

        const diff = duration > 0 ? Math.abs((x.duration || 0) - duration) : 0;
        if (duration > 0 && diff > 3) return;

        if (x.syncedLyrics && diff < bestSyncedScore) {
          const lines = parseLRC(x.syncedLyrics).map((l) => ({ time: l.time, text: l.text, words: null }));
          if (lines.length) {
            // Fix C: length sanity check
            if (!(duration > 0 && lines[lines.length - 1].time > (duration + 2) * 1000)) {
              bestSyncedScore = diff;
              bestSynced = { source: "lrclib", wordSync: false, lines };
            }
          }
        }

        if (x.plainLyrics && diff < bestPlainScore) {
          bestPlainScore = diff;
          bestPlain = { source: "lrclib", wordSync: false, plain: x.plainLyrics };
        }
      });

      if (bestSynced) return bestSynced;
      if (bestPlain) return bestPlain;
      return null;
    } catch { return null; }
  }

  function isValid(r) {
    if (!r || !Array.isArray(r.lines) || !r.lines.length) return false;
    if (duration > 0) {
      const last = r.lines[r.lines.length - 1];
      if (last && typeof last.time === "number" && last.time > (duration + 2) * 1000) {
        return false;
      }
    }
    return true;
  }

  async function fetchLrclibSync(queryTitle) {
    try {
      const qTitle = encodeURIComponent(queryTitle);
      const qArtist = encodeURIComponent(artist.split(",")[0]);
      let r = await fetch(`https://lrclib.net/api/get?artist_name=${qArtist}&track_name=${qTitle}&duration=${Math.round(duration)}`, {
        headers: { "User-Agent": "yoshik.xyz/lyrics" }, signal: ac(TIMEOUT)
      });
      if (r.status === 404) {
        r = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(queryTitle + " " + artist.split(",")[0])}`, {
           headers: { "User-Agent": "yoshik.xyz/lyrics" }, signal: ac(TIMEOUT)
        });
        if (!r.ok) return null;
        const arr = await r.json();
        const reqTitleLower = title.toLowerCase();
        let best = null;
        for (const x of arr || []) {
          const tName = (x.trackName || x.name || "").toLowerCase();
          if (LRCLIB_EXCLUDE.some((kw) => tName.includes(kw) && !reqTitleLower.includes(kw))) continue;
          const diff = duration > 0 ? Math.abs((x.duration || 0) - duration) : 0;
          if (duration > 0 && diff > 3) continue;
          if (x.syncedLyrics) { best = x; break; }
        }
        if (!best) return null;
        return { name: "lrclib", lines: parseLRC(best.syncedLyrics).map(l => ({ time: l.time, text: l.text })) };
      }
      if (!r.ok) return null;
      const data = await r.json();
      if (data && data.syncedLyrics) {
        return { name: "lrclib", lines: parseLRC(data.syncedLyrics).map(l => ({ time: l.time, text: l.text })) };
      }
      return null;
    } catch { return null; }
  }

  async function fetchYtMusicRef(queryTitle) {
    try {
      const r = await fetch(`https://api.lrcmux.dev/get?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(queryTitle)}&duration=${Math.round(duration)}&sources=ytmusic`, {
        headers: { "User-Agent": "yoshik.xyz/lyrics" }, signal: ac(TIMEOUT)
      });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d || !d.lines || !d.lines.length || d.meta?.source?.id !== "ytmusic") return null;
      const lines = d.lines.map(ln => ({ time: ln.start, text: (ln.text || "").trim() })).filter(ln => ln.text);
      return { name: "ytmusic", lines };
    } catch { return null; }
  }

  async function queryProviders(queryTitle) {
    if (mode === "word") {
      const [lrcmux, netease, lrclibRef, ytmusicRef] = await Promise.all([
        fetchLrcmux(queryTitle),
        fetchNetease(queryTitle),
        fetchLrclibSync(queryTitle),
        fetchYtMusicRef(queryTitle)
      ]);
      const candidates = [lrcmux, netease].filter(c => c && c.wordSync && isValid(c));
      const rawRefs = [lrclibRef, ytmusicRef].filter(Boolean);
      
      let bestRes = null;
      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        const candProvider = cand.source === "lrcmux" ? (cand.provider || "lrcmux") : "netease";
        const validRefs = rawRefs.filter(r => r.name !== candProvider);
        const res = calibrate(cand, validRefs, { provider: candProvider });
        
        if (res.rejected) continue;
        
        if (!bestRes) {
          bestRes = { ...cand, lines: res.lines, calib: res.calib };
          continue;
        }
        
        const confScores = { high: 3, medium: 2, prior: 1, none: 0 };
        const sCurrent = confScores[res.calib.confidence] || 0;
        const sBest = confScores[bestRes.calib.confidence] || 0;
        const madCurrent = res.calib.mad ?? Infinity;
        const madBest = bestRes.calib.mad ?? Infinity;
        
        let isBetter = false;
        if (sCurrent >= 2 && sBest < 2) isBetter = true;
        else if (sCurrent >= 2 && sBest >= 2) isBetter = madCurrent < madBest;
        
        if (isBetter) {
          bestRes = { ...cand, lines: res.lines, calib: res.calib };
        }
      }
      return bestRes;
    } else {
      const [lrcmux, lrclib, netease] = await Promise.all([
        fetchLrcmux(queryTitle),
        fetchLrclib(queryTitle),
        fetchNetease(queryTitle),
      ]);
      if (lrcmux && isValid(lrcmux)) return lrcmux;
      if (lrclib && isValid(lrclib)) return lrclib;
      if (netease && isValid(netease)) return netease;
      if (lrclib && lrclib.plain) return lrclib;
      if (lrclib && lrclib.rateLimited) return { rateLimited: true };
      return null;
    }
  }

  // --- Dispatch based on mode ---
  try {
    const hasLines = (r) => Boolean(r && r.lines && r.lines.length);

    let winner = await queryProviders(cleanedTitle);
    if (!hasLines(winner) && cleanedTitle !== title) {
      const retryWinner = await queryProviders(title);
      if (hasLines(retryWinner)) {
        winner = retryWinner;
      } else if (!winner) {
        winner = retryWinner;
      }
    }

    if (mode === "word") {
      if (winner && winner.wordSync) return res.json(winner);
      return res.json({ source: "none", wordSync: false, lines: [] });
    } else {
      if (winner && winner.lines && winner.lines.length) {
        winner.lines.forEach(l => delete l.ends);
        return res.json(winner);
      }
      if (winner && winner.plain) return res.json(winner);
      if (winner && winner.rateLimited) return res.status(429).json({ error: "rate-limited" });
      return res.json({ source: "none", lines: [] });
    }
  } catch {
    return res.status(502).json({ error: "lyrics upstream failed" });
  }
}

// Parse NetEase YRC word-level format
// Lines: [lineStartMs,lineDurMs](chunkStartMs,chunkDurMs,0)text(...)text...
// Syllable chunks without spaces are merged into one word; use first chunk's start.
function parseYRC(yrc) {
  const CREDIT = /^[{（]|^制作|^作词|^作曲|^编曲|^混音|^母带|^录音|^和声|^出品|^监制|^Produced|^Written|^Composed|^Arranged/i;
  const lines = [];
  yrc.split("\n").forEach((raw) => {
    raw = raw.trim();
    if (!raw) return;
    // parse line header [lineStart,lineDur]
    const hdr = raw.match(/^\[(\d+),(\d+)\]/);
    if (!hdr) return;
    const lineStart = parseInt(hdr[1]);
    // parse word chunks: (startMs,durMs,0)text
    const chunks = [];
    const re = /\((\d+),(\d+),\d+\)([^(]*)/g;
    let m;
    while ((m = re.exec(raw))) {
      const text = m[3];
      if (text) chunks.push({ start: parseInt(m[1]), dur: parseInt(m[2]), text });
    }
    if (!chunks.length) return;
    // join all text
    const fullText = chunks.map((c) => c.text).join("").trim();
    if (!fullText) return;
    // skip credit/metadata lines
    if (CREDIT.test(fullText)) return;

    const chunkEnds = yrcEnds(chunks);
    const words = []; // { text, start, end }
    let curWord = { text: chunks[0].text, start: chunks[0].start, end: chunkEnds[0] };
    for (let i = 1; i < chunks.length; i++) {
      const prev = curWord.text;
      const chunk = chunks[i];
      if (prev.endsWith(" ") || chunk.text.startsWith(" ")) {
        words.push({ text: curWord.text.trim(), start: curWord.start, end: curWord.end });
        curWord = { text: chunk.text.trimStart(), start: chunk.start, end: chunkEnds[i] };
      } else {
        curWord.text += chunk.text;
        curWord.end = chunkEnds[i];
      }
    }
    if (curWord.text.trim()) words.push({ text: curWord.text.trim(), start: curWord.start, end: curWord.end });
    
    const filtered = words.filter((w) => w.text);
    if (!filtered.length) return;

    const text = filtered.map((w) => w.text).join(" ");
    const textWords = text.split(/\s+/);
    const starts = filtered.map((w) => w.start);
    const ends = filtered.map((w) => w.end);
    
    for (let i = 0; i < ends.length; i++) {
      if (ends[i] == null || ends[i] <= starts[i]) {
        ends[i] = i < ends.length - 1 ? starts[i + 1] : starts[i] + 300;
      }
    }

    lines.push({
      time: lineStart,
      text,
      words: starts.length === textWords.length ? starts : null,
      ends: starts.length === textWords.length ? ends : null,
    });
  });
  return lines;
}

function parseLRC(lrc) {
  const lines = [];
  let offset = 0;
  const offsetMatch = lrc.match(/\[offset:(-?\d+)\]/i);
  if (offsetMatch) offset = parseInt(offsetMatch[1]) || 0;

  lrc.split("\n").forEach((raw) => {
    const times = [];
    const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    let m;
    while ((m = re.exec(raw))) {
      const frac = m[3] || "0";
      const mult = frac.length === 3 ? 1 : frac.length === 2 ? 10 : 100;
      let t = +m[1] * 60000 + +m[2] * 1000 + +frac * mult;
      t -= offset;
      times.push(t);
    }
    const text = raw.replace(/\[.*?\]/g, "").replace(/<[^>]*>/g, "").trim();
    if (!text || !times.length) return;
    times.forEach((t) => lines.push({ time: t, text }));
  });
  lines.sort((a, b) => a.time - b.time);
  return lines.filter((l, i) => i === 0 || l.time !== lines[i - 1].time);
}
