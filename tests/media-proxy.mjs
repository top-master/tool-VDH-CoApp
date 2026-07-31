#!/usr/bin/env node
// Unit tests for the media proxy's pure logic (no network): the class hierarchy,
// upstream-URL encoding, HLS manifest rewriting, and header forwarding.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { MediaProxy, Http2MediaProxy } = require("../app/src/media-proxy.js");

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("  ok  -", name);
  } else {
    console.log("  FAIL-", name);
    failures++;
  }
}

// 1. class hierarchy: Http2 is a MediaProxy but overrides the transport.
const h2 = new Http2MediaProxy({ headers: [] });
check("Http2MediaProxy extends MediaProxy", h2 instanceof MediaProxy);
check(
  "subclass overrides fetchUpstream",
  Http2MediaProxy.prototype.fetchUpstream !== MediaProxy.prototype.fetchUpstream,
);
check(
  "base keeps a plain HTTP/1.1 fetchUpstream",
  typeof MediaProxy.prototype.fetchUpstream === "function",
);

// 2. upstream URL round-trips through the proxy path.
const base = new MediaProxy({ headers: [] });
base.origin = "http://127.0.0.1:9999";
const upstream =
  "https://vault-16.example.net/stream/abc/uwu.m3u8?token=xyz&a=b";
const proxied = base.proxyUrl(upstream);
check("proxyUrl points at the loopback origin", proxied.startsWith(base.origin + "/p/"));
check(
  "proxy path decodes back to the exact upstream url",
  base._decodeProxyUrl(new URL(proxied).pathname) === upstream,
);

// 3. header forwarding drops hop-by-hop headers, keeps browser ones.
const withHeaders = new MediaProxy({
  headers: [
    { name: "User-Agent", value: "Mozilla/5.0" },
    { name: "Referer", value: "https://kwik.cx/e/x" },
    { name: "Host", value: "evil" },
    { name: "Connection", value: "keep-alive" },
  ],
});
check("keeps User-Agent", withHeaders.forwardHeaders["user-agent"] === "Mozilla/5.0");
check("keeps Referer", withHeaders.forwardHeaders["referer"] === "https://kwik.cx/e/x");
check("drops Host", !("host" in withHeaders.forwardHeaders));
check("drops Connection", !("connection" in withHeaders.forwardHeaders));

// 4. manifest rewriting: every segment / key / variant URL loops back through
//    the proxy; comments without URIs and blank lines are untouched.
const manifestUrl = "https://cdn.example.net/stream/abc/uwu.m3u8";
const manifest = [
  "#EXTM3U",
  '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.net/stream/abc/mon.key"',
  "#EXTINF:2.6,",
  "segment-1.jpg", // relative
  "#EXTINF:3.3,",
  "https://cdn.example.net/stream/abc/segment-2.jpg", // absolute
  "",
].join("\n");
const rewritten = base._rewriteManifest(manifest, manifestUrl);
const lines = rewritten.split("\n");
check("EXTM3U header untouched", lines[0] === "#EXTM3U");
check(
  "AES key URI is proxied",
  /URI="http:\/\/127\.0\.0\.1:9999\/p\/[^"]+"/.test(lines[1]),
);
check(
  "AES key decodes back to the original key url",
  base._decodeProxyUrl(
    new URL(lines[1].match(/URI="([^"]+)"/)[1]).pathname,
  ) === "https://cdn.example.net/stream/abc/mon.key",
);
check("EXTINF line untouched", lines[2] === "#EXTINF:2.6,");
check(
  "relative segment resolved + proxied",
  base._decodeProxyUrl(new URL(lines[3]).pathname) ===
    "https://cdn.example.net/stream/abc/segment-1.jpg",
);
check(
  "absolute segment proxied",
  base._decodeProxyUrl(new URL(lines[5]).pathname) ===
    "https://cdn.example.net/stream/abc/segment-2.jpg",
);
check("blank line preserved", lines[6] === "");

console.log(failures === 0 ? "\nmedia-proxy: all passed" : `\nmedia-proxy: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
