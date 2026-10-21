"""Stamp a new app version: the service-worker cache name and files.json.

Run before committing any change to app files or data:  python3 tools/release.py

files.json lists every file the app needs offline with a short content hash. The service
worker downloads only files whose hash changed since the version the phone already has, and
copies the rest from its previous cache (an update then costs kilobytes, not the whole app).
"""
import datetime, hashlib, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# what the app needs offline (data/info/ holds the summary-writing batches, not needed at runtime)
INCLUDE = ["index.html", "manifest.webmanifest", "src/*.js", "src/*.css", "lib/*", "icons/*.png",
           "data/*.json", "data/*.geojson", "data/sub/*", "flags/*.svg", "flags/sub/*"]

SF_DATALESS = 0x40000000  # macOS: file offloaded to iCloud ("Optimise Mac Storage")
try:
    previous = json.loads((ROOT / "files.json").read_text())["files"]
except Exception:
    previous = {}

def digest(p):
    # An offloaded file can't have changed since it was last written, so its hash from the
    # previous release is still right; reading it would wait for an iCloud download.
    key = "./" + p.relative_to(ROOT).as_posix()
    if getattr(p.stat(), "st_flags", 0) & SF_DATALESS and key in previous:
        return previous[key]
    return hashlib.sha1(p.read_bytes()).hexdigest()[:12]

files = {}
for pattern in INCLUDE:
    for p in sorted(ROOT.glob(pattern)):
        if p.is_file() and not re.search(r" \d+\.\w+$", p.name):  # skip iCloud "x 2.svg" copies
            files["./" + p.relative_to(ROOT).as_posix()] = digest(p)
files["./"] = files["./index.html"]  # the start URL is the same page

v = datetime.datetime.now().strftime("%Y-%m-%d.%H%M%S")
(ROOT / "files.json").write_text(json.dumps({"version": v, "files": files}, indent=0, sort_keys=True) + "\n")
sw = ROOT / "sw.js"
sw.write_text(re.sub(r"var CACHE = '[^']*';", f"var CACHE = 'ltc-{v}';", sw.read_text()))
size = sum((ROOT / k[2:]).stat().st_size for k in files if k != "./")
print(f"version {v}: {len(files) - 1} files, {size / 1e6:.1f} MB")
