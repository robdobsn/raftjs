import React, { useEffect, useState, memo, useRef, useMemo } from "react";
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Legend } from 'chart.js';
import { Line } from "react-chartjs-2";
import ConnManager from "./ConnManager";
import { DeviceState, deviceAttrValueLabel } from "../../../src/RaftDeviceStates";
import SettingsManager from "./SettingsManager";

const connManager = ConnManager.getInstance();

ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    ArcElement,
    Tooltip,
    Legend
);

export interface DeviceLineChartProps {
    deviceKey: string;
    lastUpdated: number;
    // Restrict the chart to these attributes (used when splitting into multiple charts)
    attrNames?: string[];
}

interface ChartJSData {
    labels: string[];
    datasets: {
        label: string;
        data: number[];
        fill: boolean;
        borderColor: string;
        backgroundColor: string;
        yAxisID: string;
    }[];
}

// Preferred trace colours for common attribute names (used unless too close to another trace's colour in the chart)
const PREFERRED_COLOURS: { [attrName: string]: string } = {
    prox: "hsl(60, 70%, 60%)",
    als: "hsl(0, 70%, 60%)",
    white: "hsl(120, 70%, 60%)",
    x: "hsl(240, 70%, 60%)",
    y: "hsl(300, 70%, 60%)",
    z: "hsl(0, 70%, 60%)",
    ax: "hsl(230, 70%, 60%)",
    ay: "hsl(323, 69.60%, 60.00%)",
    az: "hsl(64, 69.60%, 60.00%)",
    gx: "hsl(275, 70%, 60%)",
    gy: "hsl(352, 69.60%, 60.00%)",
    gz: "hsl(88, 69.60%, 60.00%)",
    dist: "hsl(60, 70%, 60%)",
    temperature: "hsl(360, 70%, 60%)",
    humidity: "hsl(200, 70%, 60%)",
    Red: "hsl(0, 70%, 60%)",
    Green: "hsl(120, 70%, 60%)",
    Blue: "hsl(240, 70%, 60%)",
    ir0: "hsl(300, 70%, 60%)",
    ir1: "hsl(278, 69.60%, 60.00%)",
    ir2: "hsl(7, 69.60%, 60.00%)",
    amb0: "hsl(231, 25.50%, 90.00%)",
    battV: "hsl(194, 69.60%, 60.00%)",
    powerBtn: "hsl(256, 69.60%, 60.00%)",
    USB: "hsl(71, 69.60%, 60.00%)",
    powerMan: "hsl(0, 69.60%, 60.00%)",
    powerBtnLvl: "hsl(120, 69.60%, 60.00%)",
    angle: "hsl(240, 69.60%, 60.00%)",
    current: "hsl(300, 69.60%, 60.00%)",
    state: "hsl(60, 69.60%, 60.00%)",
    velocity: "hsl(120, 69.60%, 60.00%)",
};

// Well separated hues used when an attribute has no preferred colour or it is too close to another trace's colour
const PALETTE_HUES = [210, 30, 120, 0, 280, 55, 180, 330, 90, 250];
const MIN_HUE_SEPARATION = 30;

// Height reserved above the chart area for the colour blocks over the y axes
const AXIS_SWATCH_SPACE = 22;

function colourHue(colour: string): number | undefined {
    const match = /^hsl\(\s*([\d.]+)/.exec(colour);
    return match ? parseFloat(match[1]) % 360 : undefined;
}

function hueDistance(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
}

// Choose a colour for a trace which is clearly different from the colours already used in the chart
function pickTraceColour(preferred: string | undefined, usedColours: string[]): string {
    const usedHues = usedColours.map(colourHue).filter((h): h is number => h !== undefined);
    const minDistance = (hue: number) => usedHues.reduce((m, used) => Math.min(m, hueDistance(hue, used)), 360);
    if (preferred) {
        const hue = colourHue(preferred);
        if (hue === undefined || minDistance(hue) >= MIN_HUE_SEPARATION) return preferred;
    }
    const hue = PALETTE_HUES.find(h => minDistance(h) >= MIN_HUE_SEPARATION)
        ?? PALETTE_HUES.reduce((best, h) => minDistance(h) > minDistance(best) ? h : best);
    return `hsl(${hue}, 70%, 60%)`;
}

const DeviceLineChart: React.FC<DeviceLineChartProps> = memo(({ deviceKey, lastUpdated, attrNames }) => {

    const settingsManager = SettingsManager.getInstance();
    const maxChartDataPoints = settingsManager.getSetting('maxChartDataPoints');

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    // const { deviceAttributes, deviceTimeline } = deviceState;
    const [chartData, setChartData] = useState<ChartJSData>({
        labels: [],
        datasets: []
    });

    const [chartScales, setChartScales] = useState<{ [key: string]: any }>({});

    const options = {
        responsive: true,
        maintainAspectRatio: false,
        // Animation disabled: with live-updating data, Chart.js animations schedule continuous
        // requestAnimationFrame canvas redraws (even at duration 1) that surface as long
        // scheduler tasks. Updates are already paced by the panel's ~500ms chart timer.
        animation: false as const,
        scales: chartScales,
        plugins: {
            tooltip: {
                callbacks: {
                    // Show an attribute's value label or bit labels (vl/bl) beside the value
                    label: (ctx: any) => {
                        const attrState = deviceState?.deviceAttributes[ctx.dataset.label];
                        const valueLabel = attrState ? deviceAttrValueLabel(ctx.parsed.y, attrState) : null;
                        return `${ctx.dataset.label}: ${ctx.formattedValue}${valueLabel !== null ? ` (${valueLabel})` : ''}`;
                    },
                },
            },
        },
    };

    // Colour of each attribute's trace (kept once assigned) and the colours of the traces on each y axis
    const assignedColoursRef = useRef<{ [attrName: string]: string }>({});
    const axisColoursRef = useRef<{ [axisKey: string]: string[] }>({});

    // Draws a colour block above each y axis showing the colours of the traces using it
    const axisSwatchPlugin = useMemo(() => ({
        id: 'axisSwatches',
        beforeLayout(chart: any) {
            // Make room for the colour blocks between the legend and the chart area
            const legend = chart.legend;
            if (!legend || legend._axisSwatchSpace) return;
            const fit = legend.fit;
            legend.fit = function (...args: any[]) {
                fit.apply(this, args);
                this.height += AXIS_SWATCH_SPACE;
            };
            legend._axisSwatchSpace = true;
        },
        afterDraw(chart: any) {
            const ctx = chart.ctx;
            Object.values(chart.scales).forEach((scale: any) => {
                const colours = axisColoursRef.current[scale.id];
                if (!colours || colours.length === 0) return;
                const totalWidth = Math.min(scale.width - 6, 24 * colours.length);
                const segWidth = totalWidth / colours.length;
                const x0 = scale.left + (scale.width - totalWidth) / 2;
                const y = scale.top - AXIS_SWATCH_SPACE + 2;
                ctx.save();
                colours.forEach((colour, i) => {
                    ctx.fillStyle = colour;
                    ctx.fillRect(x0 + i * segWidth, y, Math.max(segWidth - 2, 2), 8);
                });
                ctx.restore();
            });
        },
    }), []);

    useEffect(() => {
        if (!deviceState) return;

        const labels = deviceState.deviceTimeline.timestampsUs.slice(-maxChartDataPoints).map(time => {
            const seconds = time / 1e6; // Convert microseconds to seconds
            return seconds.toFixed(3); // Format decimal places
        });

        const uniqueAxes = new Map<string, { range: [number, number], units: string, colours: string[] }>();
        const datasets = Object.entries(deviceState.deviceAttributes)
            .filter(([attributeName, attributeDetails]) => {
                if (attrNames && !attrNames.includes(attributeName)) return false;
                if (attributeDetails.visibleSeries === false) return false;
                // Array attributes (multiple values per sample) don't fit a timeline trace
                if ((attributeDetails.elemsPerSample ?? 1) > 1) return false;
                // Exclude string-valued attributes from chart
                if (attributeDetails.values.length > 0 && typeof attributeDetails.values[attributeDetails.values.length - 1] === 'string') return false;
                return true;
            })
            .map(([attributeName, attributeDetails]) => {
                // Any non-numeric value is shown as a gap
                const data = attributeDetails.values.slice(-maxChartDataPoints).map(v => typeof v === 'number' ? v : NaN);
                const assignedColours = assignedColoursRef.current;
                let colour = assignedColours[attributeName];
                if (!colour) {
                    colour = pickTraceColour(PREFERRED_COLOURS[attributeName], Object.values(assignedColours));
                    assignedColours[attributeName] = colour;
                }

                // Ensure range has a minimum width if all values are the same
                const minVal = Math.min(...attributeDetails.range);
                const maxVal = Math.max(...attributeDetails.range);
                const rangeEnds: [number, number] = minVal === maxVal
                    ? [minVal - 1, maxVal + 1]
                    : [minVal, maxVal];

                const axisKey = `${rangeEnds[0]}-${rangeEnds[1]}-${attributeDetails.units}`;
                if (!uniqueAxes.has(axisKey)) {
                    uniqueAxes.set(axisKey, { range: rangeEnds, units: attributeDetails.units, colours: [] });
                }
                uniqueAxes.get(axisKey)!.colours.push(colour);

                return {
                    label: attributeName,
                    data: data,
                    fill: false,
                    borderColor: colour,
                    backgroundColor: colour,
                    yAxisID: axisKey
                };
            });

        // Left axes are placed outwards from the chart area in the order given, so add them in reverse
        // to have them read left to right in the same order as the legend
        const scales: { [key: string]: any } = {};
        const axisColours: { [axisKey: string]: string[] } = {};
        Array.from(uniqueAxes.entries()).reverse().forEach(([key, axis]) => {
            axisColours[key] = axis.colours;
            scales[key] = {
                type: 'linear',
                display: true,
                position: 'left',
                ticks: {
                    min: axis.range[0],
                    max: axis.range[1],
                    callback: (value: number) => {
                        if (typeof value !== 'number') return value;
                        if (value === 0) return '0';
                        const abs = Math.abs(value);
                        if (abs < 1) return Number(value.toPrecision(2)).toString();
                        return Number(value.toPrecision(6)).toString();
                    },
                },
            };
        });

        // Update options and chart data
        axisColoursRef.current = axisColours;
        setChartScales(scales);
        setChartData({ labels: labels.length ? labels : ['0.000'], datasets });
    }, [lastUpdated]);

    if (!deviceState || Object.keys(deviceState.deviceAttributes).length === 0) {
        return <></>;
    }

    return (
        <div className="device-line-chart">
            <Line data={chartData} options={options} plugins={[axisSwatchPlugin]} />
        </div>
    );
});

export default DeviceLineChart;
