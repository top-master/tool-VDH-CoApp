// Local media proxy: lets ffmpeg/ffprobe (HTTP/1.1-only) reach CDNs that reject
// HTTP/1.1 and only answer over a newer protocol. ffmpeg talks plain HTTP/1.1
// to this loopback server; the server re-issues each request (manifest, AES
// key, segments) upstream over the protocol the subclass implements, forwarding
// the browser headers, and rewrites the m3u8 so every segment/key URL loops
// back through here too. ffmpeg keeps doing all the HLS decrypt/mux work - only
// the transport changes.
//
//   MediaProxy      - base: forwards upstream as-is over HTTP/1.1.
//   Http2MediaProxy - subclass: forwards upstream over HTTP/2 (falls back to
//                     the base's HTTP/1.1 when a host doesn't offer HTTP/2).
//
// A future Http3MediaProxy would only need to override fetchUpstream().

const http = require("http");
const https = require("https");
const http2 = require("http2");

// Connection-specific headers that must never be forwarded (and are illegal as
// HTTP/2 request headers).
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function looksLikeManifest(url, contentType) {
  if (/mpegurl|x-mpegURL/i.test(contentType || "")) {
    return true;
  }
  return /\.m3u8(\?|#|$)/i.test(url);
}

// Some sites glue a small fake image header (a tiny PNG/JPEG/GIF/... plus its
// own end marker) onto the front of a real MPEG-TS or MP4 segment, so ffmpeg
// sees "Video: png" and bails while their own JS player strips the prefix and
// feeds the clean media to MSE. Undo that: only when the payload BEGINS with an
// image magic, scan a little way in for where the real media starts (a TS packet
// run, or an MP4 box) and drop everything before it. Anything that is not such a
// wrapper (plain segments, AES keys, actual images) is returned untouched.
const IMAGE_MAGICS = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x42, 0x4d], // BMP
  [0x52, 0x49, 0x46, 0x46], // RIFF (WEBP)
];

function startsWithImageMagic(buffer) {
  return IMAGE_MAGICS.some((magic) =>
    magic.every((byte, index) => buffer[index] === byte),
  );
}

const MP4_BOX_TYPES = [
  [0x66, 0x74, 0x79, 0x70], // ftyp
  [0x73, 0x74, 0x79, 0x70], // styp
  [0x6d, 0x6f, 0x6f, 0x66], // moof
  [0x6d, 0x6f, 0x6f, 0x76], // moov
];

// Index of the first byte that begins real muxed media, or -1. A TS start is a
// 0x47 sync that repeats at the 188-byte packet stride (at least `tsRun` packets
// in a row - a longer run is a stronger, lower-false-positive signal); an MP4
// start is an ftyp/styp/moof/moov box (its 4-char type sits 4 bytes into the box).
function findMediaStart(buffer, tsRun) {
  const limit = Math.min(buffer.length, 262144);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0x47) {
      let run = true;
      for (let packet = 0; packet < tsRun; packet++) {
        if (buffer[i + packet * 188] !== 0x47) {
          run = false;
          break;
        }
      }
      if (run) {
        return i;
      }
    }
    if (
      MP4_BOX_TYPES.some(
        (type) =>
          buffer[i] === type[0] &&
          buffer[i + 1] === type[1] &&
          buffer[i + 2] === type[2] &&
          buffer[i + 3] === type[3],
      )
    ) {
      return i >= 4 ? i - 4 : 0; // back up over the box-size field
    }
  }
  return -1;
}

// Undo an anti-download wrapper: a prefix glued in front of a real TS/MP4 segment
// so ffmpeg can't read it while the site's own player strips it. Two passes:
//   1. the common case - the prefix is a recognized image header (see
//      IMAGE_MAGICS); strip up to the media, with a light TS-run confirmation
//      since the wrapper itself is already recognized;
//   2. otherwise - any unrecognized prefix; only strip when the payload does not
//      already begin with media but a strong media start appears a little way in
//      (a longer TS run, to stay clear of false positives without the image-magic
//      confirmation). Normal segments (media at offset 0) return -> unchanged, and
//      so do payloads with no media start at all (AES keys, real images, error
//      pages), because a failed strip must never make a genuine response worse.
function stripFakeMediaPrefix(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return buffer;
  }
  if (startsWithImageMagic(buffer)) {
    const start = findMediaStart(buffer, 3);
    return start > 0 ? buffer.subarray(start) : buffer;
  }
  const start = findMediaStart(buffer, 5);
  return start > 0 ? buffer.subarray(start) : buffer;
}

class MediaProxy {
  // headers: the extension's [{name, value}, ...] browser headers to forward
  // upstream so the CDN sees a browser-shaped request.
  constructor({ headers = [], logger = null, stripWrapper = false } = {}) {
    this.forwardHeaders = {};
    for (const header of headers) {
      if (header && header.name && !HOP_BY_HOP.has(header.name.toLowerCase())) {
        this.forwardHeaders[header.name.toLowerCase()] = header.value;
      }
    }
    this.logger = logger;
    // Strip fake image prefixes off segments (an anti-download wrapper).
    this.stripWrapper = stripWrapper;
    this.server = null;
    this.origin = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) =>
        this._handleRequest(req, res),
      );
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const { port } = this.server.address();
        this.origin = `http://127.0.0.1:${port}`;
        resolve(this.origin);
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // Build the loopback URL that encodes an upstream URL in its path.
  proxyUrl(upstreamUrl) {
    return `${this.origin}/p/${Buffer.from(upstreamUrl, "utf8").toString(
      "base64url",
    )}`;
  }

  _decodeProxyUrl(requestPath) {
    const match = /^\/p\/([^/?#]+)/.exec(requestPath || "");
    if (!match) {
      return null;
    }
    try {
      return Buffer.from(match[1], "base64url").toString("utf8");
    } catch (_) {
      return null;
    }
  }

  _requestHeaders(clientRequest) {
    // Configured browser headers win; forward a Range from ffmpeg (segment
    // seeking) but drop hop-by-hop headers.
    const headers = { ...this.forwardHeaders };
    // Forward ffmpeg's Range for seeking - but not while de-wrapping, where a
    // partial body would put the fake prefix at an unknown offset; fetch whole.
    if (clientRequest.headers.range && !this.stripWrapper) {
      headers.range = clientRequest.headers.range;
    }
    return headers;
  }

  async _handleRequest(clientRequest, clientResponse) {
    const upstreamUrl = this._decodeProxyUrl(clientRequest.url);
    if (!upstreamUrl) {
      clientResponse.writeHead(400);
      clientResponse.end("bad proxy url");
      return;
    }
    try {
      const upstream = await this.fetchUpstream(
        upstreamUrl,
        this._requestHeaders(clientRequest),
      );
      const contentType = upstream.headers["content-type"] || "";
      if (looksLikeManifest(upstreamUrl, contentType)) {
        const body = await streamToBuffer(upstream.stream);
        const rewritten = this._rewriteManifest(
          body.toString("utf8"),
          upstreamUrl,
        );
        clientResponse.writeHead(upstream.status, {
          "content-type": "application/vnd.apple.mpegurl",
        });
        clientResponse.end(rewritten);
        return;
      }
      // Segment de-wrapping needs the whole body, so buffer it, strip any fake
      // image prefix, and send the result (with a corrected Content-Length).
      if (this.stripWrapper) {
        const body = stripFakeMediaPrefix(
          await streamToBuffer(upstream.stream),
        );
        const headers = this._responseHeaders(upstream);
        delete headers["content-length"];
        delete headers["Content-Length"];
        headers["content-length"] = String(body.length);
        clientResponse.writeHead(upstream.status, headers);
        clientResponse.end(body);
        return;
      }
      clientResponse.writeHead(upstream.status, this._responseHeaders(upstream));
      upstream.stream.pipe(clientResponse);
      upstream.stream.on("error", () => clientResponse.destroy());
    } catch (error) {
      if (this.logger) {
        this.logger.warn("media-proxy upstream error", upstreamUrl, error.message);
      }
      if (!clientResponse.headersSent) {
        clientResponse.writeHead(502);
      }
      clientResponse.end("proxy upstream error: " + error.message);
    }
  }

  _responseHeaders(upstream) {
    const headers = {};
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (!name.startsWith(":") && !HOP_BY_HOP.has(name.toLowerCase())) {
        headers[name] = value;
      }
    }
    return headers;
  }

  // Rewrite every URL an HLS playlist references (variant playlists, segments,
  // and URI="..." attributes such as EXT-X-KEY / EXT-X-MAP) so ffmpeg fetches
  // them back through this proxy too, resolving relative URLs against the
  // manifest's own URL.
  _rewriteManifest(text, manifestUrl) {
    const resolve = (candidate) => {
      try {
        return new URL(candidate, manifestUrl).toString();
      } catch (_) {
        return candidate;
      }
    };
    return text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return line;
        }
        if (trimmed.startsWith("#")) {
          return line.replace(
            /URI="([^"]+)"/g,
            (_all, uri) => `URI="${this.proxyUrl(resolve(uri))}"`,
          );
        }
        return this.proxyUrl(resolve(trimmed));
      })
      .join("\n");
  }

  // Base transport: forward as-is over HTTP/1.1. Resolves to
  // { status, headers, stream }.
  fetchUpstream(url, headers) {
    const lib = url.startsWith("https:") ? https : http;
    return new Promise((resolve, reject) => {
      const request = lib.request(url, { method: "GET", headers }, (response) => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          stream: response,
        });
      });
      request.on("error", reject);
      request.end();
    });
  }
}

class Http2MediaProxy extends MediaProxy {
  constructor(options) {
    super(options);
    this._sessions = new Map();
  }

  _session(origin) {
    let session = this._sessions.get(origin);
    if (!session || session.destroyed || session.closed) {
      session = http2.connect(origin);
      session.on("error", () => {});
      this._sessions.set(origin, session);
    }
    return session;
  }

  // Forward upstream over HTTP/2; if the host can't do HTTP/2, fall back to the
  // base class's HTTP/1.1 transport.
  fetchUpstream(url, headers) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      let session;
      try {
        session = this._session(target.origin);
      } catch (error) {
        return super.fetchUpstream(url, headers).then(resolve, () => reject(error));
      }
      const h2Headers = {
        ...headers,
        ":method": "GET",
        ":path": target.pathname + target.search,
        ":scheme": "https",
        ":authority": target.host,
      };
      let settled = false;
      const request = session.request(h2Headers);
      request.on("response", (responseHeaders) => {
        settled = true;
        const normalized = {};
        for (const [name, value] of Object.entries(responseHeaders)) {
          if (!name.startsWith(":")) {
            normalized[name] = value;
          }
        }
        resolve({
          status: Number(responseHeaders[":status"]),
          headers: normalized,
          stream: request,
        });
      });
      request.on("error", (error) => {
        if (settled) {
          return;
        }
        // HTTP/2 unavailable/refused: fall back to HTTP/1.1.
        super.fetchUpstream(url, headers).then(resolve, () => reject(error));
      });
      request.end();
    });
  }

  stop() {
    for (const session of this._sessions.values()) {
      try {
        session.close();
      } catch (_) {
        // already gone
      }
    }
    this._sessions.clear();
    super.stop();
  }
}

module.exports = { MediaProxy, Http2MediaProxy, stripFakeMediaPrefix };
