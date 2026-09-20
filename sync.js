(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.StreamSync = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var ROOM_CODE_MAX = 24;
  var NAME_MAX = 20;
  var STALE_DROP_MS = 45 * 60 * 1000;
  var ROOM_MAX_AGE_MS = 3 * 60 * 60 * 1000;
  var SESSION_MAX_AGE_MS = 3 * 60 * 60 * 1000;
  var ONLINE_MS = 25 * 1000;
  var KV_BASE = "https://api.keyval.org";
  var STAMP_MS_MIN = 100000000000;
  var STAMP_MS_MAX = 40000000000000;

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) n = fallback;
    return Math.min(max, Math.max(min, n));
  }

  function formatMatchSeconds(totalSeconds) {
    var secs = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    return pad2(Math.floor(secs / 60)) + ":" + pad2(secs % 60);
  }

  function parseClockInputs(minutes, seconds) {
    var mins = clampInt(minutes, 0, 199, 0);
    var secs = clampInt(seconds, 0, 59, 0);
    return mins * 60 + secs;
  }

  var MAX_MINUTES = 199;

  function splitClock(totalSeconds) {
    var secs = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    var maxTotal = MAX_MINUTES * 60 + 59;
    if (secs > maxTotal) secs = maxTotal;
    return {
      minutes: Math.floor(secs / 60),
      seconds: secs % 60,
      total: secs
    };
  }

  function stepClock(totalSeconds, part, delta) {
    var parts = splitClock(totalSeconds);
    var step = Math.floor(Number(delta) || 0);
    if (!step) return parts.total;
    if (part === "min") {
      parts.minutes = clampInt(parts.minutes + step, 0, MAX_MINUTES, 0);
      return parts.minutes * 60 + parts.seconds;
    }
    var next = parts.total + step;
    if (next < 0) return 0;
    return splitClock(next).total;
  }

  function parseTypedClock(raw) {
    var digits = String(raw || "").replace(/\D/g, "").slice(0, 5);
    if (!digits) return 0;
    var minutes = 0;
    var seconds = 0;
    if (digits.length <= 2) {
      minutes = parseInt(digits, 10);
    } else if (digits.length === 3) {
      minutes = parseInt(digits.charAt(0), 10);
      seconds = parseInt(digits.slice(1), 10);
    } else if (digits.length === 4) {
      minutes = parseInt(digits.slice(0, 2), 10);
      seconds = parseInt(digits.slice(2), 10);
    } else {
      minutes = parseInt(digits.slice(0, 3), 10);
      seconds = parseInt(digits.slice(3), 10);
    }
    return parseClockInputs(minutes, seconds);
  }

  function calculateMatchTime(participant, now) {
    now = now == null ? Date.now() : Number(now);
    if (!isFinite(now)) now = Date.now();
    if (!participant) return 0;
    var matchAtAnchor = Math.max(0, Number(participant.matchSecondsAtAnchor) || 0);
    if (participant.isPaused) return matchAtAnchor;
    var elapsed = Math.max(0, (now - (Number(participant.anchorTimestamp) || now)) / 1000);
    return matchAtAnchor + elapsed;
  }

  function calculateCurrentSeconds(participant, now) {
    return Math.floor(calculateMatchTime(participant, now));
  }

  function alignNowToDisplayedSecond(participant, now) {
    now = now == null ? Date.now() : Number(now);
    if (!isFinite(now)) now = Date.now();
    if (!participant || participant.isPaused) {
      return Math.floor(now / 1000) * 1000;
    }
    var matchAtAnchor = Math.max(0, Number(participant.matchSecondsAtAnchor) || 0);
    var anchor = Number(participant.anchorTimestamp) || now;
    var displayed = Math.floor(calculateMatchTime(participant, now));
    return anchor + (displayed - matchAtAnchor) * 1000;
  }

  function decodeStamp(raw) {
    var stamp = clampInt(raw, 0, STAMP_MS_MAX, 0);
    if (!stamp) return 0;
    if (stamp < STAMP_MS_MIN) stamp *= 1000;
    if (stamp > STAMP_MS_MAX) return STAMP_MS_MAX;
    return stamp;
  }

  function decodeMillis(raw) {
    return clampInt(raw, 0, STAMP_MS_MAX, 0);
  }

  function sanitizeRoomCode(code) {
    return String(code || "")
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, ROOM_CODE_MAX);
  }

  function sanitizeName(name) {
    return String(name || "")
      .replace(/[|<>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NAME_MAX);
  }

  function randomFrom(alphabet, length) {
    var out = "";
    for (var i = 0; i < length; i++) {
      out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
  }

  function randomRoomCode() {
    var words = ["KICK", "DERBY", "FINAL", "PITCH", "EXTRA", "PRESS"];
    var word = words[Math.floor(Math.random() * words.length)];
    return word + "-" + randomFrom("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);
  }

  function makeUserId() {
    return randomFrom("abcdefghjkmnpqrstuvwxyz23456789", 8);
  }

  function ntfyTopic(roomId) {
    var room = sanitizeRoomCode(roomId).toLowerCase();
    return "ssfc_" + room.replace(/[^a-z0-9_-]/g, "");
  }

  function roomKeys(roomId) {
    var room = sanitizeRoomCode(roomId);
    return {
      roster: "ssfcR-" + room,
      meta: "ssfcM-" + room,
      user: function (userId) {
        return "ssfcU-" + room + "-" + userId;
      }
    };
  }

  function encodeRoomMeta(meta, now) {
    now = now || Date.now();
    var createdAt = Math.floor(Number(meta && meta.createdAt) || now);
    if (!createdAt) createdAt = now;
    return String(createdAt);
  }

  function decodeRoomMeta(raw) {
    if (raw == null || raw === "") return null;
    var createdAt = decodeMillis(raw);
    if (!createdAt) createdAt = decodeStamp(raw);
    if (!createdAt) return null;
    return { createdAt: createdAt };
  }

  function roomIsExpired(meta, now, maxAgeMs) {
    now = now == null ? Date.now() : Number(now);
    if (!isFinite(now)) now = Date.now();
    maxAgeMs = maxAgeMs == null ? ROOM_MAX_AGE_MS : maxAgeMs;
    if (!meta || !meta.createdAt) return false;
    return now - Number(meta.createdAt) > maxAgeMs;
  }

  function roomMetaStatus(meta, readOk, now) {
    if (!readOk) return "unknown";
    if (!meta) return "missing";
    if (roomIsExpired(meta, now)) return "expired";
    return "live";
  }

  function sameExpiredGeneration(meta, expiredCreatedAt, now) {
    var expected = Math.floor(Number(expiredCreatedAt) || 0);
    var actual = meta ? Math.floor(Number(meta.createdAt) || 0) : 0;
    if (!expected || !actual || expected !== actual) return false;
    return roomIsExpired(meta, now);
  }

  function encodeViewer(participant, now) {
    now = now || Date.now();
    var name = sanitizeName(participant && participant.name);
    var matchSecs = Math.max(0, Math.floor(Number(participant.matchSecondsAtAnchor) || 0));
    var anchorMs = Math.floor(Number(participant.anchorTimestamp) || now);
    var paused = participant && participant.isPaused ? 1 : 0;
    var seenMs = Math.floor(now);
    return [
      name,
      matchSecs,
      Math.floor(anchorMs / 1000),
      paused,
      Math.floor(seenMs / 1000),
      anchorMs,
      seenMs
    ].join("|");
  }

  function decodeViewer(userId, raw) {
    if (raw == null || raw === "") return null;
    if (raw === "LEFT") {
      return { userId: userId, left: true };
    }
    var parts = String(raw).split("|");
    if (parts.length < 4) return null;
    var name = sanitizeName(parts[0]);
    if (!name) return null;
    var matchSecs = clampInt(parts[1], 0, 200 * 60, 0);
    var anchorMs = parts.length > 5 ? decodeMillis(parts[5]) : decodeStamp(parts[2]);
    if (!anchorMs) return null;
    var seenMs = parts.length > 6
      ? decodeMillis(parts[6])
      : (parts.length > 4 ? decodeStamp(parts[4]) : anchorMs);
    if (!seenMs) seenMs = anchorMs;
    return {
      userId: userId,
      name: name,
      matchSecondsAtAnchor: matchSecs,
      anchorTimestamp: anchorMs,
      isPaused: parts[3] === "1",
      lastSeen: seenMs,
      left: false
    };
  }

  function encodeRoster(ids) {
    var unique = [];
    var seen = {};
    (ids || []).forEach(function (id) {
      var clean = String(id || "").replace(/[^a-z0-9]/g, "").slice(0, 12);
      if (!clean || seen[clean]) return;
      seen[clean] = true;
      unique.push(clean);
    });
    return unique.slice(0, 12).join(",");
  }

  function decodeRoster(raw) {
    if (!raw) return [];
    return encodeRoster(String(raw).split(",")).split(",").filter(Boolean);
  }

  function isOnline(participant, now, windowMs) {
    now = now || Date.now();
    windowMs = windowMs == null ? ONLINE_MS : windowMs;
    if (!participant || participant.left) return false;
    return now - (Number(participant.lastSeen) || 0) <= windowMs;
  }

  function shouldDrop(participant, now, maxAgeMs) {
    now = now || Date.now();
    maxAgeMs = maxAgeMs == null ? STALE_DROP_MS : maxAgeMs;
    if (!participant || participant.left) return true;
    var stamp = Number(participant.lastSeen) || Number(participant.anchorTimestamp) || 0;
    return now - stamp > maxAgeMs;
  }

  function delayBucket(lagSeconds) {
    var lag = Math.abs(Math.floor(Number(lagSeconds) || 0));
    if (lag === 0) return "edge";
    if (lag <= 15) return "slight";
    return "delayed";
  }

  function waitSeverity(seconds) {
    var n = Math.max(0, Math.floor(Number(seconds) || 0));
    if (n <= 5) return "low";
    if (n <= 15) return "mid";
    return "high";
  }

  function formatSignedSeconds(delta) {
    var n = Math.floor(Number(delta) || 0);
    if (n === 0) return "0s";
    return (n > 0 ? "+" : "") + n + "s";
  }

  function decorateParticipants(participants, myUserId, now) {
    now = now || Date.now();
    var list = [];
    (participants || []).forEach(function (p) {
      if (!p || p.left || (p.userId !== myUserId && shouldDrop(p, now))) return;
      var online = p.userId === myUserId ? true : isOnline(p, now);
      var sampleAt = online ? now : (Number(p.lastSeen) || Number(p.anchorTimestamp) || now);
      var matchTime = calculateMatchTime(p, sampleAt);
      list.push({
        userId: p.userId,
        name: p.name,
        matchSecondsAtAnchor: p.matchSecondsAtAnchor,
        anchorTimestamp: p.anchorTimestamp,
        isPaused: !!p.isPaused,
        lastSeen: p.lastSeen,
        matchTime: matchTime,
        calculatedSeconds: Math.floor(matchTime),
        isMe: p.userId === myUserId,
        online: online
      });
    });

    list.sort(function (a, b) {
      if (a.online !== b.online) return a.online ? -1 : 1;
      if (b.matchTime !== a.matchTime) {
        return b.matchTime - a.matchTime;
      }
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });

    var live = [];
    var me = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].online) live.push(list[i]);
      if (list[i].isMe) me = list[i];
    }
    var leaderSecs = live.length ? live[0].calculatedSeconds : 0;
    var mySecs = me ? me.calculatedSeconds : 0;
    var slowestSecs = live.length ? live[live.length - 1].calculatedSeconds : 0;
    var spoilerWaitSeconds = live.length ? leaderSecs - slowestSecs : 0;

    return list.map(function (p, index) {
      var deltaFromLeader = p.calculatedSeconds - leaderSecs;
      var atLiveEdge = p.online && deltaFromLeader === 0;
      return {
        userId: p.userId,
        name: p.name,
        isPaused: p.isPaused,
        lastSeen: p.lastSeen,
        calculatedSeconds: p.calculatedSeconds,
        isMe: p.isMe,
        online: p.online,
        rank: index + 1,
        isLeader: p.online && index === 0,
        atLiveEdge: atLiveEdge,
        deltaFromLeader: deltaFromLeader,
        deltaFromMe: p.calculatedSeconds - mySecs,
        lagFromLeader: Math.abs(deltaFromLeader),
        bucket: delayBucket(deltaFromLeader),
        spoilerWaitSeconds: spoilerWaitSeconds
      };
    });
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function kvSetUrl(key, value) {
    return KV_BASE + "/set/" + encodeURIComponent(key) + "/" + encodeURIComponent(value);
  }

  function kvGetUrl(key) {
    return KV_BASE + "/get/" + encodeURIComponent(key);
  }

  function parseKvResponse(data, mode) {
    if (!data || data.status !== "SUCCESS") return mode === "get" ? null : false;
    return mode === "get" ? data.val : true;
  }

  function buildSession(input, now) {
    now = now || Date.now();
    var roomId = sanitizeRoomCode(input && input.roomId);
    var name = sanitizeName(input && input.name);
    if (!roomId || !name) return null;
    return {
      roomId: roomId,
      name: name,
      matchSecondsAtAnchor: Math.max(0, Math.floor(Number(input.matchSecondsAtAnchor) || 0)),
      anchorTimestamp: Math.floor(Number(input.anchorTimestamp) || now),
      isPaused: !!(input && input.isPaused),
      savedAt: now,
      roomCreatedAt: Math.floor(Number(input.roomCreatedAt) || 0)
    };
  }

  function parseStoredSession(raw, now) {
    now = now || Date.now();
    var data = raw;
    if (raw == null || raw === "") return null;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch (err) {
        return null;
      }
    }
    if (!data || typeof data !== "object") return null;
    var session = buildSession(data, now);
    if (!session) return null;
    var savedAt = Number(data.savedAt) || session.anchorTimestamp;
    var roomCreatedAt = Math.floor(Number(data.roomCreatedAt) || session.roomCreatedAt || 0);
    if (roomCreatedAt && roomIsExpired({ createdAt: roomCreatedAt }, now)) return null;
    if (now - savedAt > SESSION_MAX_AGE_MS) return null;
    session.savedAt = savedAt;
    session.roomCreatedAt = roomCreatedAt;
    session.matchSecondsAtAnchor = Math.max(0, Math.floor(Number(data.matchSecondsAtAnchor) || 0));
    session.anchorTimestamp = Math.floor(Number(data.anchorTimestamp) || now);
    session.isPaused = !!data.isPaused;
    return session;
  }

  function sessionShouldResume(session, roomFromUrl) {
    if (!session) return false;
    var room = sanitizeRoomCode(roomFromUrl);
    if (!room) return true;
    return room === session.roomId;
  }

  function pickRoomLeader(participants, now) {
    now = now || Date.now();
    var best = null;
    var bestSecs = -1;
    var bestOnline = false;
    var liveCount = 0;
    var count = 0;
    (participants || []).forEach(function (p) {
      if (!p || p.left || shouldDrop(p, now)) return;
      count += 1;
      var live = isOnline(p, now);
      if (live) liveCount += 1;
      var sampleAt = live ? now : (Number(p.lastSeen) || Number(p.anchorTimestamp) || now);
      var secs = calculateCurrentSeconds(p, sampleAt);
      if (!best) {
        best = p;
        bestSecs = secs;
        bestOnline = live;
        return;
      }
      if (live && !bestOnline) {
        best = p;
        bestSecs = secs;
        bestOnline = true;
        return;
      }
      if (live === bestOnline && secs > bestSecs) {
        best = p;
        bestSecs = secs;
      }
    });
    if (!best) return null;
    return {
      userId: best.userId,
      name: best.name,
      matchSecondsAtAnchor: best.matchSecondsAtAnchor,
      anchorTimestamp: best.anchorTimestamp,
      isPaused: !!best.isPaused,
      lastSeen: best.lastSeen,
      calculatedSeconds: bestSecs,
      viewerCount: liveCount || count
    };
  }

  function joinSeedHint(leader) {
    if (!leader) return "";
    var clock = formatMatchSeconds(leader.calculatedSeconds);
    var name = leader.name || "the room";
    if ((leader.viewerCount || 1) <= 1) {
      return "Copied " + name + "'s clock (" + clock + "). Nudge it if your TV is behind or ahead.";
    }
    return "Started from " + name + ", the live edge (" + clock + "). Nudge it to match your TV.";
  }

  return {
    ROOM_CODE_MAX: ROOM_CODE_MAX,
    NAME_MAX: NAME_MAX,
    STALE_DROP_MS: STALE_DROP_MS,
    ROOM_MAX_AGE_MS: ROOM_MAX_AGE_MS,
    SESSION_MAX_AGE_MS: SESSION_MAX_AGE_MS,
    ONLINE_MS: ONLINE_MS,
    KV_BASE: KV_BASE,
    formatMatchSeconds: formatMatchSeconds,
    parseClockInputs: parseClockInputs,
    splitClock: splitClock,
    stepClock: stepClock,
    parseTypedClock: parseTypedClock,
    MAX_MINUTES: MAX_MINUTES,
    calculateMatchTime: calculateMatchTime,
    calculateCurrentSeconds: calculateCurrentSeconds,
    alignNowToDisplayedSecond: alignNowToDisplayedSecond,
    sanitizeRoomCode: sanitizeRoomCode,
    sanitizeName: sanitizeName,
    randomRoomCode: randomRoomCode,
    makeUserId: makeUserId,
    ntfyTopic: ntfyTopic,
    roomKeys: roomKeys,
    encodeRoomMeta: encodeRoomMeta,
    decodeRoomMeta: decodeRoomMeta,
    roomIsExpired: roomIsExpired,
    roomMetaStatus: roomMetaStatus,
    sameExpiredGeneration: sameExpiredGeneration,
    encodeViewer: encodeViewer,
    decodeViewer: decodeViewer,
    encodeRoster: encodeRoster,
    decodeRoster: decodeRoster,
    isOnline: isOnline,
    shouldDrop: shouldDrop,
    delayBucket: delayBucket,
    waitSeverity: waitSeverity,
    formatSignedSeconds: formatSignedSeconds,
    decorateParticipants: decorateParticipants,
    escapeHtml: escapeHtml,
    kvSetUrl: kvSetUrl,
    kvGetUrl: kvGetUrl,
    parseKvResponse: parseKvResponse,
    buildSession: buildSession,
    parseStoredSession: parseStoredSession,
    sessionShouldResume: sessionShouldResume,
    pickRoomLeader: pickRoomLeader,
    joinSeedHint: joinSeedHint
  };
});
