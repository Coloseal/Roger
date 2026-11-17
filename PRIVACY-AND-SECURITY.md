# Roger: what it does and doesn't do

Roger is a private push-to-talk radio for small groups. It has a server (the thing you connect to), a website, a Windows app,
and an Android app. The source for all of it is in this repository, so you can read exactly what it does.

## The short version
- **No ads, no trackers, no analytics.** Nothing is sent anywhere except to the Roger server you sign in to, and (for updates) to GitHub.
- **No admin rights.** The Windows app installs for your user only. There is no administrator prompt.
- **No keyboard hooks.** The Windows app registers only the talk keys *you* choose, using Windows' standard hotkey feature. It cannot see any other key you press.
- **Your password is never stored**, not on the server (only a slow hash of it) and not on your device (only a sign-in token).
- **Voice is encrypted on the way to the server, but not end-to-end.** See "Voice" below.

## Voice
- Your voice travels over an encrypted connection (HTTPS / secure WebSocket) to the server, which passes it to the people on your channel.
- It is **not end-to-end encrypted**. The server relays the audio, so whoever runs the server could technically access it.
- For the **History** (replay) feature, the server keeps recent voice messages **in memory only**: at most 40 per channel, for no more than 6 hours, and about 30 minutes of audio in total. Nothing is written to a disk or the database. It is wiped whenever the server restarts or sleeps.
- The microphone is used only while you are talking (or while you run the microphone test or turn on VOX). Roger does not record you on your own device.

## Accounts
The server stores, for each account: username, role, last callsign, last sign-in time, and a **scrypt hash** of the password.
It also keeps a log of moderator actions (kicks, resets, and so on). Sign-in is rate-limited (a few wrong guesses lock the account for a few minutes), sign-in tokens are signed and can be revoked, and permissions are enforced on the server, not just in the page. There is no public sign-up: accounts are created by the owner or a moderator.

## The website
- Served over HTTPS only, with HSTS, a strict Content-Security-Policy (only the page's own script may run; nothing from other websites), a permissions policy (microphone for this site only), and anti-framing headers.
- Other websites cannot open a voice connection to the server (the WebSocket checks where the request came from).
- It is hidden from search engines.
- It stores your settings and your sign-in token in your browser's local storage. There are no cookies and no third-party scripts.

## The Windows app
- Loads your Roger server's page in a locked-down window: no Node.js access from the page, context isolation and sandbox on, it cannot navigate to any other website, and links open in your normal browser (web links only).
- Only the microphone permission is granted, and only to your Roger server.
- **Updates:** once each time you open it, the app asks this GitHub repository for a newer release. If there is one it downloads it, checks the file against the SHA-512 fingerprint in the release's `latest.yml`, installs it, and reopens. That is the only other place it talks to.
- Optional (off unless you turn it on): start with Windows, always on top, an on-screen overlay.

## The Android app
It is a thin shell around the same website. These are the permissions it asks for, and why:

| Permission | Why |
|---|---|
| Internet, network state | To reach the Roger server |
| Microphone | To talk (granted only to your Roger server's page) |
| Foreground service + microphone type, notifications | The "Roger is on" notification that keeps the radio alive with the screen off |
| Wake lock | Keeps the connection running while Roger is on |
| Change audio settings | So sound plays on the normal media volume, not the phone-call speaker |
| Display over other apps | The optional floating TALK button (you are asked once; you can say no) |
| Install unknown apps | So the app can update itself from the Roger server (you are asked once, and Android shows its own "Update" screen every time) |

- The app loads only your Roger server's page. Any other link opens in your browser.
- **Updates:** each time you open it, it reads `android-version.json` from the server. A newer version is downloaded, checked against its SHA-256, and handed to Android to install. Android only accepts it if it is signed with the same key as the installed app.

## Third parties
- **Hosting:** the server runs on Render. **Database:** accounts are stored in a Neon Postgres database. **Downloads and updates:** GitHub.
- Each of them can see the technical traffic that passes through their service (for example, connection addresses).

## Honest limits
- The Windows installer and the Android app are **not code-signed with a paid certificate**, so Windows SmartScreen and Android Play Protect may warn the first time. That is about reputation, not behaviour. See `SECURITY.md` for how to check that your download is the real one.
- Roger has **not been independently audited**. It has been tested by its author. Never reuse a password from another account here.
