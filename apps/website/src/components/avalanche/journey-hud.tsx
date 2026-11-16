// Wall-scale HUD for the avalanche journey.
//
// Laid out once in wall pixels (5760 x 2160 = 3 x 2 units of 1920 x 1080). Each screen
// renders the same tree and shows its slice through a CSS transform, so panels can span
// bezels and every node agrees on what is where. Type sizes target ~10 m viewing distance.

import { useMemo } from 'react';

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

const PAD = 72;
const PANEL =
    'absolute rounded-[28px] border-2 border-white/15 bg-[rgba(10,14,18,0.86)] text-white shadow-[0_20px_60px_rgba(0,0,0,0.45)]';

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
    return (
        <div
            className="pointer-events-none absolute top-0 left-0 origin-top-left font-sans"
            style={{
                width: WALL_W,
                height: WALL_H,
                transform: `scale(${scale}) translate(${-region.x}px, ${-region.y}px)`
            }}
        >
            <TitlePanel route={timeline.route} />
            <StatusPanel frame={frame} />
            <Toasts frame={frame} />
            {inSim && sim ? <SimPanel frame={frame} sim={sim} /> : <Legend />}
            {frame.phase === 'sim-trigger' || frame.phase === 'sim-approach' ? (
                <TriggerBanner frame={frame} />
            ) : null}
            <Profile frame={frame} timeline={timeline} />
        </div>
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
        <div
            className={PANEL}
            style={{ left: PAD, top: PAD, width: UNIT_W - 2 * PAD, padding: 56 }}
        >
            <p className="text-[34px] font-semibold tracking-[0.3em] text-white/60 uppercase">
                Lassen Volcanic NP · Test route
            </p>
            <h1 className="mt-3 text-[76px] leading-[1.05] font-bold">Avalanche terrain check</h1>
            <p className="mt-6 text-[40px] font-semibold">
                {c.name} <span className="font-normal text-white/60">· {c.date}</span>
            </p>
            <div className="mt-6 flex gap-5">
                {bands.map(([label, level]) => (
                    <div
                        key={label}
                        className="flex-1 rounded-2xl px-6 py-4"
                        style={{
                            background: DANGER_STYLE[level].color,
                            color: DANGER_STYLE[level].ink
                        }}
                    >
                        <div className="text-[28px] font-semibold opacity-80">{label}</div>
                        <div className="text-[44px] font-bold">{DANGER_STYLE[level].label}</div>
                    </div>
                ))}
            </div>
            <p className="mt-6 text-[34px] leading-snug text-white/85">{c.summary}</p>
        </div>
    );
}

// ---- top-right unit: live status of the traveller -------------------------------------

const LEG_LABEL = {
    drive: 'Driving Lassen Park Hwy',
    climb: 'Climbing Lassen Peak Trail',
    descend: 'Descending Lassen Peak Trail'
};

function StatusPanel({ frame }: { frame: JourneyFrame }) {
    const ev = frame.currentEvent;
    const inSim = frame.phase.startsWith('sim-');
    // At the summit the card describes the avalanche scenario rather than the summit cell.
    const style = inSim
        ? { color: '#c62828', ink: '#ffffff', label: 'Avalanche scenario' }
        : ZONE_STYLE[frame.zone];
    return (
        <div
            className={PANEL}
            style={{
                left: 2 * UNIT_W + PAD,
                top: PAD,
                width: UNIT_W - 2 * PAD,
                overflow: 'hidden'
            }}
        >
            <div
                className="px-14 pt-12 pb-10"
                style={{ background: style.color, color: style.ink }}
            >
                <p className="text-[32px] font-semibold tracking-[0.25em] uppercase opacity-75">
                    {inSim ? 'Paused at the summit' : 'You are in'}
                </p>
                <p className="mt-2 text-[84px] leading-[1.02] font-bold">{style.label}</p>
            </div>
            <div className="space-y-5 px-14 py-10 text-[40px] leading-snug">
                <p className="text-white/70">
                    {inSim ? 'Lassen Peak summit' : LEG_LABEL[frame.legKind]} ·{' '}
                    {(frame.dist / 1000).toFixed(1)} km · {Math.round(frame.elev).toLocaleString()}{' '}
                    m
                </p>
                {inSim ? (
                    <p>
                        Storm slab released on the <b>NE face</b> below the summit. Watch where it
                        runs and stops.
                    </p>
                ) : ev ? (
                    <EventDetail event={ev} large />
                ) : null}
            </div>
        </div>
    );
}

function EventDetail({ event, large = false }: { event: RouteEvent; large?: boolean }) {
    const danger = DANGER_STYLE[event.danger_level];
    const size = large ? 'text-[40px]' : 'text-[34px]';
    return (
        <div className={`space-y-3 ${size} leading-snug`}>
            {event.start_zone ? (
                <p>
                    Start zone{' '}
                    <b>
                        {event.start_zone.distance_m} m {event.start_zone.compass}
                    </b>
                    {event.slope ? (
                        <span className="text-white/70"> · {event.slope} slope</span>
                    ) : null}
                </p>
            ) : event.slope && event.zone === 3 ? (
                <p>
                    On a <b>{event.slope}</b> slope
                </p>
            ) : null}
            {event.zone > 0 && event.problems.length > 0 && event.active ? (
                <p>
                    <span className="mr-3 rounded-lg bg-[#f58220] px-3 py-1 font-bold text-black">
                        ⚠
                    </span>
                    {event.problems
                        .map((p) => `${p.type} (${p.likelihood}, size ${p.size[0]}–${p.size[1]})`)
                        .join(' · ')}
                </p>
            ) : event.zone > 0 ? (
                <p className="text-white/65">
                    No forecast problem matches this slope today. Still avalanche terrain.
                </p>
            ) : null}
            <p>
                Danger here:{' '}
                <span
                    className="rounded-lg px-3 py-0.5 font-bold"
                    style={{ background: danger.color, color: danger.ink }}
                >
                    {danger.label}
                </span>{' '}
                <span className="text-white/60">({event.band})</span>
            </p>
        </div>
    );
}

// ---- right column, lower unit: notifications when the category changes ----------------

function Toasts({ frame }: { frame: JourneyFrame }) {
    return (
        <div
            className="absolute flex flex-col gap-8"
            style={{ left: 2 * UNIT_W + PAD, top: UNIT_H + PAD / 2, width: UNIT_W - 2 * PAD }}
        >
            {frame.toasts.map(({ event, index, ageS }) => {
                const style = ZONE_STYLE[event.zone];
                const enter = smoothstep(0, 0.8, ageS);
                const leave = 1 - smoothstep(TOAST_LIFETIME_S - 1.5, TOAST_LIFETIME_S, ageS);
                return (
                    <div
                        key={index}
                        className="flex overflow-hidden rounded-[24px] border-2 border-white/15 bg-[rgba(10,14,18,0.9)] text-white"
                        style={{
                            opacity: enter * leave,
                            transform: `translateX(${(1 - enter) * 160}px)`
                        }}
                    >
                        <div className="w-8 shrink-0" style={{ background: style.color }} />
                        <div className="px-10 py-7">
                            <p className="text-[30px] font-semibold tracking-[0.2em] text-white/60 uppercase">
                                {event.zone === 0 ? 'Leaving avalanche terrain' : 'Entering'} ·{' '}
                                {(event.dist_m / 1000).toFixed(1)} km
                            </p>
                            <p
                                className="mt-1 text-[56px] leading-tight font-bold"
                                style={{ color: event.zone === 0 ? '#9be29f' : style.color }}
                            >
                                {event.label}
                            </p>
                            {event.zone > 0 ? (
                                <p className="mt-2 text-[34px] text-white/85">
                                    {event.start_zone
                                        ? `Start zone ${event.start_zone.distance_m} m ${event.start_zone.compass}`
                                        : event.slope
                                          ? `${event.slope} slope`
                                          : ''}
                                    {event.active && event.problems.length
                                        ? ` · ${event.problems.map((p) => p.type).join(' + ')} ${event.problems[0].likelihood}`
                                        : ''}
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
    const rows: Array<[string, React.ReactNode]> = [
        [ZONE_STYLE[3].label + ' (start zones)', <Swatch key="3" color={ZONE_STYLE[3].color} />],
        [ZONE_STYLE[2].label, <Swatch key="2" color={ZONE_STYLE[2].color} />],
        [ZONE_STYLE[1].label, <Swatch key="1" color={ZONE_STYLE[1].color} />],
        [
            'Trigger zone feeding your position',
            <span
                key="t"
                className="inline-block h-10 w-10 rounded-full border-4 border-white"
                style={{ background: ZONE_STYLE[3].color }}
            />
        ],
        [
            'Avalanche path toward you',
            <span key="a" className="inline-block h-3 w-16 rounded bg-[#fb8c00]" />
        ]
    ];
    return (
        <div
            className={PANEL}
            style={{ left: PAD, top: UNIT_H + PAD / 2, width: UNIT_W - 2 * PAD, padding: 48 }}
        >
            <p className="text-[32px] font-semibold tracking-[0.25em] text-white/60 uppercase">
                Map key · AutoATES 10 m
            </p>
            <div className="mt-6 space-y-5">
                {rows.map(([label, icon]) => (
                    <div key={label} className="flex items-center gap-6 text-[38px]">
                        <span className="flex w-16 justify-center">{icon}</span>
                        {label}
                    </div>
                ))}
            </div>
        </div>
    );
}

function Swatch({ color }: { color: string }) {
    return <span className="inline-block h-10 w-14 rounded-md" style={{ background: color }} />;
}

function TriggerBanner({ frame }: { frame: JourneyFrame }) {
    const a =
        frame.phase === 'sim-approach'
            ? smoothstep(0.6, 1, frame.phaseProgress)
            : 1 - smoothstep(0.8, 1, frame.phaseProgress);
    return (
        <div
            className="absolute flex items-center justify-center"
            style={{ left: UNIT_W, top: PAD, width: UNIT_W, opacity: a }}
        >
            <div className="rounded-[28px] border-4 border-[#ff5252] bg-[rgba(10,14,18,0.9)] px-16 py-10 text-center text-white">
                <p className="text-[34px] font-semibold tracking-[0.3em] text-[#ff8a80] uppercase">
                    What if…
                </p>
                <p className="mt-2 text-[80px] leading-none font-bold">A storm slab releases</p>
                <p className="mt-4 text-[38px] text-white/80">
                    Lassen Peak NE face · 0.5 m deep · 5.5 ha
                </p>
            </div>
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
    const spark = sim.ke_MJ
        .map((v, i) => `${(i / (sim.ke_MJ.length - 1)) * 1000},${200 - (v / peakKe) * 190}`)
        .join(' ');
    return (
        <div
            className={PANEL}
            style={{ left: PAD, top: UNIT_H + PAD / 2, width: UNIT_W - 2 * PAD, padding: 48 }}
        >
            <p className="text-[32px] font-semibold tracking-[0.25em] text-[#ff8a80] uppercase">
                Avalanche simulation · storm slab
            </p>
            <div className="mt-4 flex items-end gap-10">
                <p className="text-[120px] leading-none font-bold tabular-nums">{formatClock(t)}</p>
                <p className="pb-3 text-[36px] text-white/70">
                    {frame.phase === 'sim-flow'
                        ? `simulated time · ${speedup.toFixed(0)}× speed`
                        : settled
                          ? 'flow has run out'
                          : 'release'}
                </p>
            </div>
            <div className="mt-6 flex items-center gap-8">
                <svg viewBox="0 0 1000 210" className="h-[150px] flex-1" preserveAspectRatio="none">
                    <polyline
                        points={spark}
                        fill="none"
                        stroke="rgba(255,255,255,0.25)"
                        strokeWidth="6"
                    />
                    <line
                        x1={(k / (sim.ke_MJ.length - 1)) * 1000}
                        x2={(k / (sim.ke_MJ.length - 1)) * 1000}
                        y1="0"
                        y2="210"
                        stroke="#ff4d8d"
                        strokeWidth="8"
                    />
                </svg>
                <div className="w-[420px] text-[36px]">
                    <div className="text-white/60">Kinetic energy</div>
                    <div className="text-[64px] font-bold tabular-nums">{Math.round(ke)} MJ</div>
                </div>
            </div>
            <div
                className="mt-8 grid grid-cols-3 gap-x-8 gap-y-6 text-[34px]"
                style={{ opacity: 0.55 + 0.45 * (settled ? 1 : 0) }}
            >
                <Stat label="Max speed" value={`${s.max_speed_ms} m/s`} />
                <Stat label="Vertical drop" value={`${Math.round(s.vertical_drop_m)} m`} />
                <Stat label="Runout" value={`${(s.runout_horizontal_m / 1000).toFixed(2)} km`} />
                <Stat label="Affected area" value={`${s.affected_area_ha.toFixed(0)} ha`} />
                <Stat label="Max pressure" value={`${Math.round(s.max_pressure_kPa)} kPa`} />
                <Stat label="Deposit depth" value={`${s.max_deposit_depth_m.toFixed(1)} m`} />
            </div>
            <div className="mt-8 flex items-center gap-5 text-[30px] text-white/70">
                <span>Flow speed</span>
                <span
                    className="h-6 flex-1 rounded"
                    style={{
                        background:
                            'linear-gradient(90deg, rgb(226,240,255), rgb(140,200,255), rgb(70,130,255), rgb(168,85,247), rgb(255,77,141))'
                    }}
                />
                <span>0 → 22 m/s</span>
            </div>
            <p className="mt-6 text-[26px] text-white/50">
                Voellmy-Salm depth-averaged flow (μ {sim.inputs.mu}, ξ {sim.inputs.xi} m/s²), 10 m
                DEM. A planning scenario, not a forecast.
            </p>
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div className="text-white/60">{label}</div>
            <div className="text-[52px] font-bold">{value}</div>
        </div>
    );
}

// ---- bottom strip across the whole wall: elevation profile coloured by zone ------------

const PROFILE_H = 230;
const PROFILE_TOP = WALL_H - PROFILE_H - 40;
const PROFILE_LEFT = UNIT_W + PAD; // starts after the left column's panel
const PROFILE_W = WALL_W - PROFILE_LEFT - PAD;

function Profile({ frame, timeline }: { frame: JourneyFrame; timeline: Timeline }) {
    const route = timeline.route;
    const geometry = useMemo(() => {
        const { dist, elev } = route.samples;
        const lo = Math.min(...elev) - 50;
        const hi = Math.max(...elev) + 50;
        const x = (d: number) => (d / route.total_m) * PROFILE_W;
        const y = (e: number) => PROFILE_H - ((e - lo) / (hi - lo)) * (PROFILE_H - 20);
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
        return { line, runs, x, y };
    }, [route]);
    const mx = geometry.x(frame.dist);
    const my = geometry.y(frame.elev);
    return (
        <div
            className="absolute"
            style={{ left: PROFILE_LEFT, top: PROFILE_TOP, width: PROFILE_W, height: PROFILE_H }}
        >
            <svg width={PROFILE_W} height={PROFILE_H} className="overflow-visible">
                <rect
                    x={0}
                    y={0}
                    width={PROFILE_W}
                    height={PROFILE_H}
                    rx={20}
                    fill="rgba(10,14,18,0.7)"
                />
                {geometry.runs.map((r, i) =>
                    r.zone > 0 ? (
                        <rect
                            key={i}
                            x={r.x0}
                            y={PROFILE_H - 22}
                            width={Math.max(2, r.w)}
                            height={22}
                            fill={r.color}
                        />
                    ) : null
                )}
                <rect x={0} y={0} width={mx} height={PROFILE_H} fill="rgba(255,255,255,0.06)" />
                <polyline
                    points={geometry.line}
                    fill="none"
                    stroke="rgba(255,255,255,0.8)"
                    strokeWidth={5}
                />
                <line x1={mx} x2={mx} y1={0} y2={PROFILE_H} stroke="#ffffff" strokeWidth={4} />
                <circle
                    cx={mx}
                    cy={my}
                    r={16}
                    fill={ZONE_STYLE[frame.zone].color}
                    stroke="#fff"
                    strokeWidth={5}
                />
                <text
                    x={geometry.x(route.summit.dist_m)}
                    y={geometry.y(route.summit.elev_m) - 22}
                    fill="#ffffff"
                    fontSize={34}
                    fontWeight={700}
                    textAnchor="middle"
                >
                    Lassen Peak {route.summit.elev_m.toLocaleString()} m
                </text>
            </svg>
        </div>
    );
}
