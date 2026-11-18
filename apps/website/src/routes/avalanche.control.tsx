import { PauseIcon, PlayIcon, RepeatIcon, SkipBackIcon } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';

import { AVI, FONT_BODY, FONT_DISPLAY } from '../components/avalanche/theme';
import { AVI_SPEEDS } from '../lib/avalanche/clock';
import { loadRouteData, loadSimMeta, ZONE_STYLE } from '../lib/avalanche/data';
import { AvalancheEngine, useAvalancheStore } from '../lib/avalanche/engine';
import {
    buildTimeline,
    formatClock,
    type JourneyFrame,
    type Timeline
} from '../lib/avalanche/timeline';

type ControlSearch = { operator: string };

const PHASE_LABEL: Record<JourneyFrame['phase'], string> = {
    travel: 'On the route',
    'sim-approach': 'Flying to Lassen Peak NE face',
    'sim-trigger': 'Avalanche released',
    'sim-flow': 'Avalanche running',
    'sim-settle': 'Avalanche stopped',
    'sim-return': 'Heading back to the route',
    finish: 'End of route'
};

export const Route = createFileRoute('/avalanche/control')({
    validateSearch: (search: Record<string, unknown>): ControlSearch => ({
        operator: typeof search.operator === 'string' ? search.operator : 'A'
    }),
    component: AvalancheControl
});

const label: CSSProperties = {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: 12,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: AVI.muted
};

function AvalancheControl() {
    // The tablet sends intent (play, pause, seek, speed); it never renders the map.
    const { operator } = Route.useSearch();
    const [engine] = useState(() => AvalancheEngine.getInstance('control'));
    const clock = useAvalancheStore(engine, (s) => s.clock);
    const connection = useAvalancheStore(engine, (s) => s.connection);
    const [timeline, setTimeline] = useState<Timeline | null>(null);
    const [frame, setFrame] = useState<JourneyFrame | null>(null);
    const [scrub, setScrub] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        // Only the small sim metadata is needed for timing; the frames stay on the wall.
        void Promise.all([loadRouteData(), loadSimMeta()]).then(([route, meta]) => {
            if (!cancelled) setTimeline(buildTimeline(route, meta));
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // The tablet evaluates the same timeline as the wall to show where the journey is.
    useEffect(() => {
        if (!timeline) return;
        const id = window.setInterval(
            () => setFrame(timeline.frameAt(engine.journeyTime(timeline.total))),
            200
        );
        return () => window.clearInterval(id);
    }, [engine, timeline]);

    // Zone bands along the scrubber, in wall time (muted descent events skipped).
    const bands = useMemo(() => {
        if (!timeline) return [];
        const out: Array<{ left: number; width: number; color: string }> = [];
        const times = timeline.eventTimes;
        timeline.route.events.forEach((ev, k) => {
            const t0 = times[k];
            if (Number.isNaN(t0) || ev.zone === 0) return;
            let t1 = timeline.total;
            for (let j = k + 1; j < times.length; j++) {
                if (!Number.isNaN(times[j])) {
                    t1 = times[j];
                    break;
                }
            }
            out.push({
                left: (t0 / timeline.total) * 100,
                width: (Math.max(0.2, t1 - t0) / timeline.total) * 100,
                color: ZONE_STYLE[ev.zone].color
            });
        });
        return out;
    }, [timeline]);

    if (!timeline || !frame) {
        return (
            <main
                className="flex h-screen items-center justify-center"
                style={{ background: AVI.baseSolid, color: AVI.muted, fontFamily: FONT_BODY }}
            >
                Loading…
            </main>
        );
    }

    const total = timeline.total;
    const shownT = scrub ?? frame.t;
    const inSim = frame.phase.startsWith('sim-');
    const zone = inSim ? { color: AVI.alert, label: 'Avalanche scenario' } : ZONE_STYLE[frame.zone];
    const nextEvent = timeline.eventTimes.findIndex((te) => !Number.isNaN(te) && te > frame.t);
    const live = connection === 'open';

    return (
        <main
            className="h-screen w-screen overflow-y-auto"
            style={{ background: AVI.baseSolid, color: AVI.ink, fontFamily: FONT_BODY }}
        >
            <div className="flex w-full flex-col gap-3 p-3">
                <header className="flex items-center justify-between px-1 pt-1">
                    <div>
                        <p style={{ ...label, color: AVI.ice }}>
                            Avalanche journey · Operator {operator}
                        </p>
                        <h1
                            style={{
                                fontFamily: FONT_DISPLAY,
                                fontWeight: 700,
                                fontSize: 22,
                                textTransform: 'uppercase',
                                letterSpacing: '0.02em'
                            }}
                        >
                            Lassen test route 01
                        </h1>
                    </div>
                    <span
                        className="flex items-center gap-2"
                        style={{ ...label, color: live ? AVI.ice : AVI.warn }}
                    >
                        <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: live ? AVI.ice : AVI.warn }}
                        />
                        {live ? 'Live' : connection}
                    </span>
                </header>

                <section
                    className="flex items-stretch overflow-hidden"
                    style={{
                        background: AVI.raised,
                        border: `1px solid ${AVI.line}`,
                        borderTop: `4px solid ${zone.color}`,
                        borderRadius: 4
                    }}
                >
                    <div className="min-w-0 flex-1 px-3 py-2.5">
                        <p style={label}>{PHASE_LABEL[frame.phase]}</p>
                        <p
                            style={{
                                fontFamily: FONT_DISPLAY,
                                fontWeight: 700,
                                fontSize: 21,
                                textTransform: 'uppercase',
                                lineHeight: 1.05
                            }}
                        >
                            {zone.label}
                        </p>
                    </div>
                    <Metric label="km" value={(frame.dist / 1000).toFixed(1)} />
                    <Metric label="m" value={Math.round(frame.elev).toLocaleString()} />
                    <Metric
                        label="next"
                        value={
                            nextEvent >= 0
                                ? `${Math.max(0, Math.round(timeline.eventTimes[nextEvent] - frame.t))}s`
                                : '–'
                        }
                    />
                </section>

                <section className="px-1">
                    <div className="relative h-8">
                        {/* zone bands + chapter ticks under the native range input */}
                        <div
                            className="absolute inset-x-0 top-3 h-2 overflow-hidden"
                            style={{ background: AVI.raised, borderRadius: 2 }}
                        >
                            {bands.map((b, i) => (
                                <span
                                    key={i}
                                    className="absolute top-0 h-full"
                                    style={{
                                        left: `${b.left}%`,
                                        width: `${b.width}%`,
                                        background: b.color,
                                        opacity: 0.85
                                    }}
                                />
                            ))}
                            <span
                                className="absolute top-0 h-full"
                                style={{
                                    left: 0,
                                    width: `${(shownT / total) * 100}%`,
                                    background: 'rgba(159,216,255,0.25)'
                                }}
                            />
                        </div>
                        {timeline.chapters.map((c) => (
                            <span
                                key={c.label}
                                className="absolute top-1 h-6 w-px"
                                style={{
                                    left: `${(c.t / total) * 100}%`,
                                    background: AVI.lineStrong
                                }}
                            />
                        ))}
                        <input
                            type="range"
                            min={0}
                            max={total}
                            step={0.1}
                            value={shownT}
                            aria-label="Journey position"
                            className="avi-range absolute inset-0 w-full"
                            onChange={(e) => {
                                const t = Number(e.target.value);
                                setScrub(t);
                                engine.seekThrottled(t);
                            }}
                            onPointerUp={() => setScrub(null)}
                            onKeyUp={() => setScrub(null)}
                        />
                    </div>
                    <div
                        className="flex justify-between"
                        style={{
                            ...label,
                            fontSize: 13,
                            color: AVI.ink,
                            fontVariantNumeric: 'tabular-nums'
                        }}
                    >
                        <span>{formatClock(shownT)}</span>
                        <span style={{ color: AVI.muted }}>{formatClock(total)}</span>
                    </div>
                </section>

                <section className="grid grid-cols-[2fr_1fr_1fr] gap-2">
                    <ConsoleButton
                        primary
                        onClick={() => (clock.playing ? engine.pause(total) : engine.play(total))}
                    >
                        {clock.playing ? (
                            <PauseIcon size={18} weight="fill" />
                        ) : (
                            <PlayIcon size={18} weight="fill" />
                        )}
                        {clock.playing ? 'Pause' : 'Play'}
                    </ConsoleButton>
                    <ConsoleButton onClick={() => engine.seek(0)}>
                        <SkipBackIcon size={16} weight="fill" /> Restart
                    </ConsoleButton>
                    <ConsoleButton
                        active={clock.loop}
                        onClick={() => engine.setLoop(!clock.loop, total)}
                    >
                        <RepeatIcon size={16} weight="bold" /> Loop
                    </ConsoleButton>
                </section>

                <section>
                    <p style={label} className="mb-1.5 px-1">
                        Speed
                    </p>
                    <div
                        className="grid grid-cols-4 gap-0 overflow-hidden"
                        style={{ border: `1px solid ${AVI.line}`, borderRadius: 4 }}
                    >
                        {AVI_SPEEDS.map((speed, i) => (
                            <button
                                key={speed}
                                type="button"
                                onClick={() => engine.setSpeed(speed, total)}
                                className="cursor-pointer py-2.5"
                                style={{
                                    fontFamily: FONT_DISPLAY,
                                    fontWeight: 700,
                                    fontSize: 17,
                                    borderLeft: i ? `1px solid ${AVI.line}` : undefined,
                                    background: clock.speed === speed ? AVI.ice : AVI.raised,
                                    color: clock.speed === speed ? AVI.baseSolid : AVI.ink
                                }}
                            >
                                {speed}×
                            </button>
                        ))}
                    </div>
                </section>

                <section>
                    <p style={label} className="mb-1.5 px-1">
                        Jump to
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        {timeline.chapters.map((chapter, i) => (
                            <button
                                key={chapter.label}
                                type="button"
                                onClick={() => engine.seek(chapter.t)}
                                className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left"
                                style={{
                                    background: AVI.raised,
                                    border: `1px solid ${AVI.line}`,
                                    borderRadius: 4
                                }}
                            >
                                <span
                                    style={{
                                        fontFamily: FONT_DISPLAY,
                                        fontWeight: 700,
                                        fontSize: 18,
                                        color: AVI.ice,
                                        fontVariantNumeric: 'tabular-nums'
                                    }}
                                >
                                    {String(i + 1).padStart(2, '0')}
                                </span>
                                <span style={{ fontSize: 13, fontWeight: 500 }}>
                                    {chapter.label}
                                </span>
                            </button>
                        ))}
                    </div>
                </section>
            </div>
            <style>{RANGE_CSS}</style>
        </main>
    );
}

function Metric({ label: unit, value }: { label: string; value: string }) {
    return (
        <div
            className="flex flex-col items-end justify-center px-3"
            style={{ borderLeft: `1px solid ${AVI.line}` }}
        >
            <span
                style={{
                    fontFamily: FONT_DISPLAY,
                    fontWeight: 700,
                    fontSize: 22,
                    fontVariantNumeric: 'tabular-nums',
                    lineHeight: 1
                }}
            >
                {value}
            </span>
            <span style={{ ...label, fontSize: 10 }}>{unit}</span>
        </div>
    );
}

function ConsoleButton({
    children,
    onClick,
    primary = false,
    active = false
}: {
    children: ReactNode;
    onClick: () => void;
    primary?: boolean;
    active?: boolean;
}) {
    const filled = primary || active;
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex cursor-pointer items-center justify-center gap-2 py-3 active:translate-y-px"
            style={{
                fontFamily: FONT_DISPLAY,
                fontWeight: 700,
                fontSize: 16,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                borderRadius: 4,
                border: `1px solid ${filled ? AVI.ice : AVI.line}`,
                background: primary ? AVI.ice : active ? 'rgba(159,216,255,0.14)' : AVI.raised,
                color: primary ? AVI.baseSolid : active ? AVI.ice : AVI.ink
            }}
        >
            {children}
        </button>
    );
}

// Thin transparent track (the zone bands show through) with a square ice-blue thumb.
const RANGE_CSS = `
.avi-range { -webkit-appearance: none; appearance: none; background: transparent; margin: 0; height: 32px; cursor: pointer; }
.avi-range::-webkit-slider-runnable-track { height: 32px; background: transparent; }
.avi-range::-moz-range-track { height: 32px; background: transparent; }
.avi-range::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 28px; margin-top: 2px; border-radius: 2px; background: ${AVI.ice}; border: 2px solid ${AVI.baseSolid}; box-shadow: 0 0 0 1px ${AVI.ice}; }
.avi-range::-moz-range-thumb { width: 14px; height: 28px; border-radius: 2px; background: ${AVI.ice}; border: 2px solid ${AVI.baseSolid}; }
.avi-range:focus-visible { outline: 2px solid ${AVI.ice}; outline-offset: 2px; }
`;
