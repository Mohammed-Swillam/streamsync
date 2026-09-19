"use strict";

var sync = require("./sync.js");
var failed = 0;
var passed = 0;

function assert(name, condition) {
  if (condition) {
    passed += 1;
    console.log("ok  - " + name);
  } else {
    failed += 1;
    console.error("fail - " + name);
  }
}

function eq(name, actual, expected) {
  var ok = actual === expected;
  if (!ok) {
    console.error("     expected", expected, "got", actual);
  }
  assert(name, ok);
}

eq("format 0", sync.formatMatchSeconds(0), "00:00");
eq("format 10:40", sync.formatMatchSeconds(640), "10:40");
eq("format 90:00", sync.formatMatchSeconds(5400), "90:00");
eq("format extra time 93:12", sync.formatMatchSeconds(5592), "93:12");
eq("format ignores junk", sync.formatMatchSeconds("nope"), "00:00");

eq("parse clock 10:40", sync.parseClockInputs("10", "40"), 640);
eq("parse clamps seconds", sync.parseClockInputs(12, 99), 12 * 60 + 59);
eq("parse empty", sync.parseClockInputs("", ""), 0);
eq("type 7 means 7:00", sync.parseTypedClock("7"), 7 * 60);
eq("type 73 means 73:00", sync.parseTypedClock("73"), 73 * 60);
eq("type 730 means 7:30", sync.parseTypedClock("730"), 7 * 60 + 30);
eq("type 1040 means 10:40", sync.parseTypedClock("1040"), 640);
eq("type 73:08", sync.parseTypedClock("73:08"), 73 * 60 + 8);
eq("type 104:00 extra time", sync.parseTypedClock("10400"), 104 * 60);
eq("typed seconds clamp at 59", sync.parseTypedClock("1061"), 10 * 60 + 59);
eq("split 10:40", sync.splitClock(640).minutes, 10);
eq("step +1 minute", sync.stepClock(640, "min", 1), 700);
eq("step +1 second wraps", sync.stepClock(10 * 60 + 59, "sec", 1), 11 * 60);
eq("step -1 second at zero stays", sync.stepClock(0, "sec", -1), 0);

var frozen = Date.now();
eq(
  "paused clock stays put",
  sync.calculateCurrentSeconds(
    { matchSecondsAtAnchor: 640, anchorTimestamp: frozen - 15000, isPaused: true },
    frozen
  ),
  640
);
eq(
  "running clock adds elapsed wall time",
  sync.calculateCurrentSeconds(
    { matchSecondsAtAnchor: 640, anchorTimestamp: frozen - 10500, isPaused: false },
    frozen
  ),
  650
);

eq("sanitize room keeps readable code", sync.sanitizeRoomCode("  derby-7k3q! "), "DERBY-7K3Q");
eq("sanitize room strips junk", sync.sanitizeRoomCode("el clasico 24"), "ELCLASICO24");
eq("sanitize name trims and blocks pipes", sync.sanitizeName("  Alex | TV  "), "Alex TV");

var encoded = sync.encodeViewer(
  {
    name: "Sara",
    matchSecondsAtAnchor: 660,
    anchorTimestamp: 1789591008000,
    isPaused: false
  },
  1789591012000
);
eq("encode viewer compact string", encoded, "Sara|660|1789591008000|0|1789591012000");

var decoded = sync.decodeViewer("abc12345", encoded);
eq("decode name", decoded.name, "Sara");
eq("decode match seconds", decoded.matchSecondsAtAnchor, 660);
eq("decode keeps millisecond anchor", decoded.anchorTimestamp, 1789591008000);
eq("decode paused", decoded.isPaused, false);
eq("decode leftover flag", decoded.left, false);
eq("left tombstone", sync.decodeViewer("abc12345", "LEFT").left, true);
eq("missing payload is unknown, not leave", sync.decodeViewer("abc12345", null), null);
eq("reject empty name", sync.decodeViewer("abc12345", "|1|1|0"), null);
var legacy = sync.decodeViewer("abc12345", "Sara|660|1789591008|0|1789591012");
eq("legacy second stamps still decode", legacy.anchorTimestamp, 1789591008000);
eq("legacy seen stamp still decodes", legacy.lastSeen, 1789591012000);

eq("roster unique", sync.encodeRoster(["aa", "bb", "aa", ""]), "aa,bb");
eq("roster decode", sync.decodeRoster("aa,bb,aa").join(","), "aa,bb");

var now = 1_000_000;
var ranked = sync.decorateParticipants(
  [
    {
      userId: "slow",
      name: "Tom",
      matchSecondsAtAnchor: 640,
      anchorTimestamp: now,
      lastSeen: now,
      isPaused: false
    },
    {
      userId: "fast",
      name: "Sara",
      matchSecondsAtAnchor: 655,
      anchorTimestamp: now,
      lastSeen: now,
      isPaused: false
    },
    {
      userId: "me",
      name: "Alex",
      matchSecondsAtAnchor: 650,
      anchorTimestamp: now,
      lastSeen: now,
      isPaused: false
    }
  ],
  "me",
  now
);

eq("sorts fastest first", ranked.map(function (p) { return p.name; }).join(","), "Sara,Alex,Tom");
eq("leader is fastest", ranked[0].isLeader, true);
eq("you are marked", ranked[1].isMe, true);
eq("delta vs leader for you", ranked[1].deltaFromLeader, -5);
eq("delta vs you for leader", ranked[0].deltaFromMe, 5);
eq("tom lag vs leader", ranked[2].lagFromLeader, 15);
eq("spoiler wait is gap to slowest", ranked[0].spoilerWaitSeconds, 15);
eq("slight bucket at 5s", ranked[1].bucket, "slight");
eq("slight bucket at 15s", ranked[2].bucket, "slight");
eq("edge bucket", ranked[0].bucket, "edge");
eq("16s is delayed", sync.delayBucket(-16), "delayed");

var staggerT0 = 10_000;
var staggerViewers = [
  {
    userId: "sara",
    name: "Sara",
    matchSecondsAtAnchor: 100,
    anchorTimestamp: staggerT0,
    lastSeen: staggerT0 + 2000,
    isPaused: false
  },
  {
    userId: "me",
    name: "Alex",
    matchSecondsAtAnchor: 95,
    anchorTimestamp: staggerT0 - 400,
    lastSeen: staggerT0 + 2000,
    isPaused: false
  }
];
eq("staggered floors would disagree",
  sync.calculateCurrentSeconds(staggerViewers[1], staggerT0 + 100) -
    sync.calculateCurrentSeconds(staggerViewers[0], staggerT0 + 100) !==
    sync.calculateCurrentSeconds(staggerViewers[1], staggerT0 + 600) -
      sync.calculateCurrentSeconds(staggerViewers[0], staggerT0 + 600),
  true
);
var alignedEarly = sync.alignNowToDisplayedSecond(staggerViewers[1], staggerT0 + 100);
var alignedSameSecond = sync.alignNowToDisplayedSecond(staggerViewers[1], staggerT0 + 500);
eq("align holds the sample time inside one match second", alignedEarly, alignedSameSecond);
var alignedRanked = sync.decorateParticipants(staggerViewers, "me", alignedEarly);
var alignedMe = alignedRanked.filter(function (p) { return p.isMe; })[0];
var alignedLeader = alignedRanked[0];
eq(
  "leaderboard delta equals the displayed clocks",
  alignedMe.deltaFromLeader,
  alignedMe.calculatedSeconds - alignedLeader.calculatedSeconds
);
eq(
  "same match second keeps the same delay",
  alignedMe.deltaFromLeader,
  sync.decorateParticipants(staggerViewers, "me", alignedSameSecond).filter(function (p) { return p.isMe; })[0].deltaFromLeader
);

var shotT = 1_700_000_000_000;
var shotViewers = [
  {
    userId: "elpop",
    name: "Elpop",
    matchSecondsAtAnchor: 83 * 60 + 30,
    anchorTimestamp: shotT - 800,
    lastSeen: shotT,
    isPaused: false
  },
  {
    userId: "me",
    name: "Test",
    matchSecondsAtAnchor: 83 * 60 + 21,
    anchorTimestamp: shotT,
    lastSeen: shotT,
    isPaused: false
  }
];
var shotTick = sync.alignNowToDisplayedSecond(shotViewers[1], shotT + 400);
var shotRanked = sync.decorateParticipants(shotViewers, "me", shotTick);
var shotMe = shotRanked.filter(function (p) { return p.isMe; })[0];
var shotLead = shotRanked[0];
eq("screenshot clocks are 83:30 vs 83:21", sync.formatMatchSeconds(shotLead.calculatedSeconds) + "/" + sync.formatMatchSeconds(shotMe.calculatedSeconds), "83:30/83:21");
eq("screenshot delay follows the 9s clock gap, not a rounded 10s", shotMe.deltaFromLeader, -9);
eq("screenshot vs-you on the leader is +9s", shotLead.deltaFromMe, 9);

var elevenT = 2_000_000_000_000;
var elevenViewers = [
  {
    userId: "elpop",
    name: "Elpop",
    matchSecondsAtAnchor: 83 * 60 + 31,
    anchorTimestamp: elevenT,
    lastSeen: elevenT,
    isPaused: false
  },
  {
    userId: "me",
    name: "Test",
    matchSecondsAtAnchor: 83 * 60 + 20,
    anchorTimestamp: elevenT,
    lastSeen: elevenT,
    isPaused: false
  }
];
var elevenRanked = sync.decorateParticipants(elevenViewers, "me", elevenT);
eq("an 11s join stays 11s on the board", elevenRanked.filter(function (p) { return p.isMe; })[0].deltaFromLeader, -11);

var meClock = {
  matchSecondsAtAnchor: 54,
  anchorTimestamp: 20_000,
  isPaused: false
};
eq("displayed-second align pins to clock rollover", sync.alignNowToDisplayedSecond(meClock, 20_640), 20_000);
eq("displayed-second align holds through the same second", sync.alignNowToDisplayedSecond(meClock, 20_999), 20_000);
eq("displayed-second align steps with the main clock", sync.alignNowToDisplayedSecond(meClock, 21_000), 21_000);

eq("signed format ahead", sync.formatSignedSeconds(12), "+12s");
eq("signed format behind", sync.formatSignedSeconds(-7), "-7s");
eq("ntfy topic from room", sync.ntfyTopic("DERBY-7K3Q"), "ssfc_derby-7k3q");
eq("kv user key", sync.roomKeys("DERBY-7K3Q").user("ab12cd34"), "ssfcU-DERBY-7K3Q-ab12cd34");
eq("escape html", sync.escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");

var dropped = sync.decorateParticipants(
  [
    {
      userId: "ghost",
      name: "Old",
      matchSecondsAtAnchor: 10,
      anchorTimestamp: now - sync.STALE_DROP_MS - 1000,
      lastSeen: now - sync.STALE_DROP_MS - 1000
    },
    {
      userId: "me",
      name: "Alex",
      matchSecondsAtAnchor: 10,
      anchorTimestamp: now,
      lastSeen: now
    }
  ],
  "me",
  now
);
eq("drops abandoned viewers after 4h", dropped.length, 1);

var savedAt = 1_700_000_000_000;
var session = sync.buildSession(
  {
    roomId: "BARCA",
    name: "Elpop",
    matchSecondsAtAnchor: 640,
    anchorTimestamp: savedAt,
    isPaused: false
  },
  savedAt
);
eq("session keeps room", session.roomId, "BARCA");
eq("session keeps name", session.name, "Elpop");

var parsed = sync.parseStoredSession(JSON.stringify(session), savedAt + 15000);
eq("session survives JSON roundtrip", parsed.matchSecondsAtAnchor, 640);
eq(
  "clock continues after refresh",
  sync.calculateCurrentSeconds(parsed, savedAt + 15000),
  655
);
eq("resume when url room matches", sync.sessionShouldResume(parsed, "BARCA"), true);
eq("resume when url has no room", sync.sessionShouldResume(parsed, ""), true);
eq("do not resume a different room", sync.sessionShouldResume(parsed, "MADRID"), false);
eq("reject junk session", sync.parseStoredSession("not-json", savedAt), null);
eq(
  "reject expired session",
  sync.parseStoredSession(JSON.stringify(session), savedAt + sync.SESSION_MAX_AGE_MS + 1),
  null
);

var paused = sync.parseStoredSession(
  JSON.stringify({
    roomId: "BARCA",
    name: "Elpop",
    matchSecondsAtAnchor: 2700,
    anchorTimestamp: savedAt,
    isPaused: true,
    savedAt: savedAt
  }),
  savedAt + 60000
);
eq("paused session stays paused after refresh", sync.calculateCurrentSeconds(paused, savedAt + 60000), 2700);

eq("empty room has no leader", sync.pickRoomLeader([], now), null);

var only = sync.pickRoomLeader(
  [
    {
      userId: "host",
      name: "Elpop",
      matchSecondsAtAnchor: 1800,
      anchorTimestamp: now,
      lastSeen: now,
      isPaused: false
    }
  ],
  now
);
eq("solo room leader is the only viewer", only.name, "Elpop");
eq("solo room leader clock", only.calculatedSeconds, 1800);
eq("solo room viewerCount", only.viewerCount, 1);
eq(
  "solo seed hint names the host",
  sync.joinSeedHint(only).indexOf("Elpop") !== -1,
  true
);

var ahead = sync.pickRoomLeader(
  [
    {
      userId: "slow",
      name: "Tom",
      matchSecondsAtAnchor: 1800,
      anchorTimestamp: now,
      lastSeen: now
    },
    {
      userId: "fast",
      name: "Sara",
      matchSecondsAtAnchor: 1830,
      anchorTimestamp: now,
      lastSeen: now
    }
  ],
  now
);
eq("multi room leader is the live edge", ahead.name, "Sara");
eq("multi room viewerCount", ahead.viewerCount, 2);
eq(
  "multi seed hint mentions live edge",
  sync.joinSeedHint(ahead).indexOf("live edge") !== -1,
  true
);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
