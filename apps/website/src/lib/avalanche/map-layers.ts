// Imperative MapLibre layers for the avalanche journey.
//
// Everything renders with MapLibre primitives (no deck.gl canvas), so one renderer path
// works both top-level and inside the wall's iframes (BEST_PRACTICES.md section 7), and
// raster/vector layers line up on the same basemap. Per-frame work is limited to
// camera moves, tiny GeoJSON updates and one small canvas upload for the avalanche.

import type {
    CanvasSource,
    ExpressionSpecification,
    GeoJSONSource,
    LayerSpecification,
    Map as MaplibreMap
} from 'maplibre-gl';

import { AVALANCHE_DATA_BASE, ZONE_STYLE, type LonLat, type RouteData, type SimData } from './data';
import { clamp, smoothstep, WALL_H, WALL_W, type JourneyFrame } from './timeline';

export const JOURNEY_MAP_STYLE =
    'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';
const TERRARIUM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const ZONES_OPACITY = 0.34;
const TERRAIN_EXAGGERATION = 1.3;

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

/** Start zones feeding the route within this distance ahead are previewed. */
const AHEAD_M = 1600;

/** Which part of the 5760 x 2160 wall this client shows, and at what size. */
export type WallRegion = { x: number; y: number; w: number; h: number };

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;
const fc = (features: Feature[]): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features
});

// Widths/radii in wall pixels; scaled to the client's real size on resize.
const SIZES = {
    routeAll: 7,
    routeDone: 11,
    routeCasing: 19,
    travellerRadius: 20,
    travellerStroke: 6,
    srcRadius: 18,
    srcStroke: 5,
    aheadRadius: 9,
    trigLine: 5,
    arrowLine: 12,
    releaseLine: 6
};

export class JourneyMapLayers {
    private readonly map: MaplibreMap;
    private readonly route: RouteData;
    private sim: SimData | null = null;
    private simCanvas: HTMLCanvasElement | null = null;
    private simImage: ImageData | null = null;
    private lastSimKey = '';
    private lastProgress = -1;
    private lastScale = -1;
    private lastAheadKey = '';
    /** Last frame applied: identical frames (paused clock) are skipped so the map can idle. */
    private lastFrameKey = '';
    /** The sim texture was flagged for upload last frame; stop uploading this frame. */
    private simUploadPending = false;
    private readonly paintCache = new Map<string, unknown>();
    private readonly aheadStarts: Array<{ dist: number; p: LonLat }>;

    constructor(map: MaplibreMap, route: RouteData) {
        this.map = map;
        this.route = route;
        this.aheadStarts = buildStartZoneList(route);
        // We set the centre elevation ourselves (see CameraView.elevation).
        map.setCenterClampedToGround(false);
        // Dev-only handle for inspecting the live map from the console / test scripts.
        if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__aviMap = map;
        this.addBaseLayers();
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

        const beforeId = this.map.getLayer('route-casing') ? 'route-casing' : undefined;
        // animate: false matters: an animating CanvasSource counts as a permanent transition
        // and keeps the whole map redrawing at full frame rate. We upload only on change.
        this.map.addSource('sim', { type: 'canvas', canvas, coordinates: corners, animate: false });
        this.map.addLayer(
            {
                id: 'sim',
                type: 'raster',
                source: 'sim',
                paint: {
                    'raster-opacity': 0,
                    'raster-resampling': 'linear',
                    'raster-fade-duration': 0
                }
            },
            beforeId
        );
        this.map.addSource('release', {
            type: 'geojson',
            data: fc([
                {
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'Polygon', coordinates: [release_ring] }
                }
            ])
        });
        this.map.addLayer(
            {
                id: 'release-fill',
                type: 'fill',
                source: 'release',
                paint: { 'fill-color': '#ff5252', 'fill-opacity': 0 }
            },
            'sim'
        );
        this.map.addLayer(
            {
                id: 'release-line',
                type: 'line',
                source: 'release',
                paint: {
                    'line-color': '#ffffff',
                    'line-width': 2,
                    'line-opacity': 0,
                    'line-dasharray': [2, 1.5]
                }
            },
            beforeId
        );
        this.lastScale = -1; // re-apply widths including the release outline
    }

    /** Apply one journey frame for the wall region shown by this client. */
    update(frame: JourneyFrame, region: WallRegion, clientWidth: number) {
        const scale = clientWidth / region.w;
        if (this.simUploadPending) {
            this.map.getSource<CanvasSource>('sim')?.pause(); // uploads once, then stops
            this.simUploadPending = false;
        }
        // Paused clock => same frame every tick. Skip all work so MapLibre stops rendering.
        const key = `${frame.t.toFixed(3)}|${scale.toFixed(4)}|${region.x},${region.y}|${this.sim ? 1 : 0}`;
        if (key === this.lastFrameKey) return;
        this.lastFrameKey = key;
        this.applyCamera(frame, region, scale);
        if (Math.abs(scale - this.lastScale) > 1e-3) this.applyScale(scale);
        this.updateProgress(frame);
        this.updateTraveller(frame);
        this.updateTrigger(frame);
        this.updateAhead(frame);
        this.updateSim(frame);
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

        map.addSource('dem', {
            type: 'raster-dem',
            encoding: 'terrarium',
            tiles: [TERRARIUM_TILES],
            tileSize: 256,
            maxzoom: 14
        });
        // 3D terrain from a separate DEM source (MapLibre advises not sharing it with hillshade).
        map.addSource('terrain-dem', {
            type: 'raster-dem',
            encoding: 'terrarium',
            tiles: [TERRARIUM_TILES],
            tileSize: 256,
            maxzoom: 14
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

        const { lon, lat } = this.route.samples;
        const line: Feature = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: lon.map((x, i) => [x, lat[i]]) }
        };
        map.addSource('route', { type: 'geojson', data: fc([line]), lineMetrics: true });
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
            },
            {
                id: 'route-done',
                type: 'line',
                source: 'route',
                layout: lineLayout,
                paint: { 'line-width': 1, 'line-gradient': progressGradient(0) }
            }
        ];
        for (const layer of layers) map.addLayer(layer);

        map.addSource('ahead', { type: 'geojson', data: fc([]) });
        map.addLayer({
            id: 'ahead',
            type: 'circle',
            source: 'ahead',
            paint: {
                'circle-color': ZONE_STYLE[3].color,
                'circle-opacity': ['get', 'a'],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-opacity': ['*', ['get', 'a'], 0.8],
                'circle-radius': 1,
                'circle-stroke-width': 1
            }
        });

        map.addSource('trigger', { type: 'geojson', data: fc([]) });
        map.addLayer({
            id: 'trigger-line',
            type: 'line',
            source: 'trigger',
            filter: ['==', ['get', 'kind'], 'line'],
            layout: lineLayout,
            paint: {
                'line-color': '#ffffff',
                'line-opacity': ['get', 'a'],
                'line-width': 1,
                'line-dasharray': [2, 2]
            }
        });
        map.addLayer({
            id: 'trigger-arrow',
            type: 'line',
            source: 'trigger',
            filter: ['==', ['get', 'kind'], 'arrow'],
            layout: lineLayout,
            paint: { 'line-color': '#fb8c00', 'line-opacity': ['get', 'a'], 'line-width': 1 }
        });
        map.addLayer({
            id: 'trigger-head',
            type: 'fill',
            source: 'trigger',
            filter: ['==', ['get', 'kind'], 'head'],
            paint: { 'fill-color': '#fb8c00', 'fill-opacity': ['get', 'a'] }
        });
        map.addLayer({
            id: 'trigger-pulse',
            type: 'circle',
            source: 'trigger',
            filter: ['==', ['get', 'kind'], 'src'],
            paint: {
                'circle-color': 'rgba(0,0,0,0)',
                'circle-stroke-color': ZONE_STYLE[3].color,
                'circle-stroke-opacity': ['get', 'pa'],
                'circle-radius': ['get', 'pr'],
                'circle-stroke-width': 1
            }
        });
        map.addLayer({
            id: 'trigger-src',
            type: 'circle',
            source: 'trigger',
            filter: ['==', ['get', 'kind'], 'src'],
            paint: {
                'circle-color': ZONE_STYLE[3].color,
                'circle-opacity': ['get', 'a'],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-opacity': ['get', 'a'],
                'circle-radius': 1,
                'circle-stroke-width': 1
            }
        });

        map.addSource('traveller', { type: 'geojson', data: fc([]) });
        map.addLayer({
            id: 'traveller-halo',
            type: 'circle',
            source: 'traveller',
            paint: {
                'circle-color': '#ffffff',
                'circle-opacity': 0.18,
                'circle-radius': 1,
                'circle-blur': 0.6
            }
        });
        map.addLayer({
            id: 'traveller',
            type: 'circle',
            source: 'traveller',
            paint: {
                'circle-color': ['get', 'color'],
                'circle-radius': 1,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1
            }
        });
    }

    private applyScale(scale: number) {
        this.lastScale = scale;
        const px = (v: number) => Math.max(0.5, v * scale);
        const set = (layer: string, prop: string, value: number) => {
            if (this.map.getLayer(layer)) this.map.setPaintProperty(layer, prop, value);
        };
        set('route-casing', 'line-width', px(SIZES.routeCasing));
        set('route-all', 'line-width', px(SIZES.routeAll));
        set('route-done', 'line-width', px(SIZES.routeDone));
        set('traveller', 'circle-radius', px(SIZES.travellerRadius));
        set('traveller', 'circle-stroke-width', px(SIZES.travellerStroke));
        set('traveller-halo', 'circle-radius', px(SIZES.travellerRadius * 3));
        set('trigger-src', 'circle-radius', px(SIZES.srcRadius));
        set('trigger-src', 'circle-stroke-width', px(SIZES.srcStroke));
        set('trigger-pulse', 'circle-stroke-width', px(SIZES.srcStroke));
        set('ahead', 'circle-radius', px(SIZES.aheadRadius));
        set('ahead', 'circle-stroke-width', px(2));
        set('trigger-line', 'line-width', px(SIZES.trigLine));
        set('trigger-arrow', 'line-width', px(SIZES.arrowLine));
        set('release-line', 'line-width', px(SIZES.releaseLine));
    }

    private updateProgress(frame: JourneyFrame) {
        const p = clamp(frame.dist / this.route.total_m, 0, 1);
        // Paint-property recompiles are cheap but not free: skip sub-pixel changes.
        if (Math.abs(p - this.lastProgress) < 0.0004) return;
        this.lastProgress = p;
        this.map.setPaintProperty('route-done', 'line-gradient', progressGradient(p));
    }

    private updateTraveller(frame: JourneyFrame) {
        const source = this.map.getSource<GeoJSONSource>('traveller');
        source?.setData(
            fc([
                {
                    type: 'Feature',
                    properties: { color: ZONE_STYLE[frame.zone].color },
                    geometry: { type: 'Point', coordinates: frame.position }
                }
            ])
        );
    }

    private updateTrigger(frame: JourneyFrame) {
        const source = this.map.getSource<GeoJSONSource>('trigger');
        if (!source) return;
        const tr = frame.trigger;
        if (!tr || tr.alpha <= 0.01) {
            source.setData(fc([]));
            return;
        }
        const a = tr.alpha;
        const here = frame.position;
        // Gentle 2.4 s pulse on the trigger point (no flashing: BEST_PRACTICES.md section 6).
        const phase = (frame.t / 2.4) % 1;
        const metersPerDeg = 111_320;
        const scale = this.lastScale > 0 ? this.lastScale : 1;
        const head = arrowHead(tr.up, here, 55 / metersPerDeg);
        source.setData(
            fc([
                {
                    type: 'Feature',
                    properties: { kind: 'line', a: a * 0.85 },
                    geometry: { type: 'LineString', coordinates: [here, tr.src] }
                },
                {
                    type: 'Feature',
                    properties: { kind: 'arrow', a },
                    geometry: { type: 'LineString', coordinates: [tr.up, head.base] }
                },
                {
                    type: 'Feature',
                    properties: { kind: 'head', a },
                    geometry: { type: 'Polygon', coordinates: [head.ring] }
                },
                {
                    type: 'Feature',
                    properties: {
                        kind: 'src',
                        a,
                        pa: a * (1 - phase) * 0.9,
                        pr: (SIZES.srcRadius + phase * 70) * scale
                    },
                    geometry: { type: 'Point', coordinates: tr.src }
                }
            ])
        );
    }

    private updateAhead(frame: JourneyFrame) {
        const visible = frame.phase === 'travel';
        const d = frame.dist;
        // Coarse key: refresh when the traveller has moved ~20 m or visibility flips.
        const key = visible ? String(Math.round(d / 20)) : 'off';
        if (key === this.lastAheadKey) return;
        this.lastAheadKey = key;
        const features: Feature[] = [];
        if (visible) {
            for (const s of this.aheadStarts) {
                const ahead = s.dist - d;
                if (ahead < -60 || ahead > AHEAD_M) continue;
                const a =
                    ahead < 0
                        ? smoothstep(-60, 0, ahead)
                        : 1 - smoothstep(AHEAD_M * 0.5, AHEAD_M, ahead);
                features.push({
                    type: 'Feature',
                    properties: { a: a * 0.75 },
                    geometry: { type: 'Point', coordinates: s.p }
                });
            }
        }
        this.map.getSource<GeoJSONSource>('ahead')?.setData(fc(features));
    }

    private updateSim(frame: JourneyFrame) {
        if (!this.sim || !this.simCanvas || !this.simImage) return;
        const visible = frame.simTime !== null && frame.simOpacity > 0.001;
        this.setPaint('zones', 'raster-opacity', ZONES_OPACITY * (1 - 0.65 * frame.simFocus));
        // Hidden layers are switched off entirely rather than drawn at opacity 0.
        this.setLayout('sim', 'visibility', visible ? 'visible' : 'none');
        this.setLayout(
            'release-fill',
            'visibility',
            frame.releaseOpacity > 0.001 ? 'visible' : 'none'
        );
        this.setLayout(
            'release-line',
            'visibility',
            frame.releaseOpacity > 0.001 ? 'visible' : 'none'
        );
        this.setPaint('sim', 'raster-opacity', visible ? frame.simOpacity : 0);
        this.setPaint('release-fill', 'fill-opacity', frame.releaseOpacity * 0.45);
        this.setPaint('release-line', 'line-opacity', frame.releaseOpacity);
        if (!visible || frame.simTime === null) return;

        const { meta, frames } = this.sim;
        const fpos = clamp(frame.simTime / meta.frame_dt_s, 0, meta.frames - 1);
        const key = fpos.toFixed(2);
        if (key === this.lastSimKey) return;
        this.lastSimKey = key;
        drawSimFrame(
            this.simImage,
            frames,
            meta.rows,
            meta.cols,
            fpos,
            meta.depth_scale_m,
            meta.speed_scale_ms
        );
        const ctx = this.simCanvas.getContext('2d');
        ctx?.putImageData(this.simImage, 0, 0);
        // play() flags a texture upload and requests a repaint; pause() next tick ends it.
        this.map.getSource<CanvasSource>('sim')?.play();
        this.simUploadPending = true;
    }

    /** setPaintProperty only when the value really changed (each call restyles the layer). */
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

function progressGradient(p: number): ExpressionSpecification {
    // Travelled part solid white, rest transparent (the dashed `route-all` shows it).
    if (p <= 0)
        return [
            'interpolate',
            ['linear'],
            ['line-progress'],
            0,
            'rgba(255,255,255,0)',
            1,
            'rgba(255,255,255,0)'
        ];
    if (p >= 1) return ['interpolate', ['linear'], ['line-progress'], 0, '#ffffff', 1, '#ffffff'];
    return ['step', ['line-progress'], '#ffffff', p, 'rgba(255,255,255,0)'];
}

function buildStartZoneList(route: RouteData) {
    // First route distance at which each distinct start zone becomes relevant.
    const seen = new Map<string, { dist: number; p: LonLat }>();
    const { src, dist } = route.samples;
    for (let i = 0; i < src.length; i++) {
        const s = src[i];
        if (!s) continue;
        const key = `${s[0]},${s[1]}`;
        if (!seen.has(key)) seen.set(key, { dist: dist[i], p: s });
    }
    return [...seen.values()];
}

/** Arrowhead triangle at `tip`, pointing from `tail` to `tip`; size in degrees of latitude. */
function arrowHead(tail: LonLat, tip: LonLat, size: number) {
    const kx = Math.cos((tip[1] * Math.PI) / 180); // lon degrees are shorter by cos(lat)
    let dx = (tip[0] - tail[0]) * kx;
    let dy = tip[1] - tail[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const base: LonLat = [tip[0] - (dx * size) / kx, tip[1] - dy * size];
    const wing = size * 0.6;
    const left: LonLat = [base[0] - (dy * wing) / kx, base[1] + dx * wing];
    const right: LonLat = [base[0] + (dy * wing) / kx, base[1] - dx * wing];
    return { base, ring: [tip, left, right, tip] };
}

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
    speedScale: number
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
        out[o + 3] = Math.round(255 * (0.35 + 0.65 * smoothstep(0.01, 0.6, depth)));
    }
}
