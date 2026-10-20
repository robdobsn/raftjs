/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// StackLightVisualizer
// Shows an LED chain as an industrial stack light: NY tiers of NX LEDs, each tier one colour.
// Click a tier to pick its colour, or choose a mode (e.g. Alert = top tier red). Each tier is
// sent as one action write of [start, count, R, G, B] (the action's w prefix selects the fill).
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { useState } from 'react';
import ConnManager from '../ConnManager';
import { DeviceVisualizerProps } from './VisualizerRegistry';

const connManager = ConnManager.getInstance();

// Chain order: the first NX LEDs in the chain form the bottom tier
const CHAIN_STARTS_AT_BOTTOM = true;

const OFF = '#000000';
const RED = '#FF0000';
const AMBER = '#FFA000';
const GREEN = '#00FF00';
const BLUE = '#0000FF';
const WHITE = '#FFFFFF';

const TIER_COLOURS = [OFF, RED, AMBER, GREEN, BLUE, WHITE, '#FF00FF', '#00FFFF'];

// Modes: tier colours listed from the top tier down (missing tiers are off)
const MODES: Record<string, { label: string; tiers: string[] }> = {
    off:      { label: 'Off',                tiers: [] },
    running:  { label: 'Running (green)',    tiers: [OFF, OFF, GREEN] },
    warning:  { label: 'Warning (amber)',    tiers: [OFF, AMBER] },
    alert:    { label: 'Alert (red)',        tiers: [RED] },
    call:     { label: 'Call for help (blue)', tiers: [OFF, OFF, OFF, BLUE] },
    all:      { label: 'All on',             tiers: [RED, AMBER, GREEN, BLUE] },
};

const hexToRgb = (hex: string): number[] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
];

const StackLightVisualizer: React.FC<DeviceVisualizerProps> = ({ deviceKey, action }) => {
    const numTiers = action?.NY ?? 4;
    const ledsPerTier = action?.NX ?? 8;

    // Tier colours, index 0 = top tier
    const [tiers, setTiers] = useState<string[]>(Array(numTiers).fill(OFF));
    const [activeTier, setActiveTier] = useState<number | null>(null);
    const [mode, setMode] = useState<string>('custom');

    if (!action) {
        return null;
    }

    // Send the given tiers (indices from the top) one write per tier
    const sendTiers = async (newTiers: string[], tierIdxs: number[]) => {
        const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
        if (!deviceManager) return;
        for (const tierIdx of tierIdxs) {
            const chainTier = CHAIN_STARTS_AT_BOTTOM ? numTiers - 1 - tierIdx : tierIdx;
            await deviceManager.sendAction(deviceKey, action,
                [chainTier * ledsPerTier, ledsPerTier, ...hexToRgb(newTiers[tierIdx])]);
        }
    };

    const handleTierColour = (colour: string) => {
        if (activeTier === null) return;
        const newTiers = tiers.map((c, i) => (i === activeTier ? colour : c));
        setTiers(newTiers);
        setActiveTier(null);
        setMode('custom');
        sendTiers(newTiers, [activeTier]);
    };

    const handleMode = (modeKey: string) => {
        setMode(modeKey);
        setActiveTier(null);
        const modeDef = MODES[modeKey];
        if (!modeDef) return;
        const newTiers = Array.from({ length: numTiers }, (_, i) => modeDef.tiers[i] ?? OFF);
        setTiers(newTiers);
        sendTiers(newTiers, newTiers.map((_, i) => i));
    };

    return (
        <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
            {/* The stack light */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: '44px', height: '10px', background: '#444', borderRadius: '6px 6px 0 0' }} />
                {tiers.map((colour, tierIdx) => {
                    const isOn = colour !== OFF;
                    return (
                        <div
                            key={tierIdx}
                            title={`Tier ${tierIdx + 1} (from top)`}
                            onClick={() => setActiveTier(activeTier === tierIdx ? null : tierIdx)}
                            style={{
                                width: '56px',
                                height: '36px',
                                margin: '2px 0',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                background: isOn ? colour : '#2a2a2a',
                                boxShadow: isOn ? `0 0 14px 2px ${colour}` : 'inset 0 0 6px #000',
                                outline: activeTier === tierIdx ? '2px solid #888' : 'none',
                                outlineOffset: '2px',
                            }}
                        />
                    );
                })}
                <div style={{ width: '64px', height: '18px', background: '#444', borderRadius: '0 0 4px 4px' }} />
                <div style={{ width: '12px', height: '20px', background: '#555' }} />
            </div>

            {/* Mode and tier colour controls */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <label>
                    Mode{' '}
                    <select value={mode} onChange={(e) => handleMode(e.target.value)}>
                        <option value="custom" disabled>Custom</option>
                        {Object.entries(MODES).map(([key, def]) => (
                            <option key={key} value={key}>{def.label}</option>
                        ))}
                    </select>
                </label>
                {activeTier !== null ? (
                    <div>
                        <div style={{ fontSize: '0.9em', marginBottom: '6px' }}>Tier {activeTier + 1} colour</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', width: '160px' }}>
                            {TIER_COLOURS.map((colour) => (
                                <button
                                    key={colour}
                                    type="button"
                                    title={colour === OFF ? 'off' : colour}
                                    onClick={() => handleTierColour(colour)}
                                    style={{
                                        width: '28px',
                                        height: '28px',
                                        padding: 0,
                                        borderRadius: '50%',
                                        cursor: 'pointer',
                                        background: colour,
                                        border: colour === tiers[activeTier] ? '3px solid #888' : '1px solid #888',
                                    }}
                                />
                            ))}
                        </div>
                    </div>
                ) : (
                    <div style={{ fontSize: '0.9em', opacity: 0.7 }}>Click a tier to set its colour</div>
                )}
            </div>
        </div>
    );
};

export default StackLightVisualizer;
