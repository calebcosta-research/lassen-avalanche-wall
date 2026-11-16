// Wall-scale HUD for the avalanche journey.
//
// Laid out once in wall pixels (5760 x 2160 = 3 x 2 units of 1920 x 1080). Each screen
// shows its slice through a CSS transform, so panels can span bezels and every node agrees
// on what is where. Panels outside this screen's slice are not rendered at all, so a wall
// unit only pays for the one or two panels it actually displays. Type sizes target ~10 m
// viewing distance.

import { type CSSProperties, type ReactNode } from 'react';

import {
    DANGER_STYLE,
    ZONE_STYLE,
    type RouteData,
    type RouteEvent,
    type SimMeta
} from '../../lib/avalanche/data';
import type { WallRegion } from '../../lib/avalanche/map-layers';
import {
    clamp,
    formatClock,
    smoothstep,
    TOAST_LIFETIME_S,
    UNIT_H,
    UNIT_W,
    WALL_H,
    WALL_W,
    type JourneyFrame,
    type Timeline
} from '../../lib/avalanche/timeline';
import { AVI, FONT_BODY, FONT_DISPLAY } from './theme';

const PAD = 72;
const INNER_W = UNIT_W - 2 * PAD;

type Rect = { x: number; y: number; w: number; h: number };

// Slot each panel can occupy; used for culling against the screen's region.
const SLOT: Record<'title' | 'status' | 'toasts' | 'lowerLeft' | 'banner' | 'profile', Rect> = {
    title: { x: 0, y: 0, w: UNIT_W, h: UNIT_H },
    status: { x: 2 * UNIT_W, y: 0, w: UNIT_W, h: UNIT_H },
    toasts: { x: 2 * UNIT_W, y: UNIT_H, w: UNIT_W, h: UNIT_H },
    lowerLeft: { x: 0, y: UNIT_H, w: UNIT_W, h: UNIT_H },
    banner: { x: UNIT_W, y: 0, w: UNIT_W, h: UNIT_H / 2 },
    profile: { x: UNIT_W, y: WALL_H - 320, w: 2 * UNIT_W, h: 320 }
};

const intersects = (a: Rect, b: WallRegion) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

type Props = {
    frame: JourneyFrame;
    timeline: Timeline;
    sim: SimMeta | null;
    region: WallRegion;
    clientWidth: number;
};

export function JourneyHud({ frame, timeline, sim, region, clientWidth }: Props) {
    const scale = clientWidth / region.w;
    const inSim = frame.phase.startsWith('sim-');
    const show = (slot: keyof typeof SLOT) => intersects(SLOT[slot], region);
    return (
        <div
            className="pointer-events-none absolute top-0 left-0 origin-top-left"
            style={{
                width: WALL_W,
                height: WALL_H,
                transform: `scale(${scale}) translate(${-region.x}px, ${-region.y}px)`,
                fontFamily: FONT_BODY,
                color: AVI.ink,
                // HUD changes never affect layout outside itself.
                contain: 'layout style'
            }}
        >
            {show('title') ? <TitlePanel route={timeline.route} /> : null}
            {show('status') ? <StatusPanel frame={frame} /> : null}
            {show('toasts') ? <Toasts frame={frame} /> : null}
            {show('lowerLeft') ? (
                inSim && sim ? (
                    <SimPanel frame={frame} sim={sim} />
                ) : (
                    <Legend />
                )
            ) : null}
            {show('banner') && (frame.phase === 'sim-trigger' || frame.phase === 'sim-approach') ? (
                <TriggerBanner frame={frame} />
            ) : null}
            {show('profile') ? <Profile frame={frame} timeline={timeline} /> : null}
        </div>
    );
}

// ---- building blocks ------------------------------------------------------------------

function Panel({
    x,
    y,
    w,
    accent = AVI.ice,
    children,
    style
}: {
    x: number;
    y: number;
    w: number;
    accent?: string;
    children: ReactNode;
    style?: CSSProperties;
}) {
    return (
        <div
            className="absolute"
            style={{
                left: x,
                top: y,
                width: w,
                background: AVI.base,
                border: `2px solid ${AVI.line}`,
                borderTop: `10px solid ${accent}`,
                borderRadius: 6,
                ...style
            }}
        >
            <CornerTicks />
            {children}
        </div>
    );
}

/** Map-frame registration ticks in the lower corners. */
function CornerTicks() {
    const tick: CSSProperties = {
        position: 'absolute',
        width: 28,
        height: 28,
        borderColor: AVI.lineStrong
    };
    return (
        <>
            <span
                style={{
                    ...tick,
                    left: 10,
                    bottom: 10,
                    borderLeft: '3px solid',
                    borderBottom: '3px solid'
                }}
            />
            <span
                style={{
                    ...tick,
                    right: 10,
                    bottom: 10,
                    borderRight: '3px solid',
                    borderBottom: '3px solid'
                }}
            />
        </>
    );
}

function Label({
    children,
    color = AVI.muted,
    size = 30
}: {
    children: ReactNode;
    color?: string;
    size?: number;
}) {
    return (
        <p
            style={{
                fontFamily: FONT_DISPLAY,
                fontWeight: 600,
                fontSize: size,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color,
                lineHeight: 1.1
            }}
        >
            {children}
        </p>
    );
}

const display = (size: number, weight = 700): CSSProperties => ({
    fontFamily: FONT_DISPLAY,
    fontWeight: weight,
    fontSize: size,
    lineHeight: 0.98,
    letterSpacing: '0.01em'
});

const tabular: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

/** Danger level as signage: a numbered square plus the name. */
function DangerChip({ level, size = 1 }: { level: number; size?: number }) {
    const d = DANGER_STYLE[level];
    return (
        <span
            className="inline-flex items-stretch align-middle"
            style={{ border: `2px solid ${d.color}`, borderRadius: 4 }}
        >
            <span
                className="flex items-center justify-center"
                style={{
                    ...display(40 * size),
                    width: 52 * size,
                    background: d.color,
                    color: d.ink
                }}
            >
                {level}
            </span>
            <span
                className="flex items-center"
                style={{
                    ...display(36 * size, 600),
                    padding: `0 ${14 * size}px`,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em'
                }}
            >
                {d.label}
            </span>
        </span>
    );
}

// ---- top-left unit: where we are and today's conditions -------------------------------

function TitlePanel({ route }: { route: RouteData }) {
    const c = route.conditions;
    const bands: Array<[string, number]> = [
        ['Alpine', c.danger.alpine],
        ['Near treeline', c.danger.treeline],
        ['Below treeline', c.danger.below_treeline]
    ];
    return (
        <Panel x={PAD} y={PAD} w={INNER_W} style={{ padding: '44px 56px 56px' }}>
            <Label color={AVI.ice}>Lassen Volcanic NP · Test route 01</Label>
            <h1 style={{ ...display(104), marginTop: 10, textTransform: 'uppercase' }}>
                Avalanche terrain check
            </h1>
            <div className="mt-6 flex items-baseline gap-5" style={{ fontSize: 38 }}>
                <span style={{ fontWeight: 600 }}>{c.name}</span>
                <span style={{ color: AVI.muted }}>{c.date}</span>
            </div>
            <div
                className="mt-8 grid grid-cols-3 gap-5"
                style={{ borderTop: `2px solid ${AVI.line}`, paddingTop: 26 }}
            >
                {bands.map(([label, level]) => (
                    <div key={label}>
                        <Label size={26}>{label}</Label>
                        <div className="mt-3">
                            <DangerChip level={level} size={0.95} />
                        </div>
                    </div>
                ))}
            </div>
            <p className="mt-8" style={{ fontSize: 33, lineHeight: 1.35, color: '#cfdbe5' }}>
                {c.summary}
            </p>
        </Panel>
    );
}

// ---- top-right unit: live status of the traveller -------------------------------------

const LEG_LABEL = {
    drive: 'Driving · Lassen Park Hwy',
    climb: 'Climbing · Lassen Peak Trail',
    descend: 'Descending · Lassen Peak Trail'
};

function StatusPanel({ frame }: { frame: JourneyFrame }) {
    const ev = frame.currentEvent;
    const inSim = frame.phase.startsWith('sim-');
    // At the summit the card describes the avalanche scenario rather than the summit cell.
    const style = inSim
        ? { color: AVI.alert, ink: '#ffffff', label: 'Avalanche scenario' }
        : ZONE_STYLE[frame.zone];
    return (
        <Panel
            x={2 * UNIT_W + PAD}
            y={PAD}
            w={INNER_W}
            accent={style.color}
            style={{ overflow: 'hidden' }}
        >
            <div style={{ padding: '40px 56px 44px', borderBottom: `2px solid ${AVI.line}` }}>
                <Label>{inSim ? 'Paused at the summit' : 'You are in'}</Label>
                <div className="mt-4 flex items-center gap-8">
                    <span
                        className="shrink-0"
                        style={{
                            width: 34,
                            alignSelf: 'stretch',
                            background: style.color,
                            borderRadius: 3
                        }}
                    />
                    <p style={{ ...display(104), textTransform: 'uppercase' }}>{style.label}</p>
                </div>
            </div>
            <div className="grid grid-cols-3" style={{ borderBottom: `2px solid ${AVI.line}` }}>
                <Readout label="Route" value={`${(frame.dist / 1000).toFixed(1)}`} unit="km" />
                <Readout
                    label="Elevation"
                    value={Math.round(frame.elev).toLocaleString()}
                    unit="m"
                    divider
                />
                <Readout
                    label="Mode"
                    value={inSim ? 'Summit' : LEG_LABEL[frame.legKind].split(' · ')[0]}
                    divider
                />
            </div>
            <div
                className="space-y-5"
                style={{ padding: '36px 56px 56px', fontSize: 38, lineHeight: 1.3 }}
            >
                {inSim ? (
                    <p>
                        Storm slab released on the <b>NE face</b> below the summit. Watch where it
                        runs and stops.
                    </p>
                ) : ev ? (
                    <EventDetail event={ev} />
                ) : null}
            </div>
        </Panel>
    );
}

function Readout({
    label,
    value,
    unit,
    divider
}: {
    label: string;
    value: string;
    unit?: string;
    divider?: boolean;
}) {
    return (
        <div
            style={{
                padding: '24px 40px 26px 56px',
                borderLeft: divider ? `2px solid ${AVI.line}` : undefined
            }}
        >
            <Label size={24}>{label}</Label>
            <p className="mt-2" style={{ ...display(60), ...tabular }}>
                {value}
                {unit ? (
                    <span style={{ ...display(34, 500), color: AVI.muted, marginLeft: 8 }}>
                        {unit}
                    </span>
                ) : null}
            </p>
        </div>
    );
}

function EventDetail({ event }: { event: RouteEvent }) {
    return (
        <>
            {event.start_zone ? (
                <p>
                    Start zone{' '}
                    <b style={{ color: AVI.ice }}>
                        {event.start_zone.distance_m} m {event.start_zone.compass}
                    </b>
                    {event.slope ? (
                        <span style={{ color: AVI.muted }}> · {event.slope} slope</span>
                    ) : null}
                </p>
            ) : event.slope && event.zone === 3 ? (
                <p>
                    On a <b style={{ color: AVI.ice }}>{event.slope}</b> slope
                </p>
            ) : null}
            {event.zone > 0 && event.problems.length > 0 && event.active ? (
                <p className="flex items-start gap-4">
                    <span
                        style={{
                            ...display(30),
                            background: AVI.warn,
                            color: '#140a00',
                            padding: '4px 12px',
                            borderRadius: 3,
                            letterSpacing: '0.1em'
                        }}
                    >
                        PROBLEM
                    </span>
                    <span>
                        {event.problems
                            .map(
                                (p) =>
                                    `${p.type} · ${p.likelihood} · size ${p.size[0]}–${p.size[1]}`
                            )
                            .join('  /  ')}
                    </span>
                </p>
            ) : event.zone > 0 ? (
                <p style={{ color: AVI.muted }}>
                    No forecast problem matches this slope today. Still avalanche terrain.
                </p>
            ) : null}
            <p className="flex items-center gap-5">
                <span style={{ color: AVI.muted }}>Danger here</span>
                <DangerChip level={event.danger_level} size={0.85} />
                <span style={{ color: AVI.dim }}>{event.band}</span>
            </p>
        </>
    );
}

// ---- right column, lower unit: notifications when the category changes ----------------

function Toasts({ frame }: { frame: JourneyFrame }) {
    return (
        <div
            className="absolute flex flex-col gap-7"
            style={{ left: 2 * UNIT_W + PAD, top: UNIT_H + PAD / 2, width: INNER_W }}
        >
            {frame.toasts.map(({ event, index, ageS }) => {
                const firedAt = frame.t - ageS;
                const style = ZONE_STYLE[event.zone];
                const leaving = event.zone === 0;
                return (
                    <div
                        key={index}
                        data-toast-at={firedAt}
                        className="relative flex overflow-hidden"
                        style={{
                            ...toastMotion(ageS),
                            background: AVI.base,
                            border: `2px solid ${AVI.line}`,
                            borderRadius: 6
                        }}
                    >
                        <div
                            className="flex shrink-0 items-center justify-center"
                            style={{ width: 132, background: style.color, color: style.ink }}
                        >
                            <span style={display(64)}>
                                {leaving ? '✓' : event.zone === 3 ? '▲' : '◆'}
                            </span>
                        </div>
                        <div style={{ padding: '22px 36px 26px' }}>
                            <Label size={26}>
                                {leaving ? 'Leaving avalanche terrain' : 'Entering'} · km{' '}
                                {(event.dist_m / 1000).toFixed(1)}
                            </Label>
                            <p style={{ ...display(64), marginTop: 6, textTransform: 'uppercase' }}>
                                {event.label}
                            </p>
                            {event.zone > 0 ? (
                                <p className="mt-2" style={{ fontSize: 32, color: '#cfdbe5' }}>
                                    {event.start_zone
                                        ? `Start zone ${event.start_zone.distance_m} m ${event.start_zone.compass}`
                                        : event.slope
                                          ? `${event.slope} slope`
                                          : ''}
                                    {event.active && event.problems.length ? (
                                        <span style={{ color: AVI.warn }}>
                                            {' '}
                                            · {event.problems.map((p) => p.type).join(' + ')}{' '}
                                            {event.problems[0].likelihood}
                                        </span>
                                    ) : null}
                                </p>
                            ) : null}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ---- left column, lower unit: legend while travelling, simulation stats at the peak ----

function Legend() {
    const rows: Array<[string, ReactNode]> = [
        [ZONE_STYLE[3].label + ' · start zones', <Swatch key="3" color={ZONE_STYLE[3].color} />],
        [ZONE_STYLE[2].label, <Swatch key="2" color={ZONE_STYLE[2].color} />],
        [ZONE_STYLE[1].label, <Swatch key="1" color={ZONE_STYLE[1].color} />],
        [
            'Trigger zone feeding your position',
            <span
                key="t"
                className="inline-block rounded-full"
                style={{
                    width: 40,
                    height: 40,
                    border: '5px solid #fff',
                    background: ZONE_STYLE[3].color
                }}
            />
        ],
        [
            'Avalanche path toward you',
            <span
                key="a"
                className="inline-block"
                style={{ width: 64, height: 12, background: '#fb8c00' }}
            />
        ]
    ];
    return (
        <Panel x={PAD} y={UNIT_H + PAD / 2} w={INNER_W} style={{ padding: '40px 56px 52px' }}>
            <Label color={AVI.ice}>Map key · AutoATES 10 m</Label>
            <div className="mt-6">
                {rows.map(([label, icon], i) => (
                    <div
                        key={label}
                        className="flex items-center gap-7"
                        style={{
                            fontSize: 38,
                            padding: '14px 0',
                            borderTop: i ? `1px solid ${AVI.line}` : undefined
                        }}
                    >
                        <span className="flex w-16 justify-center">{icon}</span>
                        {label}
                    </div>
                ))}
            </div>
        </Panel>
    );
}

function Swatch({ color }: { color: string }) {
    return (
        <span
            className="inline-block"
            style={{ width: 60, height: 40, background: color, borderRadius: 3 }}
        />
    );
}

function TriggerBanner({ frame }: { frame: JourneyFrame }) {
    return (
        <div
            data-hud="banner"
            className="absolute flex justify-center"
            style={{ left: UNIT_W, top: PAD, width: UNIT_W, opacity: bannerOpacity(frame) }}
        >
            <Panel
                x={0}
                y={0}
                w={1400}
                accent={AVI.alert}
                style={{ position: 'relative', padding: '36px 60px 48px', textAlign: 'center' }}
            >
                <Label color={AVI.alert} size={34}>
                    Scenario · what if
                </Label>
                <p style={{ ...display(110), marginTop: 10, textTransform: 'uppercase' }}>
                    A storm slab releases
                </p>
                <p className="mt-4" style={{ fontSize: 38, color: '#cfdbe5' }}>
                    Lassen Peak NE face · 0.5 m deep · 5.5 ha
                </p>
            </Panel>
        </div>
    );
}

function SimPanel({ frame, sim }: { frame: JourneyFrame; sim: SimMeta }) {
    const t = frame.simTime ?? 0;
    const k = clamp(Math.round(t / sim.frame_dt_s), 0, sim.ke_MJ.length - 1);
    const ke = sim.ke_MJ[k] ?? 0;
    const peakKe = Math.max(...sim.ke_MJ);
    const s = sim.summary;
    const settled = frame.phase === 'sim-settle' || frame.phase === 'sim-return';
    const speedup = sim.times_s[sim.times_s.length - 1] / 34;
    const n = sim.ke_MJ.length - 1;
    const spark = sim.ke_MJ
        .map((v, i) => `${(i / n) * 1000},${200 - (v / peakKe) * 190}`)
        .join(' ');
    const sparkDone = sim.ke_MJ
        .slice(0, k + 1)
        .map((v, i) => `${(i / n) * 1000},${200 - (v / peakKe) * 190}`)
        .join(' ');
    return (
        <Panel
            x={PAD}
            y={UNIT_H + PAD / 2}
            w={INNER_W}
            accent={AVI.alert}
            style={{ padding: '40px 56px 48px' }}
        >
            <Label color={AVI.alert}>Avalanche simulation · storm slab</Label>
            <div className="mt-3 flex items-end gap-10">
                <p style={{ ...display(170), ...tabular }}>{formatClock(t)}</p>
                <div className="pb-4">
                    <Label size={28}>
                        {frame.phase === 'sim-flow'
                            ? `Simulated time · ${speedup.toFixed(0)}× speed`
                            : settled
                              ? 'Flow has run out'
                              : 'Release'}
                    </Label>
                </div>
            </div>
            <div
                className="mt-6 flex items-center gap-10"
                style={{ borderTop: `2px solid ${AVI.line}`, paddingTop: 24 }}
            >
                <svg viewBox="0 0 1000 210" className="h-[150px] flex-1" preserveAspectRatio="none">
                    <polyline points={spark} fill="none" stroke={AVI.line} strokeWidth="6" />
                    <polyline points={sparkDone} fill="none" stroke={AVI.ice} strokeWidth="7" />
                    <line
                        x1={(k / n) * 1000}
                        x2={(k / n) * 1000}
                        y1="0"
                        y2="210"
                        stroke={AVI.alert}
                        strokeWidth="6"
                    />
                </svg>
                <div className="w-[400px]">
                    <Label size={26}>Kinetic energy</Label>
                    <p className="mt-2" style={{ ...display(84), ...tabular }}>
                        {Math.round(ke)}
                        <span style={{ ...display(40, 500), color: AVI.muted, marginLeft: 10 }}>
                            MJ
                        </span>
                    </p>
                </div>
            </div>
            <div
                className="mt-6 grid grid-cols-3"
                style={{
                    borderTop: `2px solid ${AVI.line}`,
                    opacity: settled ? 1 : 0.6,
                    transition: 'opacity 600ms'
                }}
            >
                <Stat label="Max speed" value={`${s.max_speed_ms}`} unit="m/s" />
                <Stat label="Vertical drop" value={`${Math.round(s.vertical_drop_m)}`} unit="m" />
                <Stat label="Runout" value={(s.runout_horizontal_m / 1000).toFixed(2)} unit="km" />
                <Stat label="Affected area" value={s.affected_area_ha.toFixed(0)} unit="ha" />
                <Stat label="Max pressure" value={`${Math.round(s.max_pressure_kPa)}`} unit="kPa" />
                <Stat label="Deposit depth" value={s.max_deposit_depth_m.toFixed(1)} unit="m" />
            </div>
            <div className="mt-6 flex items-center gap-5">
                <Label size={24}>Flow speed</Label>
                <span
                    className="h-5 flex-1"
                    style={{
                        borderRadius: 2,
                        background:
                            'linear-gradient(90deg, rgb(226,240,255), rgb(140,200,255), rgb(70,130,255), rgb(168,85,247), rgb(255,77,141))'
                    }}
                />
                <Label size={24}>0 – 22 m/s</Label>
            </div>
            <p className="mt-5" style={{ fontSize: 25, color: AVI.dim }}>
                Voellmy-Salm depth-averaged flow (μ {sim.inputs.mu}, ξ {sim.inputs.xi} m/s²), 10 m
                DEM. A planning scenario, not a forecast.
            </p>
        </Panel>
    );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
    return (
        <div style={{ padding: '18px 0 4px' }}>
            <Label size={24}>{label}</Label>
            <p className="mt-1" style={{ ...display(60), ...tabular }}>
                {value}
                <span style={{ ...display(30, 500), color: AVI.muted, marginLeft: 6 }}>{unit}</span>
            </p>
        </div>
    );
}

// ---- bottom strip across the wall: elevation profile coloured by zone -----------------

const PROFILE_H = 240;
const PROFILE_TOP = WALL_H - PROFILE_H - 44;
const PROFILE_LEFT = UNIT_W + PAD; // starts after the left column's panel
const PROFILE_W = WALL_W - PROFILE_LEFT - PAD;
const PLOT_TOP = 54;
const PLOT_BOTTOM = PROFILE_H - 48;

type ProfileGeometry = {
    line: string;
    runs: Array<{ x0: number; w: number; color: string; zone: number }>;
    ticks: number[];
    x: (d: number) => number;
    y: (e: number) => number;
};

const profileCache = new WeakMap<RouteData, ProfileGeometry>();

function profileGeometry(route: RouteData): ProfileGeometry {
    const cached = profileCache.get(route);
    if (cached) return cached;
    const { dist, elev } = route.samples;
    const lo = Math.min(...elev) - 50;
    const hi = Math.max(...elev) + 50;
    const x = (d: number) => (d / route.total_m) * PROFILE_W;
    const y = (e: number) => PLOT_BOTTOM - ((e - lo) / (hi - lo)) * (PLOT_BOTTOM - PLOT_TOP);
    const step = Math.max(1, Math.floor(dist.length / 800));
    let line = '';
    for (let i = 0; i < dist.length; i += step)
        line += `${x(dist[i]).toFixed(1)},${y(elev[i]).toFixed(1)} `;
    const runs = route.events.map((e) => ({
        x0: x(e.dist_m),
        w: x(e.length_m + 10),
        color: ZONE_STYLE[e.zone].color,
        zone: e.zone
    }));
    const ticks: number[] = [];
    for (let km = 0; km * 1000 <= route.total_m; km += 2.5) ticks.push(km);
    const geometry = { line, runs, ticks, x, y };
    profileCache.set(route, geometry);
    return geometry;
}

function Profile({ frame, timeline }: { frame: JourneyFrame; timeline: Timeline }) {
    const route = timeline.route;
    const geometry = profileGeometry(route);
    const mx = geometry.x(frame.dist);
    const my = geometry.y(frame.elev);
    return (
        <div
            className="absolute"
            style={{
                left: PROFILE_LEFT,
                top: PROFILE_TOP,
                width: PROFILE_W,
                height: PROFILE_H,
                background: AVI.base,
                border: `2px solid ${AVI.line}`,
                borderRadius: 6
            }}
        >
            <svg
                width={PROFILE_W}
                height={PROFILE_H}
                className="overflow-visible"
                style={{ fontFamily: FONT_DISPLAY }}
            >
                <text
                    x={24}
                    y={38}
                    fill={AVI.muted}
                    fontSize={26}
                    fontWeight={600}
                    letterSpacing="0.16em"
                >
                    ROUTE PROFILE · AVALANCHE TERRAIN ALONG THE WAY
                </text>
                <rect
                    data-hud="shade"
                    x={0}
                    y={0}
                    width={mx}
                    height={PROFILE_H}
                    fill="rgba(159,216,255,0.06)"
                />
                {geometry.ticks.map((km) => (
                    <g key={km}>
                        <line
                            x1={geometry.x(km * 1000)}
                            x2={geometry.x(km * 1000)}
                            y1={PLOT_TOP}
                            y2={PLOT_BOTTOM}
                            stroke={AVI.line}
                            strokeWidth={2}
                        />
                        <text
                            x={geometry.x(km * 1000) + 8}
                            y={PROFILE_H - 14}
                            fill={AVI.dim}
                            fontSize={24}
                            fontWeight={600}
                        >
                            {km} KM
                        </text>
                    </g>
                ))}
                {geometry.runs.map((r, i) =>
                    r.zone > 0 ? (
                        <rect
                            key={i}
                            x={r.x0}
                            y={PLOT_BOTTOM + 2}
                            width={Math.max(2, r.w)}
                            height={14}
                            fill={r.color}
                        />
                    ) : null
                )}
                <polyline points={geometry.line} fill="none" stroke={AVI.ice} strokeWidth={5} />
                {/* Position is animated per frame by animateHud(); React sets the colour. */}
                <g data-hud="cursor" transform={`translate(${mx} 0)`}>
                    <line
                        x1={0}
                        x2={0}
                        y1={PLOT_TOP - 10}
                        y2={PLOT_BOTTOM + 16}
                        stroke={AVI.ink}
                        strokeWidth={4}
                    />
                </g>
                <g data-hud="diamond" transform={`translate(${mx} ${my})`}>
                    <rect
                        x={-15}
                        y={-15}
                        width={30}
                        height={30}
                        fill={ZONE_STYLE[frame.zone].color}
                        stroke="#fff"
                        strokeWidth={5}
                        transform="rotate(45)"
                    />
                </g>
                <text
                    x={geometry.x(route.summit.dist_m)}
                    y={geometry.y(route.summit.elev_m) - 22}
                    fill={AVI.ink}
                    fontSize={34}
                    fontWeight={700}
                    textAnchor="middle"
                    letterSpacing="0.06em"
                >
                    LASSEN PEAK {route.summit.elev_m.toLocaleString()} M
                </text>
            </svg>
        </div>
    );
}

// ---- per-frame motion, applied without React -----------------------------------------

function toastMotion(ageS: number): CSSProperties {
    const enter = smoothstep(0, 0.8, ageS);
    const leave = 1 - smoothstep(TOAST_LIFETIME_S - 1.5, TOAST_LIFETIME_S, ageS);
    return { opacity: enter * leave, transform: `translateX(${(1 - enter) * 160}px)` };
}

function bannerOpacity(frame: JourneyFrame) {
    return frame.phase === 'sim-approach'
        ? smoothstep(0.6, 1, frame.phaseProgress)
        : 1 - smoothstep(0.8, 1, frame.phaseProgress);
}

/**
 * Signature of everything the HUD shows as text or structure. React re-renders only when
 * this changes (a few times a second); continuous motion goes through animateHud().
 */
export function hudContentKey(frame: JourneyFrame) {
    return [
        frame.phase,
        frame.zone,
        frame.legKind,
        (frame.dist / 1000).toFixed(1),
        Math.round(frame.elev),
        frame.currentEvent?.i ?? -1,
        frame.toasts.map((toast) => toast.index).join(','),
        frame.simTime === null ? -1 : Math.floor(frame.simTime)
    ].join('|');
}

/** Per-frame HUD motion: toast slide/fade, profile cursor, banner fade. Direct DOM writes. */
export function animateHud(root: HTMLElement | null, frame: JourneyFrame, timeline: Timeline) {
    if (!root) return;
    for (const node of root.querySelectorAll<HTMLElement>('[data-toast-at]')) {
        const motion = toastMotion(frame.t - Number(node.dataset.toastAt));
        node.style.opacity = String(motion.opacity);
        node.style.transform = String(motion.transform);
    }
    const geometry = profileGeometry(timeline.route);
    const mx = geometry.x(frame.dist);
    const my = geometry.y(frame.elev);
    root.querySelector('[data-hud="cursor"]')?.setAttribute('transform', `translate(${mx} 0)`);
    root.querySelector('[data-hud="diamond"]')?.setAttribute('transform', `translate(${mx} ${my})`);
    root.querySelector('[data-hud="shade"]')?.setAttribute('width', String(mx));
    const banner = root.querySelector<HTMLElement>('[data-hud="banner"]');
    if (banner) banner.style.opacity = String(bannerOpacity(frame));
}
