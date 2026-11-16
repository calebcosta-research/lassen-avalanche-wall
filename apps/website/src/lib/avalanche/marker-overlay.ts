// Moving markers drawn as an SVG layer over the map, positioned with map.project().
//
// Why not GeoJSON layers: every GeoJSONSource.setData goes through a web worker and comes
// back a frame or two later, so markers lag the camera and judder against the terrain.
// Why not deck.gl interleaved: its layers don't sit on MapLibre's 3D terrain (they'd be
// buried under 3000 m of mountain). map.project() is synchronous and terrain-aware, and
// JourneyMapLayers renders the map synchronously in the same animation frame, so the
// markers and the terrain are always presented together.

import type { Map as MaplibreMap } from 'maplibre-gl';

import { ZONE_STYLE, type LonLat } from './data';
import type { JourneyFrame } from './timeline';

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
    arrowHead: 34
};

/** Seconds per trigger pulse (slow and soft: no flashing, BEST_PRACTICES.md section 6). */
const PULSE_S = 2.4;

export class MarkerOverlay {
    private readonly map: MaplibreMap;
    private readonly svg: SVGSVGElement;
    private readonly trigGroup: SVGGElement;
    private readonly dashLine: SVGLineElement;
    private readonly arrowLine: SVGLineElement;
    private readonly arrowHead: SVGPolygonElement;
    private readonly pulse: SVGCircleElement;
    private readonly src: SVGCircleElement;
    private readonly halo: SVGCircleElement;
    private readonly traveller: SVGCircleElement;

    constructor(map: MaplibreMap) {
        this.map = map;
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
        const el = <K extends keyof SVGElementTagNameMap>(
            tag: K,
            parent: Element,
            attrs: Record<string, string>
        ) => {
            const node = document.createElementNS(SVG_NS, tag);
            for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
            parent.appendChild(node);
            return node;
        };
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

    remove() {
        this.svg.remove();
    }

    /** Call after the camera for this frame has been applied. */
    update(frame: JourneyFrame, scale: number) {
        const here = this.project(frame.position);
        const s = (v: number) => (v * scale).toFixed(2);

        setAttrs(this.halo, { cx: here.x, cy: here.y, r: s(SIZE.haloRadius) });
        setAttrs(this.traveller, {
            cx: here.x,
            cy: here.y,
            r: s(SIZE.travellerRadius),
            'stroke-width': s(SIZE.travellerStroke),
            fill: ZONE_STYLE[frame.zone].color
        });

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

    private project(p: LonLat) {
        const pt = this.map.project(p);
        return { x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 };
    }
}

function setAttrs(node: Element, attrs: Record<string, string | number>) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
}
