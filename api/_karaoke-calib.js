// api/_karaoke-calib.js — pure calibration helpers for karaoke word timing.
// Underscore prefix keeps Vercel from routing it.  Zero deps, zero network.

// ─── 1. normLine ───────────────────────────────────────────────────
// Matches the norm() already in api/lyrics.js:
//   NFD → strip combining marks → lower → dashes→space → drop non-letter/digit/space → collapse ws
export function normLine(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-_\u2013\u2014/]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── 2. matchLines ─────────────────────────────────────────────────
// candLines = [{time, text, words?:[ms], ends?:[ms]}]
// refLines  = [{time, text}]
// Returns [{ci, ri, delta}] with delta = (cand.words?.[0] ?? cand.time) - ref.time
export function matchLines(candLines, refLines) {
  const pairs = [];
  let ri = 0;
  for (let ci = 0; ci < candLines.length && ri < refLines.length; ci++) {
    const cNorm = normLine(candLines[ci].text);
    if (!cNorm) continue;
    const cWords = cNorm.split(" ").filter(Boolean);
    // scan forward in refs for a match (allow skips on ref side)
    for (let rj = ri; rj < refLines.length; rj++) {
      const rNorm = normLine(refLines[rj].text);
      if (!rNorm) continue;

      // match: identical normalized text OR same first 4 words
      let matched = false;
      if (cNorm === rNorm) {
        matched = true;
      } else {
        const rWords = rNorm.split(" ").filter(Boolean);
        if (cWords.length >= 4 && rWords.length >= 4) {
          matched = cWords[0] === rWords[0] &&
                    cWords[1] === rWords[1] &&
                    cWords[2] === rWords[2] &&
                    cWords[3] === rWords[3];
        }
      }
      if (!matched) continue;

      // time proximity check: |cand.time - ref.time| <= 3000
      if (Math.abs(candLines[ci].time - refLines[rj].time) > 3000) continue;

      const candStart = (candLines[ci].words && candLines[ci].words.length)
        ? candLines[ci].words[0]
        : candLines[ci].time;
      const delta = candStart - refLines[rj].time;
      pairs.push({ ci, ri: rj, delta });
      ri = rj + 1; // advance ref cursor past this match
      break;
    }
  }
  return pairs;
}

// ─── 3. estimateOffset ─────────────────────────────────────────────
// Needs >= 6 pairs, otherwise null.
// Returns {offsetMs: median(delta), mad: median(|delta - median|), pairs: n}
export function estimateOffset(pairs) {
  if (!pairs || pairs.length < 6) return null;
  const deltas = pairs.map(p => p.delta).sort((a, b) => a - b);
  const med = median(deltas);
  const absDevs = deltas.map(d => Math.abs(d - med)).sort((a, b) => a - b);
  const mad = median(absDevs);
  return { offsetMs: med, mad, pairs: pairs.length };
}

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return (n & 1) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── 4. calibrate ──────────────────────────────────────────────────
// candidate = {lines:[{time, text, words?, ends?}]}
// refs = [{name, lines:[{time, text}]}]
// opts = {provider}
export function calibrate(candidate, refs, opts) {
  const provider = (opts && opts.provider) || "";
  const estimates = [];
  for (const ref of (refs || [])) {
    if (!ref.lines || !ref.lines.length) continue;
    const pairs = matchLines(candidate.lines, ref.lines);
    const est = estimateOffset(pairs);
    if (est) estimates.push({ ...est, name: ref.name });
  }

  // filter usable: mad <= 150
  const usable = estimates.filter(e => e.mad <= 150);

  let offset, mad, pairsN, refName, confidence;

  if (usable.length >= 2) {
    // sort by mad ascending
    usable.sort((a, b) => a.mad - b.mad);
    const a = usable[0], b = usable[1];
    if (Math.abs(a.offsetMs - b.offsetMs) <= 120) {
      // two refs agree: average
      offset = Math.round((a.offsetMs + b.offsetMs) / 2);
      mad = Math.round((a.mad + b.mad) / 2);
      pairsN = a.pairs + b.pairs;
      refName = a.name + "+" + b.name;
      confidence = mad <= 80 ? "high" : "medium";
    } else {
      // disagree by > 120ms: pick lower mad, don't average
      offset = a.offsetMs;
      mad = a.mad;
      pairsN = a.pairs;
      refName = a.name;
      confidence = "medium";
    }
  } else if (usable.length === 1) {
    const u = usable[0];
    offset = u.offsetMs;
    mad = u.mad;
    pairsN = u.pairs;
    refName = u.name;
    confidence = "medium";
  } else {
    // no usable refs: provider-based prior
    if (provider === "kugou") {
      offset = 220;
      confidence = "prior";
    } else {
      offset = 0;
      confidence = "none";
    }
    mad = Infinity;
    pairsN = 0;
    refName = null;
  }

  // Reject if |offset| > 1500 or best mad > 300
  const bestMad = estimates.length ? Math.min(...estimates.map(e => e.mad)) : Infinity;
  if (Math.abs(offset) > 1500 || (bestMad > 300 && estimates.length > 0)) {
    return {
      rejected: true,
      reason: Math.abs(offset) > 1500
        ? "offset too large (" + offset + "ms)"
        : "mad too high (" + bestMad + ")"
    };
  }

  // Build shifted copy (never mutate input)
  const shiftedLines = candidate.lines.map(ln => {
    const out = { time: ln.time - offset, text: ln.text };
    if (ln.words) out.words = ln.words.map(w => w - offset);
    if (ln.ends) out.ends = ln.ends.map(e => e - offset);
    return out;
  });

  return {
    lines: shiftedLines,
    calib: {
      offsetMs: offset,
      mad: mad === Infinity ? null : mad,
      pairs: pairsN,
      ref: refName,
      confidence,
      provider
    }
  };
}

// ─── 5. alignWordCount ─────────────────────────────────────────────
// textWords = string[] (from text.split(/\s+/))
// providerWords = [{text, start, end}]
// Drop empty/punctuation-only tokens. Merge tokens when there's no whitespace gap.
// Returns {starts, ends} if final count matches textWords.length, else null.
export function alignWordCount(textWords, providerWords) {
  if (!textWords || !providerWords || !textWords.length) return null;

  // filter out empty / punctuation-only provider tokens
  const PUNCT_ONLY = /^[^\p{L}\p{N}]+$/u;
  const filtered = providerWords.filter(w => w.text && !PUNCT_ONLY.test(w.text));
  if (!filtered.length) return null;

  if (filtered.length === textWords.length) {
    return {
      starts: filtered.map(w => w.start),
      ends: filtered.map(w => w.end)
    };
  }

  // try merging: when consecutive tokens should be part of the same word
  // (e.g. "don" + "'t" → "don't"), merge into previous
  const merged = [{ ...filtered[0] }];
  for (let i = 1; i < filtered.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = filtered[i];
    // merge if no whitespace between (adjacent chars, typical for split contractions)
    // heuristic: if combined text of prev+cur matches a text word at this position, merge
    const mergedText = prev.text + cur.text;
    const targetIdx = merged.length - 1;
    if (targetIdx < textWords.length &&
        normLine(mergedText) === normLine(textWords[targetIdx])) {
      prev.text = mergedText;
      prev.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }

  if (merged.length === textWords.length) {
    return {
      starts: merged.map(w => w.start),
      ends: merged.map(w => w.end)
    };
  }

  return null;
}

// ─── 6. yrcEnds ────────────────────────────────────────────────────
// chunks = [{start, dur, text}]  (raw parsed YRC chunks for one line)
// Returns end times: for each chunk, end = start + dur.
// This is a helper so the YRC parser can compute word end = last chunk's start + dur.
export function yrcEnds(chunks) {
  if (!chunks || !chunks.length) return [];
  return chunks.map(c => c.start + c.dur);
}
