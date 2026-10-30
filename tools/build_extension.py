#!/usr/bin/env python3
"""Build the GNOME Shell extension from extension/pounce@pounce.dev.

    tools/build_extension.py                  release builds for every target, plus zips
    tools/build_extension.py --dev legacy     keep the dev tools (Reload, DebugScreenshot)

Targets:
  modern  GNOME 45+: the source as is (ES modules).
  legacy  GNOME 42-44: imports converted to the old `imports.*` module system.

Release builds drop everything between `@dev-start` and `@dev-end` markers. Output goes to
build/extension/<target>/pounce@pounce.dev, and with --zip to a zip ready for
extensions.gnome.org.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UUID = "pounce@pounce.dev"
SOURCE = ROOT / "extension" / UUID
SHELL_VERSIONS = {
    "modern": ["45", "46", "47", "48"],  # tested: 46; 49+ untested
    "legacy": ["42", "43", "44"],  # tested: 42
}

DEV_BLOCK = re.compile(r"^[ \t]*(?://|<!--) @dev-start.*?@dev-end.*?\n", re.S | re.M)

# ES module imports and their legacy equivalents. Anything not listed is an error, so a new
# import can't slip into a legacy build unconverted.
LEGACY_IMPORTS = {
    "import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';": (
        "const Me = imports.misc.extensionUtils.getCurrentExtension();\n"
        "class Extension {\n"
        "    constructor() {\n"
        "        this.dir = Me.dir;\n"
        "    }\n"
        "}"
    ),
    "import * as Main from 'resource:///org/gnome/shell/ui/main.js';": (
        "const Main = imports.ui.main;"
    ),
    "import {Overlay} from './overlay.js';": (
        "const {Overlay} = imports.misc.extensionUtils.getCurrentExtension().imports.overlay;"
    ),
    # Mtk (GNOME 45) took over Meta.Rectangle.
    "import Mtk from 'gi://Mtk';": "const Mtk = {Rectangle: imports.gi.Meta.Rectangle};",
}
GI_IMPORT = re.compile(r"^import (\w+) from 'gi://(\w+)';$", re.M)


def version() -> str:
    # pyproject.toml in the main tree; a plain VERSION file in the public extension repo.
    pyproject = ROOT / "pyproject.toml"
    if pyproject.exists():
        return re.search(r'^version = "([^"]+)"', pyproject.read_text(), re.M).group(1)
    return (ROOT / "VERSION").read_text().strip()


def to_legacy(name: str, js: str) -> str:
    for esm, legacy in LEGACY_IMPORTS.items():
        js = js.replace(esm, legacy)
    js = GI_IMPORT.sub(lambda m: f"const {m[1]} = imports.gi.{m[2]};", js)
    # Legacy modules export their top-level `var`s.
    js = re.sub(r"^export class (\w+)", r"var \1 = class \1", js, flags=re.M)
    if name == "extension.js":
        js = js.replace("export default class PounceExtension", "class PounceExtension")
        js += "\nfunction init() {\n    return new PounceExtension();\n}\n"
    left = re.findall(r"^(?:import|export) .*$", js, re.M)
    if left:
        sys.exit(f"{name}: no legacy conversion for: {left}")
    return js


def build(target: str, out: Path, dev: bool, zip_it: bool) -> Path:
    dest = out / target / UUID
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(SOURCE, dest)
    for js in sorted(dest.glob("*.js")):
        text = js.read_text()
        if not dev:
            text = DEV_BLOCK.sub("", text)
            if "@dev-" in text:
                sys.exit(f"{js.name}: unbalanced @dev markers")
        if target == "legacy":
            text = to_legacy(js.name, text)
        js.write_text(text)
    meta = json.loads((dest / "metadata.json").read_text())
    meta["shell-version"] = SHELL_VERSIONS[target]
    meta["version-name"] = version()
    (dest / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n")
    if zip_it:
        archive = out / f"{UUID}.{target}.v{version()}"
        shutil.make_archive(str(archive), "zip", dest)
        print(f"{archive}.zip")
    print(dest)
    return dest


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("targets", nargs="*", choices=[*SHELL_VERSIONS, []], default=[])
    p.add_argument("--dev", action="store_true", help="keep the dev tools")
    p.add_argument("--zip", action="store_true", help="also write extensions.gnome.org zips")
    p.add_argument("--out", type=Path, default=ROOT / "build" / "extension")
    args = p.parse_args()
    for target in args.targets or SHELL_VERSIONS:
        build(target, args.out, args.dev, args.zip)
    return 0


if __name__ == "__main__":
    sys.exit(main())
