// Shared journey clock: the only collaborative state the avalanche demo needs.
//
// A clock is an anchor ("at server time anchorServerMs the journey was at anchorT")
// plus a play state and speed. Each client turns it into the current journey time with
// its own estimate of the server clock, so screens stay in step without per-frame
// network traffic (BEST_PRACTICES.md sections 3 and 8). This file is imported by both
// the bus server route and browser engines, so it stays free of browser APIs.

export const AVI_CLOCK_MESSAGE = 'avi/clock';
/** Clock-sync probe: answered by the bus to the sender only, never broadcast. */
export const AVI_PING_MESSAGE = 'avi/ping';
export const AVI_PONG_MESSAGE = 'avi/pong';

export const AVI_SPEEDS = [0.5, 1, 2, 4] as const;

export type JourneyClock = {
    playing: boolean;
    speed: number;
    loop: boolean;
    /** Journey time (s) at the anchor. */
    anchorT: number;
    /** Server wall-clock ms at the anchor; set by the bus, never by clients. */
    anchorServerMs: number;
    /** Incremented by the bus on every accepted change. */
    revision: number;
};

/** What a control sends: the bus adds anchorServerMs and revision. */
export type JourneyClockIntent = Pick<JourneyClock, 'playing' | 'speed' | 'loop' | 'anchorT'>;

export const DEFAULT_JOURNEY_CLOCK: JourneyClock = {
    playing: true,
    speed: 1,
    loop: true,
    anchorT: 0,
    anchorServerMs: 0,
    revision: 0
};

const MAX_JOURNEY_S = 60 * 60;

export function sanitizeClockIntent(value: unknown): JourneyClockIntent | null {
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.playing !== 'boolean' || typeof v.loop !== 'boolean') return null;
    if (
        typeof v.speed !== 'number' ||
        !AVI_SPEEDS.includes(v.speed as (typeof AVI_SPEEDS)[number])
    ) {
        return null;
    }
    if (typeof v.anchorT !== 'number' || !Number.isFinite(v.anchorT)) return null;
    return {
        playing: v.playing,
        speed: v.speed,
        loop: v.loop,
        // Integer milliseconds of precision is plenty (BEST_PRACTICES.md section 8).
        anchorT: Math.round(Math.min(MAX_JOURNEY_S, Math.max(0, v.anchorT)) * 1000) / 1000
    };
}

export function sanitizeClock(value: unknown): JourneyClock | null {
    const intent = sanitizeClockIntent(value);
    if (!intent) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.anchorServerMs !== 'number' || !Number.isFinite(v.anchorServerMs)) return null;
    if (typeof v.revision !== 'number' || !Number.isInteger(v.revision)) return null;
    return { ...intent, anchorServerMs: v.anchorServerMs, revision: v.revision };
}

/**
 * Journey time for a clock at a given server time. With `loop`, playback wraps to the
 * start after `total`; otherwise it holds at the end.
 */
export function journeyTimeAt(clock: JourneyClock, serverNowMs: number, total: number) {
    if (total <= 0) return 0;
    const elapsed = clock.playing ? ((serverNowMs - clock.anchorServerMs) / 1000) * clock.speed : 0;
    const t = clock.anchorT + Math.max(0, elapsed);
    if (clock.loop) return ((t % total) + total) % total;
    return Math.min(total, t);
}
