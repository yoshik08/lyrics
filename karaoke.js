/* ============================================================
   karaoke.js — per-word synced lyrics, Verci-style.
   no dependencies. one rAF-friendly entry point:

     var vk = ykVK.create(stageEl, { reduced: fn, iconKey: fn, iconNode: fn });
     vk.setWords([{ start, end, text }, ...]);      // ms
     vk.update(posMs, dtMs, snap);                  // call every frame
     vk.setStyle("ship" | "fisheye" | "fisheye-visual" | "visual");
     vk.setColors({ lyric, highlight, secondary }); // css variables

   Look: near-black stage, one focus word at a time. The active word is large,
   white on a tilted highlight box that scales/slides in as it starts. Previous
   words linger in a muted secondary colour (no box) then shrink and fade;
   upcoming words fade in small and dim. Words sit in a loose vertical stack
   (each nudged left/right + tilted), in 3D with a gentle drift and blur on
   words that are arriving or leaving. Only transform/opacity/filter are written.
   ============================================================ */
(function (root) {
  "use strict";

  /* ---------- sf-symbol-ish glyphs, drawn in currentColor (the highlight) ---------- */
  var G = {
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    eye: '<path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    bubble: '<path d="M21 12c0 4.4-4 8-9 8-1.3 0-2.5-.2-3.6-.7L3 21l1.6-4.3C3.6 15.3 3 13.7 3 12c0-4.4 4-8 9-8s9 3.6 9 8z"/>',
    hash: '<path d="M5 9h15M4 15h15M10 3 8 21M16 3l-2 18"/>',
    heart: '<path d="M12 21s-8-5.3-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.7-8 11-8 11z"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    note: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
    home: '<path d="M3 11 12 3l9 8v10h-6v-6H9v6H3z"/>',
    dollar: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9c-.4-1-1.4-1.5-2.5-1.5-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2c-1.1 0-2.1-.5-2.5-1.5M12 6v1.5M12 16.5V18"/>'
  };
  var WORD_ICON = {
    you: "person", your: "person", yours: "person", u: "person", ya: "person", yourself: "person", someone: "person", somebody: "person", anybody: "person",
    see: "eye", saw: "eye", look: "eye", looking: "eye", eyes: "eye", eye: "eye", watch: "eye", watching: "eye", seen: "eye", view: "eye",
    tell: "bubble", telling: "bubble", told: "bubble", say: "bubble", saying: "bubble", said: "bubble", talk: "bubble", talking: "bubble", speak: "bubble", words: "bubble", call: "bubble", whisper: "bubble",
    number: "hash", numbers: "hash", one: "hash", two: "hash", three: "hash", four: "hash", five: "hash", count: "hash", hundred: "hash", thousand: "hash",
    love: "heart", loved: "heart", loving: "heart", heart: "heart", hearts: "heart", baby: "heart", darling: "heart",
    star: "star", stars: "star", shine: "star", shining: "star",
    song: "note", songs: "note", music: "note", sing: "note", singing: "note", melody: "note", dance: "note", dancing: "note",
    time: "clock", hour: "clock", hours: "clock", minute: "clock", forever: "clock", always: "clock", never: "clock", now: "clock", tonight: "clock",
    fire: "bolt", lightning: "bolt", electric: "bolt", power: "bolt", energy: "bolt", thunder: "bolt",
    moon: "moon", night: "moon", midnight: "moon", dream: "moon", dreams: "moon", sleep: "moon",
    sun: "sun", sunshine: "sun", summer: "sun", morning: "sun", light: "sun",
    home: "home", house: "home", money: "dollar", cash: "dollar", rich: "dollar", dollar: "dollar", dollars: "dollar"
  };
  function iconKeyFor(text) {
    var w = String(text).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z']/g, "");
    if (!w) return null;
    var tries = [w, w.replace(/'s$/, ""), w.replace(/s$/, ""), w.replace(/ing$/, ""), w.replace(/in'?$/, "")];
    for (var i = 0; i < tries.length; i++) if (WORD_ICON[tries[i]]) return "svg:" + WORD_ICON[tries[i]];
    return null;
  }
  function svgIcon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + G[name] + "</svg>";
  }

  /* ---------- little maths ---------- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function tab(arr, x) { /* piecewise-linear lookup, arr[i] sits at x = i */
    var n = arr.length - 1;
    if (x >= n) return arr[n];
    var i = Math.floor(x);
    return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
  }
  var LOOK_AHEAD = 70; /* ms: camera starts moving just before a word is sung (perceived on-time) */
  function outBack(p) { var c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
  function rnd(i, salt) { var x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453; return x - Math.floor(x); }

  /* ---------- the four looks (timing is identical, only the staging changes) ---------- */
  var L = { x: 0, y: 0, z: 0, rx: 0, rz: 0, s: 1, o: 1, b: 0 }; /* reused, no per-frame garbage */

  var LOOKS = {
    /* a loose vertical stack, 2-3 words readable */
    stack: {
      prev: 3, next: 3, drift: 1, icons: false,
      layout: function (k, w, c) {
        var ak = Math.abs(k), up = k < 0, near = Math.min(ak, 1);
        L.s = tab(up ? [1, .5, .33, .24, .2] : [1, .46, .3, .22, .2], ak) * w.fit;
        L.o = tab(up ? [1, .62, .26, .06, 0] : [1, .5, .2, .05, 0], ak);
        L.y = Math.sign(k) * (c.U * 0.17 * near + c.U * 0.1 * Math.max(ak - 1, 0));
        L.x = w.jx * c.W * 0.12 * (0.45 + 0.55 * near);
        L.z = -ak * c.U * 0.1;
        L.rx = 0; L.rz = w.jr * 2.5;
        L.b = tab([0, 1.1, 2.3, 3.4, 4], ak);
        return L;
      }
    },
    /* words stack into a wall that drifts in 3D */
    ship: {
      prev: 8, next: 3, drift: 2.2, icons: false,
      layout: function (k, w, c) {
        var ak = Math.abs(k), up = k < 0, near = Math.min(ak, 1);
        L.s = tab(up ? [1, .62, .52, .44, .38, .33, .29, .26, .24] : [1, .46, .3, .2], ak) * w.fit;
        L.o = tab(up ? [1, .8, .6, .44, .32, .22, .13, .06, 0] : [1, .45, .16, 0], ak);
        L.y = Math.sign(k) * (c.U * 0.15 * near + c.U * (up ? 0.085 : 0.1) * Math.max(ak - 1, 0));
        L.x = w.jx * c.W * 0.2 * (0.35 + 0.65 * near) + Math.sin(c.t * 0.8 + w.i) * c.W * 0.008 * ak;
        L.z = -ak * c.U * 0.2;
        L.rx = 0; L.rz = w.jr * 4;
        L.b = tab([0, .6, 1.2, 1.9, 2.5, 3, 3.4, 3.8, 4], ak);
        return L;
      }
    },
    /* convex stack through a lens: the current word is nearest the viewer */
    fisheye: {
      prev: 4, next: 4, drift: 0.9, icons: false,
      layout: function (k, w, c) {
        var th = clamp(k * 0.5, -1.45, 1.45), ct = Math.cos(th), ak = Math.abs(k);
        L.s = (0.32 + 0.68 * Math.pow(ct, 5)) * (1 + 0.16 * Math.max(0, 1 - ak)) * w.fit;
        L.o = clamp(Math.pow(ct, 3.2), 0, 1) * (ak > 3.4 ? clamp(4.4 - ak, 0, 1) : 1);
        L.y = Math.sin(th) * c.H * 0.43;
        L.x = w.jx * c.W * 0.07 * (0.4 + 0.6 * ct) - Math.sin(Math.abs(th)) * c.W * 0.05 * (w.jx < 0 ? -1 : 1) * 0.6;
        L.z = (ct - 0.55) * c.U * 0.34;
        L.rx = -th * 38; L.rz = w.jr * 1.6;
        L.b = ak < 0.5 ? 0 : Math.min(3.4, ak * 0.9);
        return L;
      }
    }
  };
  /* style name -> look + whether icons appear beside mapped words */
  var STYLES = {
    ship: { look: "ship", icons: false },
    fisheye: { look: "fisheye", icons: false },
    "fisheye-visual": { look: "fisheye", icons: true },
    visual: { look: "stack", icons: true }
  };

  /* ---------- the engine ---------- */
  function create(stage, opts) {
    opts = opts || {};
    var world = stage.querySelector(".vk-world");
    if (!world) { world = document.createElement("div"); world.className = "vk-world"; stage.appendChild(world); }
    var words = [], els = {}, styleName = "visual", look = LOOKS.stack, iconsOn = true;
    var cursor = -0.9, lastCursor = -0.9, vel = 0, t = 0, hint = -1;
    var C = { W: 1, H: 1, U: 1, t: 0 };
    var mx = 0, my = 0, px = 0, py = 0;
    var reduced = function () { return opts.reduced ? !!opts.reduced() : false; };

    function resize() {
      C.W = stage.clientWidth || 1; C.H = stage.clientHeight || 1;
      C.U = Math.min(C.W, C.H * 1.2);
      stage.style.setProperty("--vk-fs", clamp(C.U * 0.125, 40, 200).toFixed(1) + "px");
      for (var k in els) measure(words[k]);
    }
    function measure(w) {
      if (!w || !w.el) return;
      var ww = w.el.offsetWidth || 1;
      w.fit = Math.min(1, (C.W * 0.86) / ww);
    }

    function iconNodeFor(w) {
      if (!w.iconKey) return null;
      var holder = document.createElement("span");
      holder.className = "vk-ic";
      if (w.iconKey.indexOf("svg:") === 0) holder.innerHTML = svgIcon(w.iconKey.slice(4));
      else if (opts.iconNode) { var n = opts.iconNode(w.iconKey); if (n) holder.appendChild(n); else return null; }
      else return null;
      return holder;
    }

    function make(i) {
      var w = words[i];
      var el = document.createElement("div");
      el.className = "vk-w s-up";
      var hl = document.createElement("span"); hl.className = "vk-hl";
      hl.style.setProperty("--tilt", w.tilt + "deg");
      var tx = document.createElement("span"); tx.className = "vk-t"; tx.textContent = w.text;
      el.appendChild(hl); el.appendChild(tx);
      w.ic = null;
      if (iconsOn) {
        w.ic = iconNodeFor(w);
        if (w.ic) { w.ic.classList.add(w.iconSide > 0 ? "r" : "l"); el.appendChild(w.ic); }
      }
      world.appendChild(el);
      w.el = el; w.hl = hl; w.state = "up"; w.bp = -1; w.ha = -1;
      measure(w);
      els[i] = el;
      return el;
    }
    function drop(i) {
      var el = els[i];
      if (el && el.parentNode) el.parentNode.removeChild(el);
      var w = words[i]; if (w) { w.el = null; w.hl = null; w.ic = null; }
      delete els[i];
    }
    function clear() { for (var k in els) drop(+k); }

    function setWords(list, iconOpts) {
      clear();
      if (iconOpts) { if (iconOpts.iconKey) opts.iconKey = iconOpts.iconKey; if (iconOpts.iconNode) opts.iconNode = iconOpts.iconNode; }
      words = (list || []).map(function (w, i) {
        return {
          i: i, text: w.text, start: w.start, end: Math.max(w.end, w.start + 60), lineIdx: w.lineIdx,
          jx: rnd(i, 1) * 2 - 1, jr: rnd(i, 2) * 2 - 1, tilt: (rnd(i, 3) * 2 - 1) * 3.2,
          iconSide: rnd(i, 4) > 0.5 ? 1 : -1, fit: 1, iconKey: null
        };
      });
      for (var i = 0; i < words.length; i++) {
        var nx = words[i + 1];
        /* the box belongs to one word at a time: it ends when the next word starts */
        words[i].endEff = Math.max(words[i].start + 80, Math.min(words[i].end + 140, nx ? nx.start : Infinity));
      }
      /* icons: svg glyph first, emoji second; never crowd (1 per 3 words, no repeats within 8) */
      var lastIdx = -9, recent = [];
      words.forEach(function (w, i) {
        var key = iconKeyFor(w.text) || (opts.iconKey ? opts.iconKey(w.text) : null);
        if (!key || i - lastIdx < 3 || recent.indexOf(key) !== -1) return;
        w.iconKey = key; lastIdx = i; recent.push(key); if (recent.length > 8) recent.shift();
      });
      hint = -1; cursor = lastCursor = -0.9; resize();
    }

    function find(pos) {
      var n = words.length; if (!n) return -1;
      var i = hint < 0 ? 0 : hint >= n ? n - 1 : hint;
      if (pos >= words[i].start) { while (i + 1 < n && words[i + 1].start <= pos) i++; return i; }
      var lo = 0, hi = n - 1, ans = -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (words[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      return ans;
    }

    function setStyle(name) {
      var s = STYLES[name] || STYLES.visual;
      styleName = STYLES[name] ? name : "visual";
      look = LOOKS[s.look];
      var wasIcons = iconsOn; iconsOn = s.icons;
      stage.setAttribute("data-style", styleName);
      if (wasIcons !== iconsOn) clear(); /* rebuild words with/without glyphs */
    }
    function setColors(c) {
      if (!c) return;
      if (c.lyric) stage.style.setProperty("--lyric", c.lyric);
      if (c.highlight) stage.style.setProperty("--highlight", c.highlight);
      if (c.secondary) stage.style.setProperty("--secondary", c.secondary);
    }

    function update(pos, dt, snap) {
      if (!words.length) return;
      dt = clamp(dt || 16, 1, 100);
      if (C.W <= 1 || C.H <= 1) resize();
      var a = find(pos + LOOK_AHEAD); hint = a;
      var target, tau = 120, cur = a >= 0 ? words[a] : null, nxt = a >= 0 ? words[a + 1] : words[0];
      if (!cur) target = -0.9;
      else {
        target = a;
        if (nxt) {
          var endA = Math.min(cur.end, nxt.start), gap = nxt.start - endA;
          tau = clamp((nxt.start - cur.start) * 0.2, 30, 80);
          if (gap > 260) { var p = clamp((pos - (endA + 120)) / (gap - 120), 0, 1); target = a + 0.28 * p * p; } /* lean toward the next word */
        }
      }
      var rm = reduced();
      if (snap || rm || Math.abs(target - cursor) > 7) cursor = target;
      else cursor += (target - cursor) * (1 - Math.exp(-dt / tau));
      vel = (cursor - lastCursor) / dt * 1000; lastCursor = cursor;
      t += dt / 1000; C.t = t;
      render(pos, rm);
    }

    function render(pos, rm) {
      var n = words.length, c = Math.round(cursor);
      var lo = Math.max(0, c - look.prev - 1), hi = Math.min(n - 1, c + look.next + 1), k;
      for (k in els) { var ki = +k; if (ki < lo || ki > hi) drop(ki); }
      var motionBlur = rm ? 0 : Math.min(2.6, Math.abs(vel) * 0.7);
      for (var i = lo; i <= hi; i++) {
        var w = words[i], el = els[i] || make(i);
        var kk = i - cursor, ak = Math.abs(kk);
        var out = ak > look.prev + 0.2 && kk < 0 || ak > look.next + 0.2 && kk > 0; /* beyond the staged window */
        var P = look.layout(kk, w, C);
        var o = out ? 0 : P.o;
        var s = Math.max(0.02, P.s);
        el.style.transform = "translate(-50%,-50%) translate3d(" + P.x.toFixed(1) + "px," + P.y.toFixed(1) + "px," + P.z.toFixed(1) + "px) rotateX(" + P.rx.toFixed(2) + "deg) rotateZ(" + P.rz.toFixed(2) + "deg) scale(" + s.toFixed(4) + ")";
        el.style.opacity = o.toFixed(3);
        var b = rm ? 0 : P.b * 0.6 + motionBlur * Math.min(ak, 1.5) * 0.5;
        el.style.filter = b > 0.25 ? "blur(" + b.toFixed(2) + "px)" : "none";
        el.style.zIndex = String(200 - Math.round(ak * 10));
        el.style.visibility = o < 0.01 ? "hidden" : "visible";

        /* state + highlight box, driven purely by playback position (seek-safe) */
        var st = pos < w.start ? "up" : pos < w.endEff ? "on" : "past";
        if (st !== w.state) { el.classList.remove("s-up", "s-on", "s-past"); el.classList.add("s-" + st); w.state = st; }
        var bp = 0, ha = 0;
        if (st === "on") { bp = rm ? 1 : outBack(clamp((pos - w.start) / 110, 0, 1)); ha = 1; }
        else if (st === "past") { var q = rm ? 1 : clamp((pos - w.endEff) / 80, 0, 1); bp = 1 - q * 0.45; ha = 1 - q; } /* collapse + fade, fast */
        if (bp !== w.bp || ha !== w.ha) {
          w.bp = bp; w.ha = ha;
          w.hl.style.opacity = ha.toFixed(3);
          w.hl.style.transform = "translateX(" + ((1 - bp) * -0.1).toFixed(3) + "em) scale(" + (0.86 + 0.14 * bp).toFixed(3) + "," + (0.9 + 0.1 * bp).toFixed(3) + ") rotate(var(--tilt))";
          if (w.ic) { w.ic.style.opacity = ha.toFixed(3); w.ic.style.transform = "scale(" + (0.35 + 0.65 * Math.min(bp, 1.15)).toFixed(3) + ") rotate(" + ((1 - bp) * -25).toFixed(1) + "deg)"; }
        }
      }
      /* gentle 3D drift of the whole wall, plus a hint of pointer parallax */
      px += (mx - px) * 0.05; py += (my - py) * 0.05;
      var dr = rm ? 0 : look.drift;
      world.style.transform = "rotateX(" + (Math.sin(t * 0.45) * 1.6 * dr - py * 2.2 * dr).toFixed(3) + "deg) rotateY(" + (Math.sin(t * 0.31 + 1) * 3.4 * dr + px * 3.2 * dr).toFixed(3) + "deg)";
    }

    stage.addEventListener("pointermove", function (e) {
      var r = stage.getBoundingClientRect();
      mx = ((e.clientX - r.left) / r.width - 0.5) * 2; my = ((e.clientY - r.top) / r.height - 0.5) * 2;
    }, { passive: true });
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resize).observe(stage);
    else window.addEventListener("resize", resize);

    setStyle("visual");
    return {
      setWords: setWords, update: update, setStyle: setStyle, setColors: setColors, resize: resize, clear: clear,
      get style() { return styleName; }, get count() { return words.length; }
    };
  }

  root.ykVK = { create: create, STYLES: Object.keys(STYLES), iconKeyFor: iconKeyFor };
})(window);
