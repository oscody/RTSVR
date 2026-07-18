#!/usr/bin/env python3
"""Bake the 24x24 game board into a single glTF.

Reuses the terrain tile mesh/material exported by Meta Spatial Editor
(public/gltf/generated/BoardTile_1.gltf) and emits one file containing a
GRID x GRID node grid, centered on the origin with a clean pivot. Import the
result into metaspatial/ as the single "GameBoard" object; the invisible
collider grid in scenario.ts must use the same GRID/PITCH constants.

Usage: python3 scripts/generate_board.py
"""
import json
import pathlib

GRID = 40
PITCH = 0.15         # meters between tile centers
TILE_SCALE = 0.144   # 96% of pitch -> hairline seams, city-builder style

root = pathlib.Path(__file__).resolve().parent.parent
# Template = any glTF carrying the terrain tile mesh + "rock" material. The
# script's own previous output works (self-hosting); the MSE-exported
# GameBoard is the fallback for a fresh checkout.
for candidate in ("metaspatial/board.gltf", "metaspatial/board24.gltf",
                  "public/gltf/generated/GameBoard.gltf"):
    path = root / candidate
    if path.exists():
        template = json.load(open(path))
        break
else:
    raise SystemExit("no template glTF found with the terrain tile mesh")

nodes = []
for gy in range(GRID):
    for gx in range(GRID):
        nodes.append({
            "name": f"boardCell_{gx}_{gy}",
            "mesh": 0,
            "translation": [(gx - (GRID - 1) / 2) * PITCH, 0,
                            (gy - (GRID - 1) / 2) * PITCH],
            "scale": [TILE_SCALE, 1, TILE_SCALE],
        })

out = {
    "asset": template["asset"],
    "scene": 0,
    "scenes": [{"nodes": list(range(len(nodes)))}],
    "nodes": nodes,
    "meshes": template["meshes"],
    "materials": template["materials"],
    "accessors": template["accessors"],
    "bufferViews": template["bufferViews"],
    "buffers": template["buffers"],
}

dest = root / "metaspatial/board.gltf"
dest.write_text(json.dumps(out))
print(f"wrote {dest} ({dest.stat().st_size} bytes, {len(nodes)} tiles, "
      f"{GRID * PITCH:.1f}m square)")
