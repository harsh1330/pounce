<p align="center"><img src="https://pounce.harshcom.in/pounce.svg" width="88" alt=""></p>

# pounce

Click anything on your screen by typing its name.

pounce brings Shortcat-style hints to GNOME on Wayland. Press <kbd>Super</kbd>+<kbd>B</kbd> and every
button, link, tab and menu item on screen gets a two-letter code: in every visible window, the top
bar, the dock and desktop icons. Type the code, or the start of a label such as `blu` for
Bluetooth, then press Enter. Shift+Enter right-clicks.

**Website and install guide: [pounce.harshcom.in](https://pounce.harshcom.in)**

## Install

On Ubuntu or Debian with GNOME 42 or newer:

```sh
curl -fsSL https://pounce.harshcom.in/key.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/pounce.gpg
echo "deb [signed-by=/usr/share/keyrings/pounce.gpg] https://pounce.harshcom.in/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/pounce.list
sudo apt update && sudo apt install pounce
pounce setup
```

Signing key fingerprint: `926B A38C A1B1 F055 54D0  3A28 CE92 3D4B 1F32 A9DA`

`pounce setup` asks before each change it makes, and `pounce setup --undo` puts them back.
The `.deb` is also attached to each [release](https://github.com/harsh1330/pounce/releases).

## Reporting a bug

[Open an issue](https://github.com/harsh1330/pounce/issues/new/choose). The most useful reports
name the app where pounce missed something, and include the output of `pounce doctor`.

## What's in this repository

pounce is free to use but closed source. This repository holds the release notes, the issue
tracker, and the source of pounce's GNOME Shell extension, which draws the codes on screen.
The extension is free software under the GNU General Public License, version 2 or later
([extension/pounce@pounce.dev/LICENSE](extension/pounce%40pounce.dev/LICENSE)).

`tools/build_extension.py` turns `extension/` into the two builds shipped in the package: one for
GNOME 45 and newer, and one for GNOME 42 to 44.

pounce has no network code: no update checks, no analytics, no crash reports.
