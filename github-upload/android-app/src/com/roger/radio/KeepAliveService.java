package com.roger.radio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Keeps Roger alive (mic + connection) while the phone is locked or you are in another app,
 *  and shows the floating TALK button over other apps. */
public class KeepAliveService extends Service {
    static KeepAliveService instance;
    private PowerManager.WakeLock lock;

    // Android puts the phone in "VoIP call" mode while a web page records from the microphone, which sends all sound to the
    // quiet call channel. While Roger runs we put it back to normal mode, so sound plays on the media volume like music.
    static int audioFixes = 0;
    private android.os.Handler audioHandler;
    private boolean scoOn = false;
    private final Runnable audioWatch = new Runnable() {
        @Override public void run() {
            try {
                android.media.AudioManager am = (android.media.AudioManager) getSystemService(AUDIO_SERVICE);
                boolean wantBt = getSharedPreferences("roger", MODE_PRIVATE).getBoolean("btmic", false) && btHeadsetPresent(am);
                if (wantBt) {
                    // The user chose the Bluetooth headset's own microphone: Android needs call mode + a Bluetooth call link for that.
                    if (am.getMode() != android.media.AudioManager.MODE_IN_COMMUNICATION) am.setMode(android.media.AudioManager.MODE_IN_COMMUNICATION);
                    if (!scoOn) { am.startBluetoothSco(); am.setBluetoothScoOn(true); scoOn = true; }
                } else {
                    if (scoOn) { am.setBluetoothScoOn(false); am.stopBluetoothSco(); scoOn = false; }
                    if (am.getMode() == android.media.AudioManager.MODE_IN_COMMUNICATION) { am.setMode(android.media.AudioManager.MODE_NORMAL); audioFixes++; }
                }
            } catch (Exception ignored) {}
            if (audioHandler != null) audioHandler.postDelayed(this, 700);
        }
    };

    static boolean btHeadsetPresent(android.media.AudioManager am) {
        try {
            for (android.media.AudioDeviceInfo d : am.getDevices(android.media.AudioManager.GET_DEVICES_INPUTS))
                if (d.getType() == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO) return true;
        } catch (Exception ignored) {}
        return false;
    }

    static String audioInfo(Context c) {
        try {
            int m = ((android.media.AudioManager) c.getSystemService(Context.AUDIO_SERVICE)).getMode();
            String name = m == android.media.AudioManager.MODE_NORMAL ? "media (normal)" : m == android.media.AudioManager.MODE_IN_COMMUNICATION ? "CALL mode" : m == android.media.AudioManager.MODE_IN_CALL ? "phone call" : "mode " + m;
            android.media.AudioManager am = (android.media.AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
            String bt = btHeadsetPresent(am) ? (c.getSharedPreferences("roger", Context.MODE_PRIVATE).getBoolean("btmic", false) ? ", Bluetooth headset mic ON" : ", Bluetooth headset found (using phone mic)") : "";
            return name + ", corrected " + audioFixes + "x" + bt;
        } catch (Exception e) { return "unknown"; }
    }

    private LinearLayout bubble;
    private TextView talk;
    private WindowManager.LayoutParams lp;
    private String state = "ready";

    @Override public IBinder onBind(Intent i) { return null; }

    // ----- called from the activity (main thread) -----
    static void showBubble() { if (instance != null) instance.addBubble(); }
    static void hideBubble() { if (instance != null) instance.removeBubble(); }
    static void setBubbleState(String s) { if (instance != null) instance.applyState(s); }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        instance = this;
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder nb;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel("roger_live", "Roger is running", NotificationManager.IMPORTANCE_LOW);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
            nb = new Notification.Builder(this, "roger_live");
        } else {
            nb = new Notification.Builder(this);
        }
        Notification n = nb.setContentTitle("Roger is on")
                .setContentText("Tap to open the radio (app version 7.0)")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(1, n);
        } catch (Exception e) { stopSelf(); return START_NOT_STICKY; }
        if (lock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "roger:live");
            lock.setReferenceCounted(false);
        }
        if (!lock.isHeld()) lock.acquire();
        if (audioHandler == null) { audioHandler = new android.os.Handler(android.os.Looper.getMainLooper()); audioHandler.post(audioWatch); }
        return START_STICKY;
    }

    // ----- the floating button -----
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void addBubble() {
        if (bubble != null) return;
        final SharedPreferences sp = getSharedPreferences("roger", MODE_PRIVATE);
        final WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);

        // grip (drag handle) + big round TALK button
        bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.HORIZONTAL);
        bubble.setGravity(Gravity.CENTER_VERTICAL);

        TextView grip = new TextView(this);
        grip.setText("â‹®\nâ‹®");
        grip.setTextColor(Color.WHITE);
        grip.setTextSize(18);
        grip.setGravity(Gravity.CENTER);
        GradientDrawable gb = new GradientDrawable();
        gb.setColor(0xCC1d2735);
        gb.setCornerRadius(dp(14));
        grip.setBackground(gb);
        bubble.addView(grip, new LinearLayout.LayoutParams(dp(34), dp(60)));

        talk = new TextView(this);
        talk.setText("TALK");
        talk.setTextColor(Color.WHITE);
        talk.setTextSize(15);
        talk.setTypeface(talk.getTypeface(), android.graphics.Typeface.BOLD);
        talk.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(dp(88), dp(88));
        tlp.leftMargin = dp(6);
        bubble.addView(talk, tlp);
        applyState(state);

        int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
        lp = new WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                type, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = sp.getInt("bx", dp(12));
        lp.y = sp.getInt("by", dp(260));

        // hold the round button = talk
        talk.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent e) {
                int a = e.getActionMasked();
                if (a == MotionEvent.ACTION_DOWN) { v.setPressed(true); if (MainActivity.current != null) MainActivity.current.press(true); return true; }
                if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) { v.setPressed(false); if (MainActivity.current != null) MainActivity.current.press(false); return true; }
                return true;
            }
        });

        // drag the grip = move the button
        grip.setOnTouchListener(new View.OnTouchListener() {
            float dx, dy; int sx, sy;
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN: dx = e.getRawX(); dy = e.getRawY(); sx = lp.x; sy = lp.y; return true;
                    case MotionEvent.ACTION_MOVE:
                        lp.x = Math.max(0, sx + Math.round(e.getRawX() - dx));
                        lp.y = Math.max(0, sy + Math.round(e.getRawY() - dy));
                        try { wm.updateViewLayout(bubble, lp); } catch (Exception ignored) {}
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        sp.edit().putInt("bx", lp.x).putInt("by", lp.y).apply();
                        return true;
                }
                return true;
            }
        });

        try { wm.addView(bubble, lp); } catch (Exception e) { bubble = null; talk = null; }
    }

    private void removeBubble() {
        if (bubble == null) return;
        try { ((WindowManager) getSystemService(Context.WINDOW_SERVICE)).removeView(bubble); } catch (Exception ignored) {}
        bubble = null; talk = null;
    }

    private void applyState(String s) {
        state = s == null ? "ready" : s;
        if (talk == null) return;
        int color; String text = "TALK";
        if (state.contains("live")) { color = 0xFFe3a008; text = "ON AIR"; }
        else if (state.contains("rec")) { color = 0xFFe3a008; text = "REC"; }
        else if (state.contains("busy")) { color = 0xFFc0392b; text = "BUSY\nhold"; }
        else if (state.contains("off")) { color = 0xFF55606e; text = "OFF"; }
        else if (state.contains("vox")) { color = 0xFF1f7a8c; text = "VOX"; }
        else color = 0xFF1f8f4e;
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(color);
        g.setStroke(dp(3), 0xCCFFFFFF);
        talk.setBackground(g);
        talk.setText(text);
    }

    @Override
    public void onDestroy() {
        removeBubble();
        if (audioHandler != null) { audioHandler.removeCallbacks(audioWatch); audioHandler = null; }
        if (scoOn) { try { android.media.AudioManager am = (android.media.AudioManager) getSystemService(AUDIO_SERVICE); am.setBluetoothScoOn(false); am.stopBluetoothSco(); am.setMode(android.media.AudioManager.MODE_NORMAL); } catch (Exception ignored) {} scoOn = false; }
        if (instance == this) instance = null;
        if (lock != null && lock.isHeld()) lock.release();
        super.onDestroy();
    }
}

