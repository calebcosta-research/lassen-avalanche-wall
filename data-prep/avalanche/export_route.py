"""
Build the demo journey through Lassen Volcanic NP and sample the AutoATES terrain
layers along it.

Route (OpenStreetMap, osm/lassen_ways.json):
  Lassen Peak Highway (way 10594137) from the south end to the Lassen Peak trailhead,
  Lassen Peak Trail (way 27030041) to the summit, back down the trail, and on along the
  highway to its north end.

For every ~10 m sample the script reads, from Avi_application/viewer/data/10m
(see Avi_application/terrain/scripts/export_viewer.py for the encodings):
  zones.png     3 start zone, 2 runout, 1 extreme runout only, 0 none
  source.png    for runout cells, the start (trigger) cell behind it
  upstream.png  the point ~100 m back up that avalanche path (arrow target)
  terrain.png   own aspect/band, and the aspect/band of the feeding start zone
and assesses it against one example conditions day (viewer/conditions), the same way
the viewer's assess() does.

Output: apps/website/public/data/avalanche/route.json

Usage:
  python export_route.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer

HERE = Path(__file__).resolve().parent
AVI_APP = Path(r"E:\Research\Avi_application")
VIEWER_DATA = AVI_APP / "viewer" / "data" / "10m"
CONDITIONS = AVI_APP / "viewer" / "conditions" / "storm_sw_wind.json"
ELEVATION = Path(r"E:\Research\Avi_mapping\static_terrain\scripts\data\terrain\elevation.tif")
OUT = HERE.parents[1] / "apps" / "website" / "public" / "data" / "avalanche" / "route.json"

HIGHWAY_WAY, TRAIL_WAY = 10594137, 27030041
STEP_M = 10.0
MIN_RUN_M = 100.0       # zone runs shorter than this merge into a neighbouring run
LAST_LEG_MAX_M = 10_000.0  # past ~10 km north of the trailhead the highway leaves avalanche terrain
HEADING_WINDOW_M = 250.0
R_EARTH = 6378137.0

ASP = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
BANDS = ["below_treeline", "treeline", "alpine"]
BAND_LABEL = ["below treeline", "near treeline", "alpine"]
DANGER = {1: "Low", 2: "Moderate", 3: "Considerable", 4: "High", 5: "Extreme"}
ZONE_LABEL = {
    3: "Avalanche terrain",
    2: "Avalanche runout",
    1: "Possible extreme runout",
    0: "No mapped avalanche terrain",
}
ZONE_RGB = {(229, 57, 53): 3, (253, 200, 0): 2, (255, 241, 160): 1, (67, 160, 71): 0}


def load_png(name: str) -> np.ndarray:
    return np.asarray(Image.open(VIEWER_DATA / f"{name}.png"))


def main() -> None:
    meta = json.loads((VIEWER_DATA / "meta.json").read_text())
    zones, source, upstream, terrain = (load_png(n) for n in ("zones", "source", "upstream", "terrain"))
    cond = json.loads(CONDITIONS.read_text())

    ways = {e["id"]: [(p["lon"], p["lat"]) for p in e["geometry"]]
            for e in json.loads((HERE / "osm" / "lassen_ways.json").read_text())["elements"]}
    hwy, trail = ways[HIGHWAY_WAY], ways[TRAIL_WAY]
    if hwy[0][1] > hwy[-1][1]:
        hwy = hwy[::-1]  # south -> north
    if trail[0][1] > trail[-1][1]:
        trail = trail[::-1]  # trailhead -> summit

    utm = Transformer.from_crs("EPSG:4326", "EPSG:32610", always_xy=True)
    to_ll = Transformer.from_crs("EPSG:32610", "EPSG:4326", always_xy=True)

    def xy(pts):
        x, y = utm.transform([p[0] for p in pts], [p[1] for p in pts])
        return np.column_stack([x, y])

    hwy_xy, trail_xy = xy(hwy), xy(trail)
    th = int(np.argmin(np.hypot(*(hwy_xy - trail_xy[0]).T)))  # trailhead vertex on the highway

    legs = [
        ("drive", hwy_xy[: th + 1]),
        ("climb", np.vstack([hwy_xy[th], trail_xy])),
        ("descend", np.vstack([trail_xy[::-1], hwy_xy[th]])),
        ("drive", hwy_xy[th:]),
    ]
    last = legs[-1][1]
    keep = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(last, axis=0).T))]) <= LAST_LEG_MAX_M
    legs[-1] = ("drive", last[keep])

    # Densify each leg to ~STEP_M and concatenate
    pts, leg_of, leg_ranges, total = [], [], [], 0.0
    for li, (kind, line) in enumerate(legs):
        seg = np.hypot(*np.diff(line, axis=0).T)
        cum = np.concatenate([[0], np.cumsum(seg)])
        n = max(2, int(math.ceil(cum[-1] / STEP_M)) + 1)
        d = np.linspace(0, cum[-1], n)
        lx, ly = np.interp(d, cum, line[:, 0]), np.interp(d, cum, line[:, 1])
        start = 1 if pts else 0  # skip duplicate joint
        leg_ranges.append({"kind": kind, "from_m": round(total, 1), "to_m": round(total + cum[-1], 1)})
        for i in range(start, n):
            pts.append((lx[i], ly[i], total + d[i]))
            leg_of.append(li)
        total += cum[-1]
    P = np.array(pts)
    lon, lat = to_ll.transform(P[:, 0], P[:, 1])
    lon, lat, dist = np.asarray(lon), np.asarray(lat), P[:, 2]

    # Elevation (10 m DEM, UTM)
    with rasterio.open(ELEVATION) as src:
        ex, ey = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True).transform(lon, lat)
        elev = np.array([v[0] for v in src.sample(zip(ex, ey))], dtype=float)

    # Web Mercator pixels in the viewer rasters
    mx = np.radians(lon) * R_EARTH
    my = np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * R_EARTH
    col = np.floor((mx - meta["merc_left"]) / meta["merc_px"]).astype(int)
    row = np.floor((meta["merc_top"] - my) / meta["merc_px"]).astype(int)
    assert (col >= 0).all() and (row >= 0).all() and (col < meta["width"]).all() and (row < meta["height"]).all()

    def pix_ll(c, r):
        x = meta["merc_left"] + (c + 0.5) * meta["merc_px"]
        y = meta["merc_top"] - (r + 0.5) * meta["merc_px"]
        return [round(math.degrees(x / R_EARTH), 6),
                round(math.degrees(2 * math.atan(math.exp(y / R_EARTH)) - math.pi / 2), 6)]

    def pointer(img, r, c):
        v = (int(img[r, c, 0]) << 16 | int(img[r, c, 1]) << 8 | int(img[r, c, 2])) - 1
        return pix_ll(v >> 12, v & 4095) if v >= 0 else None

    raw_zone, src_pt, up_pt, slope_ab = [], [], [], []
    for r, c in zip(row, col):
        px = zones[r, c]
        z = ZONE_RGB.get(tuple(int(v) for v in px[:3]), 0) if px[3] else 0
        raw_zone.append(z)
        own = (int(terrain[r, c, 0]), int(terrain[r, c, 1]))
        f = int(terrain[r, c, 2])
        feed = ((f - 1) // 3, (f - 1) % 3) if f > 0 else None
        if z in (1, 2):
            src_pt.append(pointer(source, r, c))
            up_pt.append(pointer(upstream, r, c))
            slope_ab.append(feed)
        else:
            src_pt.append(None)
            up_pt.append(None)
            slope_ab.append(own if z == 3 else None)
    raw_zone = np.array(raw_zone)

    # Run-length smoothing: short flickers (a single pixel of runout at a road
    # culvert) would otherwise fire a notification every few metres.
    runs = []
    i = 0
    while i < len(raw_zone):
        j = i
        while j + 1 < len(raw_zone) and raw_zone[j + 1] == raw_zone[i]:
            j += 1
        runs.append([i, j, int(raw_zone[i])])
        i = j + 1
    changed = True
    while changed:
        changed = False
        for k, (a, b, z) in enumerate(runs):
            if (dist[b] - dist[a]) < MIN_RUN_M and len(runs) > 1:
                tgt = k - 1 if k > 0 else k + 1
                runs[tgt][0] = min(runs[tgt][0], a)
                runs[tgt][1] = max(runs[tgt][1], b)
                runs.pop(k)
                changed = True
                break
        merged = [runs[0]]
        for a, b, z in runs[1:]:
            if z == merged[-1][2]:
                merged[-1][1] = b
            else:
                merged.append([a, b, z])
        runs = merged
    zone = np.zeros(len(raw_zone), int)
    for a, b, z in runs:
        zone[a: b + 1] = z

    def problems_for(ab):
        if ab is None:
            return []
        a, b = ab
        return [p for p in cond["problems"] if ASP[a] in p["aspects"] and BANDS[b] in p["elevation_bands"]]

    def bearing(lo1, la1, lo2, la2):
        f1, f2, dl = math.radians(la1), math.radians(la2), math.radians(lo2 - lo1)
        y = math.sin(dl) * math.cos(f2)
        x = math.cos(f1) * math.sin(f2) - math.sin(f1) * math.cos(f2) * math.cos(dl)
        return (math.degrees(math.atan2(y, x)) + 360) % 360

    def compass(b):
        return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][round(b / 22.5) % 16]

    # Events: one per smoothed zone run
    events = []
    for a, b, z in runs:
        own_band = int(terrain[row[a], col[a], 1])
        # describe the run by its most common feeding/own slope
        abs_ = [slope_ab[k] for k in range(a, b + 1) if slope_ab[k] is not None]
        ab = max(set(abs_), key=abs_.count) if abs_ else None
        probs = problems_for(ab)
        active = bool(probs) and z > 0
        if z == 1:
            active = ab is not None and (cond["danger"][BANDS[ab[1]]] >= 4 or any(p["size"][1] >= 3 for p in probs))
        ev = {
            "i": int(a), "end_i": int(b),
            "dist_m": round(float(dist[a]), 1), "length_m": round(float(dist[b] - dist[a]), 1),
            "zone": z, "label": ZONE_LABEL[z],
            "elev_m": round(float(elev[a])),
            "band": BAND_LABEL[own_band],
            "danger": DANGER[cond["danger"][BANDS[own_band]]],
            "danger_level": cond["danger"][BANDS[own_band]],
            "slope": f"{ASP[ab[0]]}-facing, {BAND_LABEL[ab[1]]}" if ab else None,
            "problems": [{"type": p["type"], "likelihood": p["likelihood"], "size": p["size"]} for p in probs],
            "active": active,
        }
        k = next((k for k in range(a, b + 1) if src_pt[k]), None)
        if z in (1, 2) and k is not None:
            s = src_pt[k]
            ev["start_zone"] = {
                "distance_m": round(math.dist(utm.transform(*s), (P[k, 0], P[k, 1]))),
                "compass": compass(bearing(lon[k], lat[k], s[0], s[1])),
            }
        events.append(ev)

    # Smoothed heading along the route (look-ahead minus look-behind)
    heading = []
    for k in range(len(dist)):
        a = int(np.searchsorted(dist, dist[k] - HEADING_WINDOW_M))
        b = min(len(dist) - 1, int(np.searchsorted(dist, dist[k] + HEADING_WINDOW_M)))
        heading.append(round(bearing(lon[a], lat[a], lon[b], lat[b]), 1) if b > a else 0.0)
    # unwrap so clients can interpolate without 359 -> 0 jumps
    heading = np.degrees(np.unwrap(np.radians(heading))).round(1).tolist()

    summit_i = int(np.argmax(elev))
    out = {
        "source": {
            "route": "OpenStreetMap contributors (ODbL): Lassen Peak Highway, Lassen Peak Trail",
            "terrain": "Avi_application AutoATES 10 m run (zones/source/upstream/terrain)",
            "conditions": cond["name"] + " - " + cond["date"],
        },
        "conditions": {k: cond[k] for k in ("name", "date", "summary", "danger", "problems", "weather")},
        "zones_image": {"file": "zones_10m.png", "bounds_latlon": meta["bounds_latlon"]},
        "total_m": round(float(dist[-1]), 1),
        "legs": leg_ranges,
        "summit": {"i": summit_i, "dist_m": round(float(dist[summit_i]), 1), "elev_m": round(float(elev[summit_i]))},
        "samples": {
            "lon": [round(float(v), 6) for v in lon],
            "lat": [round(float(v), 6) for v in lat],
            "dist": [round(float(v), 1) for v in dist],
            "elev": [round(float(v)) for v in elev],
            "zone": zone.tolist(),
            "heading": heading,
            "src": src_pt,
            "up": up_pt,
        },
        "events": events,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    # Wall overlay: green (no mapped avalanche terrain) made transparent to keep the map legible
    z = zones.copy()
    z[(z[..., 0] == 67) & (z[..., 1] == 160) & (z[..., 2] == 71)] = 0
    Image.fromarray(z, "RGBA").save(OUT.parent / "zones_10m.png", optimize=True)
    print(f"{len(dist)} samples, {dist[-1] / 1000:.1f} km, {len(events)} events, summit {elev[summit_i]:.0f} m "
          f"at {dist[summit_i] / 1000:.2f} km, {OUT.stat().st_size / 1e3:.0f} kB")
    for e in events:
        print(f"  {e['dist_m'] / 1000:6.2f} km  {e['length_m']:6.0f} m  {e['label']:<28} {e['slope'] or '':<28}"
              f" {'ACTIVE ' + '+'.join(p['type'] for p in e['problems']) if e['active'] else ''}")


if __name__ == "__main__":
    main()
