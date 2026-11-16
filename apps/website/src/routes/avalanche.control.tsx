import { PauseIcon, PlayIcon, RepeatIcon, SkipBackIcon } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { Button } from '../components/button';
import { AVI_SPEEDS } from '../lib/avalanche/clock';
import { loadRouteData, loadSimData, ZONE_STYLE } from '../lib/avalanche/data';
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
    'sim-approach': 'Zooming to Lassen Peak NE face',
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
        // Only sim metadata is needed here (for timing); frames are cached and small.
        void Promise.all([loadRouteData(), loadSimData()]).then(([route, sim]) => {
            if (!cancelled) setTimeline(buildTimeline(route, sim.meta));
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

    if (!timeline || !frame) {
        return (
            <main className="flex h-screen items-center justify-center text-sm text-[var(--muted-foreground)]">
                Loading…
            </main>
        );
    }

    const total = timeline.total;
    const shownT = scrub ?? frame.t;
    const zone = ZONE_STYLE[frame.zone];
    const nextEvent = timeline.eventTimes.findIndex((te) => !Number.isNaN(te) && te > frame.t);

    return (
        <main className="h-screen w-screen overflow-y-auto bg-[var(--background)] text-[var(--foreground)]">
            <div className="flex w-full flex-col gap-3 p-3">
                <header className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2">
                    <div>
                        <p className="text-[10px] tracking-[0.2em] text-[var(--muted-foreground)] uppercase">
                            Avalanche journey · operator {operator}
                        </p>
                        <h1 className="text-sm font-semibold">Lassen test route</h1>
                    </div>
                    <span
                        className={`rounded-full px-2 py-1 text-[10px] font-medium ${connection === 'open' ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300' : 'bg-amber-500/20 text-amber-700 dark:text-amber-300'}`}
                    >
                        {connection === 'open' ? 'Live' : connection}
                    </span>
                </header>

                <section className="flex items-center gap-3 rounded-lg border border-[var(--border)] p-3">
                    <span
                        className="h-10 w-3 shrink-0 rounded"
                        style={{ background: zone.color }}
                    />
                    <div className="min-w-0">
                        <p className="text-xs text-[var(--muted-foreground)]">
                            {PHASE_LABEL[frame.phase]}
                        </p>
                        <p className="truncate text-sm font-semibold">
                            {frame.phase.startsWith('sim-') ? 'Lassen Peak summit' : zone.label}
                        </p>
                        <p className="text-xs text-[var(--muted-foreground)]">
                            {(frame.dist / 1000).toFixed(1)} km · {Math.round(frame.elev)} m
                            {nextEvent >= 0
                                ? ` · next change in ${Math.max(0, Math.round(timeline.eventTimes[nextEvent] - frame.t))} s`
                                : ''}
                        </p>
                    </div>
                </section>

                <section className="flex flex-col gap-2">
                    <input
                        type="range"
                        min={0}
                        max={total}
                        step={0.1}
                        value={shownT}
                        aria-label="Journey position"
                        className="w-full accent-[var(--primary)]"
                        onChange={(e) => {
                            const t = Number(e.target.value);
                            setScrub(t);
                            engine.seekThrottled(t);
                        }}
                        onPointerUp={() => setScrub(null)}
                        onKeyUp={() => setScrub(null)}
                    />
                    <div className="flex justify-between text-xs text-[var(--muted-foreground)] tabular-nums">
                        <span>{formatClock(shownT)}</span>
                        <span>{formatClock(total)}</span>
                    </div>
                </section>

                <section className="grid grid-cols-3 gap-2">
                    <Button
                        variant="highlight"
                        onClick={() => (clock.playing ? engine.pause(total) : engine.play(total))}
                        className="flex items-center justify-center gap-1 py-3 text-sm"
                    >
                        {clock.playing ? (
                            <PauseIcon size={16} weight="fill" />
                        ) : (
                            <PlayIcon size={16} weight="fill" />
                        )}
                        {clock.playing ? 'Pause' : 'Play'}
                    </Button>
                    <Button
                        onClick={() => engine.seek(0)}
                        className="flex items-center justify-center gap-1 py-3 text-sm"
                    >
                        <SkipBackIcon size={16} weight="fill" /> Restart
                    </Button>
                    <Button
                        variant={clock.loop ? 'highlight' : 'normal'}
                        onClick={() => engine.setLoop(!clock.loop, total)}
                        className="flex items-center justify-center gap-1 py-3 text-sm"
                    >
                        <RepeatIcon size={16} /> Loop {clock.loop ? 'on' : 'off'}
                    </Button>
                </section>

                <section className="flex items-center gap-2">
                    <span className="text-xs text-[var(--muted-foreground)]">Speed</span>
                    {AVI_SPEEDS.map((speed) => (
                        <Button
                            key={speed}
                            variant={clock.speed === speed ? 'highlight' : 'normal'}
                            onClick={() => engine.setSpeed(speed, total)}
                            className="flex-1"
                        >
                            {speed}×
                        </Button>
                    ))}
                </section>

                <section className="flex flex-col gap-1">
                    <span className="text-xs text-[var(--muted-foreground)]">Jump to</span>
                    <div className="grid grid-cols-2 gap-2">
                        {timeline.chapters.map((chapter) => (
                            <Button
                                key={chapter.label}
                                onClick={() => engine.seek(chapter.t)}
                                className="text-left"
                            >
                                {chapter.label}
                            </Button>
                        ))}
                    </div>
                </section>
            </div>
        </main>
    );
}
