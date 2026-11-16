import { createFileRoute } from '@tanstack/react-router';
import { Map, type MapRef } from '@vis.gl/react-maplibre';
import { useCallback, useEffect, useRef, useState } from 'react';

import { animateHud, hudContentKey, JourneyHud } from '../components/avalanche/journey-hud';
import { AVI, FONT_DISPLAY } from '../components/avalanche/theme';
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
// `?prewarm=0` skips the tile warm-up pass (it is also skipped when `t` freezes time).
type ScreenSearch = { c?: number; r?: number; t?: number; prewarm?: boolean };

const MAX_PIXEL_RATIO = 1.5;
/** Tiles kept per source; the default only covers the current view. */
const MAX_TILE_CACHE = 1200;

export const Route = createFileRoute('/avalanche/screen')({
    validateSearch: (search: Record<string, unknown>): ScreenSearch => ({
        c: parseCoord(search.c, WALL_COLS),
        r: parseCoord(search.r, WALL_ROWS),
        t: parseTime(search.t),
        // The router writes the validated value back to the URL (as false) and validates
        // again, so every spelling of "off" has to round-trip.
        prewarm: [0, '0', false, 'false'].includes(search.prewarm as never) ? false : undefined
    }),
    component: AvalancheScreen
});

function AvalancheScreen() {
    const { c, r, t: frozenT, prewarm } = Route.useSearch();
    const shouldPrewarm = prewarm !== false && frozenT === undefined;
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
    // null = not started; 0..1 while warming; 1 when done (or skipped)
    const [warm, setWarm] = useState<number | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [viewport, setViewport] = useState({ w: 0, h: 0 });
    const layersRef = useRef<JourneyMapLayers | null>(null);
    const hudRef = useRef<HTMLDivElement | null>(null);

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

    // One animation loop: shared clock -> journey frame -> map + markers + HUD motion, all
    // in the same frame. React re-renders the HUD only when its text/structure changes.
    useEffect(() => {
        if (!timeline) return;
        const engine = AvalancheEngine.getInstance('screen');
        let raf = 0;
        let lastKey = '';
        const tick = (now: number) => {
            const frame = timeline.frameAt(
                frozenT ?? engine.journeyTimeForFrame(timeline.total, now)
            );
            const width = containerRef.current?.clientWidth || UNIT_W;
            if (mapReady && warm === 1) layersRef.current?.update(frame, region, width);
            const key = hudContentKey(frame);
            if (key !== lastKey) {
                lastKey = key;
                setHudFrame(frame);
            }
            animateHud(hudRef.current, frame, timeline);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
        // region is derived from c/r; listing its fields keeps the loop stable across renders
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [timeline, mapReady, warm, frozenT, region.x, region.y, region.w, region.h]);

    // Tile warm-up pass, once per page load, before playback is shown.
    useEffect(() => {
        if (!mapReady || !timeline || warm !== null) return;
        if (!shouldPrewarm) {
            setWarm(1);
            return;
        }
        let cancelled = false;
        setWarm(0);
        const width = containerRef.current?.clientWidth || UNIT_W;
        void layersRef.current
            ?.prewarm(
                timeline,
                region,
                width,
                (f) => setWarm(f >= 1 ? 0.999 : f),
                () => cancelled
            )
            .then(() => {
                if (!cancelled) setWarm(1);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, timeline]);

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
                        // Keep decoded tiles for the whole route in memory across loops.
                        maxTileCacheSize={MAX_TILE_CACHE}
                        // Extended toward the wall centre for the off-axis camera; the stage crops it.
                        style={{ position: 'absolute', ...rig.box }}
                    />
                ) : null}
                {warm !== null && warm < 1 ? <WarmupOverlay progress={warm} /> : null}
                {timeline && hudFrame ? (
                    <div ref={hudRef} className="pointer-events-none absolute inset-0">
                        <JourneyHud
                            frame={hudFrame}
                            timeline={timeline}
                            sim={simMeta}
                            region={region}
                            clientWidth={clientWidth}
                        />
                    </div>
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

function WarmupOverlay({ progress }: { progress: number }) {
    return (
        <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-[2vh]"
            style={{ background: AVI.baseSolid, fontFamily: FONT_DISPLAY, color: AVI.ink }}
        >
            <p
                style={{
                    fontSize: '2.4vh',
                    fontWeight: 600,
                    letterSpacing: '0.2em',
                    textTransform: 'uppercase',
                    color: AVI.ice
                }}
            >
                Preparing route tiles
            </p>
            <div style={{ width: '40%', height: '0.8vh', background: AVI.raised }}>
                <div
                    style={{
                        width: `${Math.round(progress * 100)}%`,
                        height: '100%',
                        background: AVI.ice
                    }}
                />
            </div>
            <p style={{ fontSize: '5vh', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(progress * 100)}%
            </p>
        </div>
    );
}
