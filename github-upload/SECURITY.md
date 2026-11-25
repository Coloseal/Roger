# Security

## What Roger does and doesn't do
See [PRIVACY-AND-SECURITY.md](PRIVACY-AND-SECURITY.md): no admin rights, no keyboard hooks, no ads or trackers, which servers it talks to, and
what each Android permission is for.

## Verifying a download
Every release lists the SHA-256 of each file and a VirusTotal link in its notes.

**Windows installer** (PowerShell):
```
Get-FileHash .\Roger-Setup-<version>.exe -Algorithm SHA256
```
The result must match the release notes.

**Android app:** the same check (`Get-FileHash .\Roger.apk -Algorithm SHA256`, or `sha256sum Roger.apk`). The app is always signed with the same key, and Android refuses to install an update signed with a different one. The signing certificate's SHA-256 fingerprint is:

```
bc:11:2b:20:6f:ef:0a:59:87:99:ed:c9:5b:68:6d:6b:da:db:e6:9e:6b:30:50:1f:10:10:95:d5:9e:48:2a:3b
```
(Check it with `apksigner verify --print-certs Roger.apk`.)

You can also build everything yourself from this source: `build-installer.ps1` for Windows, and the Android app's source is in the `android-app` folder.

## What is done to keep it safe
- Open source (MIT licence), so anyone can read it.
- Dependencies are checked with `npm audit` (no known vulnerabilities in what ships), and the Windows app runs on a currently supported Electron.
- The server runs on a supported Node.js and, in Docker, as an unprivileged user.
- Passwords are stored as scrypt hashes; sign-in is rate-limited; accounts are created only by the owner or a moderator.
- The site sends HSTS, a strict Content-Security-Policy and other protective headers, only accepts WebSocket connections from its own pages, and is hidden from search engines.
- The Windows installer and the Android APK are scanned with Windows Defender before each release, and the release notes link to a VirusTotal scan.
- Both apps verify an update's fingerprint before installing it.

## Not done (so you know)
- The Windows installer and the Android app are not signed with a paid code-signing certificate, so you may see a SmartScreen or Play Protect warning the first time. If it appears: Windows, **More info → Run anyway**; Android, **Install anyway**.
- Roger has not been independently audited and holds no formal certification.
- Voice is encrypted in transit but not end-to-end encrypted.

## Reporting a security problem
Please report it **privately**: on this repository open the **Security** tab and choose **Report a vulnerability**
(or open an issue that just says "security" with no details, and the owner will contact you).
Include the version (Settings → General in the app) and what you saw. Please don't post details publicly until it is fixed.
