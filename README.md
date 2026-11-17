# Roger

Push-to-talk radio for squad coordination. Players join channels (COMMAND, ALPHA SQUAD,
MEDEVAC, ...) and talk one at a time, like a real radio.

**Safety and trust:** open source (MIT, see `LICENSE`). Read [PRIVACY-AND-SECURITY.md](PRIVACY-AND-SECURITY.md) for exactly what
Roger does and doesn't do, and [SECURITY.md](SECURITY.md) to verify a download or report a problem. Each release lists the SHA-256
of every file and its scan results. Third-party software: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Parts:

1. **Server** (`server.js`, `public/`) - hosted free on Render, always reachable by link.
2. **Desktop app** (`desktop/`) - a Windows installer players just double-click. Everything it
   needs is inside; no Node, no setup. It also adds a **global talk key** that works while the
   game has focus. Players can alternatively just open the server's link in a browser.
3. **Android app** (ndroid-app/) - a small shell around the same page, with a floating talk button and self-update.
   The installer for it is served by the server at /Roger.apk.

## How talking works
- The server gives each channel to one talker at a time. If someone is talking, your button
  turns red and you can't key up until they finish.
- Join several channels to listen to all of them; click one to talk on it.
- Type a name under "New channel" to create your own.
- A talker is cut off after 60 s; dropped connections free the channel immediately.
- In the desktop app: press the talk key (default **F8**, changeable) once to go on air, press
  again to release. Holding **Space** inside the app window is true hold-to-talk.
- **Nobody can use Roger without an account** that you or a moderator created (see below).

## Accounts, moderators and joint ops
Roger is locked: you sign in with a username + password, then choose a callsign (and can change it
any time in Settings -> Account).

| Role | What they can do |
|---|---|
| **Owner (admin)** | Everything. Creates moderators. Only you set this up (see "One-time setup"). |
| **Moderator** | Opens the **Admin** page: add / delete / disable people, reset passwords, run joint ops, see who is online, read the log, and **kick** people from a channel (10 min block) or out of Roger. Can't touch the owner or other moderators. |
| **Member** | Your group's regular people. |
| **Joint-op** | People from other groups: a **Faction Leader** plus **HICOM 1, HICOM 2...** per faction. A moderator can switch a whole faction off (everyone is signed out at once) or delete it. |

- Passwords are stored hashed, shown once when created / reset, and never kept in the app. A person has
  one live session at a time (signing in elsewhere ends the old one).
- After 6 wrong passwords an account is locked for 5 minutes.
- Moderators see the account (@username) behind every callsign on a channel's people page.

### One-time setup (you do this once on your host)
1. **A free database** (so accounts survive restarts - free web hosting has no permanent disk):
   create a free project at neon.com and copy its **connection string** (starts with `postgresql://`).
2. On Render: your service -> **Environment** -> add three variables:
   - `DATABASE_URL` = the connection string
   - `ADMIN_USER` = the owner username you want (3-24 letters/numbers)
   - `ADMIN_PASSWORD` = a long password you choose (8+ characters; 12+ is better)
3. Redeploy. Sign in as the owner, open **Admin**, and create your moderators.

Forgot the owner password? Change `ADMIN_PASSWORD` on Render and redeploy - it resets the owner login.
Never share `DATABASE_URL`, `ADMIN_PASSWORD` or the tokens with anyone.

## Deploy the server (Render free tier)
1. Put this folder in a GitHub repo (the `.gitignore` already skips build output).
2. render.com -> New -> Web Service -> pick the repo. `render.yaml` fills in the settings
   (Docker via the included Dockerfile, free plan, health check `/health`).
3. You get a URL like `https://roger.onrender.com`.

Free instances sleep after ~15 min with no web traffic and wake in under a minute on the next
visit; the desktop app shows a "waking up" screen while that happens, and clients ping
`/health` every 4 min while open so it stays awake during play sessions.

## Build the installer
On a Windows PC with Node.js (only the person building needs it):

```
.\build-installer.ps1 -ServerUrl https://roger.onrender.com
```

This writes three files to `installer\`:

- `Roger-Setup-<version>.exe` (~80 MB) - the installer players run the first time
- `Roger-Setup-<version>.exe.blockmap` and `latest.yml` - what the auto-updater reads

Because it isn't code-signed, Windows SmartScreen shows "Windows protected your PC" the first
time: click **More info -> Run anyway**. (Updates that install themselves don't show it again.)

Most improvements (screens, channels, fixes) reach everyone automatically because the app loads
its screen from the server. Changes inside `desktop/` (window, hotkeys, overlay) need a new version.

## Publishing an update (auto-update)
Installed apps check GitHub Releases for a newer version a few seconds after they start and every
4 hours. When one is found it downloads in the background, shows "Roger X is ready to install" with a
**Restart & install** button, and installs it when you click that or the next time you quit.

1. Raise `"version"` in `desktop/package.json` (for example 1.2.0 -> 1.2.1).
2. Run `.\build-installer.ps1 -ServerUrl https://<your-app>.onrender.com`.
3. On GitHub: repo -> **Releases** -> **Draft a new release**. Tag `v1.2.1` (same number), then
   drag in **all three** files from `installer\` (the .exe, the .blockmap and `latest.yml`) and click
   **Publish release**.

Everyone running 1.2.0 or newer updates on their own. (Versions before 1.2.0 had no updater and
need one manual install.) The repo must stay **public**. The file names must not be changed.

## Run locally for testing
```
npm install
npm start          # http://localhost:3000
```
Desktop app against a local server: `cd desktop; npm install; $env:BHR_SERVER='http://localhost:3000'; npm start`

## Privacy and safety (what players should know)
- **Voice** travels over an encrypted connection (HTTPS/WSS) to the Roger server, which relays it to the people on the channel.
  It is **not end-to-end encrypted**: the person who runs the server could technically access the audio.
- **History** (the replay list) keeps recent voice messages in the server's **memory only**: up to 40 per channel, no more than
  6 hours, about 30 minutes of audio in total. Nothing is written to disk or the database, and it is wiped whenever the server
  restarts or sleeps.
- **Accounts** store a username, role, last callsign and a slow hash of the password (never the password). Moderator actions are
  logged. There are no ads or trackers.
- **Sign-in is protected:** no public sign-up, wrong guesses lock an account for a few minutes, other websites cannot open a voice
  connection, and the site sends HSTS, a Content-Security-Policy and other protective headers.
- **The apps are not code-signed** (that needs paid developer accounts), so Windows, Android and macOS show a warning the first time.
  The full source is in this public repository, so anyone can read what the apps do.
- **Not independently audited.** Never reuse a password from another account here.
