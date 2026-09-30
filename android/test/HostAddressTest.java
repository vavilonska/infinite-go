package org.infinitego.app;

public final class HostAddressTest {
    private static int checked;
    private static void accepted(String value, String normalized) {
        String actual = HostAddress.parse(value).toString();
        if (!actual.equals(normalized)) throw new AssertionError(value + " -> " + actual);
        checked++;
    }
    private static void rejected(String value) {
        try { HostAddress.parse(value); }
        catch (IllegalArgumentException expected) { checked++; return; }
        throw new AssertionError("Accepted unsafe address: " + value);
    }
    public static void main(String[] args) {
        accepted("192.168.1.20", "http://192.168.1.20:8000/");
        accepted(" 10.0.0.2:9000/?room=ABC123 ", "http://10.0.0.2:9000/?room=ABC123");
        accepted("http://172.16.0.2:8000", "http://172.16.0.2:8000/");
        accepted("http://172.31.255.254", "http://172.31.255.254/");
        accepted("100.64.0.1", "http://100.64.0.1:8000/");
        accepted("100.127.255.254", "http://100.127.255.254:8000/");
        accepted("https://Example.org/go/?room=A%20B", "https://example.org/go/?room=A%20B");
        rejected(""); rejected("javascript:alert(1)"); rejected("file:///data/private");
        rejected("http://example.org/"); rejected("http://127.0.0.1:8000/");
        rejected("http://8.8.8.8/"); rejected("http://172.32.0.1/");
        rejected("http://100.63.0.1/"); rejected("http://100.128.0.1/");
        rejected("http://192.168.001.2/"); rejected("http://192.168.1.999/");
        rejected("http://10.0.0.1.evil.example/"); rejected("http://10.0.0.1@evil.example/");
        rejected("https://user:secret@example.org/"); rejected("https://example.org/#token");
        rejected("http://10.0.0.2:0/"); rejected("https://example.org:65536/");
        rejected("http://10.0.0.2\\@evil.example/");
        rejected("https://appassets.androidplatform.net/");
        if (!HostAddress.origin(HostAddress.parse("https://example.org/"))
                .equals(HostAddress.origin(HostAddress.parse("https://example.org:443/path")))) {
            throw new AssertionError("Default-port origins should match");
        }
        System.out.println("HostAddress: " + checked + " cases passed");
    }
}
