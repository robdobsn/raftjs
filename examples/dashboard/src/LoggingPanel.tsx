import React, { useEffect, useState, useRef } from 'react';
import ConnManager from './ConnManager';
import { LogConfig } from './LogConfigPanel';
import { getHostPosixTZ } from '../../../src/RaftTimezone';
import './styles.css';

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
}

export default function LoggingPanel({ onLogStopped, pausePolling, logConfig }: LoggingPanelProps) {
  const [status, setStatus] = useState<LogStatus>(emptyStatus);
  const [label, setLabel] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [lastError, setLastError] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wasLoggingRef = useRef(false);

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
          onLogStopped?.();
        }
        wasLoggingRef.current = nowLogging;
      }
    } catch (e) {
      console.warn('Failed to fetch logging status', e);
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
    try {
      const labelParam = label.trim() ? `&label=${encodeURIComponent(label.trim())}` : '';
      let configParam = '';
      if (logConfig && logConfig.devices.length > 0) {
        configParam = `&config=${encodeURIComponent(JSON.stringify(logConfig))}`;
      }
      // Include current UTC time so firmware can timestamp the log even without NTP
      const utcParam = `&UTC=${encodeURIComponent(new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z'))}`;
      const posixTZ = getHostPosixTZ();
      const tzParam = posixTZ ? `&tz=${encodeURIComponent(posixTZ)}` : '';
      const resp = await connManager.getConnector().sendRICRESTMsg(
        `datalog?action=start${labelParam}${configParam}${utcParam}${tzParam}`, {}
      );
      const r = resp as any;
      if (r?.rslt !== 'ok') {
        setLastError(r?.error || 'Start failed');
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

      {lastError && (
        <div className="logging-error">{lastError}</div>
      )}
    </div>
  );
}
