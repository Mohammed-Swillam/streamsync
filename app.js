(function () {
  "use strict";

  var S = window.StreamSync;
  var POLL_MS = 2500;
  var HEARTBEAT_MS = 12000;
  var UID_KEY = "streamsync:uid";
  var NAME_KEY = "streamsync:name";
  var SOUND_KEY = "streamsync:sound";
  var SESSION_KEY = "streamsync:session";

  var state = {
    userId: "",
    name: "",
    roomId: "",
    matchSecondsAtAnchor: 0,
    anchorTimestamp: Date.now(),
    isPaused: false,
    participants: {},
    soundEnabled: false,
    netState: "offline",
    lastGoodSync: 0,
    claimExpiredRoom: false,
    exiting: false,
    roomCreatedAt: 0,
    rosterGeneration: 0
  };

  var tickTimer = null;
  var pollTimer = null;
  var heartbeatTimer = null;
  var pollInFlight = false;
  var rosterInFlight = null;
  var rosterInFlightRoom = "";
  var publishEpoch = 0;
  var announceTimer = null;
  var eventSource = null;
  var broadcast = null;
  var audioCtx = null;
  var joinClock = null;
  var exactClock = null;
  var joinFollow = null;
  var joinFollowLocked = false;
  var joinFollowTicker = null;
  var peekTimer = null;
  var DEFAULT_JOIN_HINT = "Look at the TV timer. Use + / −, or tap the digits and type 1040 for 10:40.";

  function $(id) {
    return document.getElementById(id);
  }

  function createScorebug(root, options) {
    var total = 0;
    var minEl = root.querySelector(".scorebug-digits[data-part='min']");
    var secEl = root.querySelector(".scorebug-digits[data-part='sec']");
    var typeEl = root.querySelector(".scorebug-type");
    var holdTimer = null;
    var holdDelay = null;
    options = options || {};

    function notifyUser() {
      if (options.onUserChange) options.onUserChange(get());
    }

    function render() {
      var parts = S.splitClock(total);
      minEl.textContent = String(parts.minutes).padStart(2, "0");
      secEl.textContent = String(parts.seconds).padStart(2, "0");
      root.setAttribute("data-total", String(parts.total));
    }

    function set(seconds, opts) {
      total = S.splitClock(seconds).total;
      typeEl.value = "";
      root.classList.remove("is-typing");
      render();
      if (!opts || !opts.silent) notifyUser();
    }

    function get() {
      return S.splitClock(total).total;
    }

    function step(part, delta) {
      total = S.stepClock(total, part, delta);
      typeEl.value = "";
      root.classList.remove("is-typing");
      render();
      notifyUser();
    }

    function clearTextSelection() {
      var sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    }

    function stopHold() {
      clearTimeout(holdDelay);
      clearInterval(holdTimer);
      holdDelay = null;
      holdTimer = null;
    }

    root.addEventListener("selectstart", function (event) {
      event.preventDefault();
    });
    root.addEventListener("contextmenu", function (event) {
      event.preventDefault();
    });

    root.querySelectorAll(".scorebug-step").forEach(function (btn) {
      var part = btn.getAttribute("data-part");
      var delta = parseInt(btn.getAttribute("data-delta"), 10);
      function run() {
        step(part, delta);
        clearTextSelection();
      }
      function startHold(event) {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        clearTextSelection();
        if (btn.setPointerCapture && event.pointerId != null) {
          btn.setPointerCapture(event.pointerId);
        }
        run();
        holdDelay = setTimeout(function () {
          holdTimer = setInterval(run, 75);
        }, 360);
      }
      btn.addEventListener("pointerdown", startHold);
      btn.addEventListener("touchstart", function (event) {
        event.preventDefault();
      }, { passive: false });
      btn.addEventListener("pointerup", stopHold);
      btn.addEventListener("pointercancel", stopHold);
      btn.addEventListener("lostpointercapture", stopHold);
    });

    root.querySelectorAll(".scorebug-digits").forEach(function (btn) {
      btn.addEventListener("click", function () {
        typeEl.focus();
        typeEl.click();
      });
    });

    typeEl.addEventListener("focus", function () {
      root.classList.add("is-typing");
      typeEl.value = "";
    });

    typeEl.addEventListener("input", function () {
      var raw = typeEl.value.replace(/\D/g, "").slice(0, 5);
      typeEl.value = raw;
      if (raw) total = S.parseTypedClock(raw);
      render();
      if (raw) notifyUser();
    });

    typeEl.addEventListener("blur", function () {
      root.classList.remove("is-typing");
      typeEl.value = "";
      render();
    });

    root.querySelectorAll(".scorebug-presets [data-preset]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        set(parseInt(btn.getAttribute("data-preset"), 10));
      });
    });

    render();
    return { set: set, get: get };
  }

  function showToast(message) {
    var region = $("toastRegion");
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    region.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 3200);
  }

  function playTone(freq) {
    if (!state.soundEnabled) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.frequency.value = freq || 440;
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
      osc.stop(audioCtx.currentTime + 0.09);
    } catch (err) {}
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (err) {}
  }

  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (err) {}
  }

  function getUserId() {
    var existing = storageGet(UID_KEY);
    if (!existing) {
      try { existing = sessionStorage.getItem(UID_KEY); } catch (err) {}
    }
    if (existing && existing.length >= 6) {
      storageSet(UID_KEY, existing);
      return existing;
    }
    var id = S.makeUserId();
    storageSet(UID_KEY, id);
    return id;
  }

  function persistName(name) {
    storageSet(NAME_KEY, name);
  }

  function persistSession() {
    if (!state.roomId || !state.name) return;
    var session = S.buildSession({
      roomId: state.roomId,
      name: state.name,
      matchSecondsAtAnchor: state.matchSecondsAtAnchor,
      anchorTimestamp: state.anchorTimestamp,
      isPaused: state.isPaused,
      roomCreatedAt: state.roomCreatedAt
    });
    if (!session) return;
    storageSet(SESSION_KEY, JSON.stringify(session));
  }

  function rememberRoomCreatedAt(createdAt) {
    createdAt = Math.floor(Number(createdAt) || 0);
    if (!createdAt || createdAt === state.roomCreatedAt) return;
    state.roomCreatedAt = createdAt;
    persistSession();
  }

  function clearSession() {
    storageRemove(SESSION_KEY);
  }

  function readSession() {
    return S.parseStoredSession(storageGet(SESSION_KEY), Date.now());
  }

  function loadPersisted() {
    var name = storageGet(NAME_KEY);
    if (name) $("joinUserNameInput").value = name;
    state.soundEnabled = storageGet(SOUND_KEY) === "1";
    updateSoundButton();
  }

  function updateSoundButton() {
    var btn = $("soundToggleBtn");
    var on = !!state.soundEnabled;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-label", on ? "Sound on" : "Sound off");
    var label = btn.querySelector(".header-tool-label");
    if (label) label.textContent = on ? "Sound on" : "Sound off";
  }

  function setNetState(next) {
    state.netState = next;
    var chip = $("syncStatus");
    chip.dataset.state = next;
    chip.classList.add("is-visible");
    chip.textContent = next === "live" ? "Live" : next === "degraded" ? "Weak" : "Local";
  }

  function myRecord() {
    return {
      userId: state.userId,
      name: state.name,
      matchSecondsAtAnchor: state.matchSecondsAtAnchor,
      anchorTimestamp: state.anchorTimestamp,
      isPaused: state.isPaused,
      lastSeen: Date.now(),
      left: false
    };
  }

  function rememberMe() {
    state.participants[state.userId] = myRecord();
  }

  function roomLink() {
    var url = new URL(window.location.href);
    url.search = "?room=" + encodeURIComponent(state.roomId);
    url.hash = "";
    return url.toString();
  }

  function inviteText() {
    return "Join my StreamSync room and enter the match clock on your TV so we can see who is ahead: " + roomLink();
  }

  async function fetchJson(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 8000);
    try {
      var res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function kvGet(key) {
    var data = await fetchJson(S.kvGetUrl(key));
    return S.parseKvResponse(data, "get");
  }

  async function kvSet(key, value) {
    var data = await fetchJson(S.kvSetUrl(key, value));
    if (!S.parseKvResponse(data, "set")) {
      throw new Error("kv set failed");
    }
    return true;
  }

  function updateJoinFollowHint() {
    var hint = $("joinClockHint");
    var source = $("joinClockSource");
    var scorebug = $("joinScorebug");
    if (!hint || !source || !scorebug) return;
    if (joinFollow && !joinFollowLocked && !state.roomId) {
      var live = {
        name: joinFollow.name,
        viewerCount: joinFollow.viewerCount,
        calculatedSeconds: S.calculateCurrentSeconds(joinFollow, Date.now())
      };
      hint.textContent = S.joinSeedHint(live);
      source.textContent = "From " + (joinFollow.name || "room");
      scorebug.classList.add("is-following");
    } else {
      hint.textContent = DEFAULT_JOIN_HINT;
      source.textContent = "TV match clock";
      scorebug.classList.remove("is-following");
    }
  }

  function lockJoinFollow() {
    if (state.roomId) return;
    joinFollowLocked = true;
    joinFollow = null;
    updateJoinFollowHint();
  }

  function stopJoinFollowTicker() {
    if (joinFollowTicker) {
      clearInterval(joinFollowTicker);
      joinFollowTicker = null;
    }
  }

  function startJoinFollowTicker() {
    if (joinFollowTicker) return;
    joinFollowTicker = setInterval(function () {
      if (state.roomId || joinFollowLocked || !joinFollow || !joinClock) return;
      joinClock.set(S.calculateCurrentSeconds(joinFollow, Date.now()), { silent: true });
    }, 250);
  }

  async function kickExpiredRoom() {
    if (!state.roomId) return;
    await exitRoom({ expired: true });
  }

  async function peekRoomLeader(roomId) {
    var room = S.sanitizeRoomCode(roomId);
    if (!room) return null;
    var keys = S.roomKeys(room);
    var meta = null;
    var metaReadOk = false;
    try {
      meta = S.decodeRoomMeta(await kvGet(keys.meta));
      metaReadOk = true;
    } catch (err) {}
    if (S.roomMetaStatus(meta, metaReadOk) === "expired") return null;
    var rosterKey = keys.roster;
    if (meta && meta.createdAt) {
      var genIds = S.decodeRoster(await kvGet(keys.rosterAt(meta.createdAt)));
      if (genIds.length) rosterKey = keys.rosterAt(meta.createdAt);
    }
    var ids = S.decodeRoster(await kvGet(rosterKey));
    if (!ids.length) return null;
    var rows = await Promise.all(ids.map(function (id) {
      return kvGet(keys.user(id)).then(function (raw) {
        return S.decodeViewer(id, raw);
      }).catch(function () { return null; });
    }));
    return S.pickRoomLeader(rows, Date.now());
  }

  async function peekAndSeedJoinClock() {
    if (state.roomId || joinFollowLocked || !joinClock) return;
    var room = S.sanitizeRoomCode($("joinRoomCodeInput").value);
    if (!room) {
      joinFollow = null;
      joinClock.set(0, { silent: true });
      updateJoinFollowHint();
      return;
    }
    try {
      var leader = await peekRoomLeader(room);
      if (state.roomId || joinFollowLocked) return;
      if (!leader) {
        joinFollow = null;
        joinClock.set(0, { silent: true });
        updateJoinFollowHint();
        return;
      }
      joinFollow = leader;
      joinClock.set(leader.calculatedSeconds, { silent: true });
      updateJoinFollowHint();
      startJoinFollowTicker();
    } catch (err) {
      if (!joinFollowLocked) updateJoinFollowHint();
    }
  }

  function scheduleJoinPeek() {
    joinFollowLocked = false;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(peekAndSeedJoinClock, 350);
  }

  function markLive() {
    state.lastGoodSync = Date.now();
    setNetState("live");
  }

  function applyViewer(record) {
    if (!record || !record.userId || record.userId === state.userId) return;
    if (record.left || S.shouldDrop(record, Date.now())) {
      delete state.participants[record.userId];
      return;
    }
    state.participants[record.userId] = record;
  }

  function publishLocal(payload) {
    if (!broadcast) return;
    try {
      broadcast.postMessage(payload);
    } catch (err) {}
  }

  async function publishLive(payload) {
    var topic = S.ntfyTopic(state.roomId);
    await fetch("https://ntfy.sh/" + topic + "?priority=min&title=ssfc", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  function livePayload(type) {
    return {
      v: 1,
      type: type,
      room: state.roomId,
      id: state.userId,
      body: type === "leave" ? "LEFT" : S.encodeViewer(myRecord(), Date.now())
    };
  }

  async function publishMe(options) {
    options = options || {};
    var epoch = publishEpoch;
    rememberMe();
    if (!state.roomId) return;
    if (!options.leave && (state.exiting || epoch !== publishEpoch)) return;
    if (options.leave) clearSession();
    else persistSession();
    render();
    var keys = S.roomKeys(state.roomId);
    var payload = livePayload(options.leave ? "leave" : "sync");
    if (!options.leave) publishLocal(payload);
    var kvOk = false;
    var liveOk = false;
    try {
      if (options.leave) {
        await kvSet(keys.user(state.userId), "LEFT");
      } else {
        if (options.roster) {
          var ensured = await ensureRoster();
          if (epoch !== publishEpoch || !state.roomId || state.exiting) return;
          if (ensured && ensured.expired) {
            kvOk = true;
            await kickExpiredRoom();
            return;
          }
        }
        if (epoch !== publishEpoch || !state.roomId || state.exiting) return;
        await kvSet(keys.user(state.userId), payload.body);
      }
      kvOk = true;
    } catch (err) {}
    if (epoch !== publishEpoch || (!options.leave && (!state.roomId || state.exiting))) return;
    try {
      await publishLive(payload);
      liveOk = true;
    } catch (err) {}
    if (kvOk || liveOk) markLive();
    else setNetState(state.lastGoodSync ? "degraded" : "offline");
    if (state.roomId && epoch === publishEpoch) render();
  }

  function sameRoom(epoch, roomId) {
    return epoch === publishEpoch && !!roomId && state.roomId === roomId;
  }

  async function joinGenerationRoster(keys, createdAt, epoch, roomId) {
    var attempts = 0;
    while (attempts < 4) {
      attempts += 1;
      if (!sameRoom(epoch, roomId)) return;
      var latest = null;
      try {
        latest = S.decodeRoomMeta(await kvGet(keys.meta));
      } catch (err) {}
      if (!sameRoom(epoch, roomId)) return;
      var gen = latest && latest.createdAt ? latest.createdAt : createdAt;
      rememberRoomCreatedAt(gen);
      state.rosterGeneration = gen;
      var rosterKey = keys.rosterAt(gen);
      var current = S.decodeRoster(await kvGet(rosterKey));
      if (!sameRoom(epoch, roomId)) return;
      if (current.indexOf(state.userId) === -1) {
        current.push(state.userId);
        await kvSet(rosterKey, S.encodeRoster(current));
      }
      if (!sameRoom(epoch, roomId)) return;
      try {
        latest = S.decodeRoomMeta(await kvGet(keys.meta));
      } catch (err) {
        return;
      }
      if (!latest || !latest.createdAt || latest.createdAt === gen) return;
      createdAt = latest.createdAt;
    }
  }

  async function runEnsureRoster() {
    var epoch = publishEpoch;
    var roomId = state.roomId;
    if (!roomId) return { expired: false };
    if (!state.claimExpiredRoom && S.roomIsExpired({ createdAt: state.roomCreatedAt })) {
      return { expired: true };
    }
    var keys = S.roomKeys(roomId);
    var meta = null;
    var metaReadOk = false;
    try {
      meta = S.decodeRoomMeta(await kvGet(keys.meta));
      metaReadOk = true;
    } catch (err) {}
    if (!sameRoom(epoch, roomId)) return { expired: false };
    var metaStatus = S.roomMetaStatus(meta, metaReadOk);
    if (metaStatus === "unknown" && S.roomIsExpired({ createdAt: state.roomCreatedAt })) {
      return { expired: true };
    }
    if (metaStatus === "expired") {
      if (!state.claimExpiredRoom) return { expired: true };
      var claimedAt = Date.now();
      try {
        await kvSet(keys.meta, S.encodeRoomMeta({ createdAt: claimedAt }));
      } catch (err) {
        return { expired: true };
      }
      if (!sameRoom(epoch, roomId)) return { expired: false };
      state.claimExpiredRoom = false;
      await joinGenerationRoster(keys, claimedAt, epoch, roomId);
      return { expired: false };
    }
    if (metaStatus === "missing") {
      var stampedAt = Date.now();
      try {
        await kvSet(keys.meta, S.encodeRoomMeta({ createdAt: stampedAt }));
      } catch (err) {}
      if (!sameRoom(epoch, roomId)) return { expired: false };
      rememberRoomCreatedAt(stampedAt);
      state.claimExpiredRoom = false;
    } else if (metaStatus === "live" && meta && meta.createdAt) {
      rememberRoomCreatedAt(meta.createdAt);
    }
    if (!sameRoom(epoch, roomId)) return { expired: false };
    var createdAt = state.rosterGeneration || state.roomCreatedAt || (meta && meta.createdAt);
    var rosterKey = keys.roster;
    if (state.rosterGeneration) {
      rosterKey = keys.rosterAt(createdAt);
    } else if (createdAt) {
      var existingGen = S.decodeRoster(await kvGet(keys.rosterAt(createdAt)));
      if (!sameRoom(epoch, roomId)) return { expired: false };
      if (existingGen.length) {
        rosterKey = keys.rosterAt(createdAt);
        state.rosterGeneration = createdAt;
      }
    }
    var current = S.decodeRoster(await kvGet(rosterKey));
    if (!sameRoom(epoch, roomId)) return { expired: false };
    if (current.indexOf(state.userId) === -1) {
      current.push(state.userId);
      await kvSet(rosterKey, S.encodeRoster(current));
    }
    return { expired: false };
  }

  function ensureRoster() {
    var roomId = state.roomId;
    if (!roomId) return Promise.resolve({ expired: false });
    if (rosterInFlight && rosterInFlightRoom === roomId) return rosterInFlight;
    rosterInFlightRoom = roomId;
    rosterInFlight = runEnsureRoster().then(function (result) {
      if (rosterInFlightRoom === roomId) {
        rosterInFlight = null;
        rosterInFlightRoom = "";
      }
      return result;
    }, function (err) {
      if (rosterInFlightRoom === roomId) {
        rosterInFlight = null;
        rosterInFlightRoom = "";
      }
      throw err;
    });
    return rosterInFlight;
  }

  async function fetchRoom() {
    if (!state.roomId || pollInFlight) return;
    pollInFlight = true;
    try {
      var keys = S.roomKeys(state.roomId);
      var ensured = await ensureRoster();
      if (!state.roomId) return;
      if (ensured && ensured.expired) {
        await kickExpiredRoom();
        return;
      }
      var rosterKey = state.rosterGeneration
        ? keys.rosterAt(state.rosterGeneration)
        : keys.roster;
      if (!state.rosterGeneration && state.roomCreatedAt) {
        var genIds = S.decodeRoster(await kvGet(keys.rosterAt(state.roomCreatedAt)));
        if (genIds.length) rosterKey = keys.rosterAt(state.roomCreatedAt);
      }
      var ids = S.decodeRoster(await kvGet(rosterKey));
      if (ids.indexOf(state.userId) === -1) ids.push(state.userId);
      var others = ids.filter(function (id) { return id !== state.userId; });
      var rows = await Promise.all(others.map(function (id) {
        return kvGet(keys.user(id)).then(function (raw) {
          return S.decodeViewer(id, raw);
        }).catch(function () { return null; });
      }));
      rows.forEach(applyViewer);
      rememberMe();
      markLive();
      render();
    } catch (err) {
      if (!state.lastGoodSync) setNetState("offline");
      else if (Date.now() - state.lastGoodSync > 20000) setNetState("degraded");
    } finally {
      pollInFlight = false;
    }
  }

  function handleLiveMessage(raw) {
    var msg;
    try { msg = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (err) { return; }
    if (!msg || msg.v !== 1 || msg.room !== state.roomId || !msg.id) return;
    if (msg.type === "leave") {
      applyViewer({ userId: msg.id, left: true });
      render();
      return;
    }
    var record = S.decodeViewer(msg.id, msg.body);
    var isNew = record && record.userId !== state.userId && !state.participants[record.userId];
    applyViewer(record);
    markLive();
    render();
    if (isNew) {
      if (!announceTimer) {
        announceTimer = setTimeout(function () {
          announceTimer = null;
          publishMe();
        }, 200);
      }
    }
  }

  function startLiveChannel() {
    stopLiveChannel();
    var topic = S.ntfyTopic(state.roomId);
    try {
      eventSource = new EventSource("https://ntfy.sh/" + topic + "/sse");
      eventSource.onmessage = function (event) {
        try {
          var envelope = JSON.parse(event.data);
          handleLiveMessage(envelope.message);
        } catch (err) {}
      };
      eventSource.onopen = function () {
        if (state.roomId) markLive();
      };
    } catch (err) {}

    try {
      broadcast = new BroadcastChannel("streamsync:" + state.roomId);
      broadcast.onmessage = function (event) {
        handleLiveMessage(event.data);
      };
    } catch (err) {
      broadcast = null;
    }
  }

  function stopLiveChannel() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (broadcast) {
      broadcast.close();
      broadcast = null;
    }
  }

  function rankedList(now) {
    rememberMe();
    var values = Object.keys(state.participants).map(function (id) {
      return state.participants[id];
    });
    if (now == null) now = S.alignNowToDisplayedSecond(myRecord(), Date.now());
    return S.decorateParticipants(values, state.userId, now);
  }

  function renderLeaderboard(list) {
    var root = $("participantList");
    root.textContent = "";
    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No viewers yet.";
      root.appendChild(empty);
      return;
    }
    list.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "viewer";

      var left = document.createElement("div");
      var rank = document.createElement("span");
      rank.className = "mono";
      rank.textContent = "#" + item.rank + " ";
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = item.name;
      left.appendChild(rank);
      left.appendChild(name);
      if (item.isMe) {
        var you = document.createElement("span");
        you.className = "you-pill";
        you.textContent = "you";
        left.appendChild(you);
      }
      if (item.isPaused) {
        var paused = document.createElement("span");
        paused.className = "pause-pill";
        paused.textContent = "paused";
        left.appendChild(paused);
      }
      if (!item.online) {
        var away = document.createElement("span");
        away.className = "away-pill";
        away.textContent = "last report";
        left.appendChild(away);
      }
      var clock = document.createElement("div");
      clock.className = "mono";
      clock.textContent = S.formatMatchSeconds(item.calculatedSeconds);
      left.appendChild(clock);

      var right = document.createElement("div");
      var delta = document.createElement("span");
      delta.className = "delta " + item.bucket;
      var vsYou = item.isMe ? "you" : S.formatSignedSeconds(item.deltaFromMe);
      delta.textContent = item.isLeader
        ? "EDGE " + (item.isMe ? "0s" : vsYou)
        : S.formatSignedSeconds(item.deltaFromLeader) + " / " + vsYou;
      right.appendChild(delta);

      row.appendChild(left);
      row.appendChild(right);
      root.appendChild(row);
    });
  }

  function render() {
    if (!state.roomId) return;
    var tickNow = S.alignNowToDisplayedSecond(myRecord(), Date.now());
    var list = rankedList(tickNow);
    var me = null;
    var leader = null;
    var onlineCount = 0;
    list.forEach(function (p) {
      if (p.isMe) me = p;
      if (p.online) {
        onlineCount += 1;
        if (!leader) leader = p;
      }
    });
    var mySecs = me ? me.calculatedSeconds : S.calculateCurrentSeconds(myRecord(), tickNow);

    $("myClock").textContent = S.formatMatchSeconds(mySecs);
    $("myClock").classList.toggle("is-paused", state.isPaused);
    $("clockStatus").textContent = state.isPaused ? "Paused" : "Feed ticking";
    $("pauseBtn").textContent = state.isPaused ? "Resume clock" : "Pause (halftime)";
    $("myNameLabel").textContent = state.name;
    $("participantCount").textContent = list.length + (list.length === 1 ? " viewer" : " viewers");

    var banner = $("roleBanner");
    var heroValue = $("roleHeroValue");
    var heroLabel = $("roleHeroLabel");
    var heroInvite = $("heroInviteBtn");
    var boardInvite = $("inviteFriendsBtn");
    heroValue.classList.add("hidden");
    heroInvite.classList.add("hidden");
    boardInvite.classList.remove("hidden");
    $("roleText").classList.remove("hidden");
    heroLabel.classList.remove("hidden");
    delete banner.dataset.lag;
    delete banner.dataset.wait;

    if (onlineCount <= 1) {
      banner.dataset.role = "solo";
      $("roleTitle").textContent = "Room ready";
      $("roleTag").textContent = "SOLO";
      $("roleText").textContent = "Send the link. Friends type the clock on their TV.";
      $("myRelative").textContent = "Waiting for the group";
      heroLabel.textContent = "Invite friends";
      heroInvite.classList.remove("hidden");
      boardInvite.classList.add("hidden");
    } else if (me && me.atLiveEdge) {
      var wait = me.spoilerWaitSeconds;
      $("roleTitle").textContent = wait ? "You are ahead" : "Tied";
      $("roleTag").textContent = wait ? "AHEAD" : "TIED";
      $("roleText").textContent = wait
        ? ""
        : "You are tied at the front of the room.";
      $("myRelative").textContent = wait ? ("Ahead of the slowest feed by " + wait + "s") : "Tied for the lead";
      if (wait > 0) {
        banner.dataset.role = "ahead";
        banner.dataset.wait = S.waitSeverity(wait);
        heroLabel.textContent = "";
        heroLabel.classList.add("hidden");
        heroValue.textContent = "Wait " + wait + "s";
        heroValue.classList.remove("hidden");
      } else {
        banner.dataset.role = "tied";
        heroLabel.textContent = "Tied at the live edge";
      }
    } else if (me && leader) {
      var lag = Math.abs(me.deltaFromLeader);
      banner.dataset.role = "behind";
      banner.dataset.lag = lag > 15 ? "high" : "mild";
      $("roleTitle").textContent = "You are behind";
      $("roleTag").textContent = lag > 15 ? "HIGH LAG" : "BEHIND";
      $("roleText").textContent = "";
      $("roleText").classList.add("hidden");
      $("myRelative").textContent = S.formatSignedSeconds(me.deltaFromLeader) + " vs " + leader.name;
      heroLabel.textContent = "behind " + leader.name;
      heroValue.textContent = lag + "s";
      heroValue.classList.remove("hidden");
    }

    renderLeaderboard(list);
  }

  function msUntilNextDisplayTick() {
    var now = Date.now();
    var tickNow = S.alignNowToDisplayedSecond(myRecord(), now);
    var delay = Math.round(tickNow + 1000 - now);
    if (delay < 16) delay = 16;
    if (delay > 1000) delay = 1000;
    return delay;
  }

  function startTimers() {
    stopTimers();
    function alignTick() {
      render();
      tickTimer = setTimeout(alignTick, msUntilNextDisplayTick());
    }
    alignTick();
    pollTimer = setInterval(fetchRoom, POLL_MS);
    heartbeatTimer = setInterval(function () {
      if (document.visibilityState === "visible") publishMe();
    }, HEARTBEAT_MS);
  }

  function stopTimers() {
    clearTimeout(tickTimer);
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    tickTimer = pollTimer = heartbeatTimer = null;
  }

  function setExact(minutes, seconds) {
    state.matchSecondsAtAnchor = S.parseClockInputs(minutes, seconds);
    state.anchorTimestamp = Date.now();
    playTone(620);
    publishMe();
    showToast("Clock set to " + S.formatMatchSeconds(state.matchSecondsAtAnchor));
  }

  function nudge(delta) {
    var current = S.calculateCurrentSeconds(myRecord());
    state.matchSecondsAtAnchor = Math.max(0, current + delta);
    state.anchorTimestamp = Date.now();
    playTone(delta > 0 ? 560 : 380);
    publishMe();
    showToast("Adjusted " + S.formatSignedSeconds(delta));
  }

  function togglePause() {
    var current = S.calculateCurrentSeconds(myRecord());
    state.matchSecondsAtAnchor = current;
    state.anchorTimestamp = Date.now();
    state.isPaused = !state.isPaused;
    playTone(state.isPaused ? 300 : 640);
    publishMe();
    showToast(state.isPaused ? "Clock paused" : "Clock resumed");
  }

  function openModal(id) {
    $(id).classList.add("is-open");
  }

  function closeModal(id) {
    $(id).classList.remove("is-open");
  }

  async function copyText(text, success) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        var area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      showToast(success);
      playTone(700);
    } catch (err) {
      showToast("Copy the link manually");
    }
  }

  function enterRoom(options) {
    options = options || {};
    state.userId = getUserId();
    state.name = S.sanitizeName(options.name);
    state.roomId = S.sanitizeRoomCode(options.room) || S.randomRoomCode();
    if (options.resumed) {
      state.matchSecondsAtAnchor = Math.max(0, Math.floor(Number(options.matchSecondsAtAnchor) || 0));
      state.anchorTimestamp = Number(options.anchorTimestamp) || Date.now();
      state.isPaused = !!options.isPaused;
    } else {
      state.matchSecondsAtAnchor = S.parseClockInputs(options.minutes, options.seconds);
      state.anchorTimestamp = Date.now();
      state.isPaused = false;
    }
    state.participants = {};
    state.claimExpiredRoom = !options.resumed;
    state.roomCreatedAt = Math.floor(Number(options.roomCreatedAt) || 0) || (options.resumed ? 0 : Date.now());
    state.rosterGeneration = 0;
    persistName(state.name);
    rememberMe();
    persistSession();
    stopJoinFollowTicker();
    joinFollow = null;
    joinFollowLocked = true;

    $("welcomeView").classList.add("hidden");
    $("dashboardView").classList.remove("hidden");
    $("exitRoomBtn").classList.remove("hidden");
    window.scrollTo(0, 0);
    document.body.classList.add("in-room");
    $("roomChip").classList.add("is-visible");
    $("roomCodeLabel").textContent = state.roomId;
    $("copyInviteBtn").setAttribute("aria-label", "Open invite for room " + state.roomId);
    $("syncStatus").classList.add("is-visible");

    var url = new URL(window.location.href);
    url.searchParams.set("room", state.roomId);
    history.replaceState({}, "", url);

    startLiveChannel();
    startTimers();
    publishMe({ roster: true });
    fetchRoom();
    showToast((options.resumed ? "Welcome back to " : "Joined ") + state.roomId);
    playTone(520);
  }

  async function exitRoom(options) {
    options = options || {};
    if (!state.roomId || state.exiting) return;
    publishEpoch += 1;
    state.exiting = true;
    if (!options.expired) {
      try { await publishMe({ leave: true }); } catch (err) {}
    }
    stopTimers();
    stopLiveChannel();
    clearSession();
    state.roomId = "";
    state.participants = {};
    state.claimExpiredRoom = false;
    state.exiting = false;
    state.roomCreatedAt = 0;
    state.rosterGeneration = 0;
    rosterInFlight = null;
    rosterInFlightRoom = "";
    $("dashboardView").classList.add("hidden");
    $("welcomeView").classList.remove("hidden");
    $("exitRoomBtn").classList.add("hidden");
    $("roomChip").classList.remove("is-visible");
    $("syncStatus").classList.remove("is-visible");
    $("copyInviteBtn").removeAttribute("aria-label");
    document.body.classList.remove("in-room");
    closeModal("exactModal");
    closeModal("inviteModal");
    var url = new URL(window.location.href);
    url.searchParams.delete("room");
    history.replaceState({}, "", url);
    showToast(options.expired ? "Room closed after 3 hours" : "Left the room");
    joinFollowLocked = false;
    scheduleJoinPeek();
  }

  function bind() {
    joinClock = createScorebug($("joinScorebug"), {
      onUserChange: lockJoinFollow
    });
    exactClock = createScorebug($("exactScorebug"));
    loadPersisted();
    var params = new URLSearchParams(window.location.search);
    var roomParam = S.sanitizeRoomCode(params.get("room") || "");
    var saved = readSession();
    if (roomParam) $("joinRoomCodeInput").value = roomParam;
    else if (saved) $("joinRoomCodeInput").value = saved.roomId;

    if (saved && S.sessionShouldResume(saved, roomParam)) {
      var current = S.calculateCurrentSeconds(saved, Date.now());
      $("joinUserNameInput").value = saved.name;
      joinClock.set(current);
      enterRoom({
        name: saved.name,
        room: saved.roomId,
        matchSecondsAtAnchor: saved.matchSecondsAtAnchor,
        anchorTimestamp: saved.anchorTimestamp,
        isPaused: saved.isPaused,
        roomCreatedAt: saved.roomCreatedAt,
        resumed: true
      });
    } else {
      peekAndSeedJoinClock();
    }

    setInterval(function () {
      if (!state.roomId && !joinFollowLocked) peekAndSeedJoinClock();
    }, 5000);

    $("generateRandomRoomBtn").addEventListener("click", function () {
      $("joinRoomCodeInput").value = S.randomRoomCode();
      scheduleJoinPeek();
    });

    $("joinRoomCodeInput").addEventListener("input", scheduleJoinPeek);

    $("joinForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var name = $("joinUserNameInput").value;
      if (!S.sanitizeName(name)) {
        showToast("Enter a name first");
        $("joinUserNameInput").focus();
        return;
      }
      var picked = S.splitClock(joinClock.get());
      enterRoom({
        name: name,
        room: $("joinRoomCodeInput").value,
        minutes: picked.minutes,
        seconds: picked.seconds
      });
    });

    $("soundToggleBtn").addEventListener("click", function () {
      state.soundEnabled = !state.soundEnabled;
      storageSet(SOUND_KEY, state.soundEnabled ? "1" : "0");
      updateSoundButton();
      if (state.soundEnabled) playTone(440);
    });

    document.querySelectorAll(".nudgeBtn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        nudge(parseInt(btn.getAttribute("data-nudge"), 10));
      });
    });

    $("pauseBtn").addEventListener("click", togglePause);
    function openExact() {
      exactClock.set(S.calculateCurrentSeconds(myRecord()));
      openModal("exactModal");
    }
    $("clockTapBtn").addEventListener("click", openExact);
    $("saveExactBtn").addEventListener("click", function () {
      var picked = S.splitClock(exactClock.get());
      setExact(picked.minutes, picked.seconds);
      closeModal("exactModal");
    });
    $("cancelExactBtn").addEventListener("click", function () {
      closeModal("exactModal");
    });

    function openInvite() {
      $("shareUrlInput").value = roomLink();
      openModal("inviteModal");
    }
    $("inviteFriendsBtn").addEventListener("click", openInvite);
    $("heroInviteBtn").addEventListener("click", openInvite);
    $("copyInviteBtn").addEventListener("click", openInvite);
    $("closeInviteBtn").addEventListener("click", function () {
      closeModal("inviteModal");
    });
    $("copyShareUrlBtn").addEventListener("click", function () {
      copyText(roomLink(), "Room link copied");
    });
    $("whatsAppBtn").addEventListener("click", function () {
      window.open("https://wa.me/?text=" + encodeURIComponent(inviteText()), "_blank", "noopener");
    });
    $("telegramBtn").addEventListener("click", function () {
      window.open("https://t.me/share/url?url=" + encodeURIComponent(roomLink()) + "&text=" + encodeURIComponent("Sync our match clocks"), "_blank", "noopener");
    });

    $("exitRoomBtn").addEventListener("click", exitRoom);

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && state.roomId) {
        publishMe();
        fetchRoom();
      }
    });

    window.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeModal("exactModal");
        closeModal("inviteModal");
      }
    });
    ["exactModal", "inviteModal"].forEach(function (id) {
      $(id).addEventListener("click", function (event) {
        if (event.target === $(id)) closeModal(id);
      });
    });
  }

  document.addEventListener("DOMContentLoaded", bind);
})();
