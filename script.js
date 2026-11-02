/* ============================================================
   lyrics — standalone synced-lyrics + karaoke app
   frontend logic adapted from the yoshik.xyz lyrics overlay:
   same sync engine, same karaoke rendering, same lyrics pipeline.
   differences: per-user spotify oauth (no server token), the overlay
   is the whole page, karaoke defaults on. lyrics sync = same code as the
   personal site: no baked-in leads; a manual headphones toggle for bluetooth.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- element refs ---------- */
  var landingView = document.getElementById("landingView"),
      landingErr = document.getElementById("landingErr"),
      lyricsOverlay = document.getElementById("lyricsOverlay");

  /* ---------- small dot cursor ---------- */
  var cursorDot = document.getElementById("cursorDot");
  if (cursorDot) {
    var dotShown = false;
    document.addEventListener("mousemove", function (e) {
      if (!dotShown) {
        dotShown = true;
        cursorDot.style.display = "block";
        document.body.classList.add("has-dot-cursor");
      }
      cursorDot.style.transform =
        "translate(" + e.clientX + "px," + e.clientY + "px) translate(-50%,-50%)";
    }, { passive: true });
  }

  /* ---------- rAF loop watchdog (copied) ---------- */
  var loopState = {};
  function loopTick(key) {
    var st = loopState[key] || (loopState[key] = { gen: 0, last: 0 });
    st.last = performance.now();
  }
  function loopGen(key) {
    var st = loopState[key] || (loopState[key] = { gen: 0, last: 0 });
    return st.gen;
  }
  function bumpLoop(key) {
    var st = loopState[key] || (loopState[key] = { gen: 0, last: 0 });
    st.gen++;
  }

  /* ---------- sync core (copied) ----------
     The server polls Spotify ~every 2s; each response is an anchor
     { progressMs, timestamp, isPlaying }. Between anchors the browser
     advances a monotonic performance.now() clock. Each new anchor only
     corrects drift: tiny drift is ignored, moderate drift is absorbed
     gradually (no visible jump), large drift/seek hard-resets. */
  var SYNC = { POLL_MS: 3500, OPEN_POLL_MS: 2000,
               SNAP_MS: 120, IGNORE_MS: 15, SLEW_MS: 150, WINDOW: 4 };
  function createPlaybackClock(nowFn) {
    nowFn = nowFn || function () { return performance.now(); };
    var baseMs = 0, basePerf = 0, playing = false, corrMs = 0, corrStart = 0;
    function get(now) {
      var pos = baseMs + (playing ? now - basePerf : 0);
      if (corrMs) { var e = now - corrStart; if (e >= SYNC.SLEW_MS) corrMs = 0; else pos += corrMs * (1 - e / SYNC.SLEW_MS); }
      return pos;
    }
    return {
      getProgressMs: function () { return get(nowFn()); },
      isPlaying: function () { return playing; },
      hardSet: function (posMs, atPerf, isPlaying) {
        var now = nowFn(); playing = !!isPlaying;
        baseMs = posMs + (playing ? now - atPerf : 0); basePerf = now; corrMs = 0;
      },
      correct: function (targetNowMs) {           /* target already projected to nowFn() */
        var now = nowFn(), shown = get(now), drift = targetNowMs - shown, ad = Math.abs(drift);
        if (ad < SYNC.IGNORE_MS) return "ignore";
        baseMs = targetNowMs; basePerf = now;
        if (ad > SYNC.SNAP_MS) { corrMs = 0; return "snap"; }
        corrMs = shown - targetNowMs; corrStart = now; return "slew";
      }
    };
  }

  /* one player response -> position estimate at arrival time */
  function sampleFrom(d, tSend, tArrive) {
    var rtt = tArrive - tSend, hasT = d.spotifyRtt != null && d.serverHold != null;
    var net = hasT ? Math.max(0, rtt - d.serverHold) / 2 : rtt / 2;
    var age = hasT ? d.spotifyRtt / 2 + d.msSinceSpotifyResponse + net : rtt / 2;
    return { pos: (d.progressMs || 0) + (d.playing ? age : 0), at: tArrive, rtt: rtt,
             unc: hasT ? d.spotifyRtt / 2 + net : rtt / 2, d: d };
  }
  /* freshest-sample envelope: Spotify's progress_ms is only ever stale (late), never early,
     so among recent good samples the one projecting furthest is the least stale */
  function envelopeTarget(win, now) {
    var minUnc = Infinity, best = -Infinity, i;
    for (i = 0; i < win.length; i++) minUnc = Math.min(minUnc, win[i].unc);
    for (i = 0; i < win.length; i++) {
      if (win[i].unc > 2 * minUnc + 20) continue;
      best = Math.max(best, win[i].pos + (now - win[i].at));
    }
    return best;
  }

  /* lyric index lookup: advance forward from the hint when playing normally
     (O(1) amortized), binary search when seeking backward */
  function findLyricIndex(lines, pos, hint) {
    var n = lines.length, i;
    if (!n) return -1;
    i = hint < 0 ? 0 : hint >= n ? n - 1 : hint;
    if (pos >= lines[i].time) {
      while (i + 1 < n && lines[i + 1].time <= pos) i++;
      return i;
    }
    var lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].time <= pos) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /* ---------- spotify player state (adapted: per-user /api/player) ---------- */
  var spState = { key: null, title: null, artist: "", artists: [], trackUrl: null, image: null, playing: false, progressMs: null, durationMs: null, deviceId: null, deviceType: null };
  var playbackClock = createPlaybackClock();
  var isPremium = false;
  var loggedIn = false;

  var itunesArtCache = new Map();
  function upgradeArtwork(title, artist, trackId, fallback, callback) {
    var key = trackId || (title + " :: " + artist);
    if (itunesArtCache.has(key)) return callback(itunesArtCache.get(key));
    var term = encodeURIComponent(title + " " + artist.split(",")[0]);
    fetch("https://itunes.apple.com/search?term=" + term + "&entity=song&limit=1")
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var highRes = fallback;
        if (data.results && data.results.length > 0) {
          var res = data.results[0];
          var a1 = res.artistName.toLowerCase();
          var a2 = artist.split(",")[0].toLowerCase().trim();
          if (a1.indexOf(a2) !== -1 || a2.indexOf(a1) !== -1) {
            highRes = res.artworkUrl100.replace("100x100bb", "1500x1500bb");
          }
        }
        itunesArtCache.set(key, highRes);
        callback(highRes);
      })
      .catch(function() {
        itunesArtCache.set(key, fallback);
        callback(fallback);
      });
  }

  function renderSpotify(d) {
    var title = d && d.title ? d.title : null;
    var live = !!(d && d.playing);
    isPremium = !!(d && d.premium);
    updatePlaybackVisibility();
    if (!title) {
      spState = { key: null, title: null, artist: "", artists: [], trackUrl: null, image: null, playing: false, progressMs: null, durationMs: null, deviceId: null, deviceType: null };
      playbackClock.hardSet(0, performance.now(), false);
      // clear the header explicitly (setLyricsHeader early-returns on matching keys)
      lastHeaderKey = "__none__";
      lyricsTitle.textContent = "nothing playing";
      lyricsTitle.removeAttribute("href");
      lyricsArtist.textContent = "";
      lyricsArt.removeAttribute("src");
      if (kTopCover) kTopCover.removeAttribute("src");
      if (kTopTitle) kTopTitle.textContent = "nothing playing";
      if (kTopArtist) kTopArtist.textContent = "";
      lyricsBg.style.backgroundImage = "";
      lyricsHint.textContent = "play something on spotify — lyrics will show up here";
      updatePlaybackUI();
      return;
    }

    var key = d.trackId || (title + " :: " + d.artist);
    var isNewTrack = spState.key !== key;
    spState.key = key;
    spState.title = title;
    spState.artist = d.artist || "";
    spState.artists = d.artists || [];
    spState.trackUrl = d.url || null;
    spState.image = d.image || null;
    spState.playing = live;
    spState.progressMs = d.progressMs;
    spState.durationMs = d.durationMs;
    spState.isrc = d.isrc || null;

    if (d && d.deviceId && d.deviceId !== spState.deviceId) {
      spState.deviceId = d.deviceId;
      spState.deviceType = d.deviceType || "Device";
    } else if (d && !d.deviceId) {
      spState.deviceId = null;
      spState.deviceType = null;
    }

    if (lyricsOverlay.classList.contains("open")) {
      setLyricsHeader();
      if (isNewTrack) {
        kSnapNext = true;
        /* a song only deviates from the automatic lead when you nudged THAT song */
        var savedLyr = lsInt("lLead:" + key, null);
        lTrackHasCustomLead = savedLyr !== null;
        lyrLeadMs = lTrackHasCustomLead ? savedLyr : 0;
        var savedK = lsInt("kLead:" + key, null);
        kTrackHasCustomLead = savedK !== null;
        kLeadMs = kTrackHasCustomLead ? savedK : autoKLead(key);
        if (typeof updateSyncLabel !== "undefined") updateSyncLabel();

        lyrActiveIdx = -1;
        kActiveIdx = -1;
        lyrRenderedKey = null;
        if (lyrStore.has(key)) {
          renderLyrEntry(key, d.durationMs);
        } else if (!lyrInflight[key]) {
          fetchLyrics(title, d.artist, d.durationMs);
        }
      }
    }

    if (d.image) {
      upgradeArtwork(title, d.artist, key, d.image, function(bestImg) {
        if (spState.key === key) {
          spState.image = bestImg;
          if (lyricsOverlay.classList.contains("open")) {
            setLyricsHeader();
          }
        }
      });
    }
    updatePlaybackUI();
  }

  var spPollTimer = null, spInflight = false, spWin = [], spEpoch = null, spClockKey = null;
  var spLastActivity = 0;
  function scheduleNext(ms) {
    if (spPollTimer) clearTimeout(spPollTimer);
    if (document.hidden) return;
    var delay = ms != null ? ms : ((lyricsOverlay && lyricsOverlay.classList.contains("open")) ? SYNC.OPEN_POLL_MS : SYNC.POLL_MS);
    var now = performance.now();
    if (now - spLastActivity < 4000) delay = 700;
    else if (spState.playing && spState.durationMs && playbackClock.getProgressMs() >= spState.durationMs - 3000) delay = 500;
    spPollTimer = setTimeout(function() { pollSpotify(false); }, delay);
  }
  function pollSpotify(hardSync, doneCb) {
    if (spInflight) {
      if (doneCb) doneCb();
      return;
    }
    spInflight = true;
    if (spPollTimer) { clearTimeout(spPollTimer); spPollTimer = null; }
    var tSend = performance.now();
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var abortTimer = ctrl ? setTimeout(function() { ctrl.abort(); }, 6000) : null;
    fetch("api/player", { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (abortTimer) clearTimeout(abortTimer);
        var tArr = performance.now();
        if (r.status === 401) {
          var e = new Error("not logged in");
          e.auth = true;
          throw e;
        }
        return r.json().then(function(d) { return {d: d, tSend: tSend, tArr: tArr}; });
      })
      .then(function (res) {
        spInflight = false;
        handleSample(res.d, res.tSend, res.tArr, hardSync);
        if (doneCb) doneCb();
      })
      .catch(function (err) {
        if (abortTimer) clearTimeout(abortTimer);
        spInflight = false;
        if (err && err.auth) {
          showLanding(); // session gone -> back to connect screen
          if (doneCb) doneCb();
          return;
        }
        scheduleNext();
        if (doneCb) doneCb();
      });
  }
  function applySample(s, hard) {
    if (!s.d || !s.d.title) {
      playbackClock.hardSet(0, performance.now(), false);
      spClockKey = null;
      spWin = [];
      return "stop";
    }
    var key = s.d.trackId || (s.d.title + " :: " + s.d.artist);
    /* spotify's `timestamp` is the moment of the last playback state change (play, pause, skip,
       scrub); it stays fixed during normal playback. when it moves, every older sample describes a
       timeline that no longer exists, so drop them (a short backward scrub used to leave the
       lyrics ~1.4s ahead for ~6s because it was not seen as a seek). */
    var epoch = key + "|" + !!s.d.playing + "|" + (s.d.spotifyTs || "");
    var newTrack = key !== spClockKey;
    var stateChanged = spEpoch !== null && epoch !== spEpoch;
    spClockKey = key;
    if (hard || newTrack || stateChanged || !s.d.playing || !playbackClock.isPlaying()) {
      playbackClock.hardSet(s.pos, s.at, !!s.d.playing);
      spWin = s.d.playing ? [s] : [];
      spEpoch = epoch;
      return newTrack ? "newtrack" : stateChanged ? "state" : "reset";
    }
    spWin.push(s);
    if (spWin.length > SYNC.WINDOW) spWin.shift();
    var now = performance.now();
    return playbackClock.correct(envelopeTarget(spWin, now));
  }
  function handleSample(d, tSend, tArr, hardSync) {
    if (!d) { scheduleNext(); return; }
    if (d.rateLimited) { scheduleNext(Math.max(6000, (d.retryAfter || 6) * 1000)); return; }
    if (d.transient) { scheduleNext(4000); return; } /* keep the current track + lyrics on screen */
    var s = sampleFrom(d, tSend, tArr);
    var key = d.trackId || (d.title ? (d.title + " :: " + d.artist) : null);
    var isNewTrack = key !== spClockKey;
    var curPos = playbackClock.getProgressMs();
    var seeked = Math.abs(s.pos - curPos) > 2000;
    var _hard = !!(hardSync || isNewTrack || seeked);
    if (_hard) spLastActivity = performance.now();
    renderSpotify(d);
    /* after a state change during playback (scrub, resume) poll quickly for a few seconds so the
       sample window refills fast; not while paused, and not for ordinary corrections */
    var applied = applySample(s, _hard);
    if (!_hard && applied === "state" && d.playing) spLastActivity = performance.now();
    scheduleNext();
  }
  /* coming back to the tab is a normal (soft) poll: a pause/skip/scrub made while away arrives as a
     new spotify timestamp and resets the clock by itself (the old hard reset threw away the sample
     history and made lyrics step back ~100ms on every alt-tab). long absences still start clean. */
  var spHiddenAt = 0;
  document.addEventListener("visibilitychange", function() {
    if (document.hidden) { spHiddenAt = performance.now(); return; }
    if (loggedIn) pollSpotify(performance.now() - spHiddenAt > 30000);
  });
  window.addEventListener("focus", function() {
    if (!document.hidden && loggedIn) {
      pollSpotify(false);
    }
  });

  /* ---------- 11b. synced lyrics overlay (verci-style) + karaoke ---------- */
  var lyricsOverlay = document.getElementById("lyricsOverlay"),
      lyricsBg = document.getElementById("lyricsBg"),
      lyricsLines = document.getElementById("lyricsLines"),
      lyricsHint = document.getElementById("lyricsHint"),
      lyricsTitle = document.getElementById("lyricsTitle"),
      lyricsArtist = document.getElementById("lyricsArtist"),
      lyricsArt = document.getElementById("lyricsArt"),
      lyricsProg = document.getElementById("lyricsProg"),
      karaokeToggle = document.getElementById("karaokeToggle"),
      lyricsClassicView = document.getElementById("lyricsClassicView"),
      lyricsKaraokeView = document.getElementById("lyricsKaraokeView"),
      kTopCover = document.getElementById("kTopCover"),
      kTopTitle = document.getElementById("kTopTitle"),
      kTopArtist = document.getElementById("kTopArtist"),
      kTopProg = document.getElementById("kTopProg"),
      karaokeStage = document.getElementById("karaokeStage"),
      kTapeCol = document.getElementById("kTapeCol");

  var EMOJI_MAP = {
  yeah:"🔥",yea:"🔥",yuh:"🔥",ayy:"🙌",ay:"🙌",aye:"🙌",woo:"🥳",skrrt:"🏎️",skrt:"🏎️",brr:"🥶",bet:"🤝",facts:"💯",fax:"💯",
  deadass:"💯",forreal:"💯",hundred:"💯",perfect:"💯",fire:"🔥",lit:"🔥",flame:"🔥",flames:"🔥",burn:"🔥",blaze:"🔥",hot:"🥵",
  heat:"🥵",sauce:"🥫",spicy:"🌶️",pepper:"🌶️",gas:"⛽",fuel:"⛽",valid:"✅",slay:"💅",slaps:"🔊",banger:"🔊",bop:"🎶",vibe:"🌈",
  vibes:"🌈",mood:"🌈",energy:"⚡",aura:"✨",rizz:"😏",swag:"😎",swagger:"😎",drip:"💧",drippy:"💧",wet:"💦",splash:"💦",
  flex:"💪",flexin:"💪",stunt:"😎",stuntin:"😎",style:"🕶️",fly:"🕊️",fresh:"🆕",clean:"🧼",icy:"🧊",ice:"🧊",frozen:"🧊",
  freeze:"🧊",cold:"🥶",chill:"🧊",cool:"😎",shades:"🕶️",glasses:"🕶️",sunglasses:"🕶️",money:"💸",cash:"💵",bands:"💵",
  band:"💵",racks:"💰",rack:"💰",stack:"💰",stacks:"💰",bread:"🍞",cheese:"🧀",cheddar:"🧀",paper:"📄",guap:"💰",bag:"💰",
  bags:"💰",bankroll:"💰",bank:"🏦",vault:"🏦",safe:"🔐",rich:"🤑",wealthy:"🤑",millionaire:"🤑",billionaire:"🤑",million:"🤑",
  millions:"🤑",billion:"🤑",ticket:"🎟️",dollar:"💲",dollars:"💲",dime:"🪙",penny:"🪙",coin:"🪙",coins:"🪙",crypto:"🪙",
  bitcoin:"🪙",paid:"💰",check:"💳",cheque:"💳",debt:"📉",broke:"📉",poor:"📉",profit:"📈",stocks:"📈",invest:"📈",hustle:"💼",
  grind:"⚙️",grindin:"⚙️",work:"💼",job:"💼",business:"💼",deal:"🤝",boss:"😎",ceo:"👔",suit:"👔",shop:"🛍️",shopping:"🛍️",
  mall:"🛍️",spend:"💸",spent:"💸",blow:"💸",tip:"💵",price:"🏷️",cost:"🏷️",expensive:"💎",cheap:"🏷️",luxury:"💎",
  designer:"👜",gucci:"👜",prada:"👜",louis:"👜",fendi:"👜",dior:"👜",chanel:"👜",versace:"👜",balenciaga:"👟",purse:"👜",
  wallet:"👛",diamond:"💎",diamonds:"💎",gem:"💎",jewel:"💎",jewelry:"💎",bling:"💎",chain:"⛓️",chains:"⛓️",necklace:"📿",
  pendant:"📿",rings:"💍",rolex:"⌚",watch:"⌚",wrist:"⌚",patek:"⌚",gold:"🥇",golden:"🥇",silver:"🥈",platinum:"💿",
  plaque:"💿",grammy:"🏆",award:"🏆",trophy:"🏆",medal:"🏅",crown:"👑",throne:"👑",king:"👑",kings:"👑",queen:"👸",prince:"🤴",
  princess:"👸",royal:"👑",goat:"🐐",legend:"🏆",legendary:"🏆",icon:"⭐",star:"⭐",superstar:"🌟",famous:"🌟",fame:"🌟",
  celebrity:"🌟",spotlight:"🔦",camera:"📸",cameras:"📸",paparazzi:"📸",photo:"📸",pic:"📸",selfie:"🤳",picture:"🖼️",
  frame:"🖼️",win:"🏆",winning:"🏆",winner:"🏆",won:"🏆",champion:"🏆",champ:"🏆",best:"🥇",greatest:"🐐",loser:"📉",player:"🎮",
  mvp:"🏆",goal:"🥅",aim:"🎯",target:"🎯",car:"🏎️",cars:"🚘",whip:"🏎️",ride:"🚗",drive:"🚗",drivin:"🚗",driver:"🚗",wheel:"🛞",
  wheels:"🛞",tires:"🛞",engine:"🏁",motor:"🏁",race:"🏁",racing:"🏁",speed:"💨",fast:"💨",faster:"💨",zoom:"💨",vroom:"🏎️",
  lambo:"🏎️",lamborghini:"🏎️",ferrari:"🏎️",porsche:"🏎️",benz:"🚘",mercedes:"🚘",bentley:"🚘",rolls:"🚘",bugatti:"🏎️",
  maybach:"🚘",tesla:"🚘",truck:"🛻",coupe:"🏎️",foreign:"🏎️",garage:"🏠",parking:"🅿️",road:"🛣️",roads:"🛣️",highway:"🛣️",
  freeway:"🛣️",street:"🛣️",streets:"🛣️",hood:"🏘️",city:"🏙️",town:"🏘️",downtown:"🌆",uptown:"🌆",corner:"🏘️",traffic:"🚦",
  plane:"✈️",planes:"✈️",jet:"🛩️",private:"🛩️",flight:"✈️",flights:"✈️",airport:"🛫",pilot:"✈️",boat:"🛥️",yacht:"🛥️",
  ship:"🚢",train:"🚆",bike:"🚲",bus:"🚌",taxi:"🚕",uber:"🚕",rocket:"🚀",launch:"🚀",space:"🚀",moonwalk:"🌕",travel:"🧳",
  passport:"🛂",vacation:"🏝️",trip:"🧳",world:"🌍",global:"🌍",earth:"🌎",map:"🗺️",paris:"🗼",london:"💂",tokyo:"🗼",
  miami:"🌴",vegas:"🎰",york:"🗽",atlanta:"🍑",houston:"🚀",chicago:"🌆",toronto:"🍁",cali:"🌴",california:"🌴",texas:"🤠",
  brazil:"🇧🇷",mexico:"🌮",love:"❤️",lovin:"❤️",lover:"💕",lovers:"💕",loved:"❤️",heart:"💖",hearts:"💖",heartbeat:"💓",
  heartbreak:"💔",heartbroken:"💔",broken:"💔",break:"💔",kiss:"💋",kisses:"💋",kissin:"💋",lips:"💋",hug:"🫂",hugs:"🫂",
  cuddle:"🫂",crush:"😍",cute:"🥺",pretty:"🌸",beautiful:"🌸",gorgeous:"😍",sexy:"😏",hottie:"🥵",baby:"👶",babe:"😘",bae:"😘",
  boo:"👻",shawty:"💅",darling:"🥰",honey:"🍯",sweetie:"🍬",sweet:"🍬",sugar:"🍬",candy:"🍭",lollipop:"🍭",chocolate:"🍫",
  cake:"🎂",cookie:"🍪",cherry:"🍒",cherries:"🍒",peach:"🍑",strawberry:"🍓",lemon:"🍋",lemonade:"🍋",apple:"🍎",banana:"🍌",
  grape:"🍇",watermelon:"🍉",pineapple:"🍍",mango:"🥭",coconut:"🥥",honeymoon:"🌙",dates:"🌹",valentine:"💘",cupid:"💘",
  forever:"♾️",always:"♾️",eternity:"♾️",infinity:"♾️",soulmate:"💞",wifey:"💍",wife:"💍",husband:"💍",marry:"💒",
  married:"💒",wedding:"💒",bride:"👰",propose:"💍",together:"💑",couple:"💑",relationship:"💑",exes:"🙅",lonely:"🥀",
  alone:"🥀",miss:"🥺",missin:"🥺",jealous:"😒",toxic:"☠️",cheat:"🐍",cheater:"🐍",cheated:"🐍",liar:"🤥",lie:"🤥",lies:"🤥",
  lyin:"🤥",fake:"🤡",clown:"🤡",snake:"🐍",snakes:"🐍",trust:"🤝",loyal:"🤞",loyalty:"🤞",promise:"🤞",swear:"🤞",secret:"🤫",
  secrets:"🤫",whisper:"🤫",quiet:"🤫",silence:"🤫",shh:"🤫",cry:"😭",cryin:"😭",crying:"😭",cried:"😭",tears:"😢",tear:"😢",
  sad:"😔",sadness:"😔",blue:"💙",hurt:"🤕",pain:"🩹",scar:"🩹",scars:"🩹",wound:"🩹",bleed:"🩸",bleeding:"🩸",blood:"🩸",
  sorry:"🙏",apologize:"🙏",regret:"😞",depressed:"😞",anxiety:"😰",stress:"😩",stressed:"😩",tired:"😴",sleepy:"😴",sleep:"😴",
  nap:"😴",bed:"🛏️",pillow:"🛏️",dream:"💭",dreams:"💭",dreamin:"💭",nightmare:"😱",wake:"⏰",awake:"👁️",insomnia:"🌃",
  happy:"😊",happiness:"😊",smile:"😁",smilin:"😁",laugh:"😂",laughin:"😂",lol:"😂",haha:"😂",joke:"😂",funny:"😂",fun:"🥳",
  joy:"😊",glad:"😊",excited:"🤩",amazing:"🤩",wow:"🤩",crazy:"🤪",insane:"🤯",brain:"🧠",smart:"🧠",genius:"🧠",thinkin:"🤔",
  thoughts:"💭",wonder:"🤔",wild:"🐆",savage:"😈",mad:"😤",angry:"😠",anger:"😠",rage:"😡",hate:"😤",hater:"😒",haters:"😒",
  enemy:"😤",enemies:"😤",opps:"👀",beef:"🥩",scared:"😱",scary:"😱",afraid:"😱",fear:"😱",nervous:"😬",shy:"🙈",shock:"😳",
  shook:"😳",confused:"😵",dizzy:"😵",search:"🔎",hope:"🤞",faith:"🙏",wish:"🌠",wishes:"🌠",luck:"🍀",lucky:"🍀",blessed:"🙌",
  bless:"🙌",blessing:"🙌",grateful:"🙏",thankful:"🙏",thank:"🙏",thanks:"🙏",pray:"🙏",prayer:"🙏",prayin:"🙏",god:"🙏",
  lord:"🙏",jesus:"✝️",church:"⛪",heaven:"☁️",angel:"😇",angels:"😇",halo:"😇",holy:"😇",saint:"😇",good:"😇",devil:"😈",
  demon:"👹",demons:"👹",evil:"👿",bad:"😈",sin:"😈",sins:"😈",hell:"🔥",soul:"🫀",spirit:"👻",ghost:"👻",ghosts:"👻",
  haunted:"👻",dead:"💀",death:"💀",die:"💀",dying:"💀",skull:"💀",bones:"🦴",grave:"🪦",rip:"🪦",heavenly:"☁️",karma:"☯️",
  peace:"☮️",zen:"🧘",calm:"😌",relax:"😌",breathe:"💨",party:"🎉",parties:"🎉",partyin:"🎉",celebrate:"🎊",turnt:"🎉",
  dance:"💃",dancin:"💃",dancer:"💃",twerk:"🍑",club:"🪩",clubs:"🪩",disco:"🪩",dj:"🎧",floor:"🪩",stage:"🎤",crowd:"🙌",
  concert:"🎤",tour:"🚌",festival:"🎡",rave:"🪩",night:"🌙",nights:"🌙",tonight:"🌃",midnight:"🌃",drink:"🍹",drinks:"🍹",
  drinkin:"🍹",cup:"🥤",cups:"🥤",sip:"🥤",shot:"🥃",shots:"🥃",liquor:"🥃",whiskey:"🥃",tequila:"🥃",vodka:"🍸",wine:"🍷",
  champagne:"🍾",bottle:"🍾",bottles:"🍾",toast:"🥂",cheers:"🥂",beer:"🍺",drunk:"🥴",tipsy:"🥴",smoke:"💨",smokin:"💨",
  high:"🌿",cloud:"☁️",clouds:"☁️",hookah:"💨",lighter:"🔥",ash:"🚬",food:"🍔",hungry:"🍔",eat:"🍽️",eatin:"🍽️",dinner:"🍽️",
  lunch:"🥪",breakfast:"🥞",pizza:"🍕",burger:"🍔",fries:"🍟",chicken:"🍗",wings:"🪽",steak:"🥩",sushi:"🍣",tacos:"🌮",taco:"🌮",
  noodles:"🍜",ramen:"🍜",rice:"🍚",icecream:"🍦",cream:"🍦",milk:"🥛",coffee:"☕",tea:"🍵",juice:"🧃",water:"💧",soda:"🥤",
  popcorn:"🍿",snack:"🍿",kitchen:"🍳",cook:"🍳",cookin:"🍳",chef:"🍳",recipe:"📜",phone:"📱",phones:"📱",iphone:"📱",call:"📞",
  calls:"📞",callin:"📞",text:"💬",texts:"💬",textin:"💬",message:"💌",dm:"📩",dms:"📩",inbox:"📥",email:"📧",letter:"💌",
  facetime:"🤳",insta:"📸",instagram:"📸",tiktok:"🎵",twitter:"🐦",online:"🌐",internet:"🌐",viral:"🦠",followers:"👥",
  likes:"👍",views:"👀",stream:"🎧",streams:"🎧",spotify:"🎧",radio:"📻",tv:"📺",movie:"🎬",movies:"🎬",film:"🎬",scene:"🎬",
  hollywood:"🎬",computer:"💻",laptop:"💻",code:"💻",robot:"🤖",alien:"👽",ufo:"🛸",matrix:"🕶️",glitch:"👾",video:"📹",
  records:"💿",album:"💿",mixtape:"📼",tape:"📼",studio:"🎙️",mic:"🎤",microphone:"🎤",sing:"🎤",singin:"🎤",singer:"🎤",
  song:"🎵",songs:"🎵",music:"🎶",melody:"🎶",rhythm:"🥁",beat:"🥁",beats:"🥁",drum:"🥁",drums:"🥁",bass:"🔊",loud:"🔊",
  volume:"🔊",speaker:"🔊",headphones:"🎧",guitar:"🎸",piano:"🎹",violin:"🎻",trumpet:"🎺",saxophone:"🎷",rap:"🎤",rapper:"🎤",
  verse:"📝",bars:"📝",pen:"🖊️",write:"✍️",wrote:"✍️",book:"📖",books:"📚",school:"🏫",class:"🏫",teacher:"🏫",college:"🎓",
  graduate:"🎓",degree:"🎓",plan:"📝",plans:"📝",list:"📝",notes:"🗒️",history:"📜",story:"📖",stories:"📖",chapter:"📖",
  time:"⏳",clock:"⏰",hour:"⏰",hours:"⏰",minute:"⏱️",minutes:"⏱️",seconds:"⏱️",today:"📅",tomorrow:"🌅",yesterday:"🕰️",
  morning:"🌅",sunrise:"🌅",sunset:"🌇",evening:"🌆",weekend:"🎉",monday:"😩",friday:"🎉",saturday:"🎉",sunday:"☀️",
  summer:"🏖️",winter:"❄️",spring:"🌷",autumn:"🍂",christmas:"🎄",halloween:"🎃",birthday:"🎂",year:"📅",years:"📅",new:"🆕",
  young:"🧒",old:"👴",future:"🔮",memories:"🧠",memory:"🧠",remember:"🧠",forget:"🫥",forgot:"🫥",moment:"⏱️",repeat:"🔁",
  replay:"🔁",rewind:"⏪",pause:"⏸️",run:"🏃",runnin:"🏃",runaway:"🏃",chase:"🏃",jump:"🦘",walk:"🚶",walkin:"🚶",climb:"🧗",
  flyin:"🕊️",float:"🎈",balloon:"🎈",swim:"🏊",surf:"🏄",sink:"⚓",drown:"🌊",moon:"🌙",moonlight:"🌙",sun:"☀️",sunshine:"🌞",
  sunny:"☀️",stars:"✨",starry:"✨",shine:"✨",shinin:"✨",glow:"✨",glitter:"✨",sparkle:"✨",galaxy:"🌌",universe:"🌌",
  planet:"🪐",mars:"🪐",sky:"🌌",skies:"🌌",rain:"🌧️",rainy:"🌧️",rainbow:"🌈",storm:"⛈️",thunder:"⚡",lightning:"⚡",
  wind:"🌬️",tornado:"🌪️",hurricane:"🌀",snow:"❄️",snowflake:"❄️",ocean:"🌊",sea:"🌊",wave:"🌊",waves:"🌊",tide:"🌊",
  beach:"🏝️",island:"🏝️",sand:"🏖️",river:"🏞️",lake:"🏞️",hills:"⛰️",hill:"⛰️",mountain:"🏔️",mountains:"🏔️",valley:"🏞️",
  desert:"🏜️",jungle:"🌴",forest:"🌲",tree:"🌳",trees:"🌳",palm:"🌴",leaf:"🍃",leaves:"🍂",flower:"🌸",flowers:"🌸",rose:"🌹",
  roses:"🌹",petal:"🌸",garden:"🌷",sunflower:"🌻",tulip:"🌷",lily:"🪷",grass:"🌱",seed:"🌱",grow:"🌱",growin:"🌱",
  earthquake:"🫨",volcano:"🌋",fireworks:"🎆",dark:"🌑",darkness:"🌑",shadow:"👤",shadows:"👤",black:"🖤",white:"🤍",red:"❤️",
  pink:"🩷",purple:"💜",green:"💚",yellow:"💛",orange:"🧡",colors:"🌈",eyes:"👀",eye:"👁️",look:"👀",lookin:"👀",stare:"👀",
  face:"😶",tongue:"👅",mouth:"👄",teeth:"🦷",hand:"✋",hands:"👐",finger:"☝️",fingers:"🤞",nails:"💅",hair:"💇",body:"💃",
  legs:"🦵",feet:"🦶",shoes:"👟",sneakers:"👟",kicks:"👟",jordans:"👟",nikes:"👟",boots:"👢",heels:"👠",dress:"👗",jeans:"👖",
  shirt:"👕",hoodie:"🧥",jacket:"🧥",coat:"🧥",hat:"🧢",cap:"🧢",mask:"🎭",makeup:"💄",lipstick:"💄",perfume:"🧴",mirror:"🪞",
  muscle:"💪",strong:"💪",strength:"💪",power:"⚡",powerful:"⚡",clap:"👏",hello:"👋",bye:"👋",goodbye:"👋",pinky:"🤙",
  handshake:"🤝",fist:"✊",punch:"👊",fight:"🥊",fightin:"🥊",boxing:"🥊",knockout:"🥊",war:"⚔️",battle:"⚔️",sword:"⚔️",
  shield:"🛡️",armor:"🛡️",army:"🪖",soldier:"🪖",gun:"💥",guns:"💥",shoot:"💥",shootin:"💥",bang:"💥",boom:"💥",bomb:"💣",
  blast:"💥",explode:"💥",police:"🚓",cops:"🚓",sirens:"🚨",jail:"⛓️",prison:"⛓️",freedom:"🕊️",judge:"⚖️",court:"⚖️",
  lawyer:"⚖️",crime:"🚨",danger:"⚠️",dangerous:"⚠️",risk:"🎲",dice:"🎲",casino:"🎰",gamble:"🎰",cards:"🃏",poker:"🃏",
  chess:"♟️",trap:"🪤",key:"🔑",keys:"🔑",lock:"🔒",door:"🚪",doors:"🚪",window:"🪟",house:"🏡",home:"🏠",mansion:"🏰",
  castle:"🏰",palace:"🏰",pool:"🏊",penthouse:"🏙️",roof:"🏠",room:"🚪",couch:"🛋️",tub:"🛁",shower:"🚿",girl:"💅",girls:"💅",
  woman:"👩",women:"👩",lady:"💃",ladies:"💃",boy:"🧢",boys:"🧢",man:"🧔",men:"🧔",guy:"🧔",dude:"🧔",bro:"🤜",brother:"🤜",
  brothers:"🤜",sister:"👭",sisters:"👭",friend:"🤝",friends:"🤝",homie:"🤝",homies:"🤝",dawg:"🐶",fam:"🏡",family:"🏡",
  mama:"👩",mom:"👩",mother:"👩",dad:"👨",daddy:"👨",father:"👨",son:"👦",daughter:"👧",kid:"🧒",kids:"🧒",child:"🧒",
  children:"🧒",crew:"👯",squad:"👯",team:"🤝",gang:"🤝",clique:"👯",everybody:"🙌",everyone:"🙌",people:"👥",stranger:"🕵️",
  neighbor:"🏘️",baddie:"💅",diva:"💅",bestie:"👯",dog:"🐶",dogs:"🐶",puppy:"🐶",cat:"🐱",kitty:"🐱",lion:"🦁",tiger:"🐯",
  wolf:"🐺",wolves:"🐺",bear:"🐻",fox:"🦊",bunny:"🐰",rabbit:"🐰",horse:"🐎",pony:"🐴",bird:"🐦",birds:"🐦",eagle:"🦅",dove:"🕊️",
  owl:"🦉",butterfly:"🦋",butterflies:"🦋",bee:"🐝",bees:"🐝",spider:"🕷️",shark:"🦈",fish:"🐟",whale:"🐋",dolphin:"🐬",
  monkey:"🐒",ape:"🦍",gorilla:"🦍",panda:"🐼",unicorn:"🦄",dragon:"🐉",dinosaur:"🦖",frog:"🐸",rat:"🐀",cow:"🐄",pig:"🐷",
  duck:"🦆",bull:"🐂",panther:"🐆",cheetah:"🐆",leopard:"🐆",zebra:"🦓",monster:"👾",beast:"🦍",magic:"🪄",wizard:"🧙",
  witch:"🧙",spell:"✨",potion:"🧪",crystal:"🔮",fortune:"🔮",destiny:"🔮",fate:"🔮",mystery:"🕵️",gift:"🎁",gifts:"🎁",
  surprise:"🎁",candle:"🕯️",balloons:"🎈",confetti:"🎊",ribbon:"🎀",bow:"🎀",doll:"🪆",teddy:"🧸",toy:"🧸",fairy:"🧚",
  fairytale:"🧚",hero:"🦸",superhero:"🦸",villain:"🦹",ninja:"🥷",pirate:"☠️",cowboy:"🤠",zombie:"🧟",vampire:"🧛",
  medicine:"💊",pill:"💊",pills:"💊",doctor:"🩺",hospital:"🏥",sick:"🤒",fever:"🤒",poison:"☠️",bitter:"🍋",sour:"🍋",
  salty:"🧂",fireproof:"🧯",alarm:"🚨",bell:"🔔",tick:"⏱️",
  you:"👉",u:"👉",ya:"👉",yall:"👥","y'all":"👥",your:"👉",yours:"👉",yourself:"👉",
  bruh:"😑",opp:"🎯",ops:"🎯",dripping:"💧",iced:"🧊",goated:"🐐",rollie:"⌚",psycho:"🤪",
  lunatic:"🤪",lowkey:"🤫",highkey:"📢",lmao:"😂",nocap:"🚫🧢",fr:"💯",real:"💯",sus:"🤨",
  thick:"🍑",booty:"🍑",shorty:"💃",ex:"💔",ghosted:"👻",pop:"💥",popping:"💥",poppin:"💥",
  lean:"🥤",drank:"🥤",turn:"🔄",ig:"📸",gram:"📸",pull:"🧲",slide:"🛝",glock:"🔫",
  trigger:"🔫",damn:"😳",woah:"😮",whoa:"😮",oops:"🙊",
  // --- taste-based additions (mined from library lyrics) ---
  // money / luxury / brands
  thousand:"💵",mil:"🤑",miles:"🛣️",hunnid:"💯",commas:"💰",dough:"💰",bill:"💵",card:"💳",buy:"🛒",count:"🧮",
  pocket:"👖",tiffany:"💎",birkin:"👜",mink:"🧥",nike:"👟",vip:"🥂",plug:"🔌",
  // cars / rides
  rari:"🏎️",corvette:"🏎️",wraith:"🚘",phantom:"👻",rover:"🚙",backseat:"🚘",seat:"💺",ridin:"🚗",riding:"🚗",driving:"🚗",
  metro:"🚇",
  // drugs / drinks / smoke
  drug:"💊",molly:"💊",ecstasy:"💊",percocet:"💊",needle:"💉",codeine:"🥤",wock:"🥤",syrup:"🥤",pint:"🥤",sippin:"🥤",
  sipping:"🥤",pour:"🫗",henny:"🥃",hennessy:"🥃",weed:"🌿",kush:"🍃",blunt:"🍃",hotbox:"💨",smoking:"💨",cigarette:"🚬",
  cocaine:"❄️",wasted:"🥴",faded:"🥴",geeked:"🤪",trippin:"🤪",tripping:"🤪",
  // guns / street
  pistol:"🔫",strapped:"🔫",uzi:"🔫",chopper:"🚁",choppa:"🚁",draco:"🐉",knife:"🔪",kill:"🔪",block:"🧱",stop:"🛑",
  // body / flirt
  ass:"🍑",dick:"🍆",sex:"🔞",naked:"🫣",bite:"🫦",lick:"👅",taste:"👅",nose:"👃",knees:"🧎",arms:"💪",breath:"😮💨",
  sweat:"💦",freak:"😜",freaky:"😜",
  // love / feels
  ring:"💍",ringing:"📞",girlfriend:"💞",boyfriend:"💞",true:"💯",mind:"🧠",lost:"🧭",hide:"🙈",scream:"😱",lame:"🥱",
  drama:"🎭",lying:"🤥",loving:"❤️",save:"🛟",free:"🕊️",
  // places / home
  crib:"🏠",hotel:"🏨",motel:"🏩",bedroom:"🛏️",sheets:"🛏️",booth:"🎙️",paradise:"🏝️",
  // party / music / play
  dancing:"💃",shake:"🫨",rock:"🤘",rockstar:"🤘",play:"🎮",game:"🎮",ball:"🏀",swimming:"🏊",running:"🏃",top:"🔝",
  crash:"💥",mustard:"🌭",
  // light / vibes / fun
  light:"💡",shining:"✨",woke:"⏰",chick:"🐥",
  // romanized hindi / punjabi
  dil:"❤️",yaar:"🤝",pyaar:"💕",pyar:"💕",jaan:"💖",raat:"🌙",taare:"✨",badal:"☁️",duniya:"🌍",aankhon:"👀",saath:"🫂",
  // spanish (normalizer only trims edge accents: bebé -> beb; inner accents stay: corazón)
  mami:"💃",noche:"🌙",amor:"❤️",fiesta:"🎉",baila:"💃",bailando:"💃",loco:"🤪",loca:"🤪",beb:"👶",bebe:"👶",
  fuego:"🔥",dinero:"💸",corazon:"❤️","corazón":"❤️"
};
  var EMOJI_STOP = {"a":1,"the":1,"i":1,"me":1,"it":1,"oh":1,"la":1,"na":1};
  function emojiFor(word) {
    var w = word.toLowerCase().replace(/[’‘]/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "").replace(/^'+|'+$/g, "");
    if (!w || EMOJI_STOP[w]) return null;
    var tries = [w, w.replace(/'s$/, ""), w.replace(/in'?$/, "ing"), w.replace(/in'?$/, ""), w.replace(/ing$/, ""),
                 w.replace(/ies$/, "y"), w.replace(/es$/, ""), w.replace(/s$/, ""), w.replace(/ed$/, "")];
    for (var i = 0; i < tries.length; i++) if (tries[i] && EMOJI_MAP[tries[i]]) return EMOJI_MAP[tries[i]];
    return null;
  }

  /* ---------- apple (iOS) emojis ---------- */
  var APPLE_EMOJI_BASE = "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/";
  var EMOJI_REGEX;
  try {
    /* real emoji only: emoji-presentation chars, or pictographs explicitly followed by VS16 (plain
       text symbols like arrows must stay text — they have no apple image) */
    EMOJI_REGEX = new RegExp("(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)(?:\\uFE0F|\\u200D(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F?)|\\p{Emoji_Modifier})*", "gu");
  } catch (e) {
    EMOJI_REGEX = null;
  }

  var appleEmojiCache = (typeof Map !== "undefined") ? new Map() : {
    _d: {},
    get: function (k) { return this._d[k]; },
    set: function (k, v) { this._d[k] = v; },
    has: function (k) { return Object.prototype.hasOwnProperty.call(this._d, k); }
  };

  function getEmojiVariants(str) {
    var codes = [];
    if (Array.from) {
      var chars = Array.from(str);
      for (var i = 0; i < chars.length; i++) {
        codes.push(chars[i].codePointAt(0).toString(16).toLowerCase());
      }
    } else {
      for (var j = 0; j < str.length;) {
        var cp = str.codePointAt(j);
        codes.push(cp.toString(16).toLowerCase());
        j += cp > 0xffff ? 2 : 1;
      }
    }
    var raw = codes.join("-");
    var list = [raw];

    // 2. retry with every "-fe0f" removed
    var noFe0f = raw.replace(/-fe0f/g, "");
    if (noFe0f !== raw && list.indexOf(noFe0f) === -1) {
      list.push(noFe0f);
    }

    // 3. retry with "-fe0f" appended to the first codepoint
    var parts = raw.split("-");
    if (parts.length > 0 && parts[0].indexOf("fe0f") === -1) {
      var withFe0f = (parts.length > 1 && parts[1] === "fe0f")
        ? raw
        : (parts[0] + "-fe0f" + (parts.length > 1 ? "-" + parts.slice(1).join("-") : ""));
      if (withFe0f !== raw && list.indexOf(withFe0f) === -1) {
        list.push(withFe0f);
      }
    }
    return list;
  }

  function toAppleEmoji(char) {
    if (appleEmojiCache.has(char)) {
      var cached = appleEmojiCache.get(char);
      if (!cached) {
        return document.createTextNode(char);
      }
      var imgCached = document.createElement("img");
      imgCached.className = "ios-emo";
      imgCached.alt = char;
      imgCached.draggable = false;
      imgCached.decoding = "async";
      imgCached.src = APPLE_EMOJI_BASE + cached + ".png";
      imgCached.onerror = function () {
        if (imgCached.parentNode) {
          imgCached.parentNode.replaceChild(document.createTextNode(char), imgCached);
        }
      };
      return imgCached;
    }

    var variants = getEmojiVariants(char);
    var img = document.createElement("img");
    img.className = "ios-emo";
    img.alt = char;
    img.draggable = false;
    img.decoding = "async";

    var step = 0;
    img.onerror = function () {
      step++;
      if (step < variants.length) {
        img.src = APPLE_EMOJI_BASE + variants[step] + ".png";
      } else {
        appleEmojiCache.set(char, null);
        if (img.parentNode) {
          img.parentNode.replaceChild(document.createTextNode(char), img);
        }
      }
    };
    img.onload = function () {
      appleEmojiCache.set(char, variants[step]);
    };
    img.src = APPLE_EMOJI_BASE + variants[0] + ".png";
    return img;
  }

  function preloadEmoji(char) {
    if (appleEmojiCache.has(char)) {
      var cached = appleEmojiCache.get(char);
      if (cached) {
        var p = new Image();
        p.src = APPLE_EMOJI_BASE + cached + ".png";
      }
      return;
    }
    var variants = getEmojiVariants(char);
    var pImg = new Image();
    var step = 0;
    pImg.onload = function () {
      appleEmojiCache.set(char, variants[step]);
    };
    pImg.onerror = function () {
      step++;
      if (step < variants.length) {
        pImg.src = APPLE_EMOJI_BASE + variants[step] + ".png";
      } else {
        appleEmojiCache.set(char, null);
      }
    };
    pImg.src = APPLE_EMOJI_BASE + variants[0] + ".png";
  }

  function replaceEmojisInTree(rootEl) {
    if (!rootEl || !EMOJI_REGEX) return;
    try {
      var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (!n || !n.nodeValue) return NodeFilter.FILTER_REJECT;
          var p = n.parentNode;
          if (!p) return NodeFilter.FILTER_REJECT;
          var tag = p.nodeName.toUpperCase();
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "INPUT") {
            return NodeFilter.FILTER_REJECT;
          }
          EMOJI_REGEX.lastIndex = 0;
          return EMOJI_REGEX.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }, false);

      var nodes = [];
      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
      }

      for (var i = 0; i < nodes.length; i++) {
        var textNode = nodes[i];
        var text = textNode.nodeValue;
        EMOJI_REGEX.lastIndex = 0;
        var match;
        var lastIdx = 0;
        var frag = document.createDocumentFragment();
        var hasMatch = false;

        while ((match = EMOJI_REGEX.exec(text)) !== null) {
          hasMatch = true;
          if (match.index > lastIdx) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
          }
          frag.appendChild(toAppleEmoji(match[0]));
          lastIdx = match.index + match[0].length;
        }

        if (hasMatch) {
          if (lastIdx < text.length) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx)));
          }
          if (textNode.parentNode) {
            textNode.parentNode.replaceChild(frag, textNode);
          }
        }
      }
    } catch (e) {}
  }

  function runEmojiWalker() {
    try {
      if (!EMOJI_REGEX) return;
      var header = document.querySelector("header");
      var main = document.querySelector("main");
      if (header) replaceEmojisInTree(header);
      if (main) replaceEmojisInTree(main);
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runEmojiWalker);
  } else {
    runEmojiWalker();
  }
  /* integer from localStorage; 0 is a legitimate saved lead */
  function lsInt(key, fallback) {
    try {
      var v = parseInt(localStorage.getItem(key), 10);
      return isNaN(v) ? fallback : v;
    } catch (e) { return fallback; }
  }
  /* lyric leads (ms added to the playback clock before looking up the line/word).
     line view: 0 for every source; karaoke: per word source (autoKLead). a track only deviates when
     you nudge it. there are NO baked-in compensations: bluetooth delay is a manual toggle below. */
  var lyrLeadMs = 0;
  var kLeadMs = 150;
  try {
    if (localStorage.getItem("lyrLeadV") !== "4") {
      /* clean slate: older builds shifted and saved offsets silently (mouse wheel over the sync pill,
         provider presets, a global default that leaked into every song) */
      var stale = [];
      for (var li = 0; li < localStorage.length; li++) {
        var lk = localStorage.key(li);
        if (/^(kLead|lLead|lyrLead):/.test(lk) || lk === "kLeadMs" || lk === "lyrLeadMs") stale.push(lk);
      }
      stale.forEach(function (k) { localStorage.removeItem(k); });
      localStorage.setItem("lyrLeadV", "4");
    }
  } catch (e) {}
  var karaokeMode = true;
  try { karaokeMode = localStorage.getItem("karaokeMode") !== "false"; } catch(e) {}
  var karaokePref = karaokeMode; /* the user's choice; forced-off for word-less songs doesn't change it */
  /* bluetooth headphones play audio late (codec + radio buffering; spotify reports the app's
     position, not what reaches your ears). a manual toggle, OFF by default: -225ms is the value
     measured by ear on yoshik's own headphones, not a universal number. line and word modes alike. */
  var HEADPHONES_MS = -225;
  var headphonesOn = false;
  try { headphonesOn = localStorage.getItem("ykHeadphones") === "1"; } catch (e) {}
  var lTrackHasCustomLead = false;
  var lyrStore = new Map();
  var lyrInflight = {};
  var lyrRaf = 0, lyrActiveIdx = -1, lyrUserScrollAt = 0, lyrRenderedKey = null;
  var karaokeWordList = [];
  var kActiveIdx = -1;
  var kIdleTimer = null;
  var kCamY = 0;
  var kSnapNext = true;
  var kLastFrameTime = 0;
  var kLastLyrPos = 0;
  var kTrackHasCustomLead = false;
  var lyrFailUntil = {}, lyrTries = {};

  function resetKIdle() {
    if (kIdleTimer) clearTimeout(kIdleTimer);
    lyricsOverlay.classList.remove("idle");
    if (karaokeMode && lyricsOverlay.classList.contains("open")) {
      kIdleTimer = setTimeout(function() {
        if (karaokeMode && lyricsOverlay.classList.contains("open")) {
          lyricsOverlay.classList.add("idle");
        }
      }, 3000);
    }
  }
  window.addEventListener("mousemove", resetKIdle);
  window.addEventListener("click", resetKIdle);
  window.addEventListener("touchstart", resetKIdle);
  window.addEventListener("resize", function() {
    kSnapNext = true;
  });

  function lyrPos() { return playbackClock.getProgressMs(); }
  function lyrPut(key, val) {
    lyrStore.set(key, val);
    if (lyrStore.size > 24) lyrStore.delete(lyrStore.keys().next().value);
  }


  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max == min) { h = s = 0; }
    else {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
  }

  var colorToken = 0;
  function extractDominantColors(imgSrc) {
    var token = ++colorToken;
    var img = new Image();
    img.crossOrigin = "Anonymous";
    img.onerror = function () {};
    img.onload = function() {
      if (token !== colorToken) return; /* a newer track's artwork already won */
      try { paintDominantColors(img); } catch (e) { /* tainted canvas: keep the default backdrop */ }
    };
    img.src = imgSrc;
  }
  function paintDominantColors(img) {
    {
      var cvs = document.createElement("canvas");
      var ctx = cvs.getContext("2d", { willReadFrequently: true });
      cvs.width = 16; cvs.height = 16;
      ctx.drawImage(img, 0, 0, 16, 16);
      var data = ctx.getImageData(0, 0, 16, 16).data;
      var r=0, g=0, b=0, count=0;
      for(var i=0; i<data.length; i+=4) {
        if(data[i+3] < 100) continue;
        r += data[i]; g += data[i+1]; b += data[i+2]; count++;
      }
      if(count > 0) {
        r = Math.floor(r/count); g = Math.floor(g/count); b = Math.floor(b/count);
        var hsl = rgbToHsl(r,g,b);
        var bgHue = hsl[0];
        var bgSat = Math.max(30, Math.min(hsl[1] * 1.2, 90));
        var bgLum = Math.max(15, Math.min(hsl[2] * 0.8, 25));
        var bgLighter = Math.min(bgLum + 12, 40);
        lyricsBg.style.setProperty("--lyr-bg-gradient", "linear-gradient(135deg, hsla(" + bgHue + ", " + bgSat + "%, " + bgLum + "%, 0.8), hsla(" + ((bgHue+30)%360) + ", " + bgSat + "%, " + Math.max(5, bgLum-5) + "%, 0.9), #000)");
        lyricsOverlay.style.setProperty("--k-inactive", "hsl(" + bgHue + "," + Math.max(10, bgSat - 20) + "%," + Math.min(bgLum + 15, 60) + "%)");
        var accHue = (bgHue + 180) % 360;
        lyricsOverlay.style.setProperty("--k-accent", "hsl(" + accHue + ", 100%, 65%)");
      }
    }
  }

  /* ---------- karaoke engine (karaoke.js) ---------- */
  function emojiNode(key) {
    var frag = document.createDocumentFragment();
    var parts = (EMOJI_REGEX && key.match(EMOJI_REGEX)) || [key];
    for (var i = 0; i < parts.length; i++) frag.appendChild(toAppleEmoji(parts[i]));
    return frag;
  }
  var vk = null;
  (function initVK() {
    if (!window.ykVK || !karaokeStage) return;
    vk = ykVK.create(karaokeStage, {
      reduced: function () { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; },
      iconKey: function (t) { return emojiFor(t); },
      iconNode: emojiNode
    });
    var DEF = { lyric: "#ffffff", highlight: "#ff3d8b", secondary: "#d6906c" };
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem("vkSettings") || "{}"); } catch (e) {}
    var st = { style: saved.style || "visual", colors: Object.assign({}, DEF, saved.colors) };
    var bar = document.getElementById("vkSettings");
    function paint() {
      vk.setStyle(st.style); vk.setColors(st.colors);
      if (bar) {
        [].forEach.call(bar.querySelectorAll("[data-s]"), function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-s") === st.style ? "true" : "false"); });
        [].forEach.call(bar.querySelectorAll("[data-c]"), function (i) { i.value = st.colors[i.getAttribute("data-c")]; });
      }
      try { localStorage.setItem("vkSettings", JSON.stringify(st)); } catch (e) {}
    }
    window.__vkSetStyle = function (name) { st.style = name; paint(); };
    if (bar) {
      bar.addEventListener("click", function (e) {
        var b = e.target.closest("[data-s]");
        if (b) { st.style = b.getAttribute("data-s"); paint(); }
        if (e.target.closest("#vkReset")) { st = { style: "visual", colors: Object.assign({}, DEF) }; paint(); }
      });
      bar.addEventListener("input", function (e) {
        var c = e.target.getAttribute && e.target.getAttribute("data-c");
        if (c) { st.colors[c] = e.target.value; paint(); }
      });
    }
    paint();
  })();

  /* ---------- headphones toggle ---------- */
  var hpToggle = document.getElementById("hpToggle");
  function paintHeadphones() {
    if (!hpToggle) return;
    hpToggle.classList.toggle("active", headphonesOn);
    hpToggle.setAttribute("aria-pressed", headphonesOn ? "true" : "false");
  }
  function toggleHeadphones() {
    headphonesOn = !headphonesOn;
    try { localStorage.setItem("ykHeadphones", headphonesOn ? "1" : "0"); } catch (e) {}
    paintHeadphones();
  }
  if (hpToggle) hpToggle.addEventListener("click", toggleHeadphones);
  paintHeadphones();

  function updateKaraokeToggle(hasWords) {
    if (!hasWords) {
      karaokeToggle.classList.add("disabled");
      toggleKaraokeMode(false);
    } else {
      karaokeToggle.classList.remove("disabled");
      if (karaokePref) toggleKaraokeMode(true);
    }
  }

  function toggleKaraokeMode(force) {
    var isBool = typeof force === "boolean";
    var nextMode = isBool ? force : !karaokeMode;
    if (nextMode && (karaokeToggle.classList.contains("disabled") || !karaokeWordList.length)) {
      nextMode = false;
    }
    karaokeMode = nextMode;
    if (!isBool) { /* only a real toggle (click / K key) is a preference */
      karaokePref = karaokeMode;
      try { localStorage.setItem("karaokeMode", karaokeMode); } catch(e) {}
    }
    kSnapNext = true;
    karaokeToggle.classList.toggle("active", karaokeMode);
    lyricsOverlay.classList.toggle("karaoke-mode", karaokeMode);
    resetKIdle();
    lyricsClassicView.style.display = karaokeMode ? "none" : "";
    lyricsKaraokeView.style.display = karaokeMode ? "flex" : "none";
    if (!karaokeMode) {
      setLyricsPadding();
    } else {
      kActiveIdx = -1;
      if (vk) { vk.resize(); kSnapNext = true; }
    }
    if (typeof updateSyncLabel !== "undefined") updateSyncLabel();
  }
  karaokeToggle.addEventListener("click", toggleKaraokeMode);

  var syncBtn = document.getElementById("syncBtn");
  var syncLabel = document.getElementById("syncLabel");
  function doSync() {
    if (syncBtn.classList.contains("spinning")) return;
    syncBtn.classList.add("spinning");
    spInflight = false;
    pollSpotify(true, function() {
      syncBtn.classList.remove("spinning");
      syncBtn.classList.add("done");
      syncLabel.textContent = "✓";
      setTimeout(function() {
        syncBtn.classList.remove("done");
        syncLabel.textContent = restingSyncLabel();
      }, 900);
    });
  }
  syncBtn.addEventListener("click", doSync);
  /* no wheel handler on purpose: scrolling over this pill used to nudge the offset and save it, so
     one trackpad swipe could put lyrics a second or more out of sync */
  document.getElementById("syncPlus").addEventListener("click", function() { nudgeSync(50); });
  document.getElementById("syncMinus").addEventListener("click", function() { nudgeSync(-50); });

  /* karaoke lead by word source: apple syllable timings are exact; the others carry the provider
     bias this code has always applied. used whenever a track has no custom offset. */
  function autoKLead(key) {
    var entry = lyrStore.get(key || spState.key);
    var src = entry ? String(entry.wordSource || "").toLowerCase() : "";
    var prov = entry ? String(entry.calibProvider || entry.wordProvider || "").toLowerCase() : "";
    if (src === "netease" || prov === "netease") return -400;
    if (prov === "kugou" || src === "kugou") return -100;
    if (src === "apple" || prov === "apple") return 0;
    return 150;
  }
  /* resting label: "Sync" when on auto, the offset itself (tinted) when this track is nudged,
     so a shifted song can never look normal */
  function restingSyncLabel() {
    var custom = karaokeMode ? kTrackHasCustomLead : lTrackHasCustomLead;
    var v = userOffset();
    syncBtn.classList.toggle("custom", custom);
    syncBtn.title = custom ? "Offset for this song (hold to reset)" : "Resync (S)";
    return custom ? (v >= 0 ? "+" : "") + v + "ms" : (karaokeMode ? "K Sync" : "Sync");
  }
  /* what the pill shows: your tweak on top of the automatic lead (+50 means "50ms earlier") */
  function userOffset() { return karaokeMode ? kLeadMs - autoKLead() : lyrLeadMs; }
  var nudgeTimer = null;
  function updateSyncLabel(flash) {
    if (!syncLabel) return;
    if (!flash) { if (nudgeTimer) clearTimeout(nudgeTimer); syncLabel.textContent = restingSyncLabel(); return; }
    var v = userOffset();
    syncLabel.textContent = (karaokeMode ? "K " : "") + (v >= 0 ? "+" : "") + v + "ms";
    syncBtn.classList.toggle("custom", karaokeMode ? kTrackHasCustomLead : lTrackHasCustomLead);
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(function () { syncLabel.textContent = restingSyncLabel(); }, 2500);
  }

  /* +/- adjust THIS song only (saved per track; it no longer leaks into every other song) */
  function nudgeSync(delta) {
    if (!spState.key) return;
    try {
      if (karaokeMode) {
        kLeadMs = Math.max(-1000, Math.min(1000, kLeadMs + (delta > 0 ? 25 : -25)));
        kTrackHasCustomLead = true;
        localStorage.setItem("kLead:" + spState.key, kLeadMs);
      } else {
        lyrLeadMs = Math.max(-2000, Math.min(2000, lyrLeadMs + delta));
        lTrackHasCustomLead = true;
        localStorage.setItem("lLead:" + spState.key, lyrLeadMs);
      }
    } catch (e) {}
    updateSyncLabel(true);
  }
  function resetLead() {
    try {
      if (karaokeMode) { localStorage.removeItem("kLead:" + spState.key); kLeadMs = autoKLead(); kTrackHasCustomLead = false; }
      else { localStorage.removeItem("lLead:" + spState.key); lyrLeadMs = 0; lTrackHasCustomLead = false; }
    } catch (e) {}
    updateSyncLabel(true);
  }

  var syncPressTimer = null;
  syncBtn.addEventListener("mousedown", function() {
    syncPressTimer = setTimeout(function() { syncPressTimer = null; resetLead(); }, 600);
  });
  syncBtn.addEventListener("mouseup", function() {
    if (syncPressTimer) { clearTimeout(syncPressTimer); syncPressTimer = null; }
  });
  syncBtn.addEventListener("mouseleave", function() {
    if (syncPressTimer) { clearTimeout(syncPressTimer); syncPressTimer = null; }
  });
  syncBtn.addEventListener("touchstart", function() {
    syncPressTimer = setTimeout(function() { syncPressTimer = null; resetLead(); }, 600);
  }, {passive: true});
  syncBtn.addEventListener("touchend", function() {
    if (syncPressTimer) { clearTimeout(syncPressTimer); syncPressTimer = null; }
  });

  function renderSynced(lines, wordLines, durationMs) {
    lyricsHint.textContent = "";
    lyricsLines.innerHTML = "";
    karaokeWordList = [];
    var frag = document.createDocumentFragment();
    var anyHasWords = false;

    // Classic view uses 'lines'
    lines.forEach(function (ln, i) {
      var words = ln.text.split(/\s+/).filter(Boolean);
      var hasWords = !!(ln.words && ln.words.length === words.length);
      ln.hasWords = hasWords;
      
      var div = document.createElement("div");
      div.className = "lyr-line";

      if (hasWords) {
        words.forEach(function (w, j) {
          var ws = document.createElement("span");
          ws.className = "w";
          for (var k = 0; k < w.length; k++) {
            var ls = document.createElement("span");
            ls.className = "ch";
            ls.textContent = w[k];
            ws.appendChild(ls);
          }
          div.appendChild(ws);
          if (j < words.length - 1) div.appendChild(document.createTextNode(" "));
        });
      } else {
        div.textContent = ln.text;
      }
      frag.appendChild(div);
    });
    lyricsLines.appendChild(frag);

    // Karaoke view uses 'wordLines' (or lines if it has words as fallback)
    var kLines = (wordLines && wordLines.length > 0) ? wordLines : lines;
    kLines.forEach(function (ln, i) {
      var words = ln.text.split(/\s+/).filter(Boolean);
      var hasWords = !!(ln.words && ln.words.length === words.length);
      if (!hasWords) return; // skip lines without word timings
      anyHasWords = true;
      var nextLnTime = kLines[i + 1] ? kLines[i + 1].time : (ln.time + 8000);
      words.forEach(function (w, j) {
        var wStart = ln.words[j];
        var wEnd = (ln.ends && ln.ends.length === ln.words.length) ? ln.ends[j] : ((j + 1 < ln.words.length) ? ln.words[j + 1] : nextLnTime);
        if (wEnd <= wStart) wEnd = wStart + 1;
        karaokeWordList.push({ start: wStart, end: wEnd, text: w, lineIdx: i });
      });
    });

    var seenSongEmojis = {};
    karaokeWordList.forEach(function(kw) {
      var se = emojiFor(kw.text);
      if (se && !seenSongEmojis[se]) {
        seenSongEmojis[se] = true;
        var sMatches = (EMOJI_REGEX && se.match(EMOJI_REGEX)) || [se];
        for (var smi = 0; smi < sMatches.length; smi++) {
          preloadEmoji(sMatches[smi]);
        }
      }
    });
    if (vk) { vk.setWords(karaokeWordList); kSnapNext = true; }

    updateKaraokeToggle(anyHasWords);
    setLyricsPadding();
  }

  function renderPlain(plain) {
    lyricsHint.textContent = "unsynced lyrics";
    lyricsLines.innerHTML = "";
    karaokeWordList = [];
    updateKaraokeToggle(false);
    var frag = document.createDocumentFragment();
    plain.split("\n").forEach(function (t) {
      t = t.trim();
      if (!t) return;
      var div = document.createElement("div");
      div.className = "lyr-line past";
      div.textContent = t;
      frag.appendChild(div);
    });
    lyricsLines.appendChild(frag);
    setLyricsPadding();
  }

  function renderNoLyrics() {
    lyricsLines.innerHTML = "";
    karaokeWordList = [];
    updateKaraokeToggle(false);
    lyricsHint.textContent = "no lyrics found for this one";
  }

  function renderLyrEntry(key, durationMs) {
    var entry = lyrStore.get(key);
    if (!entry) return;
    lyrActiveIdx = -1; kActiveIdx = -1;
    if (!kTrackHasCustomLead) kLeadMs = autoKLead(key);
    if (entry.lines) renderSynced(entry.lines, entry.wordLines, durationMs);
    else if (entry.plain) renderPlain(entry.plain);
    else renderNoLyrics();
  }

  function fetchLyrics(title, artist, durationMs, force) {
    var key = spState.key;
    if (!key) return;
    if (!force && (lyrStore.has(key) || lyrInflight[key])) return;
    lyrInflight[key] = true;
    lyrActiveIdx = -1; kActiveIdx = -1; lyrRenderedKey = null;
    lyricsLines.innerHTML = "";
    if (vk) vk.clear();
    lyricsHint.textContent = "finding lyrics…";
    lyricsHint.style.cursor = "";
    lyricsHint.onclick = null;
    var base = "api/lyrics?artist=" + encodeURIComponent((artist || "").split(",")[0]) +
      "&title=" + encodeURIComponent(title) +
      "&duration=" + Math.round((durationMs || 0) / 1000) +
      (spState.isrc ? "&isrc=" + encodeURIComponent(spState.isrc) : "") + "&v=6";

    /* never swallow a non-ok response: a 429 must reach the rate-limit path, and a 5xx / network
       failure must NOT be cached as "this song has no lyrics". */
    function getJson(url) {
      return fetch(url).then(function (r) {
        if (r.status === 429) return { rateLimited: true };
        if (!r.ok) return { failed: true };
        return r.json();
      }).catch(function () { return { failed: true }; });
    }
    Promise.all([getJson(base + "&mode=line"), getJson(base + "&mode=word")]).then(function(results) {
      delete lyrInflight[key];
      var dLine = results[0], dWord = results[1];
      if ((dLine && dLine.rateLimited) || (dWord && dWord.rateLimited)) { var e = new Error("rate-limited"); e.rate = true; throw e; }
      if (dLine && dLine.failed && dWord && dWord.failed) throw new Error("lyrics upstream failed");
      if (dLine && dLine.failed) dLine = null;
      var wordFailed = !!(dWord && dWord.failed);
      if (wordFailed) dWord = null;

      var entry = { empty: true, wordFailed: wordFailed };
      if (dLine && dLine.lines && dLine.lines.length) {
        entry.lines = dLine.lines;
      } else if (dLine && dLine.plain) {
        entry.plain = dLine.plain;
      }
      if (dLine && dLine.source) entry.lineSource = dLine.source;
      if (dWord && dWord.lines && dWord.lines.length && dWord.wordSync) {
        entry.wordLines = dWord.lines;
        entry.wordSource = dWord.source;
        if (dWord.provider) entry.wordProvider = dWord.provider;
        entry.calibProvider = dWord.calib ? dWord.calib.provider : null;
        if (dWord.calib) entry.calib = dWord.calib;
      }

      lyrPut(key, entry);
      delete lyrTries[key]; delete lyrFailUntil[key];
      /* the line request worked but the word request blew up: try the word timings once more in the
         background so karaoke can still switch on, instead of staying line-only forever */
      if (entry.wordFailed && entry.lines) {
        setTimeout(function () {
          getJson(base + "&mode=word").then(function (dw) {
            if (dw && dw.lines && dw.lines.length && dw.wordSync) {
              entry.wordLines = dw.lines;
              entry.wordSource = dw.source;
              if (dw.provider) entry.wordProvider = dw.provider;
              entry.calibProvider = dw.calib ? dw.calib.provider : null;
              entry.wordFailed = false;
              if (spState.key === key && lyricsOverlay.classList.contains("open")) { lyrRenderedKey = null; }
            }
          });
        }, 4000);
      }

      /* the source is only known now: apply its auto lead (the track-change rule ran before the
         lyrics existed, which is how apple-timed lines ended up shown early) */
      if (spState.key === key) {
        if (!kTrackHasCustomLead) kLeadMs = autoKLead(key);
        if (!lTrackHasCustomLead) lyrLeadMs = 0;
        if (typeof updateSyncLabel !== "undefined") updateSyncLabel();
      }

      if (spState.key === key && lyricsOverlay.classList.contains("open"))
        renderLyrEntry(key, durationMs);
    }).catch(function (err) {
      delete lyrInflight[key];
      /* cooldown: lyrTick auto-fetches whenever a track has no entry, so without this a failed
         request was re-issued on the very next frame (hammering the api, and "tap to retry" could
         never stay on screen). the retry counter is per track, so the automatic retry really
         happens once instead of looping every 2.5s forever. */
      var tries = lyrTries[key] || 0;
      if (!err.rate && tries < 1 && lyricsOverlay.classList.contains("open")) {
        lyrTries[key] = tries + 1;
        lyrFailUntil[key] = Date.now() + 3500;
        lyricsHint.textContent = "retrying…";
        setTimeout(function () {
          if (lyricsOverlay.classList.contains("open") && spState.key === key && !lyrStore.has(key))
            fetchLyrics(title, artist, durationMs, true);
        }, 2500);
        return;
      }
      lyrFailUntil[key] = Infinity; /* stay failed until the user taps */
      lyricsLines.innerHTML = "";
      lyricsHint.textContent = err.rate ? "too many requests — tap to retry" : "couldn't load lyrics — tap to retry";
      lyricsHint.style.cursor = "pointer";
      lyricsHint.onclick = function () {
        lyricsHint.style.cursor = "";
        lyricsHint.onclick = null;
        delete lyrFailUntil[key]; delete lyrTries[key];
        fetchLyrics(title, artist, durationMs, true);
      };
    });
  }

  var lastHeaderKey = null;
  function setLyricsHeader() {
    if (lastHeaderKey === spState.key) return;
    lastHeaderKey = spState.key;
    lyricsTitle.textContent = spState.title || "";
    if (spState.trackUrl) {
      lyricsTitle.setAttribute("href", spState.trackUrl);
    } else {
      lyricsTitle.removeAttribute("href");
    }
    lyricsArtist.textContent = "";
    (spState.artists || []).forEach(function (a, i) {
      if (i > 0) {
        lyricsArtist.appendChild(document.createTextNode(", "));
      }
      var link = document.createElement("a");
      link.textContent = a.name;
      if (a.url) { link.href = a.url; link.target = "_blank"; link.rel = "noopener"; }
      lyricsArtist.appendChild(link);
    });
    if (spState.image) {
      lyricsArt.src = spState.image;
      lyricsBg.style.backgroundImage = "url(" + spState.image + ")";
      if (kTopCover) kTopCover.src = spState.image;
      if (kTopTitle) kTopTitle.textContent = spState.title || "";
      if (kTopArtist) kTopArtist.textContent = spState.artist || "";
      extractDominantColors(spState.image);
    }
  }

  function lyrProgress() {
    if (!spState.durationMs) return;
    var pos = Math.min(lyrPos(), spState.durationMs);
    var p = (pos / spState.durationMs * 100) + "%";
    lyricsProg.style.width = p;
    if (kTopProg) kTopProg.style.width = p;
  }

  function setLyricsPadding() {
    var h = lyricsLines.clientHeight / 2;
    lyricsLines.style.paddingTop = h + "px";
    lyricsLines.style.paddingBottom = h + "px";
  }

  function findKaraokeIndex(pos, hint) {
    var n = karaokeWordList.length;
    if (!n) return -1;
    var i = hint < 0 ? 0 : hint >= n ? n - 1 : hint;
    if (pos >= karaokeWordList[i].start) {
      while (i + 1 < n && karaokeWordList[i + 1].start <= pos) i++;
      return i;
    }
    var lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (karaokeWordList[mid].start <= pos) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function lyrTick() {
    if (!lyricsOverlay.classList.contains("open")) return;
    
    var now = performance.now();
    var dt = Math.max(0, Math.min(now - (kLastFrameTime || now), 100));
    kLastFrameTime = now;
    
    lyrProgress();
    if (typeof updatePlaybackUI === "function") updatePlaybackUI();
    var key = spState.key;
    if (!key) return;
    if (!lyrStore.has(key)) {
      if (!lyrInflight[key] && !(lyrFailUntil[key] > Date.now())) {
        setLyricsHeader();
        fetchLyrics(spState.title, spState.artist, spState.durationMs);
      }
      return;
    }
    if (lyrRenderedKey !== key) {
      setLyricsHeader();
      renderLyrEntry(key, spState.durationMs);
      lyrRenderedKey = key;
      karaokeToggle.classList.toggle("active", karaokeMode);
      lyricsOverlay.classList.toggle("karaoke-mode", karaokeMode);
      lyricsClassicView.style.display = karaokeMode ? "none" : "";
      lyricsKaraokeView.style.display = karaokeMode ? "flex" : "none";
      return;
    }

    var pos = lyrPos() + (karaokeMode ? kLeadMs : lyrLeadMs) + (headphonesOn ? HEADPHONES_MS : 0);
    var entry = lyrStore.get(key);

    if (Math.abs(lyrPos() - kLastLyrPos) > 1500) kSnapNext = true;
    kLastLyrPos = lyrPos();

    if (karaokeMode && karaokeWordList.length > 0) {
      if (entry && entry.calib && !entry._logged) {
        console.info("[karaoke] provider=" + entry.calib.provider + " ref=" + entry.calib.ref + " offset=" + entry.calib.offsetMs + "ms mad=" + entry.calib.mad + " conf=" + entry.calib.confidence + " kLead=" + kLeadMs);
        entry._logged = true;
        var dbg = document.getElementById("kDebugLabel");
        if (!dbg) {
          dbg = document.createElement("div");
          dbg.id = "kDebugLabel";
          dbg.style.cssText = "position:fixed;bottom:10px;right:10px;font-size:10px;color:rgba(255,255,255,0.5);z-index:9999;display:none;pointer-events:none;";
          document.body.appendChild(dbg);
        }
        dbg.textContent = "[karaoke] p=" + entry.calib.provider + " r=" + entry.calib.ref + " off=" + entry.calib.offsetMs + " mad=" + entry.calib.mad + " conf=" + entry.calib.confidence + " lead=" + kLeadMs;
      }
    
      if (vk) { vk.update(pos, dt, kSnapNext); kSnapNext = false; }
      kActiveIdx = findKaraokeIndex(pos, kActiveIdx);
    } else if (karaokeMode && karaokeWordList.length === 0) {
      toggleKaraokeMode(false);
    } else if (!karaokeMode && entry.lines) {
      var lines = entry.lines;
      var idx = findLyricIndex(lines, pos, lyrActiveIdx);
      if (idx !== lyrActiveIdx) {
        var kids = lyricsLines.children;
        if (lyrActiveIdx >= 0 && kids[lyrActiveIdx]) kids[lyrActiveIdx].className = "lyr-line past";
        if (idx >= 0 && kids[idx]) {
          kids[idx].className = "lyr-line active";
          if (Date.now() - lyrUserScrollAt > 3000) {
            var _el = kids[idx];
            var scrollTarget = _el.offsetTop + _el.offsetHeight / 2 - lyricsLines.clientHeight / 2;
            lyricsLines.scrollTo({ top: Math.max(0, scrollTarget), behavior: "smooth" });
          }
        }
        lyrActiveIdx = idx;
      }
      if (idx >= 0 && lyricsLines.children[idx]) {
        var line = lines[idx];
        if (line.hasWords) {
          var wordEls = lyricsLines.children[idx].querySelectorAll(".w");
          var wt = line.words || [];
          var _nl = lines[idx + 1];
          var _lineEnd = _nl ? _nl.time : (line.time + 8000);
          for (var j = 0; j < wordEls.length; j++) {
            var wStart = wt[j] || 0;
            var wEnd = j + 1 < wt.length ? wt[j + 1] : _lineEnd;
            if (!(wEnd > wStart)) wEnd = wStart + 1;
            var chEls = wordEls[j].querySelectorAll(".ch");
            var _n = chEls.length;
            for (var k = 0; k < _n; k++) {
              var _on = pos >= wStart + (wEnd - wStart) * (k / _n);
              var _el = chEls[k];
              if (_el.classList.contains("lit") !== _on) _el.classList.toggle("lit", _on);
            }
          }
        }
      }
    }
  }

  /* ---------- 11c. continuous sync loop ---------- */
  function startSyncLoop() {
    bumpLoop("sync");
    var gen = loopGen("sync");
    (function loop() {
      if (loopGen("sync") !== gen) return; /* superseded by a restart */
      loopTick("sync");
      
      if (spState.playing && spState.durationMs) {
        var p = playbackClock.getProgressMs();
        if (p >= spState.durationMs && !spInflight) {
          pollSpotify(true); /* track ended */
        }
      }

      if (lyricsOverlay && lyricsOverlay.classList.contains("open")) {
        lyrTick();
      }

      requestAnimationFrame(loop);
    })();
  }
  startSyncLoop();
  function logout() {
    window.location.href = "api/auth/logout";
  }
  document.getElementById("lyricsClose").addEventListener("click", logout);
  document.addEventListener("keydown", function (e) {
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key === "k" || e.key === "K") && lyricsOverlay.classList.contains("open")) toggleKaraokeMode();
    if ((e.key === "s" || e.key === "S") && lyricsOverlay.classList.contains("open")) doSync();
    if ((e.key === "h" || e.key === "H") && lyricsOverlay.classList.contains("open")) toggleHeadphones();
    if (karaokeMode && lyricsOverlay.classList.contains("open") && window.ykVK && window.__vkSetStyle && e.key >= "1" && e.key <= "4") window.__vkSetStyle(ykVK.STYLES[+e.key - 1]);
    if ((e.key === "d" || e.key === "D") && lyricsOverlay.classList.contains("open")) {
       var dbg = document.getElementById("kDebugLabel");
       if (dbg) dbg.style.display = dbg.style.display === "none" ? "block" : "none";
    }
  });
  lyricsLines.addEventListener("wheel", function () { lyrUserScrollAt = Date.now(); }, { passive: true });
  lyricsLines.addEventListener("touchmove", function () { lyrUserScrollAt = Date.now(); }, { passive: true });
  window.addEventListener("resize", function () {
    if (lyricsOverlay.classList.contains("open") && spState.key && lyrStore.get(spState.key) && lyrStore.get(spState.key).lines) {
      setLyricsPadding();
    }
  });



  /* ---------- playback controls ---------- */
  var pbTime = document.getElementById("pbTime"),
      pbTimeK = document.getElementById("pbTimeK"),
      playbackControls = document.getElementById("playbackControls"),
      playbackControlsK = document.getElementById("playbackControlsK");

  function fmtMs(ms) {
    ms = Math.max(0, Math.round(ms || 0));
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }

  // hidden entirely for non-premium accounts (controls don't work for free tier)
  function updatePlaybackVisibility() {
    var show = isPremium && loggedIn;
    if (playbackControls) playbackControls.hidden = !show;
    if (playbackControlsK) playbackControlsK.hidden = !show;
  }

  function updatePlaybackUI() {
    var pos = playbackClock.getProgressMs();
    var dur = spState.durationMs || 0;
    var t = fmtMs(Math.min(pos, dur)) + " / " + fmtMs(dur);
    if (pbTime) pbTime.textContent = t;
    if (pbTimeK) pbTimeK.textContent = t;
    var playing = !!spState.playing;
    var btns = document.querySelectorAll(".pb-play");
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var icPlay = btn.querySelector(".ic-play");
      var icPause = btn.querySelector(".ic-pause");
      if (icPlay) icPlay.style.display = playing ? "none" : "";
      if (icPause) icPause.style.display = playing ? "" : "none";
      btn.setAttribute("aria-label", playing ? "pause" : "play");
    }
  }

  function playbackAction(action) {
    fetch("api/playback?action=" + encodeURIComponent(action), { method: "POST", cache: "no-store" })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (d) {
          return { status: r.status, d: d };
        });
      })
      .then(function (res) {
        if (res.status === 403) {
          lyricsHint.textContent = "playback controls need spotify premium";
          return;
        }
        if (res.status === 404) {
          lyricsHint.textContent = "no active spotify device — start playback in the spotify app first";
          return;
        }
        if (res.status === 401) { showLanding(); return; }
        setTimeout(function () { pollSpotify(true); }, 450);
      })
      .catch(function () {});
  }

  [["pbPrev", "previous"], ["pbPlay", null], ["pbNext", "next"],
   ["pbPrevK", "previous"], ["pbPlayK", null], ["pbNextK", "next"]].forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    if (!el) return;
    el.addEventListener("click", function () {
      // play button toggles based on current state
      var action = pair[1] || (spState.playing ? "pause" : "play");
      playbackAction(action);
    });
  });

  /* ---------- views + boot ---------- */
  function showLanding(errMsg) {
    loggedIn = false;
    if (spPollTimer) { clearTimeout(spPollTimer); spPollTimer = null; }
    lyricsOverlay.classList.remove("open");
    lyricsOverlay.setAttribute("aria-hidden", "true");
    landingView.style.display = "";
    if (errMsg && landingErr) landingErr.textContent = errMsg;
    updatePlaybackVisibility();
  }

  function showLyrics(premium) {
    loggedIn = true;
    if (typeof premium === "boolean") isPremium = premium;
    landingView.style.display = "none";
    lyricsOverlay.classList.add("open");
    lyricsOverlay.setAttribute("aria-hidden", "false");
    karaokeToggle.classList.toggle("active", karaokeMode);
    lyricsOverlay.classList.toggle("karaoke-mode", karaokeMode);
    lyricsClassicView.style.display = karaokeMode ? "none" : "";
    lyricsKaraokeView.style.display = karaokeMode ? "flex" : "none";
    updatePlaybackVisibility();
    paintHeadphones();
    resetKIdle();
    pollSpotify(true);
  }

  // surface oauth errors (?error=...) on the landing page
  (function () {
    try {
      var q = new URLSearchParams(window.location.search);
      var err = q.get("error");
      if (err && landingErr) {
        var msgs = {
          auth: "spotify login was cancelled — try again",
          bad_state: "login session expired — try again",
          token_exchange: "couldn't finish spotify login — try again"
        };
        landingErr.textContent = msgs[err] || "login failed — try again";
      }
    } catch (e) {}
  })();

  fetch("api/auth/status", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (s) {
      if (s && s.loggedIn) showLyrics(!!s.premium);
      else showLanding();
    })
    .catch(function () { showLanding(); });

})();
