/* ============================================================
   lyrics — standalone synced-lyrics + karaoke app
   frontend logic adapted from the yoshik.xyz lyrics overlay:
   same sync engine, same karaoke rendering, same lyrics pipeline.
   differences: per-user spotify oauth (no server token), the overlay
   is the whole page, karaoke defaults on, offset defaults to 0ms.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- element refs ---------- */
  var landingView = document.getElementById("landingView"),
      landingErr = document.getElementById("landingErr"),
      lyricsOverlay = document.getElementById("lyricsOverlay");

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

    if (d && d.deviceId && d.deviceId !== spState.deviceId) {
      spState.deviceId = d.deviceId;
      spState.deviceType = d.deviceType || "Device";
      try {
        var saved = localStorage.getItem("lyrLead:" + d.deviceId);
        var _p = saved ? parseInt(saved, 10) : NaN;
        lyrLeadMs = isNaN(_p) ? 0 : _p;
      } catch (e) {}
      if (typeof updateSyncLabel !== "undefined") updateSyncLabel();
    } else if (d && !d.deviceId) {
      spState.deviceId = null;
      spState.deviceType = null;
    }

    if (lyricsOverlay.classList.contains("open")) {
      setLyricsHeader();
      if (isNewTrack) {
        kSnapNext = true;
        try {
          var ksaved = localStorage.getItem("kLead:" + key);
          if (ksaved !== null) {
            kLeadMs = parseInt(ksaved, 10) || 0;
            kTrackHasCustomLead = true;
          } else {
            kLeadMs = parseInt(localStorage.getItem("kLeadMs"), 10) || 0;
            kTrackHasCustomLead = false;
          }
        } catch (e) {}
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
    var epoch = key + "|" + !!s.d.playing;
    var newTrack = key !== spClockKey;
    spClockKey = key;
    if (hard || newTrack || !s.d.playing || !playbackClock.isPlaying()) {
      playbackClock.hardSet(s.pos, s.at, !!s.d.playing);
      spWin = s.d.playing ? [s] : [];
      spEpoch = epoch;
      return newTrack ? "newtrack" : "reset";
    }
    if (epoch !== spEpoch) { spWin = []; spEpoch = epoch; }
    spWin.push(s);
    if (spWin.length > SYNC.WINDOW) spWin.shift();
    var now = performance.now();
    return playbackClock.correct(envelopeTarget(spWin, now));
  }
  function handleSample(d, tSend, tArr, hardSync) {
    if (!d) { scheduleNext(); return; }
    if (d.rateLimited) { scheduleNext(Math.max(6000, (d.retryAfter || 6) * 1000)); return; }
    var s = sampleFrom(d, tSend, tArr);
    var key = d.trackId || (d.title ? (d.title + " :: " + d.artist) : null);
    var isNewTrack = key !== spClockKey;
    var curPos = playbackClock.getProgressMs();
    var seeked = Math.abs(s.pos - curPos) > 2000;
    var _hard = !!(hardSync || isNewTrack || seeked);
    if (_hard) spLastActivity = performance.now();
    renderSpotify(d);
    applySample(s, _hard);
    scheduleNext();
  }
  document.addEventListener("visibilitychange", function() {
    if (!document.hidden && loggedIn) {
      pollSpotify(true);
    }
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
    EMOJI_REGEX = new RegExp("\\p{Extended_Pictographic}(\\uFE0F|\\u200D\\p{Extended_Pictographic}|\\p{Emoji_Modifier})*", "gu");
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
  var lyrLeadMs = 0;
  var kLeadMs = 0;
  try {
    var _l2 = localStorage.getItem("lyrLeadMs");
    if (_l2 !== null) lyrLeadMs = parseInt(_l2, 10) || 0;

    var _k = localStorage.getItem("kLeadMs");
    if (_k !== null) kLeadMs = parseInt(_k, 10) || 0;
  } catch (e) {}
  // Provider-specific default offsets (exact spec, do not tune).
  // Line mode: Apple -150ms, all others +400ms.
  // Karaoke mode: Apple -150ms, Kugou -100ms, Netease -400ms, all others +150ms.
  function providerDefaultLead(source, provider, karaoke) {
    var src = String(source || "").toLowerCase();
    var prov = String(provider || "").toLowerCase();
    if (karaoke) {
      if (src === "apple") return -150;
      if (prov === "kugou" || src === "kugou") return -100;
      if (src === "netease") return -400;
      return 150;
    }
    if (src === "apple") return -150;
    return 400;
  }
  var karaokeMode = true;
  try { karaokeMode = localStorage.getItem("karaokeMode") !== "false"; } catch(e) {}
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

  function extractDominantColors(imgSrc) {
    var img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = function() {
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
    };
    img.src = imgSrc;
  }

  function updateKaraokeToggle(hasWords) {
    if (!hasWords) {
      karaokeToggle.classList.add("disabled");
      toggleKaraokeMode(false);
    } else {
      karaokeToggle.classList.remove("disabled");
      if (karaokeMode) toggleKaraokeMode(true);
    }
  }

  function toggleKaraokeMode(force) {
    var isBool = typeof force === "boolean";
    var nextMode = isBool ? force : !karaokeMode;
    if (nextMode && (karaokeToggle.classList.contains("disabled") || !karaokeWordList.length)) {
      nextMode = false;
    }
    karaokeMode = nextMode;
    try { localStorage.setItem("karaokeMode", karaokeMode); } catch(e) {}
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
        syncLabel.textContent = "Sync";
      }, 900);
    });
  }
  syncBtn.addEventListener("click", doSync);
  syncBtn.addEventListener("wheel", function(e) {
    e.preventDefault();
    if (e.deltaY < 0) nudgeSync(50);
    else if (e.deltaY > 0) nudgeSync(-50);
  }, { passive: false });
  document.getElementById("syncPlus").addEventListener("click", function() { nudgeSync(50); });
  document.getElementById("syncMinus").addEventListener("click", function() { nudgeSync(-50); });
  
  var nudgeTimer = null;
  function updateSyncLabel() {
    var sl = document.getElementById("syncLabel");
    if (!sl) return;
    if (karaokeMode) {
      sl.textContent = "K " + (kLeadMs >= 0 ? "+" : "") + kLeadMs + "ms";
    } else {
      sl.textContent = (lyrLeadMs >= 0 ? "+" : "") + lyrLeadMs + "ms";
    }
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(function() { sl.textContent = karaokeMode ? "K Sync" : "Sync"; }, 2500);
  }

  function nudgeSync(delta) {
    if (karaokeMode) {
      kLeadMs += delta > 0 ? 25 : -25;
      if (kLeadMs > 1000) kLeadMs = 1000;
      if (kLeadMs < -1000) kLeadMs = -1000;
      try {
        localStorage.setItem("kLead:" + spState.key, kLeadMs);
        if (!kTrackHasCustomLead) {
          localStorage.setItem("kLeadMs", kLeadMs);
        }
        kTrackHasCustomLead = true;
      } catch(e) {}
    } else {
      lyrLeadMs += delta;
      if (lyrLeadMs > 2000) lyrLeadMs = 2000;
      if (lyrLeadMs < -2000) lyrLeadMs = -2000;
      try {
        localStorage.setItem("lyrLeadMs", lyrLeadMs);
        if (spState.deviceId) localStorage.setItem("lyrLead:" + spState.deviceId, lyrLeadMs);
      } catch(e) {}
    }
    updateSyncLabel();
  }
  
  var syncPressTimer = null;
  syncBtn.addEventListener("mousedown", function() {
    if (!karaokeMode) return;
    syncPressTimer = setTimeout(function() {
      syncPressTimer = null;
      try {
        localStorage.removeItem("kLead:" + spState.key);
        kLeadMs = parseInt(localStorage.getItem("kLeadMs"), 10) || 0;
        kTrackHasCustomLead = false;
        updateSyncLabel();
      } catch(e) {}
    }, 600);
  });
  syncBtn.addEventListener("mouseup", function() {
    if (syncPressTimer) { clearTimeout(syncPressTimer); syncPressTimer = null; }
  });
  syncBtn.addEventListener("mouseleave", function() {
    if (syncPressTimer) { clearTimeout(syncPressTimer); syncPressTimer = null; }
  });
  syncBtn.addEventListener("touchstart", function() {
    if (!karaokeMode) return;
    syncPressTimer = setTimeout(function() {
      syncPressTimer = null;
      try {
        localStorage.removeItem("kLead:" + spState.key);
        kLeadMs = parseInt(localStorage.getItem("kLeadMs"), 10) || 0;
        kTrackHasCustomLead = false;
        updateSyncLabel();
      } catch(e) {}
    }, 600);
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

    if (kTapeCol) kTapeCol.innerHTML = "";
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
    var kFrag2 = document.createDocumentFragment();
    var seed = 42;
    var kPrev = [], kCurr = [], kLastLine = -1;
    karaokeWordList.forEach(function(word, idx) {
       if (word.lineIdx !== kLastLine) {
         kPrev = kCurr;
         kCurr = [];
         kLastLine = word.lineIdx;
       }
       var div = document.createElement("div");
       div.className = "k-tape-word";
       div.textContent = word.text;
       var e = emojiFor(word.text);
       if (e && kCurr.length < 2 && kCurr.indexOf(e) === -1 && kPrev.indexOf(e) === -1) {
         kCurr.push(e);
         var emo = document.createElement("span");
         emo.className = "emo";
         var eMatches = (EMOJI_REGEX && e.match(EMOJI_REGEX)) || [e];
         for (var emi = 0; emi < eMatches.length; emi++) {
           emo.appendChild(toAppleEmoji(eMatches[emi]));
         }
         div.appendChild(emo);
       }
       seed = (seed * 9301 + 49297) % 233280; var rand1 = seed / 233280;
       seed = (seed * 9301 + 49297) % 233280; var rand2 = seed / 233280;
       var rot = -3 + rand1 * 6;
       div.style.setProperty("--rot", rot + "deg");
       if (rand2 < 0.16) div.classList.add("font-bubbly");
       
       var tl_x = rand1 * 4, tl_y = rand2 * 4;
       seed = (seed * 9301 + 49297) % 233280; var r3 = seed / 233280;
       seed = (seed * 9301 + 49297) % 233280; var r4 = seed / 233280;
       var tr_x = 100 - r3 * 4, tr_y = r4 * 4;
       seed = (seed * 9301 + 49297) % 233280; var r5 = seed / 233280;
       seed = (seed * 9301 + 49297) % 233280; var r6 = seed / 233280;
       var br_x = 100 - r5 * 4, br_y = 100 - r6 * 4;
       seed = (seed * 9301 + 49297) % 233280; var r7 = seed / 233280;
       seed = (seed * 9301 + 49297) % 233280; var r8 = seed / 233280;
       var bl_x = r7 * 4, bl_y = 100 - r8 * 4;
       var clip = "polygon(" + tl_x + "% " + tl_y + "%, " + tr_x + "% " + tr_y + "%, " + br_x + "% " + br_y + "%, " + bl_x + "% " + bl_y + "%)";
       div.style.setProperty("--clip", clip);
       word.el = div;
       kFrag2.appendChild(div);
    });
    if (kTapeCol) {
      kTapeCol.appendChild(kFrag2);
      kTapeCol.style.transform = "translateY(0px)";
    }

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
    // Apply provider defaults on cache-hit too (if user hasn't customized).
    if (!kTrackHasCustomLead && entry.wordSource) {
      kLeadMs = providerDefaultLead(entry.wordSource, entry.wordProvider, true);
    }
    try {
      var _devCustom = spState.deviceId ? localStorage.getItem("lyrLead:" + spState.deviceId) : null;
      if (_devCustom === null && entry.lineSource) {
        lyrLeadMs = providerDefaultLead(entry.lineSource, null, false);
      }
    } catch (e) {}
    if (entry.lines) renderSynced(entry.lines, entry.wordLines, durationMs);
    else if (entry.plain) renderPlain(entry.plain);
    else renderNoLyrics();
  }

  var lyrLastQuery = null;
  function fetchLyrics(title, artist, durationMs, force) {
    var key = spState.key;
    if (!key) return;
    if (!force && (lyrStore.has(key) || lyrInflight[key])) return;
    lyrInflight[key] = true;
    lyrLastQuery = { title: title, artist: artist, durationMs: durationMs, retried: false };
    lyrActiveIdx = -1; kActiveIdx = -1; lyrRenderedKey = null;
    lyricsLines.innerHTML = "";
    if (kTapeCol) kTapeCol.innerHTML = "";
    lyricsHint.textContent = "finding lyrics…";
    lyricsHint.style.cursor = "";
    lyricsHint.onclick = null;
    var base = "api/lyrics?artist=" + encodeURIComponent((artist || "").split(",")[0]) +
      "&title=" + encodeURIComponent(title) +
      "&duration=" + Math.round((durationMs || 0) / 1000) + "&v=4";
      
    Promise.all([
      fetch(base + "&mode=line").then(function(r) { return r.ok ? r.json() : null; }),
      fetch(base + "&mode=word").then(function(r) { return r.ok ? r.json() : null; })
    ]).then(function(results) {
      delete lyrInflight[key];
      var dLine = results[0], dWord = results[1];
      if (dLine && dLine.error && dLine.error === "rate-limited") { var e = new Error("rate-limited"); e.rate = true; throw e; }
      
      var entry = { empty: true };
      if (dLine && dLine.lines && dLine.lines.length) {
        entry.lines = dLine.lines;
      } else if (dLine && dLine.plain) {
        entry.plain = dLine.plain;
      }
      
      if (dWord && dWord.lines && dWord.lines.length && dWord.wordSync) {
        entry.wordLines = dWord.lines;
      }
      // Record provider sources for default-offset lookup.
      // Line view uses the line-mode winner; karaoke uses the word-mode winner.
      if (dLine && dLine.source) entry.lineSource = dLine.source;
      if (dWord && dWord.source) {
        entry.wordSource = dWord.source;
        if (dWord.provider) entry.wordProvider = dWord.provider;
        if (dWord.calib) entry.calib = dWord.calib;
      }

      // Apply provider-specific default offsets (unless the user customized).
      // Karaoke: track-level custom wins; otherwise provider default.
      if (!kTrackHasCustomLead) {
        kLeadMs = providerDefaultLead(entry.wordSource, entry.wordProvider, true);
      }
      // Line mode: device-level custom wins; otherwise provider default.
      // (Device custom is checked in renderSpotify; here we set the fallback.)
      try {
        var _devCustom = spState.deviceId ? localStorage.getItem("lyrLead:" + spState.deviceId) : null;
        if (_devCustom === null) {
          lyrLeadMs = providerDefaultLead(entry.lineSource, null, false);
        }
      } catch (e) {}

      lyrPut(key, entry);
      if (spState.key === key && lyricsOverlay.classList.contains("open"))
        renderLyrEntry(key, durationMs);
    }).catch(function (err) {
      delete lyrInflight[key];
      var lq = lyrLastQuery;
      if (!err.rate && lq && !lq.retried && lyricsOverlay.classList.contains("open")) {
        lq.retried = true;
        lyricsHint.textContent = "retrying…";
        setTimeout(function () {
          if (lyricsOverlay.classList.contains("open") && spState.key === key && !lyrStore.has(key))
            fetchLyrics(title, artist, durationMs, true);
        }, 2500);
        return;
      }
      lyricsLines.innerHTML = "";
      lyricsHint.textContent = err.rate ? "too many requests — tap to retry" : "couldn't load lyrics — tap to retry";
      lyricsHint.style.cursor = "pointer";
      lyricsHint.onclick = function () {
        lyricsHint.style.cursor = "";
        lyricsHint.onclick = null;
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
      if (!lyrInflight[key]) {
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

    var pos = lyrPos() + (karaokeMode ? kLeadMs : lyrLeadMs);
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
    
      var kidx = findKaraokeIndex(pos, kActiveIdx);
      if (kidx !== kActiveIdx) {
        if (kActiveIdx >= 0 && karaokeWordList[kActiveIdx] && karaokeWordList[kActiveIdx].el) {
          karaokeWordList[kActiveIdx].el.classList.remove("active", "k-rest");
        }
        kActiveIdx = kidx;
        if (kidx >= 0 && karaokeWordList[kidx] && karaokeWordList[kidx].el) {
          var word = karaokeWordList[kidx];
          if (karaokeStage && kTapeCol) {
            var wW = word.el.scrollWidth;
            var maxW = window.innerWidth * 0.9;
            if (wW > maxW) {
              word.el.style.setProperty("--scale", (maxW / wW));
            } else {
              word.el.style.setProperty("--scale", "1");
            }
          }
        }
      }
      
      if (kidx >= 0 && karaokeWordList[kidx] && karaokeWordList[kidx].el) {
         var cw = karaokeWordList[kidx];
         var nw = karaokeWordList[kidx + 1];
         var nStart = nw ? nw.start : Infinity;
         var inGap = pos >= cw.end + 120 && (nStart - cw.end) > 400;
         cw.el.classList.toggle("active", !inGap);
         cw.el.classList.toggle("k-rest", inGap);
      }
      
      if (karaokeStage && kTapeCol) {
         var lookPos = pos + 60;
         var lookIdx = findKaraokeIndex(lookPos, kActiveIdx);
         if (lookIdx >= 0 && karaokeWordList[lookIdx] && karaokeWordList[lookIdx].el) {
             var tgtWord = karaokeWordList[lookIdx];
             var targetY = tgtWord.el.offsetTop + tgtWord.el.offsetHeight / 2 - karaokeStage.offsetHeight / 2;
             
             if (Math.abs(targetY - kCamY) > 1.5 * karaokeStage.offsetHeight) kSnapNext = true;
             if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) kSnapNext = true;
             
             if (kSnapNext) {
               kCamY = targetY;
               kSnapNext = false;
             } else {
               kCamY += (targetY - kCamY) * (1 - Math.exp(-dt / 45));
             }
             kTapeCol.style.transform = "translate3d(0, " + (-kCamY) + "px, 0)";
         }
      }

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
  var karaokeFontsLoaded = false;
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
