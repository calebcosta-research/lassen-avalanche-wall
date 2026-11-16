import { throttle } from '@tanstack/pacer';
import { Store, useStore } from '@tanstack/react-store';

import { BusEngine } from '../realtime/engines/bus-engine';
import {
    createInitialEngineStoreState,
    type BusMessage,
    type EngineRole,
    type EngineStoreState,
    type HelloBusMessage
} from '../realtime/types';
import {
    AVI_CLOCK_MESSAGE,
    AVI_PING_MESSAGE,
    AVI_PONG_MESSAGE,
    DEFAULT_JOURNEY_CLOCK,
    journeyTimeAt,
    sanitizeClock,
    type JourneyClock,
    type JourneyClockIntent
} from './clock';

export type AvalancheStoreState = EngineStoreState & {
    clock: JourneyClock;
    /** Estimated server clock minus local clock, in ms. */
    serverOffsetMs: number;
    /** False until the bus has told us the shared clock (hello or a clock message). */
    hasClock: boolean;
};

const SEEK_BROADCAST_WAIT_MS = 120;
// Clock sync: a quick burst on connect, then a slow heartbeat. The offset comes from the
// lowest-round-trip probe among recent ones, so a busy page cannot skew it.
const SYNC_BURST = 6;
const SYNC_BURST_GAP_MS = 250;
const SYNC_INTERVAL_MS = 5_000;
const SYNC_KEEP = 10;

// One engine per page: wall screens and tablets both use it. Screens only read the clock;
// controls also send clock intents.
export class AvalancheEngine extends BusEngine<AvalancheStoreState> {
    private syncSamples: Array<{ rtt: number; offset: number }> = [];
    private syncTimer: ReturnType<typeof setTimeout> | null = null;

    private constructor(role: EngineRole) {
        super(
            role,
            new Store<AvalancheStoreState>({
                ...createInitialEngineStoreState(role),
                clock: DEFAULT_JOURNEY_CLOCK,
                serverOffsetMs: 0,
                hasClock: false
            })
        );
    }

    static getInstance(role: EngineRole) {
        const g = globalThis as typeof globalThis & { __avalancheEngine?: AvalancheEngine };
        g.__avalancheEngine ??= new AvalancheEngine(role);
        return g.__avalancheEngine;
    }

    get state() {
        return this.store.state;
    }

    get storeRef() {
        return this.store;
    }

    /** Best estimate of the bus server's clock right now. */
    serverNow() {
        return Date.now() + this.store.state.serverOffsetMs;
    }

    /** Current journey time for a timeline of the given length. */
    journeyTime(total: number) {
        return journeyTimeAt(this.store.state.clock, this.serverNow(), total);
    }

    // ---- control intents ----------------------------------------------------------------

    play(total: number) {
        const { clock } = this.store.state;
        let t = this.journeyTime(total);
        if (!clock.loop && t >= total) t = 0; // play from the end restarts
        this.sendIntent({ ...pickIntent(clock), playing: true, anchorT: t });
    }

    pause(total: number) {
        this.sendIntent({
            ...pickIntent(this.store.state.clock),
            playing: false,
            anchorT: this.journeyTime(total)
        });
    }

    setSpeed(speed: number, total: number) {
        this.sendIntent({
            ...pickIntent(this.store.state.clock),
            speed,
            anchorT: this.journeyTime(total)
        });
    }

    setLoop(loop: boolean, total: number) {
        this.sendIntent({
            ...pickIntent(this.store.state.clock),
            loop,
            anchorT: this.journeyTime(total)
        });
    }

    seek(t: number) {
        this.sendIntent({ ...pickIntent(this.store.state.clock), anchorT: t });
    }

    /** Scrubber drags fire continuously: coalesce to a few messages per second. */
    readonly seekThrottled = throttle((t: number) => this.seek(t), {
        wait: SEEK_BROADCAST_WAIT_MS,
        leading: true,
        trailing: true
    });

    private sendIntent(intent: JourneyClockIntent) {
        // Optimistic local update so the operator's own UI responds immediately; the bus
        // echoes the stamped clock back and that replaces this guess.
        this.store.setState((prev) => ({
            ...prev,
            clock: { ...prev.clock, ...intent, anchorServerMs: this.serverNow() }
        }));
        this.send({
            type: AVI_CLOCK_MESSAGE,
            clock: intent,
            peerId: this.getPeerId() ?? undefined
        });
    }

    // ---- bus input ----------------------------------------------------------------------

    // The bus echoes clock messages to their sender too (with the server stamp), so we
    // must not drop our own echoes.
    protected override shouldIgnoreSelfMessages() {
        return false;
    }

    protected override onHello(hello: HelloBusMessage) {
        // Rough offset until the first probe returns, then refine with pings.
        if (this.syncSamples.length === 0) this.noteRoughServerTime(hello.serverTime);
        this.startClockSync();
        this.applyClock((hello.state as { aviClock?: unknown } | undefined)?.aviClock);
    }

    protected override onMessage(message: BusMessage) {
        if (message.type === AVI_PONG_MESSAGE) {
            this.onPong(message.sentAt, message.serverTime);
            return;
        }
        if (message.type !== AVI_CLOCK_MESSAGE) return;
        this.applyClock(message.clock);
    }

    private startClockSync() {
        if (this.syncTimer) clearTimeout(this.syncTimer);
        let sent = 0;
        const probe = () => {
            this.send({ type: AVI_PING_MESSAGE, sentAt: Date.now() });
            sent++;
            this.syncTimer = setTimeout(
                probe,
                sent < SYNC_BURST ? SYNC_BURST_GAP_MS : SYNC_INTERVAL_MS
            );
        };
        probe();
    }

    private onPong(sentAt: unknown, serverTime: unknown) {
        if (typeof sentAt !== 'number' || typeof serverTime !== 'number') return;
        const now = Date.now();
        const rtt = now - sentAt;
        if (!(rtt >= 0) || rtt > 10_000) return;
        // Assume the server stamped halfway through the round trip.
        this.syncSamples.push({ rtt, offset: serverTime - (sentAt + rtt / 2) });
        if (this.syncSamples.length > SYNC_KEEP) this.syncSamples.shift();
        const best = this.syncSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.setOffset(best.offset);
    }

    private noteRoughServerTime(serverTime: unknown) {
        if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return;
        this.setOffset(serverTime - Date.now());
    }

    private setOffset(offset: number) {
        this.store.setState((prev) =>
            Math.abs(prev.serverOffsetMs - offset) < 2 ? prev : { ...prev, serverOffsetMs: offset }
        );
    }

    private applyClock(value: unknown) {
        const clock = sanitizeClock(value);
        if (!clock) return;
        this.store.setState((prev) => {
            // Stale or duplicate revisions are ignored, so delivery order cannot rewind time.
            if (prev.hasClock && clock.revision < prev.clock.revision) return prev;
            return { ...prev, clock, hasClock: true };
        });
    }
}

function pickIntent(clock: JourneyClock): JourneyClockIntent {
    return { playing: clock.playing, speed: clock.speed, loop: clock.loop, anchorT: clock.anchorT };
}

export function useAvalancheStore<T>(
    engine: AvalancheEngine,
    selector: (state: AvalancheStoreState) => T
) {
    return useStore(engine.storeRef, selector);
}
