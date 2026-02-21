import React from 'react';
import ConnManager from './ConnManager';
import './styles.css';

const connManager = ConnManager.getInstance();

export interface DeviceStatsPanelProps {
    deviceKey: string;
    lastUpdated: number;
}

const DeviceStatsPanel: React.FC<DeviceStatsPanelProps> = ({ deviceKey, lastUpdated }: DeviceStatsPanelProps) => {
    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const stats = deviceManager?.getDeviceStats(deviceKey);

    if (!stats) {
        return <></>;
    }

    const windowSeconds = stats.windowMs / 1000;
    const sampleRateHz = Number.isFinite(stats.sampleRateHz) ? stats.sampleRateHz : 0;
    const nowMs = lastUpdated || Date.now();
    const lastSampleAgeSec = stats.lastSampleTimeMs
        ? (nowMs - stats.lastSampleTimeMs) / 1000
        : null;

    const handleReset = () => {
        deviceManager?.resetDeviceStats(deviceKey);
    };

    return (
        <div className="device-stats-panel">
            <div className="device-stats-header">
                <span>Sampling Stats</span>
                <button className="device-stats-reset" onClick={handleReset}>Reset Samples</button>
            </div>
            <div className="device-stats-grid">
                <div className="device-stats-item">
                    <div className="device-stats-label">Sample Rate</div>
                    <div className="device-stats-value">{sampleRateHz.toFixed(2)} Hz</div>
                </div>
                <div className="device-stats-item">
                    <div className="device-stats-label">Window</div>
                    <div className="device-stats-value">{windowSeconds.toFixed(1)} s</div>
                </div>
                <div className="device-stats-item">
                    <div className="device-stats-label">Window Samples</div>
                    <div className="device-stats-value">{stats.windowSamples}</div>
                </div>
                <div className="device-stats-item">
                    <div className="device-stats-label">Total Samples</div>
                    <div className="device-stats-value">{stats.totalSamples}</div>
                </div>
                <div className="device-stats-item">
                    <div className="device-stats-label">Last Sample</div>
                    <div className="device-stats-value">
                        {lastSampleAgeSec === null ? 'N/A' : `${lastSampleAgeSec.toFixed(1)} s ago`}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DeviceStatsPanel;
