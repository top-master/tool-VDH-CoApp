#!/usr/bin/env node
// Unit test for the convert retry triggers + per-convert vdh directives (no
// network, no ffmpeg). converter.js exits at import time when ffmpeg is absent,
// so extract the pure helpers from its source and evaluate them in isolation -
// the same trick the ext-VDH specs use for their bundle.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../app/src/converter.js"), "utf8");
const start = src.indexOf("function takeVdhArg(");
const end = src.indexOf("function extractHeadersFromArgs(");
if (start < 0 || end < start) {
  console.error("could not locate the retry helpers in converter.js");
  process.exit(1);
}
// looksLike* live just above takeVdhArg; include them too.
const helpersStart = src.indexOf("function looksLikeHttp2Refusal(");
// eslint-disable-next-line no-new-func
const H = new Function(
  src.slice(helpersStart, end) +
    "\nreturn { looksLikeHttp2Refusal, looksLikeUnparsableInput, looksLikeImageWrapped, takeVdhArg, stripVdhArgs, normalizeLogLevel };",
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

const INVALID_DATA = "Error opening input: Invalid data found when processing input";
const IMG_WRAP =
  "[hls @ 0x0] Could not find codec parameters for stream 0 (Video: png, none(pc)): unspecified size\n" +
  "[out#0/mp4 @ 0x0] Output file does not contain any stream";

// looksLikeHttp2Refusal = 40x access block only.
check("403 is an HTTP/2 refusal", H.looksLikeHttp2Refusal("Server returned 403 Forbidden"));
check('"Invalid data" is NOT an HTTP/2 refusal', !H.looksLikeHttp2Refusal(INVALID_DATA));
check('image-wrap is NOT an HTTP/2 refusal', !H.looksLikeHttp2Refusal(IMG_WRAP));

// looksLikeUnparsableInput = the opt-in-only signal.
check('"Invalid data" is unparsable input', H.looksLikeUnparsableInput(INVALID_DATA));

// looksLikeImageWrapped = png codec OR the hidden "no stream" (error level).
check("image-wrap (Video: png) detected", H.looksLikeImageWrapped(IMG_WRAP));
check(
  '"does not contain any stream" alone detected (error level)',
  H.looksLikeImageWrapped("Output file does not contain any stream"),
);
check("a plain 403 is not image-wrapped", !H.looksLikeImageWrapped("Server returned 403"));

// takeVdhArg extracts + strips a two-word "-vdh_*" directive.
{
  const args = ["-i", "u", "-vdh_strip_wrapper", "1", "-vdh_loglevel", "warning", "-y", "o"];
  check("takes -vdh_strip_wrapper value", H.takeVdhArg(args, "-vdh_strip_wrapper") === "1");
  check("takes -vdh_loglevel value", H.takeVdhArg(args, "-vdh_loglevel") === "warning");
  check("strips both flags from args", args.join(" ") === "-i u -y o");
  check("returns null when absent", H.takeVdhArg(args, "-vdh_proxy_fallback") === null);
}

// normalizeLogLevel maps to a valid ffmpeg level, "silent"->"quiet", else "error".
check('normalizeLogLevel("warning") = warning', H.normalizeLogLevel("warning") === "warning");
check('normalizeLogLevel("silent") = quiet', H.normalizeLogLevel("silent") === "quiet");
check('normalizeLogLevel("debug") = debug', H.normalizeLogLevel("debug") === "debug");
check('normalizeLogLevel(null) = error', H.normalizeLogLevel(null) === "error");
check('normalizeLogLevel("bogus") = error', H.normalizeLogLevel("bogus; rm -rf") === "error");

// stripVdhArgs removes any leftover (unknown) "-vdh_*" flag + value, and only those.
{
  const args = ["-i", "u", "-vdh_future_thing", "42", "-b:v", "1M", "-vdh_another", "x", "-y", "o"];
  H.stripVdhArgs(args);
  check("strips unknown -vdh_* flags with their values", args.join(" ") === "-i u -b:v 1M -y o");
}
{
  const args = ["-i", "u", "-y", "o"];
  H.stripVdhArgs(args);
  check("leaves plain ffmpeg args untouched", args.join(" ") === "-i u -y o");
}

console.log(
  failures === 0 ? "\nconvert-retry: all passed" : `\nconvert-retry: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
