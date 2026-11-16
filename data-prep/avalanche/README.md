# Avalanche journey demo: data prep

Builds the static files in `apps/website/public/data/avalanche/` used by
`/avalanche/screen` and `/avalanche/control` (switch the playground to it with `/?demo=avalanche`).

| Script | Reads | Writes |
| --- | --- | --- |
| `export_route.py` | `osm/lassen_ways.json` (OSM: Lassen Peak Highway, Lassen Peak Trail), `E:\Research\Avi_application\viewer\data\10m\*` (AutoATES zones, start-zone and upstream pointers, aspect/band), `viewer\conditions\storm_sw_wind.json`, `E:\Research\Avi_mapping\static_terrain\...\elevation.tif` | `route.json` (10 m samples, zone, trigger pointers, smoothed category events), `zones_10m.png` |
| `export_sim_frames.py` | `E:\Research\Avi_mapping\simulation` (solver.py, scenario.py, `data/lassen_ne`) | `sim_frames.bin.gz` (151 frames of depth + speed, 1 s apart), `sim_meta.json` |

```bash
python export_route.py
python export_sim_frames.py
```

Notes
- The route is: highway from the south end to the trailhead, trail to the summit, back down,
  then 10 km more of highway. Zone runs shorter than 100 m are merged so notifications don't flicker.
- The simulation re-runs the storm-slab scenario with the same inputs as `run_sim.py` and keeps the
  first 150 s; after that the solver only creeps (kinetic energy plateaus around 30 MJ).
- Conditions are the example "After a storm, SW wind" day, not a real forecast.
