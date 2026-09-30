package org.infinitego.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Small native shell. The Go engine and interface remain the shared web sources. */
public final class MainActivity extends Activity {
    private static final String LOCAL_URL = "https://appassets.androidplatform.net/index.html";
    private static final String LOCAL_ORIGIN = HostAddress.origin(URI.create(LOCAL_URL));
    private static final int OPEN_JSON = 10, SAVE_JSON = 11, MAX_SAVE = 10_000_000;
    private WebView web;
    private TextView status;
    private volatile String activeOrigin = LOCAL_ORIGIN;
    private String lastHost = "", pendingExport;
    private ValueCallback<Uri[]> fileCallback;
    private int generation, chooserGeneration;
    private boolean exporting;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(245, 239, 227));
        // Target SDK 36 uses edge-to-edge; apply system bars without hiding controls.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        Button offline = button("离线同屏", v -> confirmNavigation(LOCAL_URL));
        Button connect = button("连接房主", v -> askForHost());
        Button about = button("帮助", v -> showHelp());
        toolbar.addView(offline, new LinearLayout.LayoutParams(0, -2, 1));
        toolbar.addView(connect, new LinearLayout.LayoutParams(0, -2, 1));
        toolbar.addView(about, new LinearLayout.LayoutParams(-2, -2));
        root.addView(toolbar);
        status = new TextView(this);
        status.setPadding(dp(12), dp(3), dp(12), dp(7));
        status.setTextSize(12);
        status.setTextColor(Color.rgb(72, 82, 72));
        root.addView(status);
        web = new WebView(this);
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
        configureWebView();
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> confirmExit());
        }
        navigate(LOCAL_URL);
    }

    private Button button(String text, View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(text); b.setTextSize(13); b.setAllCaps(false); b.setOnClickListener(listener);
        return b;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }

    @SuppressWarnings("deprecation")
    private void configureWebView() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); // Required by the shared game, no Java bridge is exposed.
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setSafeBrowsingEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String origin = originOf(request.getUrl().toString());
                if (!origin.equals(activeOrigin)) return response(403, "Forbidden", "Blocked origin");
                if (origin.equals(LOCAL_ORIGIN)) return localAsset(request.getUrl(), request.getMethod());
                return null;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (originOf(url).equals(activeOrigin)) return false;
                // Let same-origin blob links reach DownloadListener (JSON export).
                if (url.startsWith("blob:") && originOf(url.substring(5)).equals(activeOrigin)) return false;
                if (request.isForMainFrame() && request.hasGesture()
                        && "https".equals(request.getUrl().getScheme())) {
                    new AlertDialog.Builder(MainActivity.this).setTitle("在浏览器打开链接？")
                        .setMessage(url).setNegativeButton("取消", null)
                        .setPositiveButton("打开", (d, w) -> {
                            try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); }
                            catch (ActivityNotFoundException e) { toast("没有可打开此链接的浏览器"); }
                        }).show();
                }
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                generation++; exporting = false; pendingExport = null;
                if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
                status.setText(activeOrigin.equals(LOCAL_ORIGIN) ? "离线同屏 · 正在加载" : "正在连接 " + lastHost);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!originOf(url).equals(activeOrigin)) return;
                status.setText(activeOrigin.equals(LOCAL_ORIGIN)
                    ? "离线同屏 · 退出或切换前请导出 JSON 保存" : "房主 " + lastHost + " · 请在页面加入房间");
                if (activeOrigin.equals(LOCAL_ORIGIN)) {
                    web.evaluateJavascript("(()=>{const e=document.getElementById('roomInfo');"
                        + "if(e)e.textContent='这是应用内离线同屏版。联机请点上方「连接房主」，输入电脑的局域网或虚拟局域网地址。';"
                        + "const b=document.getElementById('openHost');if(b){b.disabled=true;b.textContent='请使用上方连接房主';}})()", null);
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) status.setText("加载失败。检查房主服务、地址、Wi-Fi / VPN；或点离线同屏");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); // Never bypass certificate errors, including self-signed certificates.
                status.setText("HTTPS 证书无效，已停止连接；请修复房主证书");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                                       FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback; chooserGeneration = generation;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain"});
                try { startActivityForResult(pick, OPEN_JSON); }
                catch (ActivityNotFoundException e) {
                    fileCallback.onReceiveValue(null); fileCallback = null; toast("系统文件选择器不可用");
                }
                return true;
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, size) -> exportBlob(url));
    }

    private static String originOf(String url) {
        try {
            URI uri = URI.create(url);
            if (uri.getRawUserInfo() != null || uri.getHost() == null
                    || !("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))) return "";
            return HostAddress.origin(uri);
        } catch (RuntimeException e) { return ""; }
    }

    private WebResourceResponse localAsset(Uri uri, String method) {
        String path = uri.getPath();
        if ("/".equals(path)) path = "/index.html";
        // A closed asset route; never let a miss fall through to the real network.
        if (!"GET".equals(method) || path == null || path.contains("..") || path.contains("\\")
                || !path.matches("/[a-zA-Z0-9/_\\-.]+")) return response(404, "Not Found", "Missing asset");
        String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".js") ? "application/javascript"
            : path.endsWith(".css") ? "text/css" : path.endsWith(".png") ? "image/png"
            : path.endsWith(".webmanifest") ? "application/manifest+json" : "text/plain";
        try {
            InputStream stream = getAssets().open("web" + path);
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; "
                + "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' blob:; "
                + "object-src 'none'; frame-src 'none'; base-uri 'none'");
            return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, stream);
        } catch (IOException e) { return response(404, "Not Found", "Missing asset"); }
    }
    private static WebResourceResponse response(int code, String reason, String message) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, new HashMap<>(),
            new ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8)));
    }

    private void askForHost() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("192.168.1.20:8000"); input.setText(lastHost);
        LinearLayout box = new LinearLayout(this); box.setPadding(dp(20), 0, dp(20), 0); box.addView(input);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("连接可信房主")
            .setMessage("房主需在电脑启动服务并创建房间。HTTP 仅支持私有 IPv4（含常见 VPN 网段），不加密；仅用于可信网络。也可填 HTTPS 地址。切换前请导出当前棋谱。")
            .setView(box).setNegativeButton("取消", null).setPositiveButton("连接", null).create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            try {
                String target = HostAddress.parse(input.getText().toString()).toString();
                dialog.dismiss(); confirmNavigation(target);
            } catch (IllegalArgumentException e) { input.setError(e.getMessage()); }
        }));
        dialog.show();
    }
    private void confirmNavigation(String url) {
        new AlertDialog.Builder(this).setTitle("切换页面？")
            .setMessage("当前同屏棋局不会自动保存。请先导出 JSON；连接房间的棋局保留在房主内存中。")
            .setNegativeButton("取消", null).setPositiveButton("继续", (d, w) -> navigate(url)).show();
    }
    private void navigate(String url) {
        web.stopLoading();
        activeOrigin = originOf(url);
        if (!activeOrigin.equals(LOCAL_ORIGIN)) lastHost = url;
        web.loadUrl(url);
    }

    /** Pull a same-origin blob only into a user-chosen save document. No native JS bridge. */
    private void exportBlob(String url) {
        if (exporting || pendingExport != null) { toast("请先完成或取消当前导出"); return; }
        if (!url.startsWith("blob:") || !originOf(url.substring(5)).equals(activeOrigin)
                || !originOf(web.getUrl()).equals(activeOrigin)) { toast("仅支持导出当前棋局的 JSON"); return; }
        exporting = true;
        final int page = generation;
        final String slot = "__infiniteGoExport_" + UUID.randomUUID().toString().replace("-", "");
        String js = "(()=>{window[" + JSONObject.quote(slot) + "]={pending:true};fetch(" + JSONObject.quote(url)
            + ").then(r=>r.blob()).then(async b=>{if(b.size>" + MAX_SAVE + ")throw Error('保存文件超过10 MB');"
            + "window[" + JSONObject.quote(slot) + "]={text:await b.text()};}).catch(()=>{window["
            + JSONObject.quote(slot) + "]={error:true};});})()";
        web.evaluateJavascript(js, ignored -> pollExport(slot, page, 0));
    }
    private void pollExport(String slot, int page, int attempts) {
        if (page != generation || isFinishing()) { exporting = false; return; }
        web.evaluateJavascript("window[" + JSONObject.quote(slot) + "]", raw -> {
            if (page != generation || isFinishing()) { exporting = false; return; }
            try {
                JSONObject result = new JSONObject(raw);
                if (result.optBoolean("pending") && attempts < 100) {
                    web.postDelayed(() -> pollExport(slot, page, attempts + 1), 50); return;
                }
                web.evaluateJavascript("delete window[" + JSONObject.quote(slot) + "]", null);
                exporting = false;
                if (!result.has("text")) { toast("导出失败，请重试"); return; }
                String json = result.getString("text");
                if (json.getBytes(StandardCharsets.UTF_8).length > MAX_SAVE) { toast("保存文件超过 10 MB"); return; }
                new JSONObject(json); // Export only a JSON object, not arbitrary downloaded content.
                pendingExport = json;
                Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                save.addCategory(Intent.CATEGORY_OPENABLE); save.setType("application/json");
                save.putExtra(Intent.EXTRA_TITLE, "infinite-go.json");
                startActivityForResult(save, SAVE_JSON);
            } catch (Exception e) { exporting = false; pendingExport = null; toast("导出失败或系统文件选择器不可用"); }
        });
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        Uri uri = result == RESULT_OK && data != null ? data.getData() : null;
        if (uri != null && !"content".equals(uri.getScheme())) uri = null;
        if (request == OPEN_JSON && fileCallback != null) {
            fileCallback.onReceiveValue(uri != null && chooserGeneration == generation ? new Uri[]{uri} : null);
            fileCallback = null;
        } else if (request == SAVE_JSON) {
            final String text = pendingExport; pendingExport = null;
            if (uri != null && text != null) {
                final Uri destination = uri;
                new Thread(() -> {
                    try (OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                        if (output == null) throw new IOException("No destination");
                        output.write(text.getBytes(StandardCharsets.UTF_8));
                        runOnUiThread(() -> toast("棋谱 JSON 已保存"));
                    } catch (IOException | SecurityException e) { runOnUiThread(() -> toast("保存失败，请重试")); }
                }, "save-game-json").start();
            }
        }
    }
    private void showHelp() {
        new AlertDialog.Builder(this).setTitle("无限围棋 · Infinite Go 0.2.0")
            .setMessage("离线同屏不需要网络或账号。上方连接房主可加入电脑上的 LAN / VPN 房间；本应用不运行房主服务器、VPN 或 AI 引擎。\n\n请保持系统 Android WebView / Chrome 更新。游戏在内存中，退出、系统回收或切换前，点页面「导出 JSON」并选保存位置；「导入 JSON」可恢复棋局。没有自动云备份。\n\nAGPL-3.0-only · 源码和许可证在页面底部。")
            .setPositiveButton("知道了", null).show();
    }
    @Override public void onBackPressed() { confirmExit(); }
    private void confirmExit() {
        new AlertDialog.Builder(this).setTitle("退出无限围棋？")
            .setMessage("请先导出 JSON 保存当前棋局，退出不会自动保存。")
            .setNegativeButton("取消", null).setPositiveButton("退出", (d, w) -> finish()).show();
    }
    @Override protected void onPause() { super.onPause(); if (web != null) web.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() {
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (web != null) { web.stopLoading(); web.destroy(); }
        super.onDestroy();
    }
}
