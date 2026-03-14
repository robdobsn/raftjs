import React, { useEffect, useState, memo, useRef } from "react";
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Legend } from 'chart.js';
import { Line } from "react-chartjs-2";
import ConnManager from "./ConnManager";
import { DeviceState } from "../../../src/RaftDeviceStates";
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

const DeviceLineChart: React.FC<DeviceLineChartProps> = memo(({ deviceKey, lastUpdated }) => {

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
        animation: {
            duration: 1, // default is 1000ms
        },
        scales: chartScales
    };

    const colourMapRef = useRef<{ [key: string]: string }>({
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
    });

    useEffect(() => {
        if (!deviceState) return;

        const labels = deviceState.deviceTimeline.timestampsUs.slice(-maxChartDataPoints).map(time => {
            const seconds = time / 1e6; // Convert microseconds to seconds
            return seconds.toFixed(3); // Format decimal places
        });

        const uniqueAxes = new Map<string, { range: [number, number], units: string }>();
        const datasets = Object.entries(deviceState.deviceAttributes)
            .filter(([attributeName, attributeDetails]) => {
                if (attributeDetails.visibleSeries === false) return false;
                // Exclude string-valued attributes from chart
                if (attributeDetails.values.length > 0 && typeof attributeDetails.values[attributeDetails.values.length - 1] === 'string') return false;
                return true;
            })
            .map(([attributeName, attributeDetails]) => {
                const data = attributeDetails.values.slice(-maxChartDataPoints);
                let colour = colourMapRef.current[attributeName];
                if (!colour) {
                    colour = `hsl(${Math.random() * 360}, 70%, 60%)`;
                    colourMapRef.current[attributeName] = colour;
                }

                // Ensure range has a minimum width if all values are the same
                const minVal = Math.min(...attributeDetails.range);
                const maxVal = Math.max(...attributeDetails.range);
                const rangeEnds: [number, number] = minVal === maxVal
                    ? [minVal - 1, maxVal + 1]
                    : [minVal, maxVal];

                const axisKey = `${rangeEnds[0]}-${rangeEnds[1]}-${attributeDetails.units}`;
                if (!uniqueAxes.has(axisKey)) {
                    uniqueAxes.set(axisKey, { range: rangeEnds, units: attributeDetails.units });
                }

                return {
                    label: attributeName,
                    data: data,
                    fill: false,
                    borderColor: colour,
                    backgroundColor: colour,
                    yAxisID: axisKey
                };
            });

        const scales: { [key: string]: any } = {};
        uniqueAxes.forEach((axis, key) => {
            scales[key] = {
                type: 'linear',
                display: true,
                position: 'left',
                ticks: {
                    min: axis.range[0],
                    max: axis.range[1],
                    callback: (value: number) => {
                        if (typeof value === 'number' && Math.abs(value) > 0 && Math.abs(value) < 1) {
                            return value.toPrecision(2);
                        }
                        return value;
                    },
                },
            };
        });

        // Update options and chart data
        setChartScales(scales);
        setChartData({ labels: labels.length ? labels : ['0.000'], datasets });
    }, [lastUpdated]);

    if (!deviceState || Object.keys(deviceState.deviceAttributes).length === 0) {
        return <></>;
    }

    return (
        <div className="device-line-chart">
            <Line data={chartData} options={options} />
        </div>
    );
});

export default DeviceLineChart;
