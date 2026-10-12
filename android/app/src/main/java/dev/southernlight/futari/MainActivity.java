package dev.southernlight.futari;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** #1672: load watchdog. See {@link FutariWebViewClient}. */
    private FutariWebViewClient webViewClient;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Right after super: Bridge exists, and the first main-frame request has not started yet.
        if (getBridge() != null) {
            webViewClient = FutariWebViewClient.install(getBridge());
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        if (webViewClient != null) webViewClient.onForegrounded();
    }

    @Override
    public void onStop() {
        if (webViewClient != null) webViewClient.onBackgrounded();
        super.onStop();
    }
}
