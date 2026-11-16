// Visual identity for the avalanche demo: an "alpine instrument panel" look.
// Condensed signage type, near-square panels with a coloured top rule and corner ticks,
// a cold blue-black base and an ice-blue accent. Orange/red are kept for hazard only.
//
// Fonts are bundled locally (fontsource), so wall nodes need no internet for type.
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';

export const FONT_DISPLAY = '"Barlow Condensed", "Arial Narrow", sans-serif';
export const FONT_BODY = '"Barlow", "Segoe UI", sans-serif';

export const AVI = {
    ink: '#e9f2f9',
    muted: '#93abbf',
    dim: '#5f7487',
    ice: '#9fd8ff',
    iceDeep: '#2b5d80',
    base: 'rgba(6, 10, 15, 0.9)',
    baseSolid: '#0a1119',
    raised: '#111b26',
    line: 'rgba(159, 216, 255, 0.2)',
    lineStrong: 'rgba(159, 216, 255, 0.45)',
    warn: '#ff9a3c',
    alert: '#ff5a4e'
} as const;
