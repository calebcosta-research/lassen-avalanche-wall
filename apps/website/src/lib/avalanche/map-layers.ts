// Imperative MapLibre layers for the avalanche journey.
//
// MapLibre draws the 3D terrain and the static draped layers (basemap, hillshade, zones,
// dashed route) plus the avalanche canvas. Everything that changes while playing lives in
// MarkerOverlay, because with 3D terrain any change to a MapLibre layer rebuilds the cached
// terrain textures. Works the same top-level and inside the wall's iframes.

import type { CanvasSource, LayerSpecification, Map as MaplibreMap } from 'maplibre-gl';

import { AVALANCHE_DATA_BASE, type RouteData, type SimData } from './data';
import { MarkerOverlay } from './marker-overlay';
import { clamp, smoothstep, WALL_H, WALL_W, type JourneyFrame, type Timeline } from './timeline';

export const JOURNEY_MAP_STYLE =
    'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';
const TERRARIUM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const ZONES_OPACITY = 0.34;
/** Prewarm: one stop every this many journey seconds while travelling. */
const PREWARM_STEP_S = 5;
/** Longest wait for one stop's tiles; slow networks move on rather than stall. */
const PREWARM_STOP_TIMEOUT_MS = 3000;
const TERRAIN_EXAGGERATION = 1.3;
/** Terrain mesh DEM zoom (~30 m cells at Lassen). The hillshade still uses z14 detail. */
const TERRAIN_MAX_ZOOM = 12;

/**
 * Wall camera distance in wall pixels: MapLibre's default 36.87 degree vertical field of view
 * over the full 2160 px wall height. Each client derives its own field of view from this so
 * all of them share one camera position.
 */
const WALL_CAMERA_DISTANCE = WALL_H / 2 / Math.tan((36.87 / 2) * (Math.PI / 180));

export type CameraRig = {
    /** Map canvas box in client CSS px, relative to the region's top-left corner. */
    box: { left: number; top: number; width: number; height: number };
    padding: { left: number; right: number; top: number; bottom: number };
    fov: number;
};

/**
 * Off-axis projection for one wall slice.
 *
 * The wall is one big perspective camera aimed at the wall centre. A screen that is not in
 * the middle needs that camera with its centre of perspective outside its own rectangle.
 * MapLibre supports an off-centre perspective through padding, but clamps it to the canvas,
 * so the canvas is extended toward the wall centre (at most 1.5x the pixels, on corner
 * units) and cropped by the stage. Same camera everywhere means the horizon and terrain
 * line up across bezels, which a per-screen centre shift cannot do once pitched.
 */
export function wallCameraRig(region: WallRegion, scale: number): CameraRig {
    const px = WALL_W / 2 - region.x; // wall centre in region coordinates (wall px)
    const py = WALL_H / 2 - region.y;
    const x0 = Math.min(0, px);
    const x1 = Math.max(region.w, px);
    const y0 = Math.min(0, py);
    const y1 = Math.max(region.h, py);
    const w = x1 - x0;
    const h = y1 - y0;
    const dx = 2 * (px - x0) - w; // left - right padding needed
    const dy = 2 * (py - y0) - h; // top - bottom padding needed
    return {
        box: { left: x0 * scale, top: y0 * scale, width: w * scale, height: h * scale },
        padding: {
            left: Math.max(0, dx) * scale,
            right: Math.max(0, -dx) * scale,
            top: Math.max(0, dy) * scale,
            bottom: Math.max(0, -dy) * scale
        },
        fov: (2 * Math.atan(h / 2 / WALL_CAMERA_DISTANCE) * 180) / Math.PI
    };
}

/** Which part of the 5760 x 2160 wall this client shows, and at what size. */
export type WallRegion = { x: number; y: number; w: number; h: number };

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;
const fc = (features: Feature[]): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features
});

// Widths in wall pixels; scaled to the client's real size on resize.
const SIZES = {
    routeAll: 7,
    routeCasing: 19
};

/** Levels the zone overlay dims through at the summit (each level = one texture rebuild). */
const ZONE_DIM_STEPS = 4;

// MapLibre internals used to refresh only the terrain tiles under the avalanche
// (maplibre-gl 5.21; guarded so a version change degrades to a full refresh).
type TerrainTile = { tileID: { canonical: { x: number; y: number; z: number } } };
type TerrainInternals = {
    terrain?: {
        tileManager: {
            getRenderableTiles(): TerrainTile[];
            freeRtt(tileID?: TerrainTile['tileID']): void;
        };
    };
};

export class JourneyMapLayers {
    private readonly map: MaplibreMap;
    private readonly route: RouteData;
    private sim: SimData | null = null;
    private simCanvas: HTMLCanvasElement | null = null;
    private simImage: ImageData | null = null;
    private simBounds: [number, number, number, number] | null = null; // w, s, e, n
    private lastSimKey = '';
    private lastScale = -1;
    /** Last frame applied: identical frames (paused clock) are skipped so the map can idle. */
    private lastFrameKey = '';
    private readonly paintCache = new Map<string, unknown>();
    private readonly markers: MarkerOverlay;
    private inUpdate = false;
    private lastFrame: JourneyFrame | null = null;
    private markerScale = 1;

    constructor(map: MaplibreMap, route: RouteData) {
        this.map = map;
        this.route = route;
        // We set the centre elevation ourselves (see CameraView.elevation).
        map.setCenterClampedToGround(false);
        // Dev-only handle for inspecting the live map from the console / test scripts.
        if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__aviMap = map;
        this.addBaseLayers();
        this.markers = new MarkerOverlay(map, route);
        // Renders we didn't drive (tiles arriving while paused can change terrain height
        // under a marker) re-place the overlay with the last frame.
        map.on('render', () => {
            if (!this.inUpdate && this.lastFrame)
                this.markers.update(this.lastFrame, this.markerScale);
        });
    }

    attachSim(sim: SimData) {
        if (this.sim) return;
        this.sim = sim;
        const { cols, rows, corners, release_ring } = sim.meta;
        const canvas = document.createElement('canvas');
        canvas.width = cols;
        canvas.height = rows;
        this.simCanvas = canvas;
        this.simImage = new ImageData(cols, rows);
        const lons = corners.map((c) => c[0]);
        const lats = corners.map((c) => c[1]);
        this.simBounds = [
            Math.min(...lons),
            Math.min(...lats),
            Math.max(...lons),
            Math.max(...lats)
        ];
        this.markers.setReleaseRing(release_ring);

        const beforeId = this.map.getLayer('route-casing') ? 'route-casing' : undefined;
        // animate: false matters: an animating CanvasSource counts as a permanent transition
        // and keeps the whole map redrawing at full frame rate. We upload only on change.
        this.map.addSource('sim', { type: 'canvas', canvas, coordinates: corners, animate: false });
        this.map.addLayer(
            {
                id: 'sim',
                type: 'raster',
                source: 'sim',
                layout: { visibility: 'none' },
                // Opacity is baked into the canvas pixels instead: changing a paint property
                // would throw away every cached terrain texture.
                paint: {
                    'raster-opacity': 1,
                    'raster-resampling': 'linear',
                    'raster-fade-duration': 0
                }
            },
            beforeId
        );
    }

    /** Apply one journey frame for the wall region shown by this client. */
    update(frame: JourneyFrame, region: WallRegion, clientWidth: number) {
        const scale = clientWidth / region.w;
        // Paused clock => same frame every tick. Skip all work so MapLibre stops rendering.
        const key = `${frame.t.toFixed(3)}|${scale.toFixed(4)}|${region.x},${region.y}|${this.sim ? 1 : 0}`;
        if (key === this.lastFrameKey) return;
        this.lastFrameKey = key;
        this.applyCamera(frame, region, scale);
        if (Math.abs(scale - this.lastScale) > 1e-3) this.applyScale(scale);
        const simChanged = this.updateSim(frame);
        const sim = simChanged ? this.map.getSource<CanvasSource>('sim') : undefined;
        // Render now, inside our animation frame, instead of on MapLibre's next one. The
        // map then shows exactly this frame's camera, and the overlay placed below (same
        // transform) is presented together with it: no one-frame drift.
        this.inUpdate = true;
        sim?.play(); // flag the new avalanche frame for upload during this render...
        this.map.redraw();
        sim?.pause(); // ...and stop uploading afterwards
        this.inUpdate = false;
        this.lastFrame = frame;
        this.markerScale = scale;
        this.markers.update(frame, scale);
    }

    /**
     * Fly the camera through every view the journey will use and wait for its tiles, so
     * playback runs from warm caches instead of decoding tiles mid-route. The route is
     * fixed, so the views are known in advance. Run before playback starts.
     */
    async prewarm(
        timeline: Timeline,
        region: WallRegion,
        clientWidth: number,
        onProgress: (fraction: number) => void,
        isCancelled: () => boolean
    ) {
        const scale = clientWidth / region.w;
        const times: number[] = [];
        for (let t = 0; t < timeline.simStart; t += PREWARM_STEP_S) times.push(t);
        // The swing round to the avalanche passes through new views: sample it densely.
        for (let u = 0; u <= 1.0001; u += 0.2) times.push(timeline.simStart + u * 6);
        times.push((timeline.simStart + timeline.simEnd) / 2);
        for (let t = timeline.simEnd; t < timeline.total; t += PREWARM_STEP_S) times.push(t);

        const started = performance.now();
        let timeouts = 0;
        for (const [i, t] of times.entries()) {
            if (isCancelled()) return;
            this.applyCamera(timeline.frameAt(t), region, scale);
            if (!(await this.waitForTiles())) timeouts++;
            onProgress((i + 1) / times.length);
        }
        if (import.meta.env.DEV) {
            (globalThis as Record<string, unknown>).__aviWarm = {
                stops: times.length,
                timeouts,
                ms: Math.round(performance.now() - started)
            };
        }
        this.lastFrameKey = ''; // make sure the first real frame is applied
    }

    private waitForTiles() {
        // Resolves true when the view's tiles are in, false if we gave up waiting.
        return new Promise<boolean>((resolve) => {
            const finish = (loaded: boolean) => {
                clearTimeout(timer);
                this.map.off('idle', onIdle);
                resolve(loaded);
            };
            const onIdle = () => finish(true);
            const timer = setTimeout(() => finish(false), PREWARM_STOP_TIMEOUT_MS);
            this.map.on('idle', onIdle);
            this.map.triggerRepaint();
        });
    }

    private applyCamera(frame: JourneyFrame, region: WallRegion, scale: number) {
        const { camera } = frame;
        // Every client uses the identical wall camera; only the slice of the image differs.
        const rig = wallCameraRig(region, scale);
        if (Math.abs(this.map.getVerticalFieldOfView() - rig.fov) > 1e-3) {
            this.map.setVerticalFieldOfView(rig.fov);
        }
        this.map.jumpTo({
            center: [camera.longitude, camera.latitude],
            zoom: camera.zoom + Math.log2(scale),
            bearing: camera.bearing,
            pitch: camera.pitch,
            padding: rig.padding,
            elevation: camera.elevation * TERRAIN_EXAGGERATION
        });
    }

    private addBaseLayers() {
        const map = this.map;
        const firstSymbol = map.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id;

        // Hillshade keeps full DEM detail: it's only shading, so it costs nothing in motion.
        map.addSource('dem', {
            type: 'raster-dem',
            encoding: 'terrarium',
            tiles: [TERRARIUM_TILES],
            tileSize: 256,
            maxzoom: 14
        });
        // 3D terrain mesh from a separate, coarser DEM (~30 m). Fewer detail levels means the
        // mesh doesn't visibly re-shape as finer tiles arrive, and it's lighter to draw.
        map.addSource('terrain-dem', {
            type: 'raster-dem',
            encoding: 'terrarium',
            tiles: [TERRARIUM_TILES],
            tileSize: 256,
            maxzoom: TERRAIN_MAX_ZOOM
        });
        map.setTerrain({ source: 'terrain-dem', exaggeration: TERRAIN_EXAGGERATION });
        map.setSky({
            'sky-color': '#0d1b2a',
            'horizon-color': '#33475b',
            'fog-color': '#0b0f13',
            'sky-horizon-blend': 0.7,
            'horizon-fog-blend': 0.6,
            'fog-ground-blend': 0.85
        });
        map.addLayer(
            {
                id: 'hillshade',
                type: 'hillshade',
                source: 'dem',
                paint: {
                    'hillshade-exaggeration': 0.55,
                    'hillshade-shadow-color': '#000000',
                    'hillshade-highlight-color': '#9aa4ae',
                    'hillshade-accent-color': '#20262c'
                }
            },
            firstSymbol
        );

        const [[s, w], [n, e]] = this.route.zones_image.bounds_latlon;
        map.addSource('zones', {
            type: 'image',
            url: `${AVALANCHE_DATA_BASE}/${this.route.zones_image.file}`,
            coordinates: [
                [w, n],
                [e, n],
                [e, s],
                [w, s]
            ]
        });
        map.addLayer(
            {
                id: 'zones',
                type: 'raster',
                source: 'zones',
                paint: {
                    'raster-opacity': ZONES_OPACITY,
                    'raster-resampling': 'nearest',
                    'raster-fade-duration': 0
                }
            },
            firstSymbol
        );

        // The whole route, static (dashed). The travelled part is drawn by MarkerOverlay.
        const { lon, lat } = this.route.samples;
        const line: Feature = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: lon.map((x, i) => [x, lat[i]]) }
        };
        map.addSource('route', { type: 'geojson', data: fc([line]) });
        const lineLayout = { 'line-cap': 'round', 'line-join': 'round' } as const;
        const layers: LayerSpecification[] = [
            {
                id: 'route-casing',
                type: 'line',
                source: 'route',
                layout: lineLayout,
                paint: { 'line-color': '#05080b', 'line-opacity': 0.75, 'line-width': 1 }
            },
            {
                id: 'route-all',
                type: 'line',
                source: 'route',
                layout: lineLayout,
                paint: {
                    'line-color': '#ffffff',
                    'line-opacity': 0.35,
                    'line-width': 1,
                    'line-dasharray': [1.5, 1.5]
                }
            }
        ];
        for (const layer of layers) map.addLayer(layer);
    }

    private applyScale(scale: number) {
        // Only on resize: a paint change rebuilds the cached terrain textures.
        this.lastScale = scale;
        const px = (v: number) => Math.max(0.5, v * scale);
        const set = (layer: string, prop: string, value: number) => {
            if (this.map.getLayer(layer)) this.map.setPaintProperty(layer, prop, value);
        };
        set('route-casing', 'line-width', px(SIZES.routeCasing));
        set('route-all', 'line-width', px(SIZES.routeAll));
    }

    /** Returns true when a new avalanche image was drawn and needs uploading. */
    private updateSim(frame: JourneyFrame) {
        // Dim the zone overlay at the summit in a few discrete steps (each step rebuilds the
        // terrain textures once) rather than a continuous fade (a rebuild every frame).
        const dim = Math.round(frame.simFocus * ZONE_DIM_STEPS) / ZONE_DIM_STEPS;
        this.setPaint('zones', 'raster-opacity', ZONES_OPACITY * (1 - 0.65 * dim));
        if (!this.sim || !this.simCanvas || !this.simImage) return false;
        const visible = frame.simTime !== null && frame.simOpacity > 0.001;
        // Visibility flips only at phase changes.
        this.setLayout('sim', 'visibility', visible ? 'visible' : 'none');
        if (!visible || frame.simTime === null) return false;

        const { meta, frames } = this.sim;
        const fpos = clamp(frame.simTime / meta.frame_dt_s, 0, meta.frames - 1);
        const opacity = Math.round(frame.simOpacity * 100) / 100;
        const key = `${fpos.toFixed(2)}|${opacity}`;
        if (key === this.lastSimKey) return false;
        this.lastSimKey = key;
        drawSimFrame(
            this.simImage,
            frames,
            meta.rows,
            meta.cols,
            fpos,
            meta.depth_scale_m,
            meta.speed_scale_ms,
            opacity
        );
        this.simCanvas.getContext('2d')?.putImageData(this.simImage, 0, 0);
        this.refreshTerrainTilesUnderSim();
        return true;
    }

    /**
     * With 3D terrain, the avalanche is painted into the cached textures of the terrain
     * tiles beneath it, and a new canvas frame does not refresh that cache by itself (this
     * is what froze the avalanche part-way through). Invalidate just those few tiles.
     */
    private refreshTerrainTilesUnderSim() {
        const manager = (this.map as unknown as TerrainInternals).terrain?.tileManager;
        if (!manager || !this.simBounds) return;
        const [w, s, e, n] = this.simBounds;
        for (const tile of manager.getRenderableTiles()) {
            const { x, y, z } = tile.tileID.canonical;
            const tw = tileLon(x, z);
            const te = tileLon(x + 1, z);
            const tn = tileLat(y, z);
            const ts = tileLat(y + 1, z);
            if (tw < e && te > w && ts < n && tn > s) manager.freeRtt(tile.tileID);
        }
    }

    /** setPaintProperty only when the value really changed (each call rebuilds terrain textures). */
    private setPaint(layer: string, prop: string, value: number) {
        const rounded = Math.round(value * 400) / 400;
        const k = `p|${layer}|${prop}`;
        if (this.paintCache.get(k) === rounded || !this.map.getLayer(layer)) return;
        this.paintCache.set(k, rounded);
        this.map.setPaintProperty(layer, prop, rounded);
    }

    private setLayout(layer: string, prop: string, value: string) {
        const k = `l|${layer}|${prop}`;
        if (this.paintCache.get(k) === value || !this.map.getLayer(layer)) return;
        this.paintCache.set(k, value);
        this.map.setLayoutProperty(layer, prop, value);
    }
}

const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// Speed ramp for the flowing avalanche: pale snow (slow) -> blue -> violet -> hot pink (fast)
const SPEED_STOPS: Array<[number, [number, number, number]]> = [
    [0, [226, 240, 255]],
    [4, [140, 200, 255]],
    [9, [70, 130, 255]],
    [15, [168, 85, 247]],
    [22, [255, 77, 141]]
];

function speedColor(v: number): [number, number, number] {
    if (v <= SPEED_STOPS[0][0]) return SPEED_STOPS[0][1];
    for (let k = 1; k < SPEED_STOPS.length; k++) {
        const [v1, c1] = SPEED_STOPS[k];
        if (v <= v1) {
            const [v0, c0] = SPEED_STOPS[k - 1];
            const u = (v - v0) / (v1 - v0);
            return [
                c0[0] + (c1[0] - c0[0]) * u,
                c0[1] + (c1[1] - c0[1]) * u,
                c0[2] + (c1[2] - c0[2]) * u
            ];
        }
    }
    return SPEED_STOPS[SPEED_STOPS.length - 1][1];
}

function drawSimFrame(
    image: ImageData,
    frames: Uint8Array,
    rows: number,
    cols: number,
    fpos: number,
    depthScale: number,
    speedScale: number,
    opacity: number
) {
    const plane = rows * cols;
    const f0 = Math.floor(fpos);
    const f1 = Math.min(f0 + 1, Math.round(frames.length / (2 * plane)) - 1);
    const u = fpos - f0;
    const d0 = f0 * 2 * plane;
    const d1 = f1 * 2 * plane;
    const out = image.data;
    for (let i = 0; i < plane; i++) {
        const depth = (frames[d0 + i] * (1 - u) + frames[d1 + i] * u) * depthScale;
        const o = i * 4;
        if (depth < 0.01) {
            out[o + 3] = 0;
            continue;
        }
        const speed = (frames[d0 + plane + i] * (1 - u) + frames[d1 + plane + i] * u) * speedScale;
        const [r, g, b] = speedColor(speed);
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = Math.round(255 * opacity * (0.35 + 0.65 * smoothstep(0.01, 0.6, depth)));
    }
}
