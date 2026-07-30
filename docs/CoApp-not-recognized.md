# DownloadHelper CoApp - CoApp Not Recognized

A local copy of the
[CoApp-not-recognized](https://github.com/aclap-dev/video-downloadhelper/wiki/CoApp-not-recognized)
wiki page, for when the companion application isn't recognized by the browser
extension.

## First things to try

- Install the most recent version (see the [CoApp Installation](https://github.com/aclap-dev/video-downloadhelper/wiki/CoApp-Installation) page).
- Edge users: install from the Microsoft Store, not the Google Web Store.

## Information needed for bug reports

When reporting an issue, please provide:

- The specific browser and version.
- The operating system and version.
- The OS architecture (64-bit or 32-bit).
- The CoApp download link / version.
- The diagnostic output from running the CoApp with the `--info` flag.

Running `--info`:

- **Mac:** `/Applications/net.downloadhelper.coapp.app/Contents/MacOS/vdhcoapp --info`
- **Windows:** open CMD, `cd` to the install directory, run `vdhcoapp.exe --info`
- **Linux:** `/opt/vdhcoapp/vdhcoapp --info` or `~/.local/share/vdhcoapp/vdhcoapp --info`
- **Linux (sandboxed):** also note any sandbox mechanism in use (Flatpak, Snap, Firejail, AppArmor, ...).

## Windows

The architecture must match end to end: 64-bit Windows with 64-bit Firefox and
64-bit CoApp, or 32-bit across the board.

Check that the native-messaging manifest is registered:

- **64-bit system:**
  ```
  reg query HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Mozilla\NativeMessagingHosts\net.downloadhelper.coapp
  ```
- **32-bit system:**
  ```
  reg query HKEY_LOCAL_MACHINE\SOFTWARE\Mozilla\NativeMessagingHosts\net.downloadhelper.coapp
  ```

- No results → reinstall.
- Results that point to nonexistent files → reinstall.
- Valid results but still not detected → Firefox may be running the wrong architecture.

### Windows - antivirus

Antivirus software may block the application. The project is open source and
validated by Google, Microsoft, and Mozilla. Options:

- Switch to Microsoft Defender (free, Microsoft-recommended).
- Allowlist the three `.exe` files in the installation directory.

### Windows - installation error

Close Firefox, Chrome, and Edge before installing, to avoid installer errors.

## Mac

After installation, launch the application once so it re-registers with the
browsers. Older macOS versions may need extra steps (see
[discussion #1](https://github.com/aclap-dev/video-downloadhelper/discussions/1)).

## Ubuntu (Flatpak / Snap systems)

Make sure Ubuntu and Firefox are up to date (Firefox 122 on Ubuntu 22.04 had a
since-fixed issue). The usual cause is a missed permission prompt. Re-register:

```
~/.local/share/vdhcoapp/vdhcoapp install
# or
/opt/vdhcoapp/vdhcoapp install
```

Then grant the sandbox permission:

```
sudo apt-get install -y flatpak
flatpak permission-set webextensions net.downloadhelper.coapp snap.firefox yes
```

## Firejail-based systems

See this
[GitHub comment](https://github.com/aclap-dev/vdhcoapp/issues/189#issuecomment-1888447688)
for guidance.

## KDE Neon (AppArmor systems)

Add this line to `/etc/apparmor.d/local/usr.bin.firefox`:

```
/opt/vdhcoapp/vdhcoapp ux,
```

Then restart `apparmor.service` and Firefox.

## Linux (all systems)

Re-register:

```
~/.local/share/vdhcoapp/vdhcoapp install
# or
/opt/vdhcoapp/vdhcoapp install
```

Run diagnostics:

```
~/.local/share/vdhcoapp/vdhcoapp --info
# or
/opt/vdhcoapp/vdhcoapp --info
```

**Important:** don't install inside `/usr/` — browsers won't detect it there
([reason](https://github.com/aclap-dev/vdhcoapp/issues/160#issuecomment-1780765719)).
