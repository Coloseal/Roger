package com.roger.radio;

import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/** Checks for a newer Roger app each time it is launched. If there is one it downloads it, installs it and reopens Roger. */
final class Updater {
    static final String ACTION = "com.roger.radio.INSTALL_RESULT";
    private static boolean started = false;      // a check is already running (one check per launch)
    private static long lastCheck = 0;
    private static JSONObject waiting;          // update found, but Android still needs "install unknown apps" allowed

    private Updater() {}

    static void check(final MainActivity a) {
        long now = System.currentTimeMillis();
        if (started || waiting != null || now - lastCheck < 120000) return;      // (at most one check every 2 minutes)
        lastCheck = now;
        started = true;
        new Thread(new Runnable() { @Override public void run() {
            try { doCheck(a); } catch (Throwable t) { a.updateUi(null, 0); } finally { started = false; }
        } }, "roger-update").start();
    }

    /** Called when the user comes back from Android's "install unknown apps" screen. */
    static void resume(final MainActivity a) {
        final JSONObject w = waiting;
        if (w == null) return;
        waiting = null;
        if (!a.canInstall()) { a.updateUi(null, 0); return; }            // they said no: carry on with the current version
        new Thread(new Runnable() { @Override public void run() { try { download(a, w); } catch (Throwable t) { a.updateUi("Update failed. Roger will keep working as it is.", -1); } } }, "roger-update").start();
    }

    private static long installedCode(MainActivity a) throws Exception {
        PackageInfo pi = a.getPackageManager().getPackageInfo(a.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
    }

    private static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000); c.setReadTimeout(90000);       // the free server can take up to a minute to wake up
        c.setRequestProperty("Cache-Control", "no-cache");
        if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
        InputStream in = c.getInputStream();
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096]; int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("utf-8");
    }

    private static void doCheck(MainActivity a) throws Exception {
        JSONObject v = new JSONObject(get(MainActivity.HOME + "android-version.json?t=" + System.currentTimeMillis()));
        if (v.getLong("versionCode") <= installedCode(a)) return;            // up to date
        if (!a.canInstall()) {                                                // Android asks the user once to allow installs from Roger
            waiting = v;
            a.updateUi("A new version of Roger (" + v.optString("versionName") + ") is ready.\n\nAllow Roger to install updates on the next screen, then come back.", -1);
            a.askInstallPermission();
            return;
        }
        download(a, v);
    }

    private static void download(MainActivity a, JSONObject v) throws Exception {
        final String name = v.optString("versionName");
        a.updateUi("Updating Roger to " + name + "\nDownloading…", 0);
        String u = v.getString("url");
        if (!u.startsWith("http")) u = MainActivity.HOME + u.replaceFirst("^/", "");
        File f = new File(a.getCacheDir(), "roger-update.apk");
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setConnectTimeout(20000); c.setReadTimeout(60000);
        if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
        long total = c.getContentLengthLong();
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        InputStream in = c.getInputStream();
        OutputStream out = new FileOutputStream(f);
        byte[] buf = new byte[16384]; int n; long got = 0; int lastPct = -1;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n); md.update(buf, 0, n); got += n;
            if (total > 0) { int pct = (int) (got * 100 / total); if (pct != lastPct) { lastPct = pct; a.updateUi("Updating Roger to " + name + "\nDownloading… " + pct + "%", pct); } }
        }
        out.close(); in.close();
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest()) hex.append(String.format("%02x", b));
        String want = v.optString("sha256", "").toLowerCase();
        if (want.length() > 0 && !want.equals(hex.toString())) { f.delete(); throw new Exception("checksum mismatch"); }
        install(a, f, name);
    }

    private static void install(MainActivity a, File f, String name) throws Exception {
        a.updateUi("Updating Roger to " + name + "\nTap Update when Android asks.", 100);
        PackageInstaller pi = a.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(p);
        PackageInstaller.Session s = pi.openSession(id);
        try {
            OutputStream os = s.openWrite("roger", 0, f.length());
            FileInputStream in = new FileInputStream(f);
            byte[] buf = new byte[16384]; int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            s.fsync(os); os.close(); in.close();
            Intent i = new Intent(ACTION).setPackage(a.getPackageName());
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(a, id, i, fl).getIntentSender());
        } finally { s.close(); }
    }
}
