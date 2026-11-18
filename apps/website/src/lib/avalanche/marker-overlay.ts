// Everything on the map that changes while the journey plays, drawn as an SVG layer over
// the map and positioned with map.project().
//
// Why not MapLibre layers: with 3D terrain, MapLibre paints its flat layers into cached
// per-tile textures. Any paint/data change to a layer throws that cache away (all of it
// for a style change), so animating a line or a dot through MapLibre rebuilt the terrain
// textures many times a second and made the terrain flicker and step. Keeping MapLibre's
// layers static lets that cache live for the whole journey.
// Why not deck.gl interleaved: its layers don't sit on MapLibre's 3D terrain.
//
// map.project() is synchronous and terrain-aware, and JourneyMapLayers renders the map
// synchronously in the same animation frame, so this overlay and the terrain are always
// presented together.

// Type-only: maplibre-gl is CommonJS, and a runtime named import breaks server rendering.
import type { Map as MaplibreMap } from 'maplibre-gl';

import { ZONE_STYLE, type LonLat, type RouteData } from './data';
import { smoothstep, type JourneyFrame } from './timeline';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Sizes in wall pixels; scaled to the client's real size.
const SIZE = {
    travellerRadius: 20,
    travellerStroke: 6,
    haloRadius: 58,
    srcRadius: 18,
    srcStroke: 5,
    pulseGrow: 70,
    trigLine: 5,
    arrowLine: 12,
    arrowHead: 34,
    path: 11,
    pathCasing: 19,
    aheadRadius: 9,
    aheadStroke: 2,
    releaseLine: 6
};

/** Seconds per trigger pulse (slow and soft: no flashing, BEST_PRACTICES.md section 6). */
const PULSE_S = 2.4;
/** Travelled path drawn back to this far behind the traveller. */
const PATH_BACK_M = 7000;
/** Every Nth route sample is used for the travelled path (samples are ~10 m apart). */
const PATH_STRIDE = 2;
/** Start zones feeding the route within this distance ahead are previewed. */
const AHEAD_M = 1600;

type Pt = { x: number; y: number };

export class MarkerOverlay {
    private readonly map: MaplibreMap;
    private readonly route: RouteData;
    private readonly svg: SVGSVGElement;
    private readonly releaseFill: SVGPolygonElement;
    private readonly pathCasing: SVGPathElement;
    private readonly path: SVGPathElement;
    private readonly aheadGroup: SVGGElement;
    private readonly aheadPool: SVGCircleElement[] = [];
    private readonly trigGroup: SVGGElement;
    private readonly dashLine: SVGLineElement;
    private readonly arrowLine: SVGLineElement;
    private readonly arrowHead: SVGPolygonElement;
    private readonly pulse: SVGCircleElement;
    private readonly src: SVGCircleElement;
    private readonly halo: SVGCircleElement;
    private readonly traveller: SVGCircleElement;
    private readonly aheadStarts: Array<{ dist: number; p: LonLat }>;
    private releaseRing: LonLat[] = [];

    constructor(map: MaplibreMap, route: RouteData) {
        this.map = map;
        this.route = route;
        this.aheadStarts = buildStartZoneList(route);
        const svg = document.createElementNS(SVG_NS, 'svg');
        Object.assign(svg.style, {
            position: 'absolute',
            inset: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            overflow: 'visible',
            zIndex: '2'
        });
        this.svg = svg;
        this.releaseFill = el('polygon', svg, {
            fill: 'rgba(255,82,82,0.45)',
            stroke: '#ffffff',
            'stroke-linejoin': 'round'
        });
        const pathAttrs = { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        this.pathCasing = el('path', svg, {
            ...pathAttrs,
            stroke: '#05080b',
            'stroke-opacity': '0.75'
        });
        this.path = el('path', svg, { ...pathAttrs, stroke: '#ffffff' });
        this.aheadGroup = el('g', svg, {});
        this.trigGroup = el('g', svg, {});
        this.dashLine = el('line', this.trigGroup, {
            stroke: '#ffffff',
            'stroke-linecap': 'round'
        });
        this.arrowLine = el('line', this.trigGroup, {
            stroke: '#fb8c00',
            'stroke-linecap': 'round'
        });
        this.arrowHead = el('polygon', this.trigGroup, { fill: '#fb8c00' });
        this.pulse = el('circle', this.trigGroup, { fill: 'none', stroke: ZONE_STYLE[3].color });
        this.src = el('circle', this.trigGroup, { fill: ZONE_STYLE[3].color, stroke: '#ffffff' });
        this.halo = el('circle', svg, { fill: '#ffffff', 'fill-opacity': '0.16' });
        this.traveller = el('circle', svg, { stroke: '#ffffff' });
        map.getContainer().appendChild(svg);
    }

    setReleaseRing(ring: LonLat[]) {
        this.releaseRing = ring;
    }

    remove() {
        this.svg.remove();
    }

    /** Call after the camera for this frame has been applied. */
    update(frame: JourneyFrame, scale: number) {
        const s = (v: number) => (v * scale).toFixed(2);
        const front = this.frontTest();

        this.updateRelease(frame, scale);
        this.updatePath(frame, scale, front);
        this.updateAhead(frame, scale, front);

        const here = this.project(frame.position);
        setAttrs(this.halo, { cx: here.x, cy: here.y, r: s(SIZE.haloRadius) });
        setAttrs(this.traveller, {
            cx: here.x,
            cy: here.y,
            r: s(SIZE.travellerRadius),
            'stroke-width': s(SIZE.travellerStroke),
            fill: ZONE_STYLE[frame.zone].color
        });
        this.updateTrigger(frame, scale, here);
    }

    private updateRelease(frame: JourneyFrame, scale: number) {
        if (frame.releaseOpacity <= 0.001 || this.releaseRing.length === 0) {
            this.releaseFill.setAttribute('visibility', 'hidden');
            return;
        }
        this.releaseFill.setAttribute('visibility', 'visible');
        setAttrs(this.releaseFill, {
            points: this.releaseRing
                .map((p) => this.project(p))
                .map((p) => `${p.x},${p.y}`)
                .join(' '),
            opacity: frame.releaseOpacity.toFixed(3),
            'stroke-width': (SIZE.releaseLine * scale).toFixed(2),
            'stroke-dasharray': `${(16 * scale).toFixed(1)} ${(12 * scale).toFixed(1)}`
        });
    }

    /** Travelled part of the route (solid white over the static dashed route). */
    private updatePath(frame: JourneyFrame, scale: number, front: (p: LonLat) => boolean) {
        const { lon, lat, dist } = this.route.samples;
        const end = Math.min(lon.length - 1, Math.floor(frame.sampleIndex));
        const startDist = frame.dist - PATH_BACK_M;
        let d = '';
        let pen = false;
        const add = (p: LonLat) => {
            if (!front(p)) {
                pen = false;
                return;
            }
            const q = this.project(p);
            d += `${pen ? 'L' : 'M'}${q.x} ${q.y}`;
            pen = true;
        };
        for (let i = 0; i <= end; i += PATH_STRIDE) {
            if (dist[i] < startDist) continue;
            add([lon[i], lat[i]]);
        }
        add(frame.position);
        this.path.setAttribute('d', d);
        this.pathCasing.setAttribute('d', d);
        this.path.setAttribute('stroke-width', (SIZE.path * scale).toFixed(2));
        this.pathCasing.setAttribute('stroke-width', (SIZE.pathCasing * scale).toFixed(2));
    }

    /** Start zones that feed the route in the next ~1.6 km, fading in with distance. */
    private updateAhead(frame: JourneyFrame, scale: number, front: (p: LonLat) => boolean) {
        let used = 0;
        if (frame.phase === 'travel') {
            for (const start of this.aheadStarts) {
                const ahead = start.dist - frame.dist;
                if (ahead < -60 || ahead > AHEAD_M || !front(start.p)) continue;
                const a =
                    ahead < 0
                        ? smoothstep(-60, 0, ahead)
                        : 1 - smoothstep(AHEAD_M * 0.5, AHEAD_M, ahead);
                const node = this.aheadNode(used++);
                const q = this.project(start.p);
                setAttrs(node, {
                    cx: q.x,
                    cy: q.y,
                    r: (SIZE.aheadRadius * scale).toFixed(2),
                    'stroke-width': (SIZE.aheadStroke * scale).toFixed(2),
                    opacity: (a * 0.75).toFixed(3),
                    visibility: 'visible'
                });
            }
        }
        for (let i = used; i < this.aheadPool.length; i++) {
            this.aheadPool[i].setAttribute('visibility', 'hidden');
        }
    }

    private aheadNode(i: number) {
        while (this.aheadPool.length <= i) {
            this.aheadPool.push(
                el('circle', this.aheadGroup, { fill: ZONE_STYLE[3].color, stroke: '#ffffff' })
            );
        }
        return this.aheadPool[i];
    }

    private updateTrigger(frame: JourneyFrame, scale: number, here: Pt) {
        const s = (v: number) => (v * scale).toFixed(2);
        const tr = frame.trigger;
        if (!tr || tr.alpha <= 0.01) {
            this.trigGroup.setAttribute('visibility', 'hidden');
            return;
        }
        this.trigGroup.setAttribute('visibility', 'visible');
        this.trigGroup.setAttribute('opacity', tr.alpha.toFixed(3));
        const src = this.project(tr.src);
        const up = this.project(tr.up);

        setAttrs(this.dashLine, {
            x1: here.x,
            y1: here.y,
            x2: src.x,
            y2: src.y,
            'stroke-width': s(SIZE.trigLine),
            'stroke-dasharray': `${s(14)} ${s(14)}`,
            'stroke-opacity': '0.85'
        });

        // Arrow from ~100 m up the avalanche path down to the traveller, head drawn in
        // screen space so it stays a crisp, constant-size triangle at any pitch.
        let dx = here.x - up.x;
        let dy = here.y - up.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const head = SIZE.arrowHead * scale;
        const stop = SIZE.travellerRadius * scale * 1.3; // tip just short of the traveller dot
        const tipX = here.x - dx * stop;
        const tipY = here.y - dy * stop;
        const baseX = tipX - dx * head;
        const baseY = tipY - dy * head;
        const wing = head * 0.6;
        setAttrs(this.arrowLine, {
            x1: up.x,
            y1: up.y,
            x2: baseX,
            y2: baseY,
            'stroke-width': s(SIZE.arrowLine)
        });
        this.arrowHead.setAttribute(
            'points',
            `${tipX},${tipY} ${baseX - dy * wing},${baseY + dx * wing} ${baseX + dy * wing},${baseY - dx * wing}`
        );

        const phase = (frame.t / PULSE_S) % 1;
        setAttrs(this.pulse, {
            cx: src.x,
            cy: src.y,
            r: s(SIZE.srcRadius + phase * SIZE.pulseGrow),
            'stroke-width': s(SIZE.srcStroke),
            'stroke-opacity': ((1 - phase) * 0.9).toFixed(3)
        });
        setAttrs(this.src, {
            cx: src.x,
            cy: src.y,
            r: s(SIZE.srcRadius),
            'stroke-width': s(SIZE.srcStroke)
        });
    }

    /**
     * Returns a test for "is this point in front of the camera". project() of a point
     * behind the camera lands at a mirrored screen position, which would draw stray lines.
     */
    private frontTest() {
        const cam = this.map.transform.getCameraLngLat();
        const camera = mercator([cam.lng, cam.lat]);
        const bearing = (this.map.getBearing() * Math.PI) / 180;
        // Horizontal viewing direction in Mercator units (x east, y south).
        const fx = Math.sin(bearing);
        const fy = -Math.cos(bearing);
        return (p: LonLat) => {
            const m = mercator(p);
            return (m.x - camera.x) * fx + (m.y - camera.y) * fy > 0;
        };
    }

    private project(p: LonLat): Pt {
        const pt = this.map.project(p);
        return { x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 };
    }
}

/** Web Mercator x/y in 0..1 world units (x east, y south). */
function mercator(p: LonLat) {
    const sin = Math.sin((p[1] * Math.PI) / 180);
    return { x: (p[0] + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
}

function el<K extends keyof SVGElementTagNameMap>(
    tag: K,
    parent: Element,
    attrs: Record<string, string>
): SVGElementTagNameMap[K] {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.appendChild(node);
    return node;
}

function setAttrs(node: Element, attrs: Record<string, string | number>) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
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
