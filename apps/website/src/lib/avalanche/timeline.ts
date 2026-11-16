// Deterministic journey timeline.
//
// Everything the wall shows is a pure function of one number, the shared journey time `t`
// (seconds). Screens and controls each evaluate `journeyFrameAt(t)` locally, so the bus
// only has to carry a tiny clock (see clock.ts), never per-frame positions. Any screen
// that joins late, reloads, or drops frames lands on exactly the same picture.

import type { LonLat, RouteData, RouteEvent, RouteLeg, SimMeta, ZoneCode } from './data';

// ---- Tunables (wall seconds) ----------------------------------------------------------
/** Travel pace along the route, metres of route per wall-second, per leg kind. */
const PACE_M_PER_S: Record<RouteLeg['kind'], number> = { drive: 150, climb: 75, descend: 420 };
/** Pace changes between legs blend over this distance. */
const PACE_BLEND_M = 400;
/** Slow-in / slow-out distance around the start, the summit and the end. */
const STOP_RAMP_M = 450;
const MIN_PACE_FRACTION = 0.12;

const SIM_APPROACH_S = 6;
const SIM_TRIGGER_S = 5;
const SIM_FLOW_S = 34;
const SIM_SETTLE_S = 8;
const SIM_RETURN_S = 6;
const FINISH_HOLD_S = 8;

/** Zoom is expressed for one 1920 x 1080 wall unit; screens adjust for their real size. */
const ZOOM_BY_LEG: Record<RouteLeg['kind'], number> = { drive: 14.6, climb: 15.5, descend: 15.1 };
const ZOOM_BLEND_M = 600;
const SIM_ZOOM = 15.75;
/** Gentle tilt while travelling (north-up keeps the wall calm: BEST_PRACTICES.md section 6). */
const TRAVEL_PITCH = 45;
/** At the summit the camera stands below the run-out and looks up the avalanche path. */
const SIM_PITCH = 64;
/** Camera centre is a distance-window average of the route, which calms switchbacks. */
const CAMERA_SMOOTH_M = 700;

export const TOAST_LIFETIME_S = 9;
export const TOAST_MAX = 3;
const TRIGGER_WINDOW = 6; // samples either side (~60 m) blended for the trigger/arrow

// Wall geometry (3 x 2 units of 1920 x 1080). The traveller sits in the lower-middle unit,
// clear of the HUD in the top-left and right-hand columns.
export const WALL_COLS = 3;
export const WALL_ROWS = 2;
export const UNIT_W = 1920;
export const UNIT_H = 1080;
export const WALL_W = WALL_COLS * UNIT_W;
export const WALL_H = WALL_ROWS * UNIT_H;
const TRAVELLER_WALL_PX: [number, number] = [WALL_W * 0.5, WALL_H * 0.6];

export type JourneyPhase =
    | 'travel'
    | 'sim-approach'
    | 'sim-trigger'
    | 'sim-flow'
    | 'sim-settle'
    | 'sim-return'
    | 'finish';

export type CameraView = {
    longitude: number;
    latitude: number;
    zoom: number;
    bearing: number;
    pitch: number;
    /**
     * Ground height (m, not exaggerated) at the camera centre. Supplied from our own data so
     * every screen builds the identical 3D camera instead of each sampling terrain tiles.
     */
    elevation: number;
};

export type TriggerPointer = {
    /** Start (trigger) zone feeding the runout the traveller is in. */
    src: LonLat;
    /** ~100 m back up the avalanche path: the arrow tail. */
    up: LonLat;
    /** 0..1 fade, from how many nearby samples have a pointer. */
    alpha: number;
};

export type ToastItem = {
    event: RouteEvent;
    index: number;
    ageS: number;
};

export type JourneyFrame = {
    t: number;
    total: number;
    phase: JourneyPhase;
    /** 0..1 progress within the current phase. */
    phaseProgress: number;
    dist: number;
    /** Fractional sample index along the route. */
    sampleIndex: number;
    position: LonLat;
    elev: number;
    zone: ZoneCode;
    legKind: RouteLeg['kind'];
    camera: CameraView;
    trigger: TriggerPointer | null;
    currentEvent: RouteEvent | null;
    toasts: ToastItem[];
    /** Simulated avalanche time in seconds, or null when no avalanche is on screen. */
    simTime: number | null;
    simOpacity: number;
    releaseOpacity: number;
    /** 0..1: how much the view is focused on the avalanche (dims the terrain overlay). */
    simFocus: number;
};

export type Chapter = { label: string; t: number };

export type Timeline = {
    route: RouteData;
    total: number;
    travelAEnd: number;
    simStart: number;
    simEnd: number;
    travelBEnd: number;
    chapters: Chapter[];
    /** Wall time at which each route event fires (NaN for muted events). */
    eventTimes: number[];
    frameAt: (t: number) => JourneyFrame;
};

export function buildTimeline(
    route: RouteData,
    sim: Pick<SimMeta, 'corners' | 'times_s' | 'release_ring' | 'centre_elev_m'>
): Timeline {
    const { dist, lon, lat, elev, zone } = route.samples;
    const n = dist.length;
    const summitI = route.summit.i;
    const summitD = dist[summitI];
    const lastD = dist[n - 1];

    // --- wall time at each sample: integrate 1 / pace(d) -------------------------------
    const stops = [0, summitD, lastD];
    const paceAt = (d: number) => {
        let pace = blendByLeg(route.legs, d, PACE_M_PER_S, PACE_BLEND_M);
        const nearest = Math.min(...stops.map((s) => Math.abs(d - s)));
        pace *= Math.max(MIN_PACE_FRACTION, smoothstep(0, STOP_RAMP_M, nearest));
        return pace;
    };
    const travelT = new Float64Array(n); // travel-only seconds (no sim)
    for (let i = 1; i < n; i++) {
        const dMid = (dist[i] + dist[i - 1]) / 2;
        travelT[i] = travelT[i - 1] + (dist[i] - dist[i - 1]) / paceAt(dMid);
    }
    const travelAEnd = travelT[summitI];
    const simLength = SIM_APPROACH_S + SIM_TRIGGER_S + SIM_FLOW_S + SIM_SETTLE_S + SIM_RETURN_S;
    const simStart = travelAEnd;
    const simEnd = simStart + simLength;
    const travelBEnd = simEnd + (travelT[n - 1] - travelAEnd);
    const total = travelBEnd + FINISH_HOLD_S;

    const wallTimeOfSample = (i: number) =>
        i <= summitI ? travelT[i] : simEnd + (travelT[i] - travelAEnd);

    // Fractional sample index at a given travel-only time (binary search).
    const sampleAtTravelT = (tt: number) => {
        if (tt <= 0) return 0;
        if (tt >= travelT[n - 1]) return n - 1;
        let lo = 0;
        let hi = n - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (travelT[mid] <= tt) lo = mid;
            else hi = mid;
        }
        return lo + (tt - travelT[lo]) / Math.max(1e-9, travelT[hi] - travelT[lo]);
    };

    // --- camera centre: distance-window average of the route (precomputed per sample) ---
    const camLon = new Float64Array(n);
    const camLat = new Float64Array(n);
    const camElev = new Float64Array(n);
    {
        let a = 0;
        let b = 0;
        let sumLon = 0;
        let sumLat = 0;
        let sumElev = 0;
        for (let i = 0; i < n; i++) {
            while (b < n && dist[b] <= dist[i] + CAMERA_SMOOTH_M) {
                sumLon += lon[b];
                sumLat += lat[b];
                sumElev += elev[b];
                b++;
            }
            while (dist[a] < dist[i] - CAMERA_SMOOTH_M) {
                sumLon -= lon[a];
                sumLat -= lat[a];
                sumElev -= elev[a];
                a++;
            }
            camLon[i] = sumLon / (b - a);
            camLat[i] = sumLat / (b - a);
            camElev[i] = sumElev / (b - a);
        }
    }

    // Events in the descent are muted: the same slopes were announced on the way up.
    const descend = route.legs.find((leg) => leg.kind === 'descend');
    const isMuted = (event: RouteEvent) =>
        !!descend && event.dist_m >= descend.from_m && event.dist_m < descend.to_m;
    const eventTimes = route.events.map((event) =>
        isMuted(event) ? Number.NaN : wallTimeOfSample(event.i)
    );

    const travelCamera = (f: number): CameraView => {
        const d = sampleValue(dist, f);
        const zoom = blendByLeg(route.legs, d, ZOOM_BY_LEG, ZOOM_BLEND_M);
        const centre: LonLat = [sampleValue(camLon, f), sampleValue(camLat, f)];
        // Put the smoothed route centre at the traveller's wall position.
        const [longitude, latitude] = offsetByWallPixels(
            centre,
            WALL_W / 2 - TRAVELLER_WALL_PX[0],
            WALL_H / 2 - TRAVELLER_WALL_PX[1],
            zoom
        );
        return {
            longitude,
            latitude,
            zoom,
            bearing: 0,
            pitch: TRAVEL_PITCH,
            elevation: sampleValue(camElev, f)
        };
    };

    const simCentre = averageLonLat(sim.corners);
    // Face the slope: look from the middle of the avalanche's footprint up toward the release.
    const releaseCentre = averageLonLat(sim.release_ring.slice(0, -1));
    const simCamera: CameraView = {
        longitude: simCentre[0],
        latitude: simCentre[1],
        zoom: SIM_ZOOM,
        bearing: bearingDeg(simCentre, releaseCentre),
        pitch: SIM_PITCH,
        elevation: sim.centre_elev_m
    };
    const simDuration = sim.times_s[sim.times_s.length - 1] ?? 0;

    const eventAtSample = (i: number) => {
        // Events are ordered by start sample; find the last one that started at or before i.
        let found: RouteEvent | null = null;
        for (const event of route.events) {
            if (event.i <= i) found = event;
            else break;
        }
        return found;
    };

    const triggerAt = (f: number): TriggerPointer | null => {
        const { src, up } = route.samples;
        const i0 = Math.max(0, Math.floor(f) - TRIGGER_WINDOW);
        const i1 = Math.min(n - 1, Math.ceil(f) + TRIGGER_WINDOW);
        let wAll = 0;
        let wHit = 0;
        let sx = 0;
        let sy = 0;
        let ux = 0;
        let uy = 0;
        for (let i = i0; i <= i1; i++) {
            const w = Math.max(0, 1 - Math.abs(i - f) / (TRIGGER_WINDOW + 1));
            wAll += w;
            const s = src[i];
            if (!s || w === 0) continue;
            const u = up[i] ?? s;
            wHit += w;
            sx += s[0] * w;
            sy += s[1] * w;
            ux += u[0] * w;
            uy += u[1] * w;
        }
        if (wHit === 0) return null;
        return {
            src: [sx / wHit, sy / wHit],
            up: [ux / wHit, uy / wHit],
            alpha: smoothstep(0.15, 0.7, wHit / wAll)
        };
    };

    const frameAt = (tIn: number): JourneyFrame => {
        const t = clamp(tIn, 0, total);
        let phase: JourneyPhase = 'travel';
        let phaseProgress = 0;
        let f: number;
        let camera: CameraView;
        let simTime: number | null = null;
        let simOpacity = 0;
        let releaseOpacity = 0;

        if (t < simStart) {
            f = sampleAtTravelT(t);
            phaseProgress = t / Math.max(1e-9, simStart);
            camera = travelCamera(f);
        } else if (t < simEnd) {
            f = summitI;
            const summitCamera = travelCamera(summitI);
            let s = t - simStart;
            if (s < SIM_APPROACH_S) {
                phase = 'sim-approach';
                phaseProgress = s / SIM_APPROACH_S;
                camera = lerpCamera(summitCamera, simCamera, easeInOutCubic(phaseProgress));
                releaseOpacity = smoothstep(0.5, 1, phaseProgress);
                simOpacity = releaseOpacity;
                simTime = 0;
            } else if ((s -= SIM_APPROACH_S) < SIM_TRIGGER_S) {
                phase = 'sim-trigger';
                phaseProgress = s / SIM_TRIGGER_S;
                camera = simCamera;
                releaseOpacity = 1;
                simOpacity = 1;
                simTime = 0;
            } else if ((s -= SIM_TRIGGER_S) < SIM_FLOW_S) {
                phase = 'sim-flow';
                phaseProgress = s / SIM_FLOW_S;
                camera = simCamera;
                releaseOpacity = 1 - smoothstep(0, 0.25, phaseProgress) * 0.6;
                simOpacity = 1;
                simTime = phaseProgress * simDuration;
            } else if ((s -= SIM_FLOW_S) < SIM_SETTLE_S) {
                phase = 'sim-settle';
                phaseProgress = s / SIM_SETTLE_S;
                camera = simCamera;
                releaseOpacity = 0.4;
                simOpacity = 1;
                simTime = simDuration;
            } else {
                s -= SIM_SETTLE_S;
                phase = 'sim-return';
                phaseProgress = Math.min(1, s / SIM_RETURN_S);
                camera = lerpCamera(simCamera, summitCamera, easeInOutCubic(phaseProgress));
                releaseOpacity = 0.4 * (1 - phaseProgress);
                simOpacity = 1 - 0.55 * phaseProgress;
                simTime = simDuration;
            }
        } else {
            f = sampleAtTravelT(travelAEnd + Math.min(t, travelBEnd) - simEnd);
            camera = travelCamera(f);
            // Keep the deposit faintly on the map for the rest of the trip.
            simTime = simDuration;
            simOpacity = 0.45;
            if (t >= travelBEnd) {
                phase = 'finish';
                phaseProgress = (t - travelBEnd) / FINISH_HOLD_S;
            } else {
                phaseProgress = (t - simEnd) / Math.max(1e-9, travelBEnd - simEnd);
            }
        }

        const i = Math.min(n - 1, Math.round(f));
        const d = sampleValue(dist, f);
        const toasts: ToastItem[] = [];
        for (let k = eventTimes.length - 1; k >= 0 && toasts.length < TOAST_MAX; k--) {
            const te = eventTimes[k];
            if (Number.isNaN(te) || te > t) continue;
            const age = t - te;
            if (age > TOAST_LIFETIME_S) break;
            toasts.push({ event: route.events[k], index: k, ageS: age });
        }

        return {
            t,
            total,
            phase,
            phaseProgress: clamp(phaseProgress, 0, 1),
            dist: d,
            sampleIndex: f,
            position: [sampleValue(lon, f), sampleValue(lat, f)],
            elev: sampleValue(elev, f),
            zone: zone[i],
            legKind: legAt(route.legs, d).kind,
            camera,
            trigger: phase === 'travel' || phase === 'finish' ? triggerAt(f) : null,
            currentEvent: eventAtSample(i),
            toasts,
            simTime,
            simOpacity,
            releaseOpacity,
            simFocus:
                phase === 'sim-approach'
                    ? phaseProgress
                    : phase === 'sim-return'
                      ? 1 - phaseProgress
                      : phase.startsWith('sim-')
                        ? 1
                        : 0
        };
    };

    const climb = route.legs.find((leg) => leg.kind === 'climb');
    const chapters: Chapter[] = [
        { label: 'Start: Lassen Park Hwy', t: 0 },
        ...(climb
            ? [{ label: 'Trailhead', t: wallTimeOfSample(nearestSample(dist, climb.from_m)) }]
            : []),
        { label: 'Lassen Peak avalanche', t: simStart },
        {
            label: 'Back on the road',
            t: wallTimeOfSample(nearestSample(dist, route.legs[route.legs.length - 1].from_m))
        }
    ];

    return {
        route,
        total,
        travelAEnd,
        simStart,
        simEnd,
        travelBEnd,
        chapters,
        eventTimes,
        frameAt
    };
}

// ---- helpers --------------------------------------------------------------------------

function legAt(legs: RouteLeg[], d: number) {
    return legs.find((leg) => d < leg.to_m) ?? legs[legs.length - 1];
}

/** Per-leg value with a smooth blend across each leg boundary. */
function blendByLeg(
    legs: RouteLeg[],
    d: number,
    values: Record<RouteLeg['kind'], number>,
    blendM: number
) {
    let value = values[legs[0].kind];
    for (let k = 1; k < legs.length; k++) {
        const boundary = legs[k].from_m;
        const w = smoothstep(boundary - blendM / 2, boundary + blendM / 2, d);
        value = value + (values[legs[k].kind] - value) * w;
    }
    return value;
}

function nearestSample(dist: number[], d: number) {
    let best = 0;
    for (let i = 0; i < dist.length; i++) {
        if (Math.abs(dist[i] - d) < Math.abs(dist[best] - d)) best = i;
    }
    return best;
}

function sampleValue(values: ArrayLike<number>, f: number) {
    const i = Math.floor(f);
    if (i >= values.length - 1) return values[values.length - 1];
    if (i < 0) return values[0];
    const u = f - i;
    return values[i] + (values[i + 1] - values[i]) * u;
}

function bearingDeg(from: LonLat, to: LonLat) {
    const r = Math.PI / 180;
    const dl = (to[0] - from[0]) * r;
    const y = Math.sin(dl) * Math.cos(to[1] * r);
    const x =
        Math.cos(from[1] * r) * Math.sin(to[1] * r) -
        Math.sin(from[1] * r) * Math.cos(to[1] * r) * Math.cos(dl);
    return (Math.atan2(y, x) / r + 360) % 360;
}

function averageLonLat(points: LonLat[]): LonLat {
    const sum = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [sum[0] / points.length, sum[1] / points.length];
}

const TILE_SIZE = 512; // MapLibre world size is 512 * 2^zoom pixels

/** Shift a lon/lat by (dx, dy) pixels of a 1920 x 1080-unit wall at the given zoom. */
export function offsetByWallPixels(p: LonLat, dx: number, dy: number, zoom: number): LonLat {
    const scale = TILE_SIZE * Math.pow(2, zoom);
    const x = ((p[0] + 180) / 360) * scale + dx;
    const sinLat = Math.sin((p[1] * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale + dy;
    const lonOut = (x / scale) * 360 - 180;
    const latOut = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI;
    return [lonOut, latOut];
}

function lerpCamera(a: CameraView, b: CameraView, u: number): CameraView {
    return {
        longitude: a.longitude + (b.longitude - a.longitude) * u,
        latitude: a.latitude + (b.latitude - a.latitude) * u,
        zoom: a.zoom + (b.zoom - a.zoom) * u,
        // Turn the short way round (e.g. 0 -> 235 deg goes -125 deg, not +235).
        bearing: a.bearing + (((((b.bearing - a.bearing) % 360) + 540) % 360) - 180) * u,
        pitch: a.pitch + (b.pitch - a.pitch) * u,
        elevation: a.elevation + (b.elevation - a.elevation) * u
    };
}

export function smoothstep(e0: number, e1: number, x: number) {
    const u = clamp((x - e0) / (e1 - e0), 0, 1);
    return u * u * (3 - 2 * u);
}

export function clamp(x: number, lo: number, hi: number) {
    return Math.min(hi, Math.max(lo, x));
}

function easeInOutCubic(u: number) {
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

export function formatClock(seconds: number) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
