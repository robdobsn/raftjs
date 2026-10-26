/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// LightSpectrumVisualizer
// Bar chart for a spectral light sensor (e.g. AS7341): an array attribute with one element per band, the element
// labels giving each band's centre wavelength in nm. Each bar is drawn in the colour of its wavelength, like an
// audio spectrum's bars across frequency. Renders in the chart panel; updates with the panel's chart timer.
//
// Options come from the array attribute's "vo" (visualizer options) object in the device type record:
//   extraAttrs   names of other attributes shown as bars after the bands (e.g. ["clear", "nir"]), in grey, or
//                dark red for a near infrared one
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { memo } from 'react';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { Bar } from 'react-chartjs-2';
import ConnManager from '../ConnManager';
import { DeviceState, DeviceAttributeState } from '../../../../src/RaftDeviceStates';
import { DeviceVisualizerProps } from './VisualizerRegistry';

const connManager = ConnManager.getInstance();

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

interface LightSpectrumOptions {
    extraAttrs?: string[];
}

// Latest complete sample of an attribute (all its elements)
function latestSample(attrState: DeviceAttributeState | undefined): number[] {
    if (!attrState) return [];
    const elems = attrState.elemsPerSample ?? 1;
    if (attrState.values.length < elems) return [];
    return attrState.values.slice(-elems).map(v => typeof v === 'number' ? v : NaN);
}

// An approximate display colour for a visible wavelength (380-780 nm): the hue across the spectrum, fading
// towards the ends of the visible range, where the eye is less sensitive
export function wavelengthToColour(nm: number): string {
    let r = 0, g = 0, b = 0;
    if (nm >= 380 && nm < 440) { r = (440 - nm) / 60; b = 1; }
    else if (nm >= 440 && nm < 490) { g = (nm - 440) / 50; b = 1; }
    else if (nm >= 490 && nm < 510) { g = 1; b = (510 - nm) / 20; }
    else if (nm >= 510 && nm < 580) { r = (nm - 510) / 70; g = 1; }
    else if (nm >= 580 && nm < 645) { r = 1; g = (645 - nm) / 65; }
    else if (nm >= 645 && nm <= 780) { r = 1; }
    let fade = 1;
    if (nm < 420) fade = 0.3 + (0.7 * (nm - 380)) / 40;
    else if (nm > 700) fade = 0.3 + (0.7 * (780 - nm)) / 80;
    fade = Math.min(1, Math.max(0.3, fade));
    const c = (v: number) => Math.round(255 * Math.pow(v * fade, 0.8));
    return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

const LightSpectrumVisualizer: React.FC<DeviceVisualizerProps> = memo(({ deviceKey, attribute }) => {
    const opts: LightSpectrumOptions = ((attribute as any)?.vo ?? {}) as LightSpectrumOptions;

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    const attrState = attribute ? deviceState?.deviceAttributes[attribute.n] : undefined;
    if (!attribute || !deviceState || !attrState) {
        return null;
    }
    const bands = latestSample(attrState);
    if (bands.length === 0) {
        return null;
    }
    const elemUnits = attribute.eu ?? '';
    const bandLabels = bands.map((_, i) => attribute.el?.[i] ?? String(i));
    const bandColours = bandLabels.map(l => {
        const nm = parseFloat(l);
        return Number.isFinite(nm) ? wavelengthToColour(nm) : '#90a4ae';
    });

    // Other channels after the bands
    const extras = (opts.extraAttrs ?? [])
        .map(name => ({ name, value: latestSample(deviceState.deviceAttributes[name])[0] }))
        .filter(e => e.value !== undefined);

    const labels = [...bandLabels.map(l => (elemUnits && /^\d/.test(l) ? `${l} ${elemUnits}` : l)), ...extras.map(e => e.name)];
    const values = [...bands, ...extras.map(e => e.value)];
    const colours = [...bandColours, ...extras.map(e => (/nir|ir$/i.test(e.name) ? '#7b1f1f' : '#90a4ae'))];

    // The band with the most light
    let peakIdx = 0;
    bands.forEach((v, i) => { if (v > bands[peakIdx]) peakIdx = i; });
    const valueUnits = attrState.units || '';

    const data = {
        labels,
        datasets: [
            {
                label: `${attribute.n}${valueUnits ? ` (${valueUnits})` : ''}`,
                data: values,
                backgroundColor: colours,
                borderColor: '#444',
                borderWidth: 1,
            },
        ],
    };

    const options = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false as const,
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    label: (ctx: any) => `${ctx.parsed.y}${valueUnits ? ` ${valueUnits}` : ''}`,
                },
            },
        },
        scales: {
            x: { ticks: { color: '#ccc' } },
            y: { ticks: { color: '#ccc' }, beginAtZero: true, grace: '10%' },
        },
    };

    return (
        <div className="device-lightspectrum">
            <div className="zonegrid-header">
                <span className="zonegrid-title">{attribute.n} spectrum</span>
                <span>peak {bandLabels[peakIdx]}{elemUnits ? ` ${elemUnits}` : ''}</span>
            </div>
            <div className="lightspectrum-chart">
                <Bar data={data} options={options} />
            </div>
        </div>
    );
});

export default LightSpectrumVisualizer;
