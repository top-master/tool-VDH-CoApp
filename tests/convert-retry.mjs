#!/usr/bin/env node
// Unit test for the convert retry trigger (no network, no ffmpeg). converter.js
// exits at import time when ffmpeg is absent, so extract the pure helpers from
// its source and evaluate them in isolation - the same trick the ext-VDH specs
// use for their bundle.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../app/src/converter.js"), "utf8");
const start = src.indexOf("function looksLikeHttp2Refusal(");
const end = src.indexOf("function extractHeadersFromArgs(");
if (start < 0 || end < start) {
  console.error("could not locate the retry helpers in converter.js");
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const {
  looksLikeHttp2Refusal,
  looksLikeUnparsableInput,
  takeProxyFallbackMode,
  stripVdhArgs,
} = new Function(
  src.slice(start, end) +
    "\nreturn { looksLikeHttp2Refusal, looksLikeUnparsableInput, takeProxyFallbackMode, stripVdhArgs };",
)();

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("  ok  -", name);
  } else {
    console.log("  FAIL-", name);
    failures++;
  }
}

const INVALID_DATA =
  "[in#0 @ 0x0] Error opening input: Invalid data found when processing input\n" +
  "Error opening input file https://moon.ironwallnet.net/.../480p/index.m3u8.";

// looksLikeHttp2Refusal = the reliable 40x access-block signal only.
check(
  "403 Forbidden is an HTTP/2 refusal",
  looksLikeHttp2Refusal(
    "https://cdn/x.m3u8: Server returned 403 Forbidden (access denied)",
  ),
);
check("HTTP error 401 is an HTTP/2 refusal", looksLikeHttp2Refusal("HTTP error 401"));
// Narrowed: "Invalid data" is NOT treated as an HTTP/2 refusal anymore (it is far
// more often a client-side cause the extension already fixes).
check(
  '"Invalid data" is NOT an HTTP/2 refusal (narrowed)',
  !looksLikeHttp2Refusal(INVALID_DATA),
);

// looksLikeUnparsableInput = the opt-in-only signal.
check('"Invalid data" is unparsable input', looksLikeUnparsableInput(INVALID_DATA));
check(
  '"Error opening input" is unparsable input',
  looksLikeUnparsableInput("Error opening input file https://cdn/x.m3u8."),
);
check("a 403 is not 'unparsable input'", !looksLikeUnparsableInput("403 Forbidden"));

// takeProxyFallbackMode extracts + strips the two-word opt-in flag.
{
  const args = ["-i", "https://cdn/x.m3u8", "-vdh_proxy_fallback", "invalid-data", "-y", "out.mp4"];
  const mode = takeProxyFallbackMode(args);
  check("returns the mode value", mode === "invalid-data");
  check(
    "strips both words so ffmpeg never sees them",
    !args.includes("-vdh_proxy_fallback") && !args.includes("invalid-data"),
  );
  check("leaves the rest of the args intact", args.join(" ") === "-i https://cdn/x.m3u8 -y out.mp4");
}
check("returns null when the flag is absent", takeProxyFallbackMode(["-i", "x", "-y", "o"]) === null);

// stripVdhArgs removes any leftover (unknown) "-vdh_*" flag + value, and only those.
{
  const args = ["-i", "u", "-vdh_future_thing", "42", "-b:v", "1M", "-vdh_another", "x", "-y", "o"];
  stripVdhArgs(args);
  check("strips unknown -vdh_* flags with their values", args.join(" ") === "-i u -b:v 1M -y o");
}
{
  const args = ["-i", "u", "-y", "o"];
  stripVdhArgs(args);
  check("leaves plain ffmpeg args untouched", args.join(" ") === "-i u -y o");
}

console.log(
  failures === 0 ? "\nconvert-retry: all passed" : `\nconvert-retry: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
