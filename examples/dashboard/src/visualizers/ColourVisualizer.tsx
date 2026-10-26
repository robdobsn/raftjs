/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// ColourVisualizer
// Colour view for an RGB(C) colour sensor (e.g. TCS34725, APDS-9960, VEML6040): a swatch of the colour measured,
// the balance of the red, green and blue channels, and the illuminance and colour temperature when the device
// gives them. Renders in the chart panel; updates with the panel's chart timer.
//
// The visualizer goes on the red attribute ("vt": "colour"). Options come from its "vo" (visualizer options)
// object in the device type record - each the name of another attribute of the device:
//   green, blue  the green and blue channels (default "green" and "blue")
//   clear        the clear (or white) channel, shown with the others (optional)
//   lux          illuminance in lux (optional)
//   cct          correlated colour temperature in K (optional)
//
// The swatch is the hue: each channel is scaled by the largest of the three, so it shows the balance of the
// channels, not how bright the light is. The channels are as the sensor measures them, without white balance:
// each sensor's photodiodes differ in sensitivity, so white light usually looks slightly tinted.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { memo } from 'react';
import ConnManager from '../ConnManager';
import { DeviceState, DeviceAttributeState } from '../../../../src/RaftDeviceStates';
import { DeviceVisualizerProps } from './VisualizerRegistry';

const connManager = ConnManager.getInstance();

interface ColourOptions {
    green?: string;
    blue?: string;
    clear?: string;
    lux?: string;
    cct?: string;
}

// Latest value of an attribute (NaN if there is none)
function latestValue(attrState: DeviceAttributeState | undefined): number {
    if (!attrState || attrState.values.length === 0) return NaN;
    const v = attrState.values[attrState.values.length - 1];
    return typeof v === 'number' ? v : NaN;
}

function toHex(v: number): string {
    return Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
}

const CHANNEL_COLOURS: Record<string, string> = { red: '#e57373', green: '#81c784', blue: '#64b5f6', clear: '#cfd8dc' };

const ColourVisualizer: React.FC<DeviceVisualizerProps> = memo(({ deviceKey, attribute }) => {
    const opts: ColourOptions = ((attribute as any)?.vo ?? {}) as ColourOptions;

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    if (!attribute || !deviceState) {
        return null;
    }
    const attrs = deviceState.deviceAttributes;
    const red = latestValue(attrs[attribute.n]);
    const green = latestValue(attrs[opts.green ?? 'green']);
    const blue = latestValue(attrs[opts.blue ?? 'blue']);
    if (![red, green, blue].every(Number.isFinite)) {
        return null;
    }
    const clear = opts.clear ? latestValue(attrs[opts.clear]) : NaN;
    const lux = opts.lux ? latestValue(attrs[opts.lux]) : NaN;
    const cct = opts.cct ? latestValue(attrs[opts.cct]) : NaN;

    // The hue: each channel scaled by the largest
    const maxRgb = Math.max(red, green, blue);
    const scale = maxRgb > 0 ? 255 / maxRgb : 0;
    const hex = `#${toHex(red * scale)}${toHex(green * scale)}${toHex(blue * scale)}`;

    // Channel bars, relative to the largest channel shown
    const channels: Array<{ name: string; value: number }> = [
        { name: 'red', value: red },
        { name: 'green', value: green },
        { name: 'blue', value: blue },
    ];
    if (Number.isFinite(clear)) {
        channels.push({ name: 'clear', value: clear });
    }
    const barMax = Math.max(1, ...channels.map(c => c.value));
    const total = red + green + blue;

    return (
        <div className="device-colour">
            <div className="zonegrid-header">
                <span className="zonegrid-title">colour</span>
                <span>{hex}</span>
                {Number.isFinite(lux) && <span>{lux.toFixed(1)} lux</span>}
                {Number.isFinite(cct) && cct > 0 && <span>{Math.round(cct)} K</span>}
            </div>
            <div className="colour-body">
                <div className="colour-swatch" style={{ backgroundColor: maxRgb > 0 ? hex : '#000' }} title={hex} />
                <div className="colour-channels">
                    {channels.map(c => (
                        <div key={c.name} className="colour-channel">
                            <span className="colour-channel-name">{c.name}</span>
                            <div className="colour-channel-bar">
                                <div style={{ width: `${Math.min(100, (100 * c.value) / barMax)}%`, backgroundColor: CHANNEL_COLOURS[c.name] }} />
                            </div>
                            <span className="colour-channel-value">
                                {Math.round(c.value)}
                                {c.name !== 'clear' && total > 0 ? ` (${Math.round((100 * c.value) / total)}%)` : ''}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
});

export default ColourVisualizer;
