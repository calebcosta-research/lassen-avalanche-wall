"""
Re-run the Lassen NE storm-slab avalanche with the Avi_mapping Voellmy solver and
record the flow as animation frames for the wall demo.

The peak rasters in Avi_mapping only keep the maximum over the run; the wall needs
the flow through time, so this script steps the same solver (same DEM, release,
scenario inputs as run_sim.py) and snapshots depth and speed every FRAME_DT seconds.

Outputs (apps/website/public/data/avalanche/):
  sim_frames.bin.gz  gzip of uint8, frames x 2 x rows x cols: depth (cm, capped 255) then
                   speed (0.1 m/s, capped 255), row 0 = north edge of the crop
  sim_meta.json    crop corners (lon/lat, for a MapLibre image/canvas source),
                   frame times, release outline, summary numbers

Usage:
  python export_sim_frames.py
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer

AVI_MAPPING = Path(r"E:\Research\Avi_mapping")
SIM_SCRIPTS = AVI_MAPPING / "simulation" / "scripts"
SLOPE_DIR = AVI_MAPPING / "simulation" / "data" / "lassen_ne"
OUT_DIR = Path(__file__).resolve().parents[2] / "apps" / "website" / "public" / "data" / "avalanche"

sys.path.insert(0, str(SIM_SCRIPTS))
from scenario import get_scenario  # noqa: E402
from solver import EPS, H_MIN, VoellmyFlow  # noqa: E402

SCENARIO = "storm_slab"
FRAME_DT = 1.0          # s of simulated time between frames
T_MAX = 150.0           # s: the flow front stops by ~120 s; after that the solver only
                        # creeps (~30 MJ plateau, see run_sim.py summary), not worth shipping
STOP_KE_FRAC = 0.01     # same arrest criterion as VoellmyFlow.run
CROP_THRESH = 0.02      # m: cells ever deeper than this define the crop
CROP_MARGIN = 12        # cells


def main() -> None:
    scen = get_scenario(SCENARIO)
    with rasterio.open(SLOPE_DIR / "dem.tif") as src:
        dem = src.read(1).astype(np.float64)
        nodata = src.profile.get("nodata", -9999.0)
        res = src.res[0]
        transform = src.transform
        crs = src.crs
    dem = np.where(dem == nodata, np.nan, dem)
    dem = np.where(np.isfinite(dem), dem, np.nanmin(dem))
    with rasterio.open(SLOPE_DIR / "release.tif") as src:
        release = src.read(1).astype(bool)

    # Same initial condition as run_sim.py: slab-normal d0 -> vertical depth
    dz_r, dz_c = np.gradient(dem, res)
    cos_t = 1.0 / np.sqrt(1.0 + dz_r**2 + dz_c**2)
    h = np.where(release, scen.d0 / np.maximum(cos_t, 0.5), 0.0)
    hu = np.zeros_like(h)
    hv = np.zeros_like(h)

    model = VoellmyFlow(dem, res, mu=scen.mu, xi=scen.xi, rho=scen.rho)

    def snapshot(h, hu, hv):
        wet = h > H_MIN
        speed = np.where(wet, np.hypot(hu, hv) / np.maximum(h, EPS), 0.0)
        return h.astype(np.float32), speed.astype(np.float32)

    frames, times, ke_log = [snapshot(h, hu, hv)], [0.0], []
    t, next_frame, ke_peak = 0.0, FRAME_DT, 0.0
    while t < T_MAX:
        h, hu, hv, dt = model.step(h, hu, hv)
        t += dt
        if t >= next_frame:
            fh, fs = snapshot(h, hu, hv)
            frames.append((fh, fs))
            times.append(round(t, 2))
            next_frame += FRAME_DT
            ke = float(0.5 * scen.rho * (fh * fs**2).sum() * res**2)
            ke_peak = max(ke_peak, ke)
            ke_log.append(round(ke / 1e6, 2))
            if len(frames) % 20 == 0:
                print(f"t={t:6.1f}s  vmax={fs.max():5.1f} m/s  KE={ke / 1e6:7.2f} MJ", flush=True)
            if ke_peak > 0 and ke < STOP_KE_FRAC * ke_peak and t > 10.0:
                break

    hmax = np.max([f[0] for f in frames], axis=0)
    rows, cols = np.where(hmax > CROP_THRESH)
    r0, r1 = max(0, rows.min() - CROP_MARGIN), min(dem.shape[0], rows.max() + CROP_MARGIN + 1)
    c0, c1 = max(0, cols.min() - CROP_MARGIN), min(dem.shape[1], cols.max() + CROP_MARGIN + 1)

    depth = np.stack([np.clip(np.round(f[0][r0:r1, c0:c1] * 100), 0, 255) for f in frames]).astype(np.uint8)
    speed = np.stack([np.clip(np.round(f[1][r0:r1, c0:c1] * 10), 0, 255) for f in frames]).astype(np.uint8)
    packed = np.stack([depth, speed], axis=1)  # frames x 2 x rows x cols

    to_ll = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    def corner(r, c):
        x = transform.c + c * transform.a
        y = transform.f + r * transform.e
        lon, lat = to_ll.transform(x, y)
        return [round(lon, 7), round(lat, 7)]

    # MapLibre image source order: top-left, top-right, bottom-right, bottom-left
    corners = [corner(r0, c0), corner(r0, c1), corner(r1, c1), corner(r1, c0)]

    # Ground height at the crop centre: the wall camera orbits this point at the summit
    centre_elev = float(dem[(r0 + r1) // 2, (c0 + c1) // 2])

    rel = json.loads((SLOPE_DIR / "release.geojson").read_text())
    rel_ring = [[round(v, 7) for v in to_ll.transform(x, y)]
                for x, y in rel["features"][0]["geometry"]["coordinates"][0]]
    summary = json.loads((SLOPE_DIR / "outputs" / SCENARIO / "summary.json").read_text())

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "sim_frames.bin.gz").write_bytes(gzip.compress(packed.tobytes(), 9))
    (OUT_DIR / "sim_frames.bin").unlink(missing_ok=True)
    meta = {
        "scenario": SCENARIO,
        "source": "Avi_mapping/simulation solver.py (Voellmy-Salm depth-averaged flow), Lassen Peak NE face",
        "inputs": {"d0_m": scen.d0, "mu": scen.mu, "xi": scen.xi, "rho": scen.rho},
        "frames": len(frames),
        "rows": int(r1 - r0),
        "cols": int(c1 - c0),
        "frame_dt_s": FRAME_DT,
        "times_s": times,
        "ke_MJ": [0.0] + ke_log,
        "depth_scale_m": 0.01,
        "speed_scale_ms": 0.1,
        "corners": corners,
        "centre_elev_m": round(centre_elev, 1),
        "release_ring": rel_ring,
        "summary": summary,
    }
    (OUT_DIR / "sim_meta.json").write_text(json.dumps(meta))
    print(f"{len(frames)} frames, crop {r1 - r0} x {c1 - c0}, "
          f"{(OUT_DIR / 'sim_frames.bin.gz').stat().st_size / 1e6:.1f} MB, t_end {t:.1f} s")


if __name__ == "__main__":
    main()
