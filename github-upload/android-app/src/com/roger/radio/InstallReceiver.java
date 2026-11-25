package com.roger.radio;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** Gets the result of the update install from Android: shows its "Update?" screen, or reports a failure. */
public class InstallReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); try { ctx.startActivity(confirm); } catch (Exception ignored) {} }
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            // Cancelled or failed: go back to using the current version.
            if (MainActivity.current != null) MainActivity.current.updateUi(null, 0);
        }
        // On success Android replaces and closes the app; ReopenReceiver opens the new version.
    }
}
