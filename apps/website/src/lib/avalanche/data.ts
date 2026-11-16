// Static datasets for the avalanche journey demo, produced by
// `data-prep/avalanche/export_route.py` and `export_sim_frames.py`.

export const AVALANCHE_DATA_BASE = '/data/avalanche';

export type ZoneCode = 0 | 1 | 2 | 3;

export type LonLat = [number, number];

export type RouteProblem = {
    type: string;
    likelihood: string;
    size: [number, number];
};

export type RouteEvent = {
    i: number;
    end_i: number;
    dist_m: number;
    length_m: number;
    zone: ZoneCode;
    label: string;
    elev_m: number;
    band: string;
    danger: string;
    danger_level: number;
    slope: string | null;
    problems: RouteProblem[];
    active: boolean;
    start_zone?: { distance_m: number; compass: string };
};

export type RouteLeg = {
    kind: 'drive' | 'climb' | 'descend';
    from_m: number;
    to_m: number;
};

export type RouteData = {
    source: { route: string; terrain: string; conditions: string };
    conditions: {
        name: string;
        date: string;
        summary: string;
        danger: { alpine: number; treeline: number; below_treeline: number };
        problems: Array<RouteProblem & { aspects: string[]; elevation_bands: string[] }>;
        weather: {
            new_snow_24h_cm: number;
            new_snow_72h_cm: number;
            wind: string;
            freezing_level_m: number;
        };
    };
    zones_image: { file: string; bounds_latlon: [[number, number], [number, number]] };
    total_m: number;
    legs: RouteLeg[];
    summit: { i: number; dist_m: number; elev_m: number };
    samples: {
        lon: number[];
        lat: number[];
        dist: number[];
        elev: number[];
        zone: ZoneCode[];
        heading: number[];
        src: Array<LonLat | null>;
        up: Array<LonLat | null>;
    };
    events: RouteEvent[];
};

export type SimMeta = {
    scenario: string;
    source: string;
    inputs: { d0_m: number; mu: number; xi: number; rho: number };
    frames: number;
    rows: number;
    cols: number;
    frame_dt_s: number;
    times_s: number[];
    ke_MJ: number[];
    depth_scale_m: number;
    speed_scale_ms: number;
    /** top-left, top-right, bottom-right, bottom-left (MapLibre image source order) */
    corners: [LonLat, LonLat, LonLat, LonLat];
    /** DEM height at the crop centre (m). */
    centre_elev_m: number;
    release_ring: LonLat[];
    summary: {
        release_area_ha: number;
        release_volume_m3: number;
        vertical_drop_m: number;
        runout_horizontal_m: number;
        alpha_angle_deg: number;
        affected_area_ha: number;
        max_speed_ms: number;
        max_pressure_kPa: number;
        max_deposit_depth_m: number;
        crown_elev_m: number;
        toe_elev_m: number;
    };
};

export type SimData = {
    meta: SimMeta;
    /** frames x 2 x rows x cols: depth (cm) then speed (0.1 m/s) */
    frames: Uint8Array;
};

// Module-level caches: every route instance (and React StrictMode double mounts)
// shares one fetch per dataset.
let routePromise: Promise<RouteData> | null = null;
let simPromise: Promise<SimData> | null = null;

export function loadRouteData(): Promise<RouteData> {
    routePromise ??= fetch(`${AVALANCHE_DATA_BASE}/route.json`)
        .then((response) => {
            if (!response.ok) throw new Error(`route.json: HTTP ${response.status}`);
            return response.json() as Promise<RouteData>;
        })
        .catch((error: unknown) => {
            routePromise = null; // allow a retry on the next call
            throw error;
        });
    return routePromise;
}

let simMetaPromise: Promise<SimMeta> | null = null;

/** Timing/summary metadata only (a few kB): all a control tablet needs. */
export function loadSimMeta(): Promise<SimMeta> {
    simMetaPromise ??= fetch(`${AVALANCHE_DATA_BASE}/sim_meta.json`)
        .then((r) => {
            if (!r.ok) throw new Error(`sim_meta.json: HTTP ${r.status}`);
            return r.json() as Promise<SimMeta>;
        })
        .catch((error: unknown) => {
            simMetaPromise = null;
            throw error;
        });
    return simMetaPromise;
}

export function loadSimData(): Promise<SimData> {
    simPromise ??= Promise.all([
        loadSimMeta(),
        fetch(`${AVALANCHE_DATA_BASE}/sim_frames.bin.gz`).then(async (r) => {
            if (!r.ok) throw new Error(`sim_frames.bin.gz: HTTP ${r.status}`);
            return gunzipIfNeeded(new Uint8Array(await r.arrayBuffer()));
        })
    ])
        .then(([meta, frames]) => {
            const expected = meta.frames * 2 * meta.rows * meta.cols;
            if (frames.length !== expected) {
                throw new Error(`sim frames: expected ${expected} bytes, got ${frames.length}`);
            }
            return { meta, frames };
        })
        .catch((error: unknown) => {
            simPromise = null;
            throw error;
        });
    return simPromise;
}

async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
    // Some static servers send `.gz` with `Content-Encoding: gzip`, in which case the
    // browser has already inflated it. Only inflate when the gzip magic bytes are present.
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const ZONE_STYLE: Record<ZoneCode, { label: string; color: string; ink: string }> = {
    3: { label: 'Avalanche terrain', color: '#e53935', ink: '#ffffff' },
    2: { label: 'Avalanche runout', color: '#fdc800', ink: '#111111' },
    1: { label: 'Possible extreme runout', color: '#fff1a0', ink: '#111111' },
    0: { label: 'No mapped avalanche terrain', color: '#43a047', ink: '#ffffff' }
};

export const DANGER_STYLE: Record<number, { label: string; color: string; ink: string }> = {
    1: { label: 'Low', color: '#78b943', ink: '#111111' },
    2: { label: 'Moderate', color: '#ffd600', ink: '#111111' },
    3: { label: 'Considerable', color: '#f58220', ink: '#111111' },
    4: { label: 'High', color: '#e3001f', ink: '#ffffff' },
    5: { label: 'Extreme', color: '#1a1a1a', ink: '#ffffff' }
};
