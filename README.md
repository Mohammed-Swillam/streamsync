# StreamSync

A static web page for friends watching the same football match on different broadcasts. Each person types the match clock on their TV. The page keeps counting locally, compares those clocks, and ranks the room from the live edge down to the most delayed feed.

No accounts, no build step, no JavaScript libraries. Host the folder on GitHub Pages or any static host.

## Original version: 4.5 / 10

The first `index.html` in this repo looked finished, but it did not solve the actual problem.

### What was already right

- The timing model was correct: store a match-time **anchor** plus a wall-clock timestamp, then tick locally. Friends should not stream video through this page, and they should not send every clock tick over the network.
- The UI already had the features people need during a match: shareable room link, ±1/5/15 second nudges, exact time, pause for half-time, and a leaderboard sorted fastest to slowest.
- Viewer names in the leaderboard were escaped, so that part was not an XSS hole.

### Why the score is low

1. **Cross-country sync did not work.** Firebase only started if a host injected `__firebase_config`. On GitHub Pages that variable is missing, so the page fell back to `BroadcastChannel`, which only talks to other tabs in the same browser. Two friends in different countries would each see a solo room.
2. **It ignored the "no extra libraries" request.** Tailwind CDN, Google Fonts, and the Firebase SDK are all extra runtime dependencies.
3. **Stale viewers were never cleaned up.** `activeThreshold` was computed and unused. Anyone who closed the tab without hitting Exit stayed in the room.
4. **The Firestore listener read every match document, then filtered in memory.** That does not scale and leaks other rooms into the client snapshot.
5. **Toasts used `innerHTML` with unsanitized strings.**
6. **The WhatsApp button copied text instead of opening a share link.**
7. **The lag legend said 1–15s, the code treated 11s as fully delayed.**
8. **`user-scalable=no` hurts accessibility on a phone next to the TV.**
9. **README was empty**, so there was no way to host or use it.

## What this rewrite changes

- Vanilla HTML, CSS, and JS. Open `index.html` or serve the folder.
- Each viewer still reports only an anchor. Clocks tick on the device.
- Room state is written per person to a tiny public key-value API so a friend can join later, even if your phone is locked.
- Live nudges also go out over a public SSE topic so updates show up in about a second when both pages are open.
- Same-computer tabs still sync with `BroadcastChannel` for local testing.
- Leaderboard is always live-edge first, longest delay last, with delay vs the leader **and** vs you.
- If you are ahead, the caution timer is the gap to the slowest person, not only the next person.
- Names, toasts, and leaderboard rows do not use unsanitized HTML.
- WhatsApp and Telegram open real share URLs.
- Refreshing the page restores the same person, room, and match clock from localStorage.
- Unit tests cover clock math, sorting, and encode/decode.

## How to use it

1. Open the page.
2. Enter your name, a room code, and the minutes:seconds on your TV.
3. Join, then send friends the room link.
4. They type **their** TV clock when they join. The list shows who is ahead.
5. Refreshing keeps you in the room. Tap **Exit** when you want to leave.

Local preview:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

GitHub Pages: Settings → Pages → Deploy from branch `main` (or this branch) → `/` root.

## Tests

```bash
node sync.test.js
```

## Privacy

Room codes are unguessable if you use **Random**. Anyone with the link can read the names and match clocks in that room. Do not put secrets in names. The public sync services are used as a mailbox, not as a login system.
