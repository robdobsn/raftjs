import React, { useEffect, useState, useRef } from 'react';
import ConnManager from './ConnManager';
import { LogConfig } from './LogConfigPanel';
import { getHostPosixTZ } from '../../../src/RaftTimezone';
import './styles.css';

// Minimal query-value encoder: only encode characters that break query string parsing.
// Unlike encodeURIComponent (which encodes ~40 chars), this keeps JSON, colons, commas
// etc. as-is, significantly reducing message size for BLE transport.
function encodeQueryValue(s: string): string {
  return s.replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D');
}

const connManager = ConnManager.getInstance();

interface LogStatus {
  isLogging: boolean;
  fileName: string;
  elapsedSecs: number;
  bytesWritten: number;
  samples: number;
  flushCount: number;
  bufferOverflows: number;
  avgWriteMs: number;
  maxWriteMs: number;
  bytesPerSec: number;
}

interface CameraCaptureStatus {
  active: boolean;
  fs: string;
  folder: string;
  intervalMs: number;
  images: number;
  failures: number;
  totalBytes: number;
  lastFilename: string;
}

const emptyStatus: LogStatus = {
  isLogging: false,
  fileName: '',
  elapsedSecs: 0,
  bytesWritten: 0,
  samples: 0,
  flushCount: 0,
  bufferOverflows: 0,
  avgWriteMs: 0,
  maxWriteMs: 0,
  bytesPerSec: 0,
};

interface LoggingPanelProps {
  onLogStopped?: () => void;
  pausePolling?: boolean;
  logConfig?: LogConfig | null;
  cameraAvailable?: boolean;
}

export default function LoggingPanel({ onLogStopped, pausePolling, logConfig, cameraAvailable }: LoggingPanelProps) {
  const [status, setStatus] = useState<LogStatus>(emptyStatus);
  const [cameraStatus, setCameraStatus] = useState<CameraCaptureStatus | null>(null);
  const [label, setLabel] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [lastError, setLastError] = useState('');
  const [cameraWarning, setCameraWarning] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wasLoggingRef = useRef(false);
  const cameraSessionRef = useRef(false);

  // Stop the camera interval-capture session (best-effort)
  const stopCameraCapture = async () => {
    if (!cameraAvailable) return;
    try {
      await connManager.getConnector().sendRICRESTMsg('camera?action=stop', {});
    } catch (e) {
      console.warn('Failed to stop camera capture', e);
    }
    cameraSessionRef.current = false;
  };

  const fetchCameraStatus = async () => {
    if (!cameraAvailable || !connManager.getConnector().isConnected()) return null;
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg('camera?action=status', {});
      const r = resp as any;
      if (r?.rslt === 'ok' && r.capture) {
        const cap = r.capture;
        const capStatus: CameraCaptureStatus = {
          active: cap.active ?? false,
          fs: cap.fs ?? '',
          folder: cap.folder ?? '',
          intervalMs: cap.intervalMs ?? 0,
          images: cap.images ?? 0,
          failures: cap.failures ?? 0,
          totalBytes: cap.totalBytes ?? 0,
          lastFilename: cap.lastFilename ?? '',
        };
        setCameraStatus(capStatus);
        return capStatus;
      }
    } catch (e) {
      console.warn('Failed to fetch camera status', e);
    }
    return null;
  };

  const fetchStatus = async () => {
    if (!connManager.getConnector().isConnected()) return;
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg(
        'datalog?action=status', {}
      );
      if (resp && typeof resp === 'object') {
        const r = resp as any;
        const flushLatency = r.flushLatency ?? {};
        const nowLogging = r.active ?? false;
        setStatus({
          isLogging: nowLogging,
          fileName: r.fileName ?? '',
          elapsedSecs: (r.durationMs ?? 0) / 1000,
          bytesWritten: r.totalBytesWritten ?? 0,
          samples: r.samples ?? 0,
          flushCount: r.flushCount ?? 0,
          bufferOverflows: r.bufferOverflows ?? 0,
          avgWriteMs: (flushLatency.avgUs ?? 0) / 1000,
          maxWriteMs: (flushLatency.maxUs ?? 0) / 1000,
          bytesPerSec: r.bytesPerSec ?? 0,
        });
        // Detect timed logging session that finished on its own
        if (wasLoggingRef.current && !nowLogging) {
          // Also stop a camera capture session started alongside logging
          if (cameraSessionRef.current) {
            stopCameraCapture();
          }
          onLogStopped?.();
        }
        wasLoggingRef.current = nowLogging;
      }
    } catch (e) {
      console.warn('Failed to fetch logging status', e);
    }

    // Poll the camera capture session state (also re-syncs with a session
    // still running on the device after a reconnect)
    if (cameraAvailable) {
      await fetchCameraStatus();
    }
  };

  // Poll status every 2 seconds (paused during file downloads)
  useEffect(() => {
    if (pausePolling) {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      return;
    }
    fetchStatus();
    pollTimerRef.current = setInterval(fetchStatus, 2000);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [pausePolling]);

  const handleStart = async () => {
    setIsBusy(true);
    setLastError('');
    setCameraWarning('');
    try {
      const labelParam = label.trim() ? `&label=${encodeQueryValue(label.trim())}` : '';
      let configParam = '';
      // Strip the dashboard-side camera settings from the config sent to the
      // datalog endpoint (they drive camera?action=start below)
      const cameraConfig = logConfig?.camera;
      if (logConfig && logConfig.devices.length > 0) {
        const { camera: _camera, ...datalogConfig } = logConfig;
        configParam = `&config=${encodeQueryValue(JSON.stringify(datalogConfig))}`;
      }
      // Include current UTC time so firmware can timestamp the log even without NTP
      const utcParam = `&UTC=${encodeQueryValue(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))}`;
      const posixTZ = getHostPosixTZ();
      const tzParam = posixTZ ? `&tz=${encodeQueryValue(posixTZ)}` : '';
      const resp = await connManager.getConnector().sendRICRESTMsg(
        `datalog?action=start${labelParam}${configParam}${utcParam}${tzParam}`, {}
      );
      const r = resp as any;
      if (r?.rslt !== 'ok') {
        setLastError(r?.error || 'Start failed');
      } else if (cameraAvailable && cameraConfig?.enabled) {
        // Start the camera interval-capture session alongside logging.
        // Images go to a per-session folder named after the label (or timestamp).
        const sessionName = (label.trim() ? label.trim() : `log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`)
          .replace(/[^A-Za-z0-9_-]/g, '_');
        const folder = `/images/${sessionName}`;
        // Bound the session so images stop if the timed log ends while disconnected
        const maxImages = (logConfig && logConfig.durationMs > 0 && cameraConfig.intervalMs > 0)
          ? Math.ceil(logConfig.durationMs / cameraConfig.intervalMs) + 1
          : 0;
        const camParams = [
          `fs=${cameraConfig.fs}`,
          `folder=${encodeQueryValue(folder)}`,
          `intervalMs=${cameraConfig.intervalMs}`,
          `maxImages=${maxImages}`,
        ];
        if (cameraConfig.size) camParams.push(`size=${cameraConfig.size}`);
        if (cameraConfig.quality !== undefined) camParams.push(`quality=${cameraConfig.quality}`);
        try {
          // Starting a session with a new frame size can trigger a full camera
          // re-init on the device (several seconds) so use a long timeout
          const camResp = await connManager.getConnector().sendRICRESTMsg(
            `camera?action=start&${camParams.join('&')}`, {}, undefined, 15000
          );
          const cr = camResp as any;
          if (cr?.rslt === 'ok') {
            cameraSessionRef.current = true;
          } else {
            setCameraWarning('Logging started but image capture failed to start');
          }
        } catch (e) {
          setCameraWarning('Logging started but image capture failed to start');
        }
        await fetchCameraStatus();
      }
      await fetchStatus();
    } catch (e) {
      setLastError('Failed to send start command');
    }
    setIsBusy(false);
  };

  const handleStop = async () => {
    setIsBusy(true);
    setLastError('');
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg(
        'datalog?action=stop', {}
      );
      const r = resp as any;
      if (r?.rslt !== 'ok') {
        setLastError(r?.error || 'Stop failed');
      }
      // Stop any camera capture session (started here or still running on the device)
      if (cameraAvailable && (cameraSessionRef.current || cameraStatus?.active)) {
        await stopCameraCapture();
        await fetchCameraStatus();
      }
      await fetchStatus();
      onLogStopped?.();
    } catch (e) {
      setLastError('Failed to send stop command');
    }
    setIsBusy(false);
  };

  const handleSimulate = async () => {
    setIsBusy(true);
    setLastError('');
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg(
        'datalog?action=simulate', {}
      );
      const r = resp as any;
      if (r?.rslt !== 'ok') {
        setLastError(r?.error || 'Simulate failed');
      }
      await fetchStatus();
    } catch (e) {
      setLastError('Failed to send simulate command');
    }
    setIsBusy(false);
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatDuration = (secs: number): string => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  return (
    <div className="info-box logging-panel">
      <h3>Data Logging</h3>

      {status.isLogging ? (
        <>
          <div className="logging-status-active">
            <div className="logging-indicator" />
            <span>Logging Active</span>
          </div>
          <div className="info">
            <div className="info-line">
              <div className="info-label">File:</div>
              <div className="info-value">{status.fileName}</div>
            </div>
            <div className="info-line">
              <div className="info-label">Duration:</div>
              <div className="info-value">{formatDuration(status.elapsedSecs)}</div>
            </div>
            <div className="info-line">
              <div className="info-label">Written:</div>
              <div className="info-value">{formatBytes(status.bytesWritten)}</div>
            </div>
            <div className="info-line">
              <div className="info-label">Writes:</div>
              <div className="info-value">{status.flushCount} flushes, {status.samples} samples (overflows: {status.bufferOverflows})</div>
            </div>
            <div className="info-line">
              <div className="info-label">Write time:</div>
              <div className="info-value">avg {status.avgWriteMs.toFixed(1)}ms, max {status.maxWriteMs.toFixed(1)}ms</div>
            </div>
            {status.bytesPerSec > 0 && (
              <div className="info-line">
                <div className="info-label">Rate:</div>
                <div className="info-value">{formatBytes(status.bytesPerSec)}/s</div>
              </div>
            )}
            {cameraStatus?.active && (
              <>
                <div className="info-line">
                  <div className="info-label">Images:</div>
                  <div className="info-value">
                    {cameraStatus.images} ({formatBytes(cameraStatus.totalBytes)}
                    {cameraStatus.failures > 0 ? `, ${cameraStatus.failures} failed` : ''})
                    {' '}→ {cameraStatus.fs}{cameraStatus.folder}
                  </div>
                </div>
                {cameraStatus.lastFilename && (
                  <div className="info-line">
                    <div className="info-label">Last image:</div>
                    <div className="info-value">{cameraStatus.lastFilename}</div>
                  </div>
                )}
              </>
            )}
          </div>
          <button
            className="action-button logging-stop-button"
            onClick={handleStop}
            disabled={isBusy}
          >
            Stop Logging
          </button>
        </>
      ) : (
        <>
          <div className="logging-start-controls">
            <input
              type="text"
              className="logging-label-input"
              placeholder="Session label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleStart(); }}
            />
            <div className="logging-button-row">
              <button
                className="action-button"
                onClick={handleStart}
                disabled={isBusy || (logConfig !== undefined && (!logConfig || logConfig.devices.length === 0))}
              >
                Start Logging
              </button>
              <button
                className="action-button logging-simulate-button"
                onClick={handleSimulate}
                disabled={isBusy}
              >
                Simulate
              </button>
            </div>
          </div>
        </>
      )}

      {cameraWarning && (
        <div className="logging-warning">{cameraWarning}</div>
      )}

      {lastError && (
        <div className="logging-error">{lastError}</div>
      )}
    </div>
  );
}
