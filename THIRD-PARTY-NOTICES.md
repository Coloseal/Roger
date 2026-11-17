# Third-party software

Roger includes open-source software. Each keeps its own licence. The full licence texts ship with the packages (for the Windows app,
see `LICENSE.electron.txt` and `LICENSES.chromium.html` inside the installed app's folder).

## Server (runs on the host)
| Package | Licence | Use |
|---|---|---|
| ws | MIT | WebSocket connections |
| pg (and its parts: pg-pool, pg-protocol, pg-types, pgpass and others) | MIT | PostgreSQL database |

## Windows app
| Package | Licence | Use |
|---|---|---|
| Electron (includes Chromium and Node.js) | MIT (Chromium: BSD-style and others) | The app window |
| electron-updater and its parts (builder-util-runtime, semver, js-yaml, fs-extra, lazy-val and others) | MIT / ISC | Updates |

Build tools only (not shipped): electron-builder and its dependencies.

## Android app
No third-party libraries: it uses only the Android platform's own components.

## Website
No third-party scripts, fonts or trackers.
