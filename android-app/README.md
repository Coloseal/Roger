# Roger for Android (source)

A small native shell around the Roger page: a full-screen WebView that opens only your Roger server, grants the microphone to that server only,
keeps the radio alive with the screen off (foreground service), shows the optional floating TALK button, and updates itself.
No third-party libraries; only the Android platform.

- `src/com/roger/radio/MainActivity.java`: the WebView, permissions, the small bridge the page may call, volume-key talk.
- `src/com/roger/radio/KeepAliveService.java`: the "Roger is on" notification, the floating button, the audio-mode watcher.
- `src/com/roger/radio/Updater.java`, `InstallReceiver.java`, `ReopenReceiver.java`: self-update (reads `android-version.json`, checks the SHA-256, installs, reopens).
- `AndroidManifest.xml`: every permission the app asks for (each one is explained in `../PRIVACY-AND-SECURITY.md`).

## Build it yourself
Needs JDK 17 and the Android SDK (platform 34, build-tools 34.0.0). `build.ps1` compiles, creates **your own** signing key the first time
(`roger-release.jks`, never commit it), signs the APK, and publishes it with `android-version.json` into the `public` folder.
Edit the paths at the top of `build.ps1` to match your machine, set `ROGER_PUBLIC` to the repo's `public` folder, and raise `$VC`/`$VN` for each release.
A rebuilt APK is signed with *your* key, so it is a different app identity from the official one: Android will not install it over the official one.
