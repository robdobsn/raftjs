import React, { useEffect, useState } from 'react';
import ConnManager from './ConnManager';
import { DeviceOnlineState, DeviceState, DevicesState } from '../../../src/RaftDeviceStates';
import './styles.css';

const connManager = ConnManager.getInstance();

// Rate presets: label + milliseconds
const RATE_PRESETS = [
  { label: 'Max (poll rate)', ms: 0 },
  { label: '10 Hz', ms: 100 },
  { label: '1 Hz', ms: 1000 },
  { label: '0.1 Hz (10s)', ms: 10000 },
  { label: '1/min', ms: 60000 },
  { label: '1/10min', ms: 600000 },
  { label: '1/hour', ms: 3600000 },
  { label: '1/day', ms: 86400000 },
];

// Log-scale slider range: 0ms (every poll) to 360000000ms (100 hours)
const LOG_RATE_MIN_MS = 50;      // ~20Hz - slider minimum (meaningful minimum)
const LOG_RATE_MAX_MS = 360000000; // 100 hours

function msToSliderValue(ms: number): number {
  if (ms <= 0) return 0;
  const minLog = Math.log10(LOG_RATE_MIN_MS);
  const maxLog = Math.log10(LOG_RATE_MAX_MS);
  const val = (Math.log10(Math.max(ms, LOG_RATE_MIN_MS)) - minLog) / (maxLog - minLog);
  return Math.min(1, Math.max(0, val));
}

function sliderValueToMs(val: number): number {
  if (val <= 0) return 0;
  const minLog = Math.log10(LOG_RATE_MIN_MS);
  const maxLog = Math.log10(LOG_RATE_MAX_MS);
  return Math.round(Math.pow(10, minLog + val * (maxLog - minLog)));
}

function formatRateMs(ms: number): string {
  if (ms <= 0) return 'Max (every poll)';
  if (ms < 1000) return `${ms} ms (${(1000 / ms).toFixed(1)} Hz)`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s (${(1000 / ms).toFixed(2)} Hz)`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)} min`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)} hr`;
  return `${(ms / 86400000).toFixed(1)} days`;
}

interface DeviceLogEntry {
  enabled: boolean;
  busName: string;
  addr: string;       // hex without 0x prefix
  typeName: string;
  rateMs: number;      // 0 = every poll
  pollIntervalMs: number; // device's actual poll interval for display
}

export interface LogConfig {
  devices: Array<{
    bus: string;
    addr: string;
    mode: string;
    rateMs: number;
  }>;
}

interface LogConfigPanelProps {
  onConfigChanged?: (config: LogConfig | null) => void;
  disabled?: boolean;
}

export default function LogConfigPanel({ onConfigChanged, disabled }: LogConfigPanelProps) {
  const [deviceEntries, setDeviceEntries] = useState<DeviceLogEntry[]>([]);
  const [lastUpdated, setLastUpdated] = useState(0);

  // Refresh device list from device manager
  const refreshDeviceList = () => {
    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    if (!deviceManager) return;

    const devicesState: DevicesState = deviceManager.getDevicesState();
    const entries: DeviceLogEntry[] = [];

    for (const [deviceKey, devState] of Object.entries(devicesState)) {
      if (deviceKey === 'getDeviceKey') continue;
      const ds = devState as DeviceState;
      if (ds.onlineState !== DeviceOnlineState.Online) continue; // only online devices
      if (ds.busName === '0') continue; // skip non-bus (direct-connected) devices

      // Get poll interval from device type info
      let pollIntervalMs = 50; // default
      if (ds.deviceTypeInfo?.resp?.us) {
        pollIntervalMs = ds.deviceTypeInfo.resp.us / 1000;
      }

      // Check if already in entries (preserve user's enabled/rate settings)
      const existing = deviceEntries.find(
        e => e.busName === ds.busName && e.addr === ds.deviceAddress
      );

      entries.push({
        enabled: existing?.enabled ?? true,
        busName: ds.busName,
        addr: ds.deviceAddress,
        typeName: ds.deviceTypeInfo?.name ?? ds.deviceType ?? 'Unknown',
        rateMs: existing?.rateMs ?? 10000,
        pollIntervalMs,
      });
    }

    setDeviceEntries(entries);
  };

  // Listen for device changes
  useEffect(() => {
    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    if (!deviceManager) return;

    const onNewDevice = () => setLastUpdated(Date.now());
    const onDeviceRemoved = () => setLastUpdated(Date.now());
    deviceManager.addNewDeviceCallback(onNewDevice);
    deviceManager.addDeviceRemovedCallback(onDeviceRemoved);

    refreshDeviceList();

    return () => {
      deviceManager.removeNewDeviceCallback(onNewDevice);
      deviceManager.removeDeviceRemovedCallback(onDeviceRemoved);
    };
  }, []);

  // Refresh when devices change
  useEffect(() => {
    refreshDeviceList();
  }, [lastUpdated]);

  // Notify parent of config changes
  useEffect(() => {
    const enabledDevices = deviceEntries.filter(d => d.enabled);
    if (enabledDevices.length === 0) {
      onConfigChanged?.(null);
      return;
    }

    const config: LogConfig = {
      devices: enabledDevices.map(d => ({
        bus: d.busName,
        addr: `0x${d.addr}`,
        mode: 'poll',
        rateMs: d.rateMs,
      })),
    };
    onConfigChanged?.(config);
  }, [deviceEntries]);

  const toggleDevice = (index: number) => {
    setDeviceEntries(prev => {
      const next = [...prev];
      next[index] = { ...next[index], enabled: !next[index].enabled };
      return next;
    });
  };

  const setRate = (index: number, rateMs: number) => {
    setDeviceEntries(prev => {
      const next = [...prev];
      next[index] = { ...next[index], rateMs };
      return next;
    });
  };

  const selectAll = () => {
    setDeviceEntries(prev => prev.map(d => ({ ...d, enabled: true })));
  };

  const selectNone = () => {
    setDeviceEntries(prev => prev.map(d => ({ ...d, enabled: false })));
  };

  if (deviceEntries.length === 0) {
    return (
      <div className="info-box log-config-panel">
        <h3>Log Device Selection</h3>
        <p className="log-config-empty">No devices connected</p>
      </div>
    );
  }

  return (
    <div className="info-box log-config-panel">
      <h3>Log Device Selection</h3>

      <div className="log-config-select-buttons">
        <button className="log-config-select-btn" onClick={selectAll} disabled={disabled}>All</button>
        <button className="log-config-select-btn" onClick={selectNone} disabled={disabled}>None</button>
      </div>

      <div className="log-config-device-list">
        {deviceEntries.map((entry, idx) => (
          <div key={`${entry.busName}_${entry.addr}`} className={`log-config-device ${entry.enabled ? '' : 'log-config-device-disabled'}`}>
            <div className="log-config-device-header">
              <label className="log-config-checkbox-label">
                <input
                  type="checkbox"
                  checked={entry.enabled}
                  onChange={() => toggleDevice(idx)}
                  disabled={disabled}
                />
                <span className="log-config-device-name">{entry.typeName}</span>
              </label>
              <span className="log-config-device-addr">
                Bus {entry.busName} · 0x{entry.addr}
              </span>
            </div>

            {entry.enabled && (
              <div className="log-config-rate-control">
                <div className="log-config-rate-row">
                  <label className="log-config-rate-label">Log rate:</label>
                  <select
                    className="log-config-rate-preset"
                    value={RATE_PRESETS.find(p => p.ms === entry.rateMs) ? entry.rateMs : 'custom'}
                    onChange={e => {
                      const val = e.target.value;
                      if (val !== 'custom') setRate(idx, parseInt(val, 10));
                    }}
                    disabled={disabled}
                  >
                    {RATE_PRESETS.map(p => (
                      <option key={p.ms} value={p.ms}>{p.label}</option>
                    ))}
                    {!RATE_PRESETS.find(p => p.ms === entry.rateMs) && (
                      <option value="custom">Custom</option>
                    )}
                  </select>
                </div>

                <div className="log-config-slider-row">
                  <span className="log-config-slider-label">Fast</span>
                  <input
                    type="range"
                    className="log-config-slider"
                    min="0"
                    max="1"
                    step="0.005"
                    value={msToSliderValue(entry.rateMs)}
                    onChange={e => {
                      const ms = sliderValueToMs(parseFloat(e.target.value));
                      setRate(idx, ms);
                    }}
                    disabled={disabled}
                  />
                  <span className="log-config-slider-label">Slow</span>
                </div>

                <div className="log-config-rate-display">
                  {formatRateMs(entry.rateMs)}
                  {entry.pollIntervalMs > 0 && entry.rateMs === 0 && (
                    <span className="log-config-poll-rate"> · poll: {(1000 / entry.pollIntervalMs).toFixed(1)} Hz</span>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
