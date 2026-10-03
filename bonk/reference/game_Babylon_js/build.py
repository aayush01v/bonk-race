#!/usr/bin/env python3
"""Build sim-race.html: inlines gl.js, sim.js and game.js into ui.html.

Put these five files in one folder and run:  python3 build.py
Output: sim-race.html (a single file you can open in any modern browser).
"""
from pathlib import Path

here = Path(__file__).resolve().parent
read = lambda name: (here / name).read_text(encoding="utf-8")

out = read("ui.html")
for marker, name in (("<!--@GL-->", "gl.js"), ("<!--@SIM-->", "sim.js"), ("<!--@GAME-->", "game.js")):
    src = read(name)
    assert marker in out, marker + " is missing from ui.html"
    assert "</script" not in src.lower(), name + " must not contain a closing script tag"
    out = out.replace(marker, "<script>\n" + src + "\n</script>")

(here / "sim-race.html").write_text(out, encoding="utf-8")
print("built sim-race.html (" + str(len(out)) + " characters)")
