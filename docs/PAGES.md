# GitHub Pages static frontend

The Pages artifact contains only the HTML, CSS, frontend ES modules, LICENSE and NOTICE. It does not contain or run `server.js`, the KataGo bridge, models, binaries, accounts, room persistence or credentials. The app opens a mode menu. Same-screen human play is fully local. AI is disconnected and its dependent modes are disabled until the user connects a compatible service.

All frontend module/style links are relative, so the app works beneath a project prefix such as `/infinite-go/`. The build writes `deployment.js` with `STATIC_HOST = true`; local Node hosting keeps it false. Static mode disables same-origin LAN APIs. GitHub Pages has no default public API. The remote mode cards link to the verified Sites online edition when available; optional custom HTTPS providers remain an explicit choice. No room credentials are sent until the player connects or resumes. See [online matching](MATCHMAKING.md).

## Repository deployment

1. In the repository, open **Settings → Pages**
2. Under **Build and deployment → Source**, select **GitHub Actions**
3. The included **Deploy static Infinite Go** workflow runs on pushes to main or can be started using **Run workflow**
4. It runs `npm test`, packages the static asset allowlist, uploads the artifact, and deploys through GitHub's official Pages actions
5. Use the site URL actually returned by the successful deployment / Pages settings, not an assumed URL while deployment is pending

See GitHub's [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) and [publishing source settings](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

To inspect the artifact locally:

```sh
node scripts/build-static.mjs
python3 -m http.server 8080 --directory dist
```

## Room service and virtual LAN

The public static site is not a room server. Start `npm start` on the host computer, then have both players open the page served by that host's LAN or virtual-network address. This keeps frontend and room API on the same origin. The single-open-room discovery and optional room-code selection work there. See [LAN](LAN.md) and [virtual LAN](REMOTE-PLAY.md).

## AI

For local KataGo, open the locally served Node page on the same computer as the loopback bridge. The Pages build does not connect to loopback by default and cannot run KataGo itself.

An advanced user may explicitly connect their own HTTPS provider from the static page. It must implement the [provider contract](providers.md), allow the exact frontend origin through CORS, and handle its own operational/access controls. Complete selected game histories are sent to that provider. Do not put credentials in the URL, frontend code or public repository.

A public HTTPS page cannot be assumed to reach an HTTP/WS LAN endpoint: mixed-content checks, local-network permission policies and CORS can block it. This app intentionally directs local users to the host-served page instead. Do not disable browser security, broadly authorize an unrelated origin, or expose a bare game/AI endpoint to the public Internet.

## Shared frontend, distinct editions

`remote-config.js` keeps `DEFAULT_REMOTE_ENDPOINT` empty for the repository/static edition. `ONLINE_PLAY_URL` contains only the verified public online-edition page URL; it is a navigation link, not a hidden API default. The Sites deployment configures its own same-origin backend in its build copy. It shares the frontend and engine with this repository. Public Pages users can stay offline, open a LAN host or intentionally choose a custom provider.

A waiting service-worker update never forcibly reloads an active game. Export first, close all tabs for that site, then reopen to receive the new version. The menu reports an available update when detected.
