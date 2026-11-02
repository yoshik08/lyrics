export function ttmlTime(str) {
  if (!str) return 0;
  if (str.endsWith("s")) return Math.round(parseFloat(str.slice(0, -1)) * 1000);
  const parts = str.split(":").map(Number);
  let ms = 0;
  if (parts.length === 3) {
    ms = parts[0] * 3600000 + parts[1] * 60000 + parts[2] * 1000;
  } else if (parts.length === 2) {
    ms = parts[0] * 60000 + parts[1] * 1000;
  } else if (parts.length === 1) {
    ms = parts[0] * 1000;
  }
  return Math.round(ms);
}

// single pass, so "&amp;lt;" correctly becomes "&lt;" (not "<"); handles numeric entities too
const NAMED = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " " };
export function decodeEnt(str) {
  return String(str).replace(/&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt|nbsp);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED[e.toLowerCase()];
  });
}

const ROLE_RE = /ttm:role\s*=\s*"(x-translation|x-roman|x-bg)"/i;

// Remove every role span (translation / romanisation / background vocals) *including
// nested children* by tracking <span> depth. A lazy regex stops at the first </span>
// and leaks the rest of a multi-word background vocal into the main line.
export function splitRoleSpans(inner) {
  const tag = /<span\b[^>]*>|<\/span\s*>/gi;
  let out = "";
  let last = 0;
  let skipDepth = 0;     // >0 while inside a role span
  let skipStart = 0;
  let skipRole = null;
  let translation = null;
  let m;
  while ((m = tag.exec(inner))) {
    const t = m[0];
    const closing = t[1] === "/";
    if (skipDepth === 0) {
      if (!closing && ROLE_RE.test(t) && !/\/\s*>$/.test(t)) {
        out += inner.slice(last, m.index);
        skipDepth = 1;
        skipStart = tag.lastIndex;
        skipRole = ROLE_RE.exec(t)[1].toLowerCase();
      }
    } else if (closing) {
      skipDepth--;
      if (skipDepth === 0) {
        if (skipRole === "x-translation" && translation == null) {
          translation = decodeEnt(inner.slice(skipStart, m.index).replace(/<[^>]+>/g, "").trim());
        }
        last = tag.lastIndex;
        skipRole = null;
      }
    } else if (!/\/\s*>$/.test(t)) {
      skipDepth++;
    }
  }
  if (skipDepth === 0) out += inner.slice(last);
  else out += ""; // unbalanced role span: drop the tail rather than leak it
  return { clean: out, translation };
}

function attr(attrs, name) {
  const m = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*\"([^\"]*)\"", "i").exec(attrs);
  return m ? m[1] : null;
}

export function parseAppleTTML(xml, mode = "word") {
  if (!xml) return [];
  if (mode === "word" && !xml.includes('itunes:timing="Word"')) return null;

  const lines = [];
  const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let pMatch;

  while ((pMatch = pRegex.exec(xml))) {
    const beginStr = attr(pMatch[1], "begin");
    if (beginStr == null) continue;
    const pBegin = ttmlTime(beginStr);
    const { clean: inner, translation } = splitRoleSpans(pMatch[2]);

    if (mode === "line") {
      const text = decodeEnt(inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
      if (text) {
        const lObj = { time: pBegin, text, words: null };
        if (translation) lObj.translation = translation;
        lines.push(lObj);
      }
      continue;
    }

    // chunks: timed spans and the loose text between them (spaces live there)
    const chunks = [];
    const spanRegex = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
    let lastIndex = 0;
    let sMatch;
    let hasSpans = false;

    while ((sMatch = spanRegex.exec(inner))) {
      const b = attr(sMatch[1], "begin"), e = attr(sMatch[1], "end");
      const textBefore = inner.substring(lastIndex, sMatch.index);
      if (textBefore) chunks.push({ text: textBefore, timed: false });
      lastIndex = spanRegex.lastIndex;
      if (b == null) { chunks.push({ text: sMatch[2], timed: false }); continue; }
      hasSpans = true;
      const start = ttmlTime(b);
      chunks.push({ text: sMatch[2], start, end: e != null ? ttmlTime(e) : start, timed: true });
    }
    const textAfter = inner.substring(lastIndex);
    if (textAfter) chunks.push({ text: textAfter, timed: false });

    if (!hasSpans) {
      // a line with no timed spans inside a Word-timed document
      const txt = decodeEnt(inner.replace(/<[^>]+>/g, "").trim());
      if (txt) lines.push({ time: pBegin, text: txt, words: null, ends: null });
      continue;
    }

    const words = [];
    let currentWord = null;
    const commitWord = () => {
      if (currentWord && currentWord.text.trim()) {
        words.push({ text: decodeEnt(currentWord.text.trim()), start: currentWord.start, end: currentWord.end });
      }
      currentWord = null;
    };

    for (const chunk of chunks) {
      const txt = chunk.text.replace(/<[^>]+>/g, "");
      if (!chunk.timed) {
        if (/^\s+/.test(txt)) commitWord();
        if (currentWord) currentWord.text += txt;
        if (/\s+$/.test(txt)) commitWord();
      } else {
        if (/^\s+/.test(txt)) commitWord();
        if (currentWord) {
          currentWord.text += txt;
          currentWord.end = Math.max(currentWord.end, chunk.end);
        } else {
          currentWord = { text: txt, start: chunk.start, end: chunk.end };
        }
        if (/\s+$/.test(txt)) commitWord();
      }
    }
    commitWord();

    if (!words.length) continue;

    const text = words.map((w) => w.text).join(" ");
    const starts = words.map((w) => w.start);
    const ends = words.map((w) => w.end);
    for (let i = 0; i < ends.length; i++) {
      if (ends[i] == null || ends[i] <= starts[i]) {
        ends[i] = i < ends.length - 1 ? starts[i + 1] : starts[i] + 300;
      }
    }
    lines.push({ time: pBegin, text, words: starts, ends });
  }

  return lines;
}
