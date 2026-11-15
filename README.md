# Roger

Push-to-talk radio for squad coordination. Players join channels (COMMAND, ALPHA SQUAD,
MEDEVAC, ...) and talk one at a time, like a real radio.

Two parts:

1. **Server** (`server.js`, `public/`) - hosted free on Render, always reachable by link.
2. **Desktop app** (`desktop/`) - a Windows installer players just double-click. Everything it
   needs is inside; no Node, no setup. It also adds a **global talk key** that works while the
   game has focus. Players can alternatively just open the server's link in a browser.

## How talking works
- The server gives each channel to one talker at a time. If someone is talking, your button
  turns red and you can't key up until they finish.
- Join several channels to listen to all of them; click one to talk on it.
- Type a name under "New channel" to create your own.
- A talker is cut off after 60 s; dropped connections free the channel immediately.
- In the desktop app: press the talk key (default **F8**, changeable) once to go on air, press
  again to release. Holding **Space** inside the app window is true hold-to-talk.
- Optional password: set a `ROOM_KEY` environment variable on the server.

## Deploy the server (Render free tier)
1. Put this folder in a GitHub repo (the `.gitignore` already skips build output).
2. render.com -> New -> Web Service -> pick the repo. `render.yaml` fills in the settings
   (Node, free plan, health check `/health`).
3. You get a URL like `https://roger.onrender.com`.

Free instances sleep after ~15 min with no web traffic and wake in under a minute on the next
visit; the desktop app shows a "waking up" screen while that happens, and clients ping
`/health` every 4 min while open so it stays awake during play sessions.

## Build the installer
On a Windows PC with Node.js (only the person building needs it):

```
.\build-installer.ps1 -ServerUrl https://roger.onrender.com
```

This writes `installer\Roger Setup.exe` (~80 MB). Share that file (Google Drive,
GitHub Releases, Discord...). Because it isn't code-signed, Windows SmartScreen shows "Windows
protected your PC" the first time: click **More info -> Run anyway**.

Because the app loads its screen from the server, most updates (UI, channels, fixes) reach
everyone automatically - no new installer needed. Only changes inside `desktop/` need one.

## Run locally for testing
```
npm install
npm start          # http://localhost:3000
```
Desktop app against a local server: `cd desktop; npm install; $env:BHR_SERVER='http://localhost:3000'; npm start`
