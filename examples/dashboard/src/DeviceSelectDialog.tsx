import React, { useState } from 'react';
import './styles.css';

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

// Log-scale slider range
const LOG_RATE_MIN_MS = 50;
const LOG_RATE_MAX_MS = 360000000;

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

export interface DeviceLogEntry {
  enabled: boolean;
  busName: string;
  addr: string;
  typeName: string;
  rateMs: number;
  pollIntervalMs: number;
  availableAttrs: string[];
  selectedAttrs: string[];
}

interface DeviceSelectDialogProps {
  entries: DeviceLogEntry[];
  format: string;
  onSave: (entries: DeviceLogEntry[]) => void;
  onCancel: () => void;
}

export default function DeviceSelectDialog({ entries, format, onSave, onCancel }: DeviceSelectDialogProps) {
  const [localEntries, setLocalEntries] = useState<DeviceLogEntry[]>(
    entries.map(e => ({ ...e, selectedAttrs: [...e.selectedAttrs] }))
  );

  const toggleDevice = (index: number) => {
    setLocalEntries(prev => {
      const next = [...prev];
      next[index] = { ...next[index], enabled: !next[index].enabled };
      return next;
    });
  };

  const setRate = (index: number, rateMs: number) => {
    setLocalEntries(prev => {
      const next = [...prev];
      next[index] = { ...next[index], rateMs };
      return next;
    });
  };

  const selectAll = () => {
    setLocalEntries(prev => prev.map(d => ({ ...d, enabled: true })));
  };

  const selectNone = () => {
    setLocalEntries(prev => prev.map(d => ({ ...d, enabled: false })));
  };

  const toggleAttr = (deviceIndex: number, attrName: string) => {
    setLocalEntries(prev => {
      const next = [...prev];
      const entry = { ...next[deviceIndex] };
      const selected = [...entry.selectedAttrs];
      const idx = selected.indexOf(attrName);
      if (idx >= 0) {
        selected.splice(idx, 1);
      } else {
        selected.push(attrName);
      }
      entry.selectedAttrs = selected;
      next[deviceIndex] = entry;
      return next;
    });
  };

  return (
    <div className="dev-select-overlay" onClick={onCancel}>
      <div className="dev-select-dialog" onClick={e => e.stopPropagation()}>
        <h3 className="dev-select-title">Select Devices &amp; Attributes</h3>

        <div className="log-config-select-buttons">
          <button className="log-config-select-btn" onClick={selectAll}>All</button>
          <button className="log-config-select-btn" onClick={selectNone}>None</button>
        </div>

        <div className="dev-select-list">
          {localEntries.map((entry, idx) => (
            <div key={`${entry.busName}_${entry.addr}`} className={`log-config-device ${entry.enabled ? '' : 'log-config-device-disabled'}`}>
              <div className="log-config-device-header">
                <label className="log-config-checkbox-label">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={() => toggleDevice(idx)}
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
                    />
                    <span className="log-config-slider-label">Slow</span>
                  </div>

                  <div className="log-config-rate-display">
                    {formatRateMs(entry.rateMs)}
                    {entry.pollIntervalMs > 0 && entry.rateMs === 0 && (
                      <span className="log-config-poll-rate"> · poll: {(1000 / entry.pollIntervalMs).toFixed(1)} Hz</span>
                    )}
                  </div>

                  {format === 'csv' && entry.availableAttrs.length > 0 && (
                    <div className="log-config-attrs">
                      <div className="log-config-attrs-label">
                        Attributes {entry.selectedAttrs.length === 0 ? '(all)' : `(${entry.selectedAttrs.length}/${entry.availableAttrs.length})`}:
                      </div>
                      <div className="log-config-attrs-list">
                        {entry.availableAttrs.map(attrName => (
                          <label key={attrName} className="log-config-attr-checkbox">
                            <input
                              type="checkbox"
                              checked={entry.selectedAttrs.length === 0 || entry.selectedAttrs.includes(attrName)}
                              onChange={() => {
                                if (entry.selectedAttrs.length === 0) {
                                  setLocalEntries(prev => {
                                    const next = [...prev];
                                    const e = { ...next[idx] };
                                    e.selectedAttrs = entry.availableAttrs.filter(a => a !== attrName);
                                    next[idx] = e;
                                    return next;
                                  });
                                } else {
                                  toggleAttr(idx, attrName);
                                }
                              }}
                            />
                            {attrName}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="dev-select-buttons">
          <button className="dev-select-btn dev-select-btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="dev-select-btn dev-select-btn-save" onClick={() => onSave(localEntries)}>OK</button>
        </div>
      </div>
    </div>
  );
}
