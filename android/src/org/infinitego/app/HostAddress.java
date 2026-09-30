package org.infinitego.app;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Parsing is deliberately independent of Android so it can be tested on the JDK. */
public final class HostAddress {
    private HostAddress() {}

    public static URI parse(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty() || value.length() > 2048 || value.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("请输入房主地址，例如 192.168.1.20:8000");
        }
        boolean implicitScheme = !value.contains("://");
        if (implicitScheme) value = "http://" + value;
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost();
            if (!(scheme.equals("http") || scheme.equals("https")) || host == null
                    || uri.getRawUserInfo() != null || uri.getFragment() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535) {
                throw new IllegalArgumentException("仅支持不含用户名、密码或片段的 HTTP(S) 房主地址");
            }
            host = host.toLowerCase(Locale.ROOT);
            if (host.equals("appassets.androidplatform.net")) {
                throw new IllegalArgumentException("该地址保留给应用内离线页面");
            }
            if (scheme.equals("http") && !isPrivateIpv4(host)) {
                throw new IllegalArgumentException("HTTP 请用房主的私有 IPv4 地址；公网或域名地址须使用 HTTPS");
            }
            int port = implicitScheme && uri.getPort() == -1 ? 8000 : uri.getPort();
            String path = uri.getRawPath();
            if (path == null || path.isEmpty()) path = "/";
            // Keep already-escaped paths and room queries intact; do not double-encode them.
            String authority = host + (port == -1 ? "" : ":" + port);
            return new URI(scheme + "://" + authority + path
                    + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()));
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("房主地址格式不正确", e);
        }
    }

    public static String origin(URI uri) {
        int port = uri.getPort();
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        if (port == -1) port = scheme.equals("https") ? 443 : 80;
        return scheme + "://" + uri.getHost().toLowerCase(Locale.ROOT) + ":" + port;
    }

    static boolean isPrivateIpv4(String host) {
        String[] pieces = host.split("\\.", -1);
        if (pieces.length != 4) return false;
        int[] n = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!pieces[i].matches("0|[1-9][0-9]{0,2}")) return false;
            n[i] = Integer.parseInt(pieces[i]);
            if (n[i] > 255) return false;
        }
        return n[0] == 10 || (n[0] == 172 && n[1] >= 16 && n[1] <= 31)
                || (n[0] == 192 && n[1] == 168)
                || (n[0] == 100 && n[1] >= 64 && n[1] <= 127);
    }
}
