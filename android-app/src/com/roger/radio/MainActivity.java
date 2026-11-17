package com.roger.radio;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;

/** Roger for Android: the live Roger page in a full-screen WebView, with mic access, a keep-alive service,
 *  a floating talk button over other apps, and an optional volume-down talk key. */
public class MainActivity extends Activity {
    static final String HOME = "https://roger-oa70.onrender.com/";
    static final String HOST = "roger-oa70.onrender.com";
    static final int REQ_PERMS = 7;

    static MainActivity current;      // the live activity, used by the floating button
    WebView web;
    private PermissionRequest pending;
    private boolean volKeyDown = false;
    boolean visible = false;

    SharedPreferences prefs() { return getSharedPreferences("roger", MODE_PRIVATE); }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        current = this;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        // Full-screen "Updating Roger" cover, only shown while an update is downloading/installing.
        cover = new TextView(this);
        cover.setBackgroundColor(0xFF0a0e14);
        cover.setTextColor(0xFFcfd8e3);
        cover.setTextSize(18);
        cover.setGravity(Gravity.CENTER);
        cover.setPadding(48, 48, 48, 48);
        cover.setVisibility(View.GONE);
        cover.setClickable(true);
        root.addView(cover, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " RogerAndroid/2.0");
        web.addJavascriptInterface(new Bridge(), "RogerApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (!r.isForMainFrame()) return;
                String html = "<html><body style='background:#0a0e14;color:#cfd8e3;font-family:sans-serif;text-align:center;padding:48px 24px'>"
                        + "<h2 style='color:#7ee787'>Roger can't reach the server</h2>"
                        + "<p>Check your signal, then try again. If the server was asleep it can take up to a minute to wake up.</p>"
                        + "<p><a href='" + HOME + "' style='color:#0a0e14;background:#7ee787;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold'>Try again</a></p>"
                        + "</body></html>";
                v.loadDataWithBaseURL(HOME, html, "text/html", "utf-8", null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(new Runnable() {
                    @Override public void run() { handleWebPermission(req); }
                });
            }
        });

        askPermissions();
        setVolumeControlStream(AudioManager.STREAM_MUSIC);       // the phone's volume buttons control the normal media volume
        if (b == null) web.loadUrl(HOME + "?touch=1"); else web.restoreState(b);
    }

    private TextView cover;

    /** Update progress screen: text = null hides it. pct is only used for the message. Safe to call from any thread. */
    void updateUi(final String text, final int pct) {
        runOnUiThread(new Runnable() { @Override public void run() {
            if (cover == null) return;
            if (text == null) { cover.setVisibility(View.GONE); return; }
            cover.setText(text); cover.setVisibility(View.VISIBLE);
        } });
    }

    boolean canInstall() { return Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls(); }

    void askInstallPermission() {
        runOnUiThread(new Runnable() { @Override public void run() {
            try { askedInstall = true; startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()))); } catch (Exception ignored) { askedInstall = false; updateUi(null, 0); }
        } });
    }

    private boolean askedInstall = false, wentToSettings = false;

    @Override protected void onResume() {
        super.onResume();
        if (wentToSettings) { wentToSettings = false; askedInstall = false; Updater.resume(this); }
    }

    /** What the Roger page can ask the app to do. */
    class Bridge {
        @JavascriptInterface public boolean isApp() { return true; }

        @JavascriptInterface public String audioInfo() { return KeepAliveService.audioInfo(MainActivity.this); }

        @JavascriptInterface public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
        }

        @JavascriptInterface public void setFloat(final boolean on, final boolean ask) {
            prefs().edit().putBoolean("float", on).apply();
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (on && ask && !canOverlay()) askOverlayPermission();
                    if (!on) KeepAliveService.hideBubble();
                }
            });
        }

        @JavascriptInterface public void setVolKey(boolean on) { prefs().edit().putBoolean("volkey", on).apply(); }

        @JavascriptInterface public void setBtMic(boolean on) { prefs().edit().putBoolean("btmic", on).apply(); }   // picked up by the audio watcher within a second

        @JavascriptInterface public void setState(final String s) {
            runOnUiThread(new Runnable() { @Override public void run() { KeepAliveService.setBubbleState(s); } });
        }

        @JavascriptInterface public void quit() {
            runOnUiThread(new Runnable() { @Override public void run() { finish(); } });
        }
    }

    boolean canOverlay() { return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this); }

    private void askOverlayPermission() {
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
        } catch (Exception ignored) {}
    }

    /** Run a bit of JavaScript in the Roger page (used by the floating button and the volume key). */
    void js(final String code) {
        runOnUiThread(new Runnable() { @Override public void run() { if (web != null) web.evaluateJavascript(code, null); } });
    }

    void press(boolean down) { js("window.rogerPress&&window.rogerPress(" + (down ? "true" : "false") + ")"); }

    private boolean micGranted() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void askPermissions() {
        ArrayList<String> need = new ArrayList<String>();
        if (!micGranted()) need.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), REQ_PERMS);
        else { startKeepAlive(); maybeAskOverlay(); }
    }

    /** Once, right after the mic question: offer the floating talk button (Android shows its own "Display over other apps" screen). */
    private void maybeAskOverlay() {
        SharedPreferences p = prefs();
        if (p.getBoolean("overlayAsked", false) || !p.getBoolean("float", true) || canOverlay()) return;
        p.edit().putBoolean("overlayAsked", true).apply();
        askOverlayPermission();
    }

    private void handleWebPermission(PermissionRequest req) {
        // Only our own server may use the microphone.
        if (req.getOrigin() == null || !HOST.equals(req.getOrigin().getHost())) { req.deny(); return; }
        boolean wantsMic = false;
        for (String r : req.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
        if (!wantsMic) { req.deny(); return; }
        if (micGranted()) {
            req.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pending = req;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_PERMS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_PERMS) return;
        if (pending != null) {
            if (micGranted()) pending.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); else pending.deny();
            pending = null;
        }
        if (micGranted()) startKeepAlive();
        maybeAskOverlay();
    }

    private void startKeepAlive() {
        try {
            Intent i = new Intent(this, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        } catch (Exception ignored) {}
    }

    // ----- floating button: show it while Roger is not on screen -----
    @Override protected void onStart() {
        super.onStart();
        visible = true;
        KeepAliveService.hideBubble();
        Updater.check(this);          // every time Roger is opened (or comes back to the screen), look for a new version
    }

    @Override protected void onStop() {
        visible = false;
        if (askedInstall) wentToSettings = true;
        if (!isFinishing() && prefs().getBoolean("float", true) && canOverlay()) KeepAliveService.showBubble();
        super.onStop();
    }

    // ----- volume-down = talk (only while Roger is on screen, and only if you turned it on) -----
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent e) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN && prefs().getBoolean("volkey", false)) {
            if (e.getRepeatCount() == 0 && !volKeyDown) { volKeyDown = true; press(true); }
            return true;
        }
        return super.onKeyDown(keyCode, e);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent e) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN && prefs().getBoolean("volkey", false)) {
            if (volKeyDown) { volKeyDown = false; press(false); }
            return true;
        }
        return super.onKeyUp(keyCode, e);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else moveTaskToBack(true); // keep the radio running in the background
    }

    @Override
    protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override
    protected void onDestroy() {
        if (isFinishing()) {
            KeepAliveService.hideBubble();
            stopService(new Intent(this, KeepAliveService.class));
        }
        if (current == this) current = null;
        web.destroy();
        super.onDestroy();
    }
}
