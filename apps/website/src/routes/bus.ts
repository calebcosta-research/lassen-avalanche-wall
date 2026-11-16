import { createFileRoute } from '@tanstack/react-router';
import { defineHooks } from 'crossws';

import {
    AVI_CLOCK_MESSAGE,
    AVI_PING_MESSAGE,
    AVI_PONG_MESSAGE,
    DEFAULT_JOURNEY_CLOCK,
    sanitizeClockIntent,
    type JourneyClock
} from '../lib/avalanche/clock';
import type {
    BusMessage,
    BusSharedState,
    ScreenMapViewMessage,
    ScreenSegmentSelectionMessage
} from '../lib/realtime';
import { isMapCity } from '../lib/realtime/map-cities';

// In-memory bus state for this server process.
// New clients receive this snapshot in the `hello` handshake so they can
// join late without waiting for another control interaction.
const busSharedState: BusSharedState = {
    city: 'london',
    zoom: 9,
    selectedSegmentIndexes: []
};

// Avalanche journey clock. The bus is the single time authority: it stamps every
// accepted change with its own clock so all screens anchor to the same instant.
let aviClock: JourneyClock = { ...DEFAULT_JOURNEY_CLOCK, anchorServerMs: Date.now() };

const hooks = defineHooks({
    open(peer) {
        // `hello` is our bootstrap packet:
        // it communicates peer identity + current collaborative state.
        peer.send({
            type: 'hello',
            peerId: peer.id,
            serverTime: Date.now(),
            state: { ...busSharedState, aviClock }
        });

        // All collaborating clients publish/subscribe on one logical channel (`do`).
        // This keeps the demo simple while still showing fan-out semantics.
        peer.subscribe('do');
        peer.publish('do', {
            type: 'peer',
            peerId: peer.id,
            peerCount: peer.peers.size
        });
    },
    message(peer, message) {
        // Ignore malformed payloads; only valid JSON objects enter the shared-state path.
        let payload: Partial<BusMessage>;
        try {
            const parsed = message.json() as unknown;
            if (typeof parsed !== 'object' || parsed === null) return;
            payload = parsed as Partial<BusMessage>;
        } catch {
            return;
        }
        if (payload.type === AVI_PING_MESSAGE) {
            // NTP-style probe: echo the client's send time with ours, to the sender only.
            if (typeof payload.sentAt !== 'number') return;
            peer.send({ type: AVI_PONG_MESSAGE, sentAt: payload.sentAt, serverTime: Date.now() });
            return;
        }

        if (payload.type === AVI_CLOCK_MESSAGE) {
            const intent = sanitizeClockIntent(payload.clock);
            if (!intent) return;
            const now = Date.now();
            aviClock = { ...intent, anchorServerMs: now, revision: aviClock.revision + 1 };
            const stamped = {
                type: AVI_CLOCK_MESSAGE,
                clock: aviClock,
                serverTime: now,
                peerId: peer.id,
                peerCount: peer.peers.size
            };
            // publish() skips the sender, who also needs the server-stamped anchor.
            peer.publish('do', stamped);
            peer.send(stamped);
            return;
        }

        updateBusSharedState(payload);

        // Broadcast to all peers. Each client engine can ignore own echoes via peerId.
        peer.publish('do', {
            ...payload,
            peerId: peer.id,
            peerCount: peer.peers.size
        });
    },
    close(peer) {
        peer.publish('do', {
            type: 'bye',
            peerId: peer.id,
            peerCount: peer.peers.size
        });
        peer.unsubscribe('do');
    }
});

function updateBusSharedState(payload: Partial<BusMessage>) {
    if (payload.type === 'screen/map-view') {
        const message = payload as Partial<ScreenMapViewMessage>;
        // Preserve last known valid city/zoom for hello-state replay.
        if (isMapCity(message.city)) {
            busSharedState.city = message.city;
        }

        if (typeof message.view?.zoom === 'number') {
            busSharedState.zoom = message.view.zoom;
        }
        return;
    }

    if (payload.type === 'screen/segment-selection') {
        const message = payload as Partial<ScreenSegmentSelectionMessage>;
        if (!Array.isArray(message.indexes)) return;

        // Keep indexes deterministic for easier equality checks in clients and debugging.
        busSharedState.selectedSegmentIndexes = message.indexes
            .filter((value): value is number => Number.isInteger(value) && value >= 0)
            .slice()
            .sort((a, b) => a - b);
    }
}

export const Route = createFileRoute('/bus')({
    server: {
        handlers: {
            GET: async () => {
                // HTTP fallback response: this endpoint is a websocket upgrade target.
                return Object.assign(
                    new Response('WebSocket upgrade is required.', {
                        status: 426
                    }),
                    {
                        crossws: hooks
                    }
                );
            }
        }
    }
});
