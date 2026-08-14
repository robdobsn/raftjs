/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// SpectrumChart
// Real-time bar-chart visualizer for array attributes with element labels (e.g. FFT/octave bands).
// Renders in the chart panel; updates with the panel's chart timer.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { memo } from 'react';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { Bar } from 'react-chartjs-2';
import ConnManager from '../ConnManager';
import { DeviceState } from '../../../../src/RaftDeviceStates';
import { DeviceVisualizerProps } from './VisualizerRegistry';

const connManager = ConnManager.getInstance();

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const SpectrumChart: React.FC<DeviceVisualizerProps> = memo(({ deviceKey, attribute }) => {
    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    const attrState = attribute ? deviceState?.deviceAttributes[attribute.n] : undefined;

    if (!attribute || !attrState) {
        return null;
    }

    const elemsPerSample = attrState.elemsPerSample ?? 1;
    if (elemsPerSample <= 1 || attrState.values.length < elemsPerSample) {
        return null;
    }
    const latestSample = attrState.values.slice(-elemsPerSample).map(v => typeof v === 'number' ? v : NaN);
    const labels = attribute.el ?? latestSample.map((_, i) => String(i));

    const valueUnits = attrState.units || '';
    const elemUnits = attribute.eu || '';

    const data = {
        labels,
        datasets: [
            {
                label: `${attribute.n}${valueUnits ? ` (${valueUnits})` : ''}`,
                data: latestSample,
                backgroundColor: labels.map((_, i) => `hsl(${200 + (i * 120) / labels.length}, 70%, 55%)`),
                borderWidth: 0,
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
            x: {
                title: { display: !!elemUnits, text: elemUnits },
            },
            y: {
                title: { display: !!valueUnits, text: valueUnits },
                grace: '10%',
            },
        },
    };

    return (
        <div className="device-spectrum-chart">
            <Bar data={data} options={options} />
        </div>
    );
});

export default SpectrumChart;
