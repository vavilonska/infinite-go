# Optional analysis and move providers

Infinite Go can use an explicitly selected HTTP provider or the optional browser provider. Human-human play displays win rates only; suggestions are not exposed and autoplay requires the AI-game mode. It works without one. Provider evaluations are advisory estimates; they never determine a settled timeline's winner or its exact fractional match weight.

## Local KataGo adapter

The optional `katago-bridge.js` launches a separate KataGo analysis process. It does not attach to an existing game, tournament, benchmark, or engine session. No executable, neural-network weights, account, API key, or external AI service is included.

Obtain an engine and model from the [official KataGo project](https://github.com/lightvector/KataGo) and its linked official downloads. Install an appropriate build for your own machine. Then, with Node.js 22 or newer:

```sh
node katago-bridge.js --katago /path/to/katago --model /path/to/model.bin.gz
```

Alternatively set `KATAGO_BIN` and `KATAGO_MODEL`. `KATAGO_CONFIG` or `--config` accepts an existing analysis configuration; otherwise the included small `katago-analysis.cfg` is used. The adapter forces one analysis thread, one search thread, two Eigen CPU threads, Black-perspective reports, and full pre-root history. Its default search budget is 64 visits; `KATAGO_VISITS` or `--visits` can set another budget. This low default favors responsiveness and is not a strength guarantee.

The bridge listens only on `http://127.0.0.1:8787`; `KATAGO_PORT` or `--port` changes the port. Run the app's normal server separately and enter this bridge address in the provider UI. The bridge's terminal shows model-loading and engine errors. Initial loading can take substantially longer than later requests.

By default the bridge permits browser requests only from the app origins `http://localhost:8000` and `http://127.0.0.1:8000`. To use the app at another local address or port, set the exact origin, for example:

```sh
node katago-bridge.js --katago /path/to/katago --model /path/to/model.bin.gz \
  --origins http://localhost:8000,http://192.168.1.12:8000
```

`KATAGO_ORIGINS` accepts the same comma-separated list. This is an allowlist of pages permitted to request computation on your computer, so add only app origins you trust. Do not use wildcards or remote untrusted sites. No firewall, router, or browser security setting is changed. The loopback bridge can be used only by a browser on the same computer as the bridge; another LAN device cannot access it. A browser's local-network permission prompt, if any, remains the user's choice.

## Provider contract

The browser calls `GET /capabilities`, `POST /analyze`, `POST /generate-move`, and optionally `POST /cancel`. Capabilities include `analyze: true`, `generateMove: true`, `cancel: true`, and `winratePerspective: "black"`. POST bodies use `Content-Type: application/json`. A custom provider must support the same complete-history contract:

```json
{
  "requestId": "unique-request-123",
  "nodeId": "timeline-2:move-15",
  "boardSize": 9,
  "komi": 7.5,
  "rules": "chinese-positional-superko",
  "history": [
    { "type": "play", "color": "B", "at": 40 },
    { "type": "pass", "color": "W" }
  ]
}
```

`at` is a zero-based row-major index starting at the top left. Each request includes every move inherited from its ancestors, not merely the current board or the moves since its branch. Passes retain their colors. The adapter validates the history with the game engine before analysis; local `resume` events are validated but omitted from the KataGo move list because they do not place a stone or consume a turn. Actual passes remain in that list. Fractional komi must be an integer or half-integer for this adapter.

A result echoes `requestId` and `nodeId`, includes `blackWinrate` between 0 and 1, and may include `visits` and `move`. Move generation must provide either `{ "type": "play", "at": 40 }` or `{ "type": "pass" }`. Winrate is always from Black's perspective, even when White is about to play. The client must discard cancelled or stale results and revalidate a proposed move against its current state before applying it.

`POST /cancel` takes `{ "requestId": "unique-request-123" }` and returns the ID and a `cancelled` boolean. Cancellation sends KataGo's terminate command for only that query and rejects its pending HTTP request; late output from it cannot become a new move. Closing an analysis request also cancels its computation. Eight active requests are allowed, and each times out after two minutes. A stopped or failed engine is reported as unavailable; the bridge does not silently substitute random moves or another service.

## Rules, caveats, and final scores

The bridge explicitly requests positional superko, area scoring, no suicide, no group tax or button, no handicap bonus, and ordinary friendly passing. It does not use KataGo's plain `chinese` shortcut, whose ko setting differs. Every proposed move is checked with Infinite Go's own full-history rules as well. Warnings about unsupported settings are treated as errors rather than quietly changing the game's rules. See KataGo's [analysis protocol](https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md) and [rules API](https://github.com/lightvector/KataGo/blob/master/docs/GTP_Extensions.md).

KataGo evaluates an individual board history. It is not a complete strategy engine for the branching meta-game: it does not optimize choices across timeline weights, global rounds, or possible new branches. History-aware analysis protects move legality but does not make a probability estimate a match outcome.

There is no automatic final dead-stone adjudication. After two passes, players must review dead groups and approve the score, or resume play to settle a disagreement. A provider's winrate, score estimate, pass recommendation, or confidence cannot substitute for that agreement. Model behavior after a resumed scoring dispute may differ from ordinary positions, and the game engine remains authoritative.

The local bridge does not send game histories to the Internet. Selecting a different custom provider sends the complete requested histories to that provider; use only a destination you trust. Do not put credentials into endpoint URLs. Production public hosting and provider authentication are outside this prototype's scope.

With compensation pruning, every analysis request uses that leaf's **current effective komi**, including the match-level ledger; a settled leaf's effective komi is frozen. Historical rewinds do not remove compensation. The KataGo bridge accepts effective komi only within [-400, 400], in half-point increments, and reports a clear error outside that range rather than silently changing the rule.


## Optional browser provider

See [browser build, model selection and verified limits](BROWSER-AI.md). Its `analyze` and `generateMove` adapter preserves request/node identity and the existing legality checks. It runs a TypeScript search with TensorFlow.js, not a hosted KataGo process. Web Worker cancellation and state revisions prevent stale replies from being played.
