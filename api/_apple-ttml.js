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

function decodeEnt(str) {
  return str.replace(/&amp;/g, "&")
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">");
}

export function parseAppleTTML(xml, mode = "word") {
  if (!xml) return [];
  if (mode === "word" && !xml.includes('itunes:timing="Word"')) return null;

  const lines = [];
  const pRegex = /<p\s+[^>]*begin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  
  while ((pMatch = pRegex.exec(xml))) {
    const pBegin = ttmlTime(pMatch[1]);
    let inner = pMatch[2];

    let translation = null;
    const transMatch = inner.match(/<span[^>]*ttm:role="x-translation"[^>]*>([\s\S]*?)<\/span>/i);
    if (transMatch) {
       translation = decodeEnt(transMatch[1].replace(/<[^>]+>/g, "").trim());
    }

    inner = inner.replace(/<span[^>]*(?:ttm:role="x-translation"|ttm:role="x-roman"|ttm:role="x-bg")[^>]*>[\s\S]*?<\/span>/gi, "");
    
    if (mode === "line") {
       const text = decodeEnt(inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
       if (text) {
          const lObj = { time: pBegin, text, words: null };
          if (translation) lObj.translation = translation;
          lines.push(lObj);
       }
       continue;
    }

    const chunks = [];
    const spanRegex = /<span\s+[^>]*begin="([^"]+)"\s+[^>]*end="([^"]+)"[^>]*>([\s\S]*?)<\/span>/gi;
    
    let lastIndex = 0;
    let sMatch;
    let hasSpans = false;
    
    while ((sMatch = spanRegex.exec(inner))) {
      hasSpans = true;
      const textBefore = inner.substring(lastIndex, sMatch.index);
      if (textBefore) chunks.push({ text: textBefore, timed: false });
      
      chunks.push({
        text: sMatch[3],
        start: ttmlTime(sMatch[1]),
        end: ttmlTime(sMatch[2]),
        timed: true
      });
      lastIndex = spanRegex.lastIndex;
    }
    const textAfter = inner.substring(lastIndex);
    if (textAfter) chunks.push({ text: textAfter, timed: false });

    if (!hasSpans) {
       // if a line somehow has no timed spans but the document is Word-timed
       const txt = decodeEnt(inner.replace(/<[^>]+>/g, "").trim());
       if (txt) {
         lines.push({ time: pBegin, text: txt, words: null, ends: null });
       }
       continue;
    }

    const words = [];
    let currentWord = null;

    const commitWord = () => {
      if (currentWord && currentWord.text.trim()) {
        words.push({
          text: decodeEnt(currentWord.text.trim()),
          start: currentWord.start,
          end: currentWord.end
        });
      }
      currentWord = null;
    };

    for (const chunk of chunks) {
      if (!chunk.timed) {
        const txt = chunk.text.replace(/<[^>]+>/g, "");
        if (txt.match(/^\s+/)) commitWord();
        if (currentWord) {
          currentWord.text += txt;
        }
        if (txt.match(/\s+$/)) commitWord();
      } else {
        const txt = chunk.text;
        if (txt.match(/^\s+/)) commitWord();
        
        if (currentWord) {
          currentWord.text += txt;
          currentWord.end = Math.max(currentWord.end, chunk.end);
        } else {
          currentWord = { text: txt, start: chunk.start, end: chunk.end };
        }
        
        if (txt.match(/\s+$/)) commitWord();
      }
    }
    commitWord();

    if (!words.length) continue;

    const text = words.map(w => w.text).join(" ");
    const starts = words.map(w => w.start);
    const ends = words.map(w => w.end);

    for (let i = 0; i < ends.length; i++) {
      if (ends[i] == null || ends[i] <= starts[i]) {
        ends[i] = i < ends.length - 1 ? starts[i + 1] : starts[i] + 300;
      }
    }

    lines.push({
      time: pBegin,
      text,
      words: starts,
      ends: ends
    });
  }
  
  if (lines.length === 0) return [];
  return lines;
}
