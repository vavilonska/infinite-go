# Playing on a trusted local network

LAN play uses a tiny, dependency-free Node.js server. The host is authoritative: it validates every move and stores one shared game. No account, online service, database, or Internet connection is required after downloading the project.

## Start a game

1. Install Node.js 22 or newer on one computer and open a terminal in this project.
2. Run `node server.js`.
3. On the host, open `http://localhost:8000`. The terminal also prints local network addresses, such as `http://192.168.1.12:8000`.
4. On the other device, join the same trusted Wi-Fi or wired network and open the host's printed LAN address in a browser. Use the actual address printed on your host, not the example above.
5. The first player creates a room and receives Black. Your friend joins as White. If exactly one room has an open seat, the client can find it without a code; otherwise share the six-character room code or a link with `?room=CODE`. Both players must use the host's server, rather than separate static copies of the page.

The server binds to `0.0.0.0:8000` to accept LAN connections. `PORT=8080 node server.js` selects another port. `HOST=127.0.0.1 node server.js` restricts it to the host computer for local-only testing. These environment-variable examples use POSIX shells; Windows PowerShell can use `$env:PORT=8080; node server.js`.

The program does not modify firewall or router settings. If a second device cannot connect, check that it uses the same network and the correct host address and port. Guest-network isolation or a firewall can block local connections; follow your network's policy rather than disabling security protections.

## Reconnect and persistence

Creating or joining a room returns a cryptographically random reconnect token for that player's seat. The browser can keep the token locally and restore its own seat after a refresh; the room code alone does not reclaim a seat. Keep reconnect tokens private. Two tabs using the same token are the same player, not separate seats. A third person cannot join an already-full room.

Rooms are held only in the host process's memory. Stopping the server or restarting the host loses the rooms. There is no automatic disk persistence or restore/import endpoint for LAN games. Save an export from the client if you want an offline copy. Rooms expire after 24 hours without an authenticated read or action or a successful join. A running browser that polls keeps its room active. At most 100 rooms are kept by default.

## Trust and safety

**Use this only with people and devices you trust on a private LAN. Do not forward the port on your router or expose this server to the Internet.**

This prototype serves ordinary unencrypted HTTP, not HTTPS. Someone able to inspect LAN traffic may see game state and reconnect tokens. A local room directory exposes room codes and whether seats are filled, so anyone who can reach the host can claim an empty White seat. There are no accounts, public game-state spectator endpoints, moderation, anti-abuse service, or production Internet-security guarantees. The host controls its own server and can modify it; this is not a cheating-resistant tournament system.

The server only serves the client assets (`index.html`, `app.js`, `engine.js`, `tree.js`, `providers.js`, `ai.js`, and `style.css`, with `/` as an index alias). It never exposes the project directory, source-control metadata, arbitrary local files, or reconnect tokens in another player's state response. Cross-origin browser API requests are rejected, and request bodies and room counts are bounded. These precautions do not make public Internet hosting safe.

## HTTP API

All request bodies are JSON with `Content-Type: application/json`. Poll and action requests require `Authorization: Bearer <token>`. Tokens belong in headers, never in URLs. The browser should use same-origin relative URLs.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /api/health` | none | `{ "ok": true, "mode": "lan" }` |
| `GET /api/rooms` | none | `{ "rooms": [{ "code": "ABC234", "players": { "B": true, "W": false } }] }`; no game state or tokens |
| `POST /api/rooms` | `{ "size": 9, "komi": 7.5 }`; either field may be omitted | New room, Black's token and snapshot; status 201 |
| `POST /api/rooms/CODE/join` | `{}` | White's token and snapshot |
| `GET /api/rooms/CODE` | none | Current authenticated player's snapshot |
| `POST /api/rooms/CODE/actions` | Action below | New authoritative snapshot |

A snapshot contains `code`, `role` (`B` or `W`), monotonic `revision`, `game` (the normal exportable engine state), and `players` (`{ B: true, W: false }` until White joins). Only the create/join response includes `token`. Joining also increments the revision, so refresh the state before the next action. Player booleans mean occupied seats, not current network presence.

Actions all require the latest `revision` and a timeline `id`:

```json
{ "revision": 1, "type": "play", "id": 1, "index": 0, "at": 40 }
```

- `play`: requires `index` and `at`; use `at: null` to pass. The server checks that the token's player owns the current turn on that timeline. Historical branching still obeys the engine's timeline queue and turn rules.
- `toggleDead`: requires `at`; either player can toggle a dead group during unsettled scoring. This clears both approvals.
- `approveScore`: approves only the token's own color. An optional `color` field must match that role; clients normally omit it. Both players must approve before a timeline settles.
- `resume`: either player can resume unsettled scoring to resolve a dispute through play. Settled timelines cannot be resumed.

Unknown fields and malformed values are rejected. A stale revision returns status 409 with `{ error, ...currentSnapshot }`; update the UI from it and let the user choose again rather than blindly resubmitting a move. Other failures use `{ error }`: 400 malformed request, 401 absent/invalid token, 403 wrong role/origin, 404 missing/expired room, 409 full room, 413 body too large, 415 unsupported content type, 422 illegal game action, 503 room capacity reached. No rejected action changes the game or its revision.

Polling about once per second is sufficient for casual LAN play. Keep at most one poll in flight, discard responses older than the current revision, and display a reconnect notice on network errors. Authentication tokens must never be included in a game export, screenshot, shared room link, or diagnostic log.

## Tests

Run `node --test test/server.test.js` (or `npm test` for the whole project). Integration tests open short-lived loopback listeners on random ports; they do not change the firewall or start an externally reachable service. Importing `createServer` from `server.js` creates an unbound server, letting applications and tests choose their own listen address.
