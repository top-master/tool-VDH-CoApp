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

class MediaProxy {
  // headers: the extension's [{name, value}, ...] browser headers to forward
  // upstream so the CDN sees a browser-shaped request.
  constructor({ headers = [], logger = null } = {}) {
    this.forwardHeaders = {};
    for (const header of headers) {
      if (header && header.name && !HOP_BY_HOP.has(header.name.toLowerCase())) {
        this.forwardHeaders[header.name.toLowerCase()] = header.value;
      }
    }
    this.logger = logger;
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
    if (clientRequest.headers.range) {
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

module.exports = { MediaProxy, Http2MediaProxy };
