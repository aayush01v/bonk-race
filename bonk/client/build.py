#!/usr/bin/env python3
"""Build the two playable single-file clients from the shared sources.

  python3 build.py            builds both
  python3 build.py webgl      builds dist/sim-race-webgl.html   (hand-written WebGL1 renderer, no network needed)
  python3 build.py babylon    builds dist/sim-race-babylon.html (Babylon.js renderer, loads Babylon from a CDN)

Sources in this folder: ui.html (page + CSS), game.js (input, HUD, audio, camera, particle data),
gl.js (WebGL1 renderer), bjs.js (Babylon renderer).  The sim is read from ../sim.js (or ./sim.js).

The Babylon build is game.js with two blocks swapped: the renderer lookup at the top and the
"drawing" section.  Everything else (input, HUD, audio, menu, results) is the same code in both builds.
"""
import re, sys
from pathlib import Path

here = Path(__file__).resolve().parent
read = lambda p: Path(p).read_text(encoding="utf-8")
sim_path = here / "sim.js" if (here / "sim.js").exists() else here.parent / "sim.js"
BABYLON_URL = "https://cdnjs.cloudflare.com/ajax/libs/babylonjs/8.20.0/babylon.js"
BABYLON_FALLBACK = "https://cdn.babylonjs.com/babylon.js"

def inline(html, marker, src, name):
    assert marker in html, marker + " is missing from ui.html"
    assert "</script" not in src.lower(), name + " must not contain a closing script tag"
    return html.replace(marker, "<script>\n" + src + "\n</script>")

def build_webgl():
    out = read(here / "ui.html")
    out = inline(out, "<!--@GL-->", read(here / "gl.js"), "gl.js")
    out = inline(out, "<!--@SIM-->", read(sim_path), "sim.js")
    out = inline(out, "<!--@GAME-->", read(here / "game.js"), "game.js")
    return out

HEADER_OLD = re.compile(r"const G = typeof GFX !== 'undefined' \? GFX : null;.*?const \{ push, pop, translate, scale, rotX, rotY, draw \} = G;\n", re.S)
HEADER_NEW = """const G = typeof BJS !== 'undefined' && BJS.ok ? BJS : null;
if (!G) {
  $('errMsg').textContent = "Babylon.js couldn't start: " + ((typeof BJS !== 'undefined' && BJS.error) || 'the script did not load') +
    ". This build downloads Babylon.js from a CDN, so it needs an internet connection. sim-race-webgl.html has no such requirement.";
  $('err').classList.remove('hidden'); $('menu').classList.add('hidden');
  return;
}
const rgb = G.rgb;
"""
DRAW_OLD = re.compile(r"/\* -+ drawing -+ \*/.*?(?=function render\(t\) \{)", re.S)
DRAW_NEW = """/* ---------------- drawing: handled by bjs.js (Babylon.js) ---------------- */
function drawScene(t) { G.scene(sim, t, me, flags, world, clouds); }
function drawActors(t) { G.actors(sim, t, me, vis, KINDS, mode, groundBelow); }
function drawFx() {
  packParticles();
  for (const k of sim.pickups) if (k.on) glow(k.x, k.y, k.z, YELLOW, 0.4, 1.6);
  for (const b of sim.bullets) glow(b.x, b.y, b.z, [1, 0.9, 0.5], 0.55, 0.9);
  G.fx(pdata, pn);            // updates particles, then renders the Babylon scene
}

"""

def babylon_game():
    g = read(here / "game.js")
    g, n1 = HEADER_OLD.subn(lambda m: HEADER_NEW, g, count=1)
    g, n2 = DRAW_OLD.subn(lambda m: DRAW_NEW, g, count=1)
    assert n1 == 1, "could not find the renderer header block in game.js"
    assert n2 == 1, "could not find the drawing section in game.js"
    assert "G.outlineBegin" not in g and "drawRacer" not in g, "old immediate-mode drawing code is still present"
    return g

def build_babylon():
    out = read(here / "ui.html")
    loader = ('<script src="%s"></script>\n<script>if (typeof BABYLON === "undefined") document.write(\'<script src="%s"><\\/script>\');</script>\n'
              % (BABYLON_URL, BABYLON_FALLBACK))
    bjs = read(here / "bjs.js")
    assert "</script" not in bjs.lower(), "bjs.js must not contain a closing script tag"
    assert "<!--@GL-->" in out, "<!--@GL--> is missing from ui.html"
    out = out.replace("<!--@GL-->", loader + "<script>\n" + bjs + "\n</script>")
    out = inline(out, "<!--@SIM-->", read(sim_path), "sim.js")
    out = inline(out, "<!--@GAME-->", babylon_game(), "game.js (babylon variant)")
    return out

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    dist = here / "dist"; dist.mkdir(exist_ok=True)
    if which in ("all", "webgl"):
        (dist / "sim-race-webgl.html").write_text(build_webgl(), encoding="utf-8"); print("built dist/sim-race-webgl.html")
    if which in ("all", "babylon"):
        (dist / "sim-race-babylon.html").write_text(build_babylon(), encoding="utf-8"); print("built dist/sim-race-babylon.html")
