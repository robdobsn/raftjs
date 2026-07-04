import React, { useEffect, useState } from 'react';
import ConnManager from './ConnManager';
import { DeviceOnlineState, DeviceState, DevicesState } from '../../../src/RaftDeviceStates';
import DeviceSelectDialog, { DeviceLogEntry } from './DeviceSelectDialog';
import './styles.css';

const connManager = ConnManager.getInstance();

// Duration presets: label + milliseconds (0 = unlimited)
const DURATION_PRESETS = [
  { label: '1 min', ms: 60000 },
  { label: '5 min', ms: 300000 },
  { label: '10 min', ms: 600000 },
  { label: '30 min', ms: 1800000 },
  { label: '1 hour', ms: 3600000 },
  { label: '6 hours', ms: 21600000 },
  { label: '24 hours', ms: 86400000 },
  { label: 'Unlimited', ms: 0 },
];

// Duration slider range (log scale): 1 min to 7 days
const DUR_MIN_MS = 60000;
const DUR_MAX_MS = 604800000;

function durationToSlider(ms: number): number {
  if (ms <= 0) return 1; // unlimited = max
  const minLog = Math.log10(DUR_MIN_MS);
  const maxLog = Math.log10(DUR_MAX_MS);
  return Math.min(1, Math.max(0, (Math.log10(Math.max(ms, DUR_MIN_MS)) - minLog) / (maxLog - minLog)));
}

function sliderToDuration(val: number): number {
  if (val >= 0.99) return 0; // unlimited
  const minLog = Math.log10(DUR_MIN_MS);
  const maxLog = Math.log10(DUR_MAX_MS);
  return Math.round(Math.pow(10, minLog + val * (maxLog - minLog)));
}

function formatDurationLabel(ms: number): string {
  if (ms <= 0) return 'Unlimited';
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)} min`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)} hr`;
  return `${(ms / 86400000).toFixed(1)} days`;
}

export interface CameraLogConfig {
  enabled: boolean;
  intervalMs: number;   // capture interval in ms
  fs: string;           // 'local' or 'sd'
  size?: string;        // frame size name (undefined = device current)
  quality?: number;     // JPEG quality 0-63 (undefined = device current)
}

export interface LogConfig {
  format: string;       // "csv" or "jsonl"
  csvHeader?: boolean;  // include metadata comment block in CSV
  durationMs: number;   // logging duration in ms (0 = unlimited)
  devices: Array<{
    bus: string;
    addr: string;
    rateMs: number;
    attrs?: string[];
  }>;
  // Camera image capture settings (dashboard-side only - stripped from the
  // config sent to the datalog endpoint and used for camera?action=start)
  camera?: CameraLogConfig;
}

// Image capture interval presets
const IMAGE_INTERVAL_PRESETS = [
  { label: '10 sec', ms: 10000 },
  { label: '30 sec', ms: 30000 },
  { label: '1 min', ms: 60000 },
  { label: '5 min', ms: 300000 },
  { label: '15 min', ms: 900000 },
  { label: '1 hour', ms: 3600000 },
];

// Frame size names supported by the RaftCamera driver
const CAMERA_FRAME_SIZES = [
  '96X96', 'QQVGA', 'QCIF', 'HQVGA', '240X240', 'QVGA', 'CIF', 'HVGA',
  'VGA', 'SVGA', 'XGA', 'HD', 'SXGA', 'UXGA',
];

interface LogConfigPanelProps {
  onConfigChanged?: (config: LogConfig | null) => void;
  disabled?: boolean;
  cameraAvailable?: boolean;
}

export default function LogConfigPanel({ onConfigChanged, disabled, cameraAvailable }: LogConfigPanelProps) {
  const [deviceEntries, setDeviceEntries] = useState<DeviceLogEntry[]>([]);
  const [lastUpdated, setLastUpdated] = useState(0);
  const [format, setFormat] = useState<'csv' | 'jsonl'>('csv');
  const [csvHeader, setCsvHeader] = useState(true);
  const [durationMs, setDurationMs] = useState(600000); // 10 minutes default
  const [fsFreeBytes, setFsFreeBytes] = useState<number | null>(null);
  const [camEnabled, setCamEnabled] = useState(true);
  const [camIntervalMs, setCamIntervalMs] = useState(60000);
  const [camFs, setCamFs] = useState('sd');
  const [camSize, setCamSize] = useState('');
  const [camQuality, setCamQuality] = useState('');

  // Fetch filesystem info from device
  const fetchFsInfo = async () => {
    if (!connManager.getConnector().isConnected()) return;
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg('filelist/local', {});
      if (resp && typeof resp === 'object') {
        const r = resp as any;
        const size = r.diskSize ?? 0;
        const used = r.diskUsed ?? 0;
        if (size > 0) setFsFreeBytes(size - used);
      }
    } catch (e) {
      // ignore
    }
  };

  // Estimate bytes per minute based on current config
  const estimateBytesPerMin = (): number => {
    const enabledDevices = deviceEntries.filter(d => d.enabled);
    if (enabledDevices.length === 0) return 0;

    let totalBytesPerMin = 0;
    for (const d of enabledDevices) {
      // Effective rate: if 0 (max poll rate), use pollIntervalMs
      const effectiveRateMs = d.rateMs > 0 ? d.rateMs : d.pollIntervalMs;
      if (effectiveRateMs <= 0) continue;
      const samplesPerMin = 60000 / effectiveRateMs;

      // Estimate row size based on format
      const numAttrs = d.selectedAttrs.length > 0 ? d.selectedAttrs.length : d.availableAttrs.length;
      let bytesPerSample: number;
      if (format === 'csv') {
        // time field (~8 chars) + comma + ~8 chars per attr value + commas for other devices
        bytesPerSample = 10 + numAttrs * 9 + enabledDevices.length * 2;
      } else {
        // JSONL: ~60 overhead + ~2 per raw byte (hex) * ~2 bytes per attr
        bytesPerSample = 60 + numAttrs * 4;
      }
      totalBytesPerMin += samplesPerMin * bytesPerSample;
    }
    return totalBytesPerMin;
  };

  const bytesPerMin = estimateBytesPerMin();
  const kbPerMin = bytesPerMin / 1024;
  const maxDurationSecs = fsFreeBytes !== null && bytesPerMin > 0
    ? (fsFreeBytes / bytesPerMin) * 60
    : null;

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

      // Extract available attribute names from devInfoJson
      const availableAttrs: string[] = [];
      if (ds.deviceTypeInfo?.resp?.a) {
        for (const attr of ds.deviceTypeInfo.resp.a) {
          if (attr.n) availableAttrs.push(attr.n);
        }
      }

      entries.push({
        enabled: existing?.enabled ?? true,
        busName: ds.busName,
        addr: ds.deviceAddress,
        typeName: ds.deviceTypeInfo?.name ?? ds.deviceType ?? 'Unknown',
        rateMs: existing?.rateMs ?? 10000,
        pollIntervalMs,
        availableAttrs,
        selectedAttrs: existing?.selectedAttrs ?? [],
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
    fetchFsInfo();
  }, [lastUpdated]);

  // Notify parent of config changes
  useEffect(() => {
    const enabledDevices = deviceEntries.filter(d => d.enabled);
    if (enabledDevices.length === 0) {
      onConfigChanged?.(null);
      return;
    }

    const config: LogConfig = {
      format,
      csvHeader: format === 'csv' ? csvHeader : undefined,
      durationMs,
      devices: enabledDevices.map(d => {
        const entry: LogConfig['devices'][0] = {
          bus: d.busName,
          addr: d.addr,
          rateMs: d.rateMs,
        };
        if (format === 'csv' && d.selectedAttrs.length > 0) {
          entry.attrs = d.selectedAttrs;
        }
        return entry;
      }),
    };
    if (cameraAvailable) {
      config.camera = {
        enabled: camEnabled,
        intervalMs: camIntervalMs,
        fs: camFs,
        size: camSize || undefined,
        quality: camQuality !== '' ? parseInt(camQuality, 10) : undefined,
      };
    }
    onConfigChanged?.(config);
  }, [deviceEntries, format, csvHeader, durationMs, cameraAvailable, camEnabled, camIntervalMs, camFs, camSize, camQuality]);

  const [showDeviceDialog, setShowDeviceDialog] = useState(false);

  const handleDeviceSave = (entries: DeviceLogEntry[]) => {
    setDeviceEntries(entries);
    setShowDeviceDialog(false);
  };

  // Build a short summary of what is being logged
  const buildSummary = (): string => {
    const enabled = deviceEntries.filter(d => d.enabled);
    if (enabled.length === 0) return 'No devices selected';
    return enabled.map(d => {
      const attrInfo = d.selectedAttrs.length === 0
        ? 'all attrs'
        : `${d.selectedAttrs.length}/${d.availableAttrs.length} attrs`;
      return `${d.typeName} (0x${d.addr}) — ${attrInfo}`;
    }).join('\n');
  };

  if (deviceEntries.length === 0) {
    return (
      <div className="info-box log-config-panel">
        <h3>Logging Settings</h3>
        <p className="log-config-empty">No devices connected</p>
      </div>
    );
  }

  return (
    <div className="info-box log-config-panel">
      <h3>Logging Settings</h3>

      <div className="log-config-format-row">
        <label className="log-config-rate-label">Format:</label>
        <select
          className="log-config-mode-select"
          value={format}
          onChange={e => setFormat(e.target.value as 'csv' | 'jsonl')}
          disabled={disabled}
        >
          <option value="csv">CSV (decoded)</option>
          <option value="jsonl">JSONL (raw polls)</option>
        </select>
        {format === 'csv' && (
          <label className="log-config-csv-header-label">
            <input
              type="checkbox"
              checked={csvHeader}
              onChange={e => setCsvHeader(e.target.checked)}
              disabled={disabled}
            />
            Include metadata
          </label>
        )}
      </div>

      <div className="log-config-duration-row">
        <label className="log-config-rate-label">Duration:</label>
        <select
          className="log-config-mode-select"
          value={DURATION_PRESETS.find(p => p.ms === durationMs) ? durationMs : 'custom'}
          onChange={e => {
            const val = e.target.value;
            if (val !== 'custom') setDurationMs(parseInt(val, 10));
          }}
          disabled={disabled}
        >
          {DURATION_PRESETS.map(p => (
            <option key={p.ms} value={p.ms}>{p.label}</option>
          ))}
          {!DURATION_PRESETS.find(p => p.ms === durationMs) && (
            <option value="custom">Custom</option>
          )}
        </select>
      </div>

      <div className="log-config-duration-slider-row">
        <span className="log-config-slider-label">Short</span>
        <input
          type="range"
          className="log-config-slider"
          min="0"
          max="1"
          step="0.005"
          value={durationToSlider(durationMs)}
          onChange={e => {
            const ms = sliderToDuration(parseFloat(e.target.value));
            setDurationMs(ms);
          }}
          disabled={disabled}
        />
        <span className="log-config-slider-label">Long</span>
      </div>

      <div className="log-config-duration-display">
        {formatDurationLabel(durationMs)}
      </div>

      {bytesPerMin > 0 && (
        <div className="log-config-estimates">
          <span>~{kbPerMin < 1 ? `${(kbPerMin * 1024).toFixed(0)} B/min` : kbPerMin < 1024 ? `${kbPerMin.toFixed(1)} KB/min` : `${(kbPerMin / 1024).toFixed(2)} MB/min`}</span>
          {maxDurationSecs !== null && (
            <span className="log-config-max-duration">
              · Max: {formatDurationLabel(maxDurationSecs * 1000)} ({fsFreeBytes !== null ? `${(fsFreeBytes / 1024).toFixed(0)} KB free` : ''})
            </span>
          )}
        </div>
      )}

      <div className="log-config-devices-summary">
        <div className="log-config-summary-header">
          <span className="log-config-rate-label">Devices:</span>
          <button
            className="log-config-edit-btn"
            onClick={() => setShowDeviceDialog(true)}
            disabled={disabled}
          >
            Edit…
          </button>
        </div>
        <div className="log-config-summary-text">
          {buildSummary().split('\n').map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </div>

      {cameraAvailable && (
        <div className="log-config-camera-section">
          <label className="log-config-csv-header-label">
            <input
              type="checkbox"
              checked={camEnabled}
              onChange={e => setCamEnabled(e.target.checked)}
              disabled={disabled}
            />
            Capture images during logging
          </label>
          {camEnabled && (
            <>
              <div className="log-config-format-row">
                <label className="log-config-rate-label">Every:</label>
                <select
                  className="log-config-mode-select"
                  value={camIntervalMs}
                  onChange={e => setCamIntervalMs(parseInt(e.target.value, 10))}
                  disabled={disabled}
                >
                  {IMAGE_INTERVAL_PRESETS.map(p => (
                    <option key={p.ms} value={p.ms}>{p.label}</option>
                  ))}
                </select>
                <label className="log-config-rate-label">To:</label>
                <select
                  className="log-config-mode-select"
                  value={camFs}
                  onChange={e => setCamFs(e.target.value)}
                  disabled={disabled}
                >
                  <option value="sd">SD card</option>
                  <option value="local">Local (LittleFS)</option>
                </select>
              </div>
              <div className="log-config-format-row">
                <label className="log-config-rate-label">Size:</label>
                <select
                  className="log-config-mode-select"
                  value={camSize}
                  onChange={e => setCamSize(e.target.value)}
                  disabled={disabled}
                >
                  <option value="">Device default</option>
                  {CAMERA_FRAME_SIZES.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <label className="log-config-rate-label">Quality:</label>
                <input
                  className="log-config-quality-input"
                  type="number"
                  min="0"
                  max="63"
                  placeholder="default"
                  value={camQuality}
                  onChange={e => setCamQuality(e.target.value)}
                  disabled={disabled}
                />
              </div>
            </>
          )}
        </div>
      )}

      {showDeviceDialog && (
        <DeviceSelectDialog
          entries={deviceEntries}
          format={format}
          onSave={handleDeviceSave}
          onCancel={() => setShowDeviceDialog(false)}
        />
      )}
    </div>
  );
}
