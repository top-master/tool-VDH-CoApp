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

// 5. stripFakeMediaPrefix: undo a wrapper glued in front of real media.
const { stripFakeMediaPrefix } = require("../app/src/media-proxy.js");
// Build a TS body with 0x47 at each 188-byte packet boundary.
function makeTs(packets) {
  const ts = Buffer.alloc(188 * packets, 0);
  for (let p = 0; p < packets; p++) ts[p * 188] = 0x47;
  return ts;
}
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

// (a) Known image magic in front -> stripped (array fast-path, run of 3).
const ts3 = makeTs(3);
const pngStripped = stripFakeMediaPrefix(Buffer.concat([png, ts3]));
check("PNG-wrapped TS: prefix removed", pngStripped.length === ts3.length && pngStripped[0] === 0x47);

// (b) UNRECOGNIZED prefix (not any image magic) -> still stripped via the general
//     pass (needs the stronger 5-packet run).
const junkPrefix = Buffer.alloc(100, 0xab);
const ts6 = makeTs(6);
const junkStripped = stripFakeMediaPrefix(Buffer.concat([junkPrefix, ts6]));
check("unknown-prefix TS: prefix removed (general pass)", junkStripped.length === ts6.length && junkStripped[0] === 0x47);

// (c) An MP4 (ftyp) after an unknown prefix -> stripped.
const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42", "utf8"), Buffer.alloc(200, 0)]);
const mp4Stripped = stripFakeMediaPrefix(Buffer.concat([junkPrefix, ftyp]));
check("unknown-prefix MP4: stripped to the box-size field", mp4Stripped.slice(4, 8).toString() === "ftyp");

// Things that must be left untouched:
check("plain TS at offset 0 untouched", stripFakeMediaPrefix(ts6).equals(ts6));
const key = Buffer.from("0123456789abcdef", "utf8"); // 16-byte AES key
check("AES key untouched", stripFakeMediaPrefix(key).equals(key));
const realImage = Buffer.concat([png, Buffer.alloc(500, 0x11)]);
check("real image (no media after) untouched", stripFakeMediaPrefix(realImage).equals(realImage));
const errorPage = Buffer.from("<!DOCTYPE html><html>521</html>".repeat(20), "utf8");
check("HTML error page untouched", stripFakeMediaPrefix(errorPage).equals(errorPage));

console.log(failures === 0 ? "\nmedia-proxy: all passed" : `\nmedia-proxy: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
