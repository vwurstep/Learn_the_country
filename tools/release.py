"""Stamp a new cache name into sw.js so phones fetch the new files.

Run before committing any change to app files or data:  python3 tools/release.py
"""
import datetime, re
from pathlib import Path

sw = Path(__file__).resolve().parent.parent / "sw.js"
v = datetime.datetime.now().strftime("%Y-%m-%d.%H%M%S")
sw.write_text(re.sub(r"var CACHE = '[^']*';", f"var CACHE = 'ltc-{v}';", sw.read_text()))
print("version", v)
