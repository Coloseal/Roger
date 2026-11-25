package com.roger.radio;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After Roger has been updated, open it again. (Android allows this because Roger may display over other apps.) */
public class ReopenReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        try {
            Intent i = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception ignored) {}
    }
}
