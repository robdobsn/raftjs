/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// StackLightVisualizer
// Shows an LED chain as an industrial stack light: NY tiers of NX LEDs. Each tier is off, steady,
// flashing or flashing in anti-phase, at a rate of base period x 1, 2, 4 or 8. Tier colours are
// fixed by position, counted from the top: red, amber, green, blue, white, ...
//
// Two device protocols, chosen by the action's write prefix:
//  - "4001..." (ledstick PATTERN, StackLight): the device animates the tiers itself. One write
//    sends [basePeriodMs, state per tier, bottom tier first]; a state byte is mode (bits 0-1) and
//    rate (bits 2-3). See MultiFirmware apps/ledstick/LedStickApp/LedStickProtocol.h.
//  - anything else (e.g. "B0", ledstick FILL + show): one write of [start, count, R, G, B] per
//    tier; tiers can only be off or steady.
// Chain order: the first NX LEDs in the chain form the bottom tier.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { useEffect, useState } from 'react';
import ConnManager from '../ConnManager';
import { DeviceVisualizerProps } from './VisualizerRegistry';

const connManager = ConnManager.getInstance();

// Tier colours by position from the TOP tier (as the ledstick firmware's LEDSTICK_TIER_COLOURS_FROM_TOP)
const TIER_COLOURS_FROM_TOP = ['#FF0000', '#FF7800', '#00FF00', '#0000FF', '#FFFFFF', '#00FFFF', '#FF00FF', '#FFFF00'];

// Tier modes (state byte bits 0-1) and rates (bits 2-3: period = base x 2^rate)
const MODE_OFF = 0;
const MODE_STEADY = 1;
const MODE_FLASH = 2;
const MODE_FLASH_ANTI = 3;
const MODE_LABELS = ['Off', 'Steady', 'Flash', 'Flash (alt)'];
const RATE_LABELS = ['x1', 'x2', 'x4', 'x8'];
const DEFAULT_BASE_MS = 250;
const MIN_BASE_MS = 40;

interface TierState {
    mode: number;
    rate: number;
}

const OFF_TIER: TierState = { mode: MODE_OFF, rate: 0 };

// Presets: tier states listed from the TOP tier down (missing tiers are off). With 4 tiers the
// tiers from the top are red, amber, green, blue.
const PRESETS: Record<string, { label: string; tiers: TierState[] }> = {
    off:      { label: 'Off',                       tiers: [] },
    running:  { label: 'Running (green)',           tiers: [OFF_TIER, OFF_TIER, { mode: MODE_STEADY, rate: 0 }] },
    warning:  { label: 'Warning (amber flashing)',  tiers: [OFF_TIER, { mode: MODE_FLASH, rate: 2 }, { mode: MODE_STEADY, rate: 0 }] },
    alert:    { label: 'Alert (red, fast flash)',   tiers: [{ mode: MODE_FLASH, rate: 0 }] },
    call:     { label: 'Call for help (blue flashing)', tiers: [OFF_TIER, OFF_TIER, OFF_TIER, { mode: MODE_FLASH, rate: 1 }] },
    all:      { label: 'All on',                    tiers: Array(8).fill({ mode: MODE_STEADY, rate: 0 }) },
};

const hexToRgb = (hex: string): number[] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
];

// Whether a tier is lit at a time since the pattern (re)started - the device's rule
const tierLit = (tier: TierState, baseMs: number, elapsedMs: number): boolean => {
    if (tier.mode === MODE_STEADY) return true;
    if (tier.mode !== MODE_FLASH && tier.mode !== MODE_FLASH_ANTI) return false;
    const periodMs = baseMs * (1 << tier.rate);
    const firstHalf = (elapsedMs % periodMs) < periodMs / 2;
    return tier.mode === MODE_FLASH ? firstHalf : !firstHalf;
};

const StackLightVisualizer: React.FC<DeviceVisualizerProps> = ({ deviceKey, action }) => {
    const numTiers = Math.min(Math.max(action?.NY ?? 4, 1), TIER_COLOURS_FROM_TOP.length);
    const ledsPerTier = action?.NX ?? 8;
    const isPattern = (action?.w ?? '').toUpperCase().startsWith('4001');

    // Tier states, index 0 = top tier
    const [tiers, setTiers] = useState<TierState[]>(Array(numTiers).fill(OFF_TIER));
    const [baseMs, setBaseMs] = useState<number>(DEFAULT_BASE_MS);
    const [activeTier, setActiveTier] = useState<number | null>(null);
    const [preset, setPreset] = useState<string>('custom');
    const [startMs, setStartMs] = useState<number>(Date.now());
    const [nowMs, setNowMs] = useState<number>(Date.now());

    // Animate the preview only while something flashes
    const anyFlashing = tiers.some((t) => t.mode === MODE_FLASH || t.mode === MODE_FLASH_ANTI);
    useEffect(() => {
        if (!anyFlashing) return;
        const timer = setInterval(() => setNowMs(Date.now()), 40);
        return () => clearInterval(timer);
    }, [anyFlashing]);

    if (!action) {
        return null;
    }

    const colourOfTier = (tierIdx: number) => TIER_COLOURS_FROM_TOP[tierIdx];

    // Send the whole stack light. Pattern protocol: one write; the device restarts its clock, so
    // the preview clock restarts too. FILL protocol: one write per tier, flashing shown as steady.
    const send = async (newTiers: TierState[], newBaseMs: number) => {
        const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
        if (!deviceManager) return;
        if (isPattern) {
            const states = [...newTiers].reverse().map((t) => (t.mode & 0x03) | ((t.rate & 0x03) << 2));
            // The struct type follows the tier count, whatever the record's t says
            const patternAction = { ...action, t: '>H' + 'B'.repeat(numTiers) };
            await deviceManager.sendAction(deviceKey, patternAction, [newBaseMs, ...states]);
        } else {
            for (let tierIdx = 0; tierIdx < numTiers; tierIdx++) {
                const chainTier = numTiers - 1 - tierIdx;
                const rgb = newTiers[tierIdx].mode === MODE_OFF ? [0, 0, 0] : hexToRgb(colourOfTier(tierIdx));
                await deviceManager.sendAction(deviceKey, action, [chainTier * ledsPerTier, ledsPerTier, ...rgb]);
            }
        }
        setStartMs(Date.now());
        setNowMs(Date.now());
    };

    const updateTier = (tierIdx: number, change: Partial<TierState>) => {
        const newTiers = tiers.map((t, i) => (i === tierIdx ? { ...t, ...change } : t));
        setTiers(newTiers);
        setPreset('custom');
        send(newTiers, baseMs);
    };

    const handlePreset = (key: string) => {
        const def = PRESETS[key];
        if (!def) return;
        const newTiers = Array.from({ length: numTiers }, (_, i) => def.tiers[i] ?? OFF_TIER);
        setPreset(key);
        setActiveTier(null);
        setTiers(newTiers);
        send(newTiers, baseMs);
    };

    const handleBase = (value: number) => {
        if (!Number.isFinite(value) || value < MIN_BASE_MS || value > 65535) return;
        setBaseMs(value);
        send(tiers, value);
    };

    const elapsedMs = nowMs - startMs;
    const modeChoices = isPattern ? [MODE_OFF, MODE_STEADY, MODE_FLASH, MODE_FLASH_ANTI] : [MODE_OFF, MODE_STEADY];
    const selected = activeTier !== null ? tiers[activeTier] : null;

    return (
        <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
            {/* The stack light */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: '44px', height: '10px', background: '#444', borderRadius: '6px 6px 0 0' }} />
                {tiers.map((tier, tierIdx) => {
                    const colour = colourOfTier(tierIdx);
                    const lit = isPattern ? tierLit(tier, baseMs, elapsedMs) : tier.mode !== MODE_OFF;
                    return (
                        <div
                            key={tierIdx}
                            title={`Tier ${tierIdx + 1} from the top: ${MODE_LABELS[tier.mode]}${tier.mode >= MODE_FLASH ? ` ${baseMs * (1 << tier.rate)} ms` : ''}`}
                            onClick={() => setActiveTier(activeTier === tierIdx ? null : tierIdx)}
                            style={{
                                width: '56px',
                                height: '36px',
                                margin: '2px 0',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                background: lit ? colour : '#2a2a2a',
                                boxShadow: lit ? `0 0 14px 2px ${colour}` : `inset 0 0 6px #000, inset 0 0 0 2px ${colour}55`,
                                outline: activeTier === tierIdx ? '2px solid #888' : 'none',
                                outlineOffset: '2px',
                            }}
                        />
                    );
                })}
                <div style={{ width: '64px', height: '18px', background: '#444', borderRadius: '0 0 4px 4px' }} />
                <div style={{ width: '12px', height: '20px', background: '#555' }} />
            </div>

            {/* Controls */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <label>
                    Preset{' '}
                    <select value={preset} onChange={(e) => handlePreset(e.target.value)}>
                        <option value="custom" disabled>Custom</option>
                        {Object.entries(PRESETS).map(([key, def]) => (
                            <option key={key} value={key}>{def.label}</option>
                        ))}
                    </select>
                </label>
                {isPattern && (
                    <label>
                        Fastest flash{' '}
                        <input
                            type="number"
                            min={MIN_BASE_MS}
                            max={65535}
                            step={50}
                            value={baseMs}
                            onChange={(e) => handleBase(parseInt(e.target.value, 10))}
                            style={{ width: '70px' }}
                        />{' '}
                        ms
                    </label>
                )}
                {selected !== null && activeTier !== null ? (
                    <div>
                        <div style={{ fontSize: '0.9em', marginBottom: '6px' }}>
                            Tier {activeTier + 1} from the top
                            <span style={{ display: 'inline-block', width: '12px', height: '12px', marginLeft: '6px',
                                           background: colourOfTier(activeTier), borderRadius: '2px', verticalAlign: 'middle' }} />
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', width: '220px' }}>
                            {modeChoices.map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    onClick={() => updateTier(activeTier, { mode })}
                                    style={{ fontWeight: selected.mode === mode ? 'bold' : 'normal',
                                             border: selected.mode === mode ? '2px solid #888' : '1px solid #888' }}
                                >
                                    {MODE_LABELS[mode]}
                                </button>
                            ))}
                        </div>
                        {isPattern && selected.mode >= MODE_FLASH && (
                            <div style={{ display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' }}>
                                Rate
                                {RATE_LABELS.map((label, rate) => (
                                    <button
                                        key={rate}
                                        type="button"
                                        title={`${baseMs * (1 << rate)} ms`}
                                        onClick={() => updateTier(activeTier, { rate })}
                                        style={{ fontWeight: selected.rate === rate ? 'bold' : 'normal',
                                                 border: selected.rate === rate ? '2px solid #888' : '1px solid #888' }}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    <div style={{ fontSize: '0.9em', opacity: 0.7 }}>Click a tier to set it</div>
                )}
            </div>
        </div>
    );
};

export default StackLightVisualizer;
