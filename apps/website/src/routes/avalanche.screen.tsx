import { createFileRoute } from '@tanstack/react-router';
import { Map, type MapRef } from '@vis.gl/react-maplibre';
import { useCallback, useEffect, useRef, useState } from 'react';

import { JourneyHud } from '../components/avalanche/journey-hud';
import { loadRouteData, loadSimData, type SimMeta } from '../lib/avalanche/data';
import { AvalancheEngine } from '../lib/avalanche/engine';
import {
    JOURNEY_MAP_STYLE,
    JourneyMapLayers,
    wallCameraRig,
    type WallRegion
} from '../lib/avalanche/map-layers';
import {
    buildTimeline,
    UNIT_H,
    UNIT_W,
    WALL_COLS,
    WALL_H,
    WALL_ROWS,
    WALL_W,
    type JourneyFrame,
    type Timeline
} from '../lib/avalanche/timeline';

import 'maplibre-gl/dist/maplibre-gl.css';

// `/avalanche/screen?c=<col>&r=<row>` renders one 1920 x 1080 unit of the 3 x 2 wall.
// Without c/r it renders the whole wall in one window (handy on a laptop).
// `?t=<seconds>` freezes this screen at one journey time (rehearsal, screenshots).
type ScreenSearch = { c?: number; r?: number; t?: number };

const HUD_INTERVAL_MS = 33; // React HUD refresh; the map itself updates every frame
const MAX_PIXEL_RATIO = 1.5;

export const Route = createFileRoute('/avalanche/screen')({
    validateSearch: (search: Record<string, unknown>): ScreenSearch => ({
        c: parseCoord(search.c, WALL_COLS),
        r: parseCoord(search.r, WALL_ROWS),
        t: parseTime(search.t)
    }),
    component: AvalancheScreen
});

function AvalancheScreen() {
    const { c, r, t: frozenT } = Route.useSearch();
    const region: WallRegion =
        c === undefined || r === undefined
            ? { x: 0, y: 0, w: WALL_W, h: WALL_H }
            : { x: c * UNIT_W, y: r * UNIT_H, w: UNIT_W, h: UNIT_H };

    const [isClient, setIsClient] = useState(false);
    const [timeline, setTimeline] = useState<Timeline | null>(null);
    const [simMeta, setSimMeta] = useState<SimMeta | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hudFrame, setHudFrame] = useState<JourneyFrame | null>(null);
    const [clientWidth, setClientWidth] = useState(UNIT_W);
    const [map, setMap] = useState<ReturnType<MapRef['getMap']> | null>(null);
    const [mapReady, setMapReady] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [viewport, setViewport] = useState({ w: 0, h: 0 });
    const layersRef = useRef<JourneyMapLayers | null>(null);

    // Data + engine are browser-only (BEST_PRACTICES.md section 4).
    useEffect(() => {
        setIsClient(true);
        AvalancheEngine.getInstance('screen');
        let cancelled = false;
        Promise.all([loadRouteData(), loadSimData()])
            .then(([route, sim]) => {
                if (cancelled) return;
                setTimeline(buildTimeline(route, sim.meta));
                setSimMeta(sim.meta);
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const parent = el.parentElement;
        if (!parent) return;
        const measure = () => {
            setViewport({ w: parent.clientWidth, h: parent.clientHeight });
            setClientWidth(el.clientWidth || UNIT_W);
        };
        const observer = new ResizeObserver(measure);
        observer.observe(parent);
        observer.observe(el);
        measure();
        return () => observer.disconnect();
    }, [isClient]);

    // Letterbox the stage to the region's aspect (16:9 per unit, 8:3 for the full wall),
    // so a laptop window shows the same composition the wall does.
    const aspect = region.w / region.h;
    const stageW = viewport.w && viewport.h ? Math.min(viewport.w, viewport.h * aspect) : undefined;
    const stageH = stageW ? stageW / aspect : undefined;
    const rig = wallCameraRig(region, clientWidth / region.w);

    const setMapRef = useCallback((instance: MapRef | null) => {
        setMap(instance?.getMap() ?? null);
    }, []);

    // Add our sources/layers once the basemap style is in.
    useEffect(() => {
        if (!map || !timeline) return;
        const install = () => {
            if (layersRef.current) return;
            layersRef.current = new JourneyMapLayers(map, timeline.route);
            void loadSimData().then((sim) => layersRef.current?.attachSim(sim));
            setMapReady(true);
        };
        if (map.isStyleLoaded()) install();
        else map.on('load', install);
        return () => {
            map.off('load', install);
        };
    }, [map, timeline]);

    // One animation loop: shared clock -> journey frame -> map (every frame) + HUD (~30 Hz).
    useEffect(() => {
        if (!timeline) return;
        const engine = AvalancheEngine.getInstance('screen');
        let raf = 0;
        let lastHud = 0;
        let lastHudT = -1;
        const tick = (now: number) => {
            const frame = timeline.frameAt(frozenT ?? engine.journeyTime(timeline.total));
            const width = containerRef.current?.clientWidth || UNIT_W;
            if (mapReady) layersRef.current?.update(frame, region, width);
            // Re-render the HUD only when journey time moved (nothing to do while paused).
            if (now - lastHud >= HUD_INTERVAL_MS && frame.t !== lastHudT) {
                lastHud = now;
                lastHudT = frame.t;
                setHudFrame(frame);
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
        // region is derived from c/r; listing its fields keeps the loop stable across renders
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [timeline, mapReady, frozenT, region.x, region.y, region.w, region.h]);

    return (
        <main className="flex h-screen w-screen items-center justify-center overflow-hidden bg-black text-white">
            <div
                ref={containerRef}
                className="relative h-full w-full overflow-hidden bg-[#0b0f13]"
                style={stageW ? { width: stageW, height: stageH } : undefined}
            >
                {isClient ? (
                    <Map
                        ref={setMapRef}
                        interactive={false}
                        attributionControl={false}
                        mapStyle={JOURNEY_MAP_STYLE}
                        initialViewState={{ longitude: -121.505, latitude: 40.488, zoom: 13 }}
                        maxPitch={80}
                        // Wall units are 1:1 pixels; cap high-DPI laptops so previews stay cheap.
                        pixelRatio={Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)}
                        fadeDuration={0}
                        refreshExpiredTiles={false}
                        // Extended toward the wall centre for the off-axis camera; the stage crops it.
                        style={{ position: 'absolute', ...rig.box }}
                    />
                ) : null}
                {timeline && hudFrame ? (
                    <JourneyHud
                        frame={hudFrame}
                        timeline={timeline}
                        sim={simMeta}
                        region={region}
                        clientWidth={clientWidth}
                    />
                ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-[4vh] text-white/70">
                        {error
                            ? `Could not load avalanche data: ${error}`
                            : 'Loading avalanche journey…'}
                    </div>
                )}
            </div>
        </main>
    );
}

function parseCoord(value: unknown, size: number) {
    if (value === undefined || value === null || value === '') return undefined;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n)) return undefined;
    return Math.min(size - 1, Math.max(0, n));
}

function parseTime(value: unknown) {
    const n =
        typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}
