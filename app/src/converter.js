import open from 'open';

const os = require("os");
const path = require('path');
const fs = require("node:fs");

const logger = require('./logger');
const rpc = require('./weh-rpc');
const { Http2MediaProxy } = require('./media-proxy');

const exec_dir = path.dirname(process.execPath);

const ffmpeg = findExecutableFullPath("ffmpeg", exec_dir);
const ffprobe = findExecutableFullPath("ffprobe", exec_dir);
const filepicker = findExecutableFullPath("filepicker", exec_dir);

if (!fileExistsSync(ffmpeg)) {
  logger.error("ffmpeg not found. Install ffmpeg and make sure it's in your path.");
  process.exit(1);
}

if (!fileExistsSync(ffprobe)) {
  logger.error("ffprobe not found. Install ffmpeg and make sure it's in your path.");
  process.exit(1);
}

if (!fileExistsSync(filepicker)) {
  logger.error("filepicker not found.");
  process.exit(1);
}

function findExecutableFullPath(programName, extraPath = "") {
  programName = ensureProgramExt(programName);
  const envPath = (process.env.PATH || '');
  const pathArr = envPath.split(path.delimiter);
  if (extraPath) {
    pathArr.unshift(extraPath);
  }
  return pathArr
    .map((x) => path.join(x, programName))
    .find((x) => fileExistsSync(x));
}

function fileExistsSync (filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

function ensureProgramExt(programPath) {
  if (os.platform() == "win32") {
    return programPath + ".exe";
  }
  return programPath;
}

// Record all started processes, and kill them if the coapp
// ends, crashes or is killed by the browser.
let to_kill = new Set();

function spawn(arg0, argv) {
  const { spawn } = require('child_process');
  let process = spawn(arg0, argv);
  if (process.pid) {
    to_kill.add(process);
    process.on("exit", () => to_kill.delete(process));
  }
  return process;
}

for (let e of ["exit", "SIGINT", "SIGTERM", "uncaughtException"]) {
  process.on(e, () => {
    for (let process of to_kill) {
      try {
        process.kill(9);
      } catch (_) {
        /* */
      }
    }
    process.exit(0);
  });
}

function ExecConverter(args) {
  return new Promise((resolve, reject) => {
    let convProcess = spawn(ffmpeg, args);
    let stdout = "";
    convProcess.stdout.on("data", (data) => stdout += data);
    convProcess.stderr.on("data", (_data) => {
      // need to consume data or process stalls
    });
    convProcess.on("exit", (exitCode) => {
      if (exitCode !== 0) {
        return reject(new Error("Converter returned exit code " + exitCode));
      }
      resolve(stdout);
    });
  });
}

// Run ffprobe once. Resolves to the parsed info (or raw json), rejects with an
// "Exit code: N\n<stderr>" error carrying ffprobe's reason.
function runFfprobe(input, json, headers) {
  return new Promise((resolve, reject) => {
    let args = [];
    if (json) {
      args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams"];
    }
    if (headers.length) {
      args.push("-headers");
      args.push(headers.map((h) => h.name + ": " + h.value).join("\r\n") + "\r\n");
    }
    args.push(input);

    let probeProcess = spawn(ffprobe, args);
    let stdout = "";
    let stderr = "";
    probeProcess.stdout.on("data", (data) => stdout += data);
    probeProcess.stderr.on("data", (data) => stderr += data);
    probeProcess.on("exit", (exitCode) => {
      if (exitCode !== 0) {
        return reject(new Error("Exit code: " + exitCode + "\n" + stderr));
      }
      if (json) {
        // FIXME: not parsed?
        return resolve(stdout);
      }
      let info = {};
      let m = /([0-9]{2,})x([0-9]{2,})/g.exec(stderr);
      if (m) {
        info.width = parseInt(m[1]);
        info.height = parseInt(m[2]);
      }
      m = /Duration: ([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{2})/g.exec(stderr);
      if (m) {
        info.duration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
      }
      m = /Video:\s+([^\s\(,]+)/g.exec(stderr);
      if (m) {
        info.videoCodec = m[1];
      }
      m = /Audio:\s+([^\s\(,]+)/g.exec(stderr);
      if (m) {
        info.audioCodec = m[1];
      }
      m = /([0-9]+(?:\.[0-9]+)?)\s+fps\b/g.exec(stderr);
      if (m) {
        info.fps = parseFloat(m[1]);
      }
      resolve(info);
    });
  });
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

// ffmpeg's stderr when an HTTP/2-only CDN refuses its HTTP/1.1 request: an
// explicit 401/403 access block. This is the reliable HTTP/2-refusal signal.
function looksLikeHttp2Refusal(stderr) {
  return /\b40[13]\b|access denied|Forbidden|HTTP error 40[13]/i.test(stderr || "");
}

// ffmpeg's stderr when it could not parse an input at all. This is NOT a reliable
// HTTP/2 signal on its own - it is far more often a client-side cause the caller
// already handles (e.g. a zstd/brotli-encoded body, or disguised HLS segment
// extensions) - so the proxy only retries on it when the caller opts in via the
// "-vdh_proxy_fallback invalid-data" convert flag (see takeProxyFallbackMode).
function looksLikeUnparsableInput(stderr) {
  return /Invalid data found when processing input|Error opening input/i.test(
    stderr || "",
  );
}

// The extension can widen the proxy-retry trigger for a single convert by passing
// a two-word flag in the ffmpeg args: "-vdh_proxy_fallback invalid-data" makes a
// convert that failed as unparsable input also retry through the media proxy.
// It is a vdh-private directive, so strip both words here before ffmpeg sees them.
function takeProxyFallbackMode(args) {
  const at = args.indexOf("-vdh_proxy_fallback");
  if (at < 0) {
    return null;
  }
  const mode = args[at + 1];
  args.splice(at, 2);
  return mode;
}

// Safety net for any "-vdh_*" flag we did not consume by name above - typically
// a directive a newer extension sent that this build predates. They are all
// vdh-private, so none may reach ffmpeg (it aborts on an unknown option); drop
// each with its value, following the same two-word convention as the named
// takes above. Run this AFTER the known flags are taken, so only the
// unrecognized ones remain.
function stripVdhArgs(args) {
  for (let at = args.length - 1; at >= 0; at--) {
    if (typeof args[at] === "string" && args[at].startsWith("-vdh_")) {
      args.splice(at, 2);
    }
  }
}

// Parse every `-headers "Name: v\r\nName2: v2\r\n"` blob in an ffmpeg arg list
// into a merged [{name, value}] list, so the proxy can forward them upstream.
function extractHeadersFromArgs(args) {
  const headers = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-headers") {
      for (const line of String(args[i + 1]).split(/\r?\n/)) {
        const at = line.indexOf(":");
        if (at > 0) {
          headers.push({ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
        }
      }
    }
  }
  return headers;
}

// Replace each http(s) URL arg with its loopback proxy URL and drop the now-
// redundant `-headers` args (the proxy injects them upstream itself).
function rewriteArgsThroughProxy(args, proxy) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-headers") {
      i++; // skip the header blob too
      continue;
    }
    out.push(isHttpUrl(args[i]) ? proxy.proxyUrl(args[i]) : args[i]);
  }
  return out;
}

// Probe an input, retrying through the HTTP/2 media proxy when a direct probe
// is refused (e.g. an HTTP/2-only CDN rejecting ffprobe's HTTP/1.1 request).
async function probeWithProxyFallback(input, json, headers) {
  try {
    return await runFfprobe(input, json, headers);
  } catch (directError) {
    if (!isHttpUrl(input)) {
      throw directError;
    }
    const proxy = new Http2MediaProxy({ headers, logger });
    try {
      await proxy.start();
      const result = await runFfprobe(proxy.proxyUrl(input), json, []);
      logger.info("probe recovered via media proxy (upstream requires HTTP/2)");
      return result;
    } catch (_proxyError) {
      throw directError; // keep the direct error's ffprobe reason
    } finally {
      proxy.stop();
    }
  }
}

exports.star_listening = () => {

  const convertChildren = new Map();

  rpc.listen({

    "filepicker": async (action, directory, title, filename) => {
      let args = [action, directory, title];
      if (filename) {
        args.push(filename);
      }
      let stdout = await new Promise((ok, _ko) => {
        let proc = spawn(filepicker, args);
        let stdout = "";
        proc.stdout.on("data", (data) => stdout += data);
        proc.on("exit", (code) => {
          if (code == 0) {
            ok(stdout);
          } else {
            ok("");
          }
        });
      });
      return stdout;
    },

    "abortConvert": (pid) => {
      let child = convertChildren.get(pid);
      if (child && child.exitCode == null) {
        // Give ffmpeg a chance to gracefully die.
        child.stdin.write("q");
        setTimeout(() => {
          if (child && child.exitCode == null) {
            child.kill(9);
          }
        }, 10000);
      }
    },

    // FIXME: Partly in test suite. But just for hls retrieval.
    "convert": async (args = ["-h"], options = {}) => {
      // `-progress pipe:1` send program-friendly progress information to stdin every 500ms.
      // `-hide_banner -loglevel error`: make the output less noisy.

      // Take the caller's opt-in to widen the proxy retry, before ffmpeg sees it.
      const proxyFallbackMode = takeProxyFallbackMode(args);
      // Drop any other "-vdh_*" directive this build does not know, so a
      // forward-compat mismatch never leaks a private flag into ffmpeg.
      stripVdhArgs(args);

      // This should never happen, but just in case a third party does a convert request
      // with the old version of ffmpeg arguments, let's rewrite the arguments to fit
      // the new syntax.
      let fixed = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("[1:v][2:v] overlay=") && !args[i].endsWith("[m]")) {
          args[i] += " [m]";
          fixed = true;
        }
        if (fixed && args[i] == "1:v") {
          args[i] = "[m]";
        }
      }

      const ffmpeg_base_args = "-progress pipe:1 -hide_banner -loglevel error";
      args = [...ffmpeg_base_args.split(" "), ...args];

      // One ffmpeg run: wires progress + child tracking, resolves on exit.
      const runConvert = (ffmpegArgs) => {
        const child = spawn(ffmpeg, ffmpegArgs);

        if (!child.pid) {
          throw new Error("Process creation failed");
        }

        convertChildren.set(child.pid, child);

        let stderr = "";

        let on_exit = new Promise((resolve) => {
          child.on("exit", (code) => {
            convertChildren.delete(child.pid);
            resolve({exitCode: code, pid: child.pid, stderr});
          });
        });

        child.stderr.on("data", (data) => stderr += data);

        if (options.startHandler) {
          rpc.call("convertStartNotification", options.startHandler, child.pid);
        }

        const PROPS_RE = new RegExp("\\S+=\\s*\\S+");
        const NAMEVAL_RE = new RegExp("(\\S+)=\\s*(\\S+)");
        let progressInfo = {};

        const on_line = async (line) => {
          let props = line.match(PROPS_RE) || [];
          props.forEach((prop) => {
            let m = NAMEVAL_RE.exec(prop);
            if (m) {
              progressInfo[m[1]] = m[2];
            }
          });
          // last line of block is "progress"
          if (progressInfo["progress"]) {
            let info = progressInfo;
            progressInfo = {};
            if (typeof info["out_time_ms"] !== "undefined") {
              // out_time_ms is in ns, not ms.
              const seconds = parseInt(info["out_time_ms"]) / 1_000_000;
              try {
                await rpc.call("convertOutput", options.progressTime, seconds, info);
              } catch (_) {
                // Extension stopped caring
                child.kill();
              }
            }
          }
        };

        if (options.progressTime) {
          child.stdout.on("data", (lines) => {
            lines.toString("utf-8").split("\n").forEach(on_line);
          });
        }

        return on_exit;
      };

      let result = await runConvert(args);
      // If a CDN refused ffmpeg's HTTP/1.1 request (e.g. an HTTP/2-only host),
      // retry the whole convert through the local media proxy, which re-issues
      // upstream over HTTP/2. A 40x access block always qualifies; an unparsable
      // input only when the caller opted in with "-vdh_proxy_fallback invalid-data".
      // Working (non-blocked) downloads never reach here.
      if (
        result.exitCode !== 0 &&
        args.some(isHttpUrl) &&
        (looksLikeHttp2Refusal(result.stderr) ||
          (proxyFallbackMode === "invalid-data" &&
            looksLikeUnparsableInput(result.stderr)))
      ) {
        const proxy = new Http2MediaProxy({
          headers: extractHeadersFromArgs(args),
          logger,
        });
        try {
          await proxy.start();
          logger.info("convert retrying via media proxy (upstream requires HTTP/2)");
          const retried = await runConvert(rewriteArgsThroughProxy(args, proxy));
          // Adopt the retry only if it actually recovered the download. On a
          // failure keep the direct result: its stderr names the real upstream
          // URL (not the loopback proxy), so it stays the more useful report -
          // and the proxy retry can never make a genuine failure worse.
          if (retried.exitCode === 0) {
            result = retried;
          }
        } catch (proxyError) {
          logger.info(
            "media proxy retry failed: " +
              ((proxyError && proxyError.message) || String(proxyError)),
          );
        } finally {
          proxy.stop();
        }
      }
      return result;
    },
    // FIXME: Partly in test suite. But just for hls retrieval.
    "probe": (input, json = false, headers = []) => {
      return probeWithProxyFallback(input, json, headers);
    },
    // FIXME: test (partly because open result is untested)
    "play": (filePath) => {
      return new Promise((resolve, _reject) => {
        open(filePath);
        resolve();
      });
    },
    // In test suite
    "codecs": () => {
      return ExecConverter(["-codecs"])
        .then((out) => {
          let lines = out.split("\n");
          let result = {};
          lines.forEach((line) => {
            let m = /^\s*(\.|D)(\.|E)(\.|V|A|S)(\.|I)(\.|L)(\.|S)\s+([^\s]+)\s+(.*?)\s*$/.exec(line);
            if (!m || m[7] === '=') {
              return;
            }
            result[m[7]] = {
              d: m[1] != ".",
              e: m[2] != ".",
              t: m[3] == "." && null || m[3],
              i: m[4] != ".",
              l: m[5] != ".",
              s: m[6] != ".",
              _: m[8]
            };
          });
          return result;
        });
    },
    // In test suite
    "formats": () => {
      return ExecConverter(["-formats"])
        .then((out) => {
          let lines = out.split("\n");
          let result = {};
          lines.forEach((line) => {
            let m = /^\s*(\.| |D)(\.| |E)\s+([^\s]+)\s+(.*?)\s*$/.exec(line);
            if (!m || m[3] === '=') {
              return;
            }
            result[m[3]] = {
              d: m[1] == "D",
              e: m[2] == "E",
              _: m[4]
            };
          });
          return result;
        });
    },
    // In test suite, but just to check if not throwing.
    "open": (filePath, options = {}) => {
      return open(filePath, options);
    },

  });
};

exports.info = () => {
  return new Promise((resolve, reject) => {
    let convProcess = spawn(ffmpeg, ["-h"]);
    let done = false;

    function Parse(data) {
      if (done) {
        return;
      }
      let str = data.toString("utf8");
      logger.info("stdout:", str);
      let words = str.split(" ");
      if (words[0] == "ffmpeg" && words[1] == "version") {
        done = true;
        resolve({
          program: "ffmpeg",
          version: words[2],
          converterBinary: ffmpeg,
        });
      }
    }

    convProcess.stdout.on("data", Parse);
    convProcess.stderr.on("data", Parse);
    convProcess.on("exit", (_code) => {
      if (!done) {
        reject(new Error("Exit without answer"));
      }
    });
  });
};
