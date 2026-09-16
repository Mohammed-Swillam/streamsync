(function () {
  "use strict";

  var S = window.StreamSync;
  var POLL_MS = 2500;
  var HEARTBEAT_MS = 12000;
  var TICK_ALIGN_MS = 250;
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
    lastGoodSync: 0
  };

  var tickTimer = null;
  var pollTimer = null;
  var heartbeatTimer = null;
  var pollInFlight = false;
  var announceTimer = null;
  var eventSource = null;
  var broadcast = null;
  var audioCtx = null;

  function $(id) {
    return document.getElementById(id);
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
      isPaused: state.isPaused
    });
    if (!session) return;
    storageSet(SESSION_KEY, JSON.stringify(session));
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
    btn.textContent = state.soundEnabled ? "Sound on" : "Sound off";
    btn.setAttribute("aria-pressed", state.soundEnabled ? "true" : "false");
  }

  function setNetState(next) {
    state.netState = next;
    var chip = $("syncStatus");
    chip.dataset.state = next;
    chip.classList.add("is-visible");
    chip.textContent = next === "live" ? "Live sync" : next === "degraded" ? "Sync weak" : "Local only";
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

  function markLive() {
    state.lastGoodSync = Date.now();
    setNetState("live");
  }

  function applyViewer(record) {
    if (!record || !record.userId || record.userId === state.userId) return;
    if (record.left) {
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
    rememberMe();
    if (!state.roomId) return;
    if (options.leave) clearSession();
    else persistSession();
    var keys = S.roomKeys(state.roomId);
    var payload = livePayload(options.leave ? "leave" : "sync");
    publishLocal(payload);
    var kvOk = false;
    var liveOk = false;
    try {
      if (options.leave) {
        await kvSet(keys.user(state.userId), "LEFT");
      } else {
        await kvSet(keys.user(state.userId), payload.body);
        if (options.roster) await ensureRoster();
      }
      kvOk = true;
    } catch (err) {}
    try {
      await publishLive(payload);
      liveOk = true;
    } catch (err) {}
    if (kvOk || liveOk) markLive();
    else setNetState(state.lastGoodSync ? "degraded" : "offline");
    render();
  }

  async function ensureRoster() {
    var keys = S.roomKeys(state.roomId);
    var current = S.decodeRoster(await kvGet(keys.roster));
    if (current.indexOf(state.userId) === -1) {
      current.push(state.userId);
      await kvSet(keys.roster, S.encodeRoster(current));
    }
  }

  async function fetchRoom() {
    if (!state.roomId || pollInFlight) return;
    pollInFlight = true;
    try {
      var keys = S.roomKeys(state.roomId);
      await ensureRoster();
      var ids = S.decodeRoster(await kvGet(keys.roster));
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

  function rankedList() {
    rememberMe();
    var values = Object.keys(state.participants).map(function (id) {
      return state.participants[id];
    });
    return S.decorateParticipants(values, state.userId, Date.now());
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
    var list = rankedList();
    var me = null;
    var leader = list[0] || null;
    var next = list[1] || null;
    list.forEach(function (p) { if (p.isMe) me = p; });
    var mySecs = me ? me.calculatedSeconds : S.calculateCurrentSeconds(myRecord());

    $("myClock").textContent = S.formatMatchSeconds(mySecs);
    $("myClock").classList.toggle("is-paused", state.isPaused);
    $("clockStatus").textContent = state.isPaused ? "Paused" : "Feed ticking";
    $("pauseBtn").textContent = state.isPaused ? "Resume clock" : "Pause (halftime)";
    $("myNameLabel").textContent = state.name;
    $("participantCount").textContent = list.length + (list.length === 1 ? " viewer" : " viewers");

    var banner = $("roleBanner");
    var caution = $("cautionBox");
    if (list.length <= 1) {
      banner.dataset.role = "solo";
      $("roleTitle").textContent = "Room ready";
      $("roleTag").textContent = "SOLO";
      $("roleText").textContent = "Share the link. Friends enter the clock on their own TV.";
      $("myRelative").textContent = "Waiting for the group";
      caution.classList.add("hidden");
    } else if (me && me.isLeader) {
      var gapNext = next ? me.calculatedSeconds - next.calculatedSeconds : 0;
      var wait = me.spoilerWaitSeconds;
      banner.dataset.role = "ahead";
      $("roleTitle").textContent = "You have the live edge";
      $("roleTag").textContent = "AHEAD";
      $("roleText").textContent = gapNext
        ? "You are " + gapNext + "s ahead of " + next.name + ". Hold chat reactions."
        : "You are tied at the front of the room.";
      $("myRelative").textContent = wait ? ("Ahead of the slowest feed by " + wait + "s") : "Tied for the lead";
      if (wait > 0) {
        caution.classList.remove("hidden");
        $("cautionValue").textContent = wait + "s";
      } else {
        caution.classList.add("hidden");
      }
    } else if (me && leader) {
      var lag = Math.abs(me.deltaFromLeader);
      banner.dataset.role = "behind";
      $("roleTitle").textContent = "Your feed is delayed by " + lag + "s";
      $("roleTag").textContent = lag > 15 ? "HIGH LAG" : "BEHIND";
      $("roleText").textContent = leader.name + " is " + lag + "s ahead of you. Glance away from group chat on big moments.";
      $("myRelative").textContent = S.formatSignedSeconds(me.deltaFromLeader) + " vs " + leader.name;
      caution.classList.add("hidden");
    }

    renderLeaderboard(list);
  }

  function startTimers() {
    stopTimers();
    function alignTick() {
      render();
      tickTimer = setTimeout(alignTick, TICK_ALIGN_MS);
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
    persistName(state.name);
    rememberMe();
    persistSession();

    $("welcomeView").classList.add("hidden");
    $("dashboardView").classList.remove("hidden");
    $("exitRoomBtn").classList.remove("hidden");
    $("roomChip").classList.add("is-visible");
    $("roomCodeLabel").textContent = state.roomId;
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

  async function exitRoom() {
    try { await publishMe({ leave: true }); } catch (err) {}
    stopTimers();
    stopLiveChannel();
    clearSession();
    state.roomId = "";
    state.participants = {};
    $("dashboardView").classList.add("hidden");
    $("welcomeView").classList.remove("hidden");
    $("exitRoomBtn").classList.add("hidden");
    $("roomChip").classList.remove("is-visible");
    $("syncStatus").classList.remove("is-visible");
    closeModal("exactModal");
    closeModal("inviteModal");
    var url = new URL(window.location.href);
    url.searchParams.delete("room");
    history.replaceState({}, "", url);
    showToast("Left the room");
  }

  function bind() {
    loadPersisted();
    var params = new URLSearchParams(window.location.search);
    var roomParam = S.sanitizeRoomCode(params.get("room") || "");
    var saved = readSession();
    if (roomParam) $("joinRoomCodeInput").value = roomParam;
    else if (saved) $("joinRoomCodeInput").value = saved.roomId;

    if (saved && S.sessionShouldResume(saved, roomParam)) {
      var current = S.calculateCurrentSeconds(saved, Date.now());
      $("joinUserNameInput").value = saved.name;
      $("initialMinInput").value = Math.floor(current / 60);
      $("initialSecInput").value = current % 60;
      enterRoom({
        name: saved.name,
        room: saved.roomId,
        matchSecondsAtAnchor: saved.matchSecondsAtAnchor,
        anchorTimestamp: saved.anchorTimestamp,
        isPaused: saved.isPaused,
        resumed: true
      });
    }

    $("generateRandomRoomBtn").addEventListener("click", function () {
      $("joinRoomCodeInput").value = S.randomRoomCode();
    });

    $("joinForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var name = $("joinUserNameInput").value;
      if (!S.sanitizeName(name)) {
        showToast("Enter a name first");
        $("joinUserNameInput").focus();
        return;
      }
      enterRoom({
        name: name,
        room: $("joinRoomCodeInput").value,
        minutes: $("initialMinInput").value,
        seconds: $("initialSecInput").value
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

    document.querySelectorAll(".presetBtn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var seconds = parseInt(btn.getAttribute("data-preset"), 10);
        state.matchSecondsAtAnchor = seconds;
        state.anchorTimestamp = Date.now();
        publishMe();
        showToast("Clock set to " + S.formatMatchSeconds(seconds));
      });
    });

    $("pauseBtn").addEventListener("click", togglePause);
    $("openExactBtn").addEventListener("click", function () {
      var current = S.calculateCurrentSeconds(myRecord());
      $("exactMinInput").value = Math.floor(current / 60);
      $("exactSecInput").value = current % 60;
      openModal("exactModal");
    });
    $("saveExactBtn").addEventListener("click", function () {
      setExact($("exactMinInput").value, $("exactSecInput").value);
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
  }

  document.addEventListener("DOMContentLoaded", bind);
})();
