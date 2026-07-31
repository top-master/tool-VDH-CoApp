# DownloadHelper CoApp

➡️ **Main project: [github.com/top-master/ext-VDH](https://github.com/top-master/ext-VDH)**
— the browser extension, documentation, and issue tracker. This repository is
only its native companion app; please start there.

---

⚠️ This is a developer-oriented repository. It maintains the native companion app
for **[ext-VDH](https://github.com/top-master/ext-VDH)**, a clean-room
reproduction of Video DownloadHelper v9 (kept because v9 supports more browser
versions; VDH v10 needs no companion app).

If the CoApp is not recognized by the browser, see
[CoApp-not-recognized](docs/CoApp-not-recognized.md).

## What it is

_DownloadHelper CoApp_ is a multi-platform (Windows, Mac, Linux) application that
gives the [ext-VDH](https://github.com/top-master/ext-VDH) browser add-on a set
of features it cannot provide on its own:

- file writing API
- launching the default video-player application on a data file
- a bundled [ffmpeg](http://ffmpeg.org/) converter, with a local HTTP/2 media
  proxy so HTTP/2-only CDNs (which reject ffmpeg's HTTP/1.1 requests) still work

It complies with the
[native messaging protocol](https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Native_messaging)
and is not intended to be used directly from the command line.

Installer executables for the various platforms are available from the
[releases page](https://github.com/top-master/tool-VDH-CoApp/releases).

## Note about the registration process

After the app is installed, the CoApp writes a JSON manifest into browser-specific
directories, as described by the Mozilla, Google and Microsoft documentation:

- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests
- https://developer.chrome.com/docs/extensions/mv3/nativeMessaging/#native-messaging-host-location
- https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging?tabs=v3%2Cwindows

You can see the list of files installed by running `vdhcoapp install`.
Those files can be removed with `vdhcoapp uninstall`.
