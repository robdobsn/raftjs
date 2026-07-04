import React, { useEffect, useRef, useState } from 'react';
import ConnManager from './ConnManager';
import CameraFeedStore from './CameraFeedStore';
import { RaftCameraFrame } from '../../../src/main';
import './styles.css';

const connManager = ConnManager.getInstance();
const cameraFeedStore = CameraFeedStore.getInstance();

// Frame size names supported by the RaftCamera driver
const FRAME_SIZES = [
  '96X96', 'QQVGA', 'QCIF', 'HQVGA', '240X240', 'QVGA', 'CIF', 'HVGA',
  'VGA', 'SVGA', 'XGA', 'HD', 'SXGA', 'UXGA',
];

// Live view rate options (Hz)
const LIVE_RATES = [0.5, 1, 2, 5, 10];

// Maximum sustainable live-view rate (Hz) by frame size. Larger frames take
// longer to capture and send, so cap the requested rate to avoid overloading
// the device and the WiFi link.
const MAX_RATE_BY_SIZE: Record<string, number> = {
  '96X96': 10, QQVGA: 10, QCIF: 10, HQVGA: 10, '240X240': 10, QVGA: 10,
  CIF: 5, HVGA: 5, VGA: 5, SVGA: 2, XGA: 2, HD: 1, SXGA: 1, UXGA: 0.5,
};

function maxRateForSize(size: string): number {
  return MAX_RATE_BY_SIZE[size] ?? 2;
}

export interface CameraStatus {
  enabled: boolean;
  ready: boolean;
  size: string;
  quality: number;
  count: number;
  imageDir: string;
  fileSystem: string;
  publishTopic: string;
}

interface CameraPanelProps {
  onSnapshotTaken?: () => void;
}

export default function CameraPanel({ onSnapshotTaken }: CameraPanelProps) {
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [liveRateHz, setLiveRateHz] = useState(
    connManager.getConnector().getConnMethod() === 'WebSocket' ? 2 : 1
  );
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [frameMeta, setFrameMeta] = useState<RaftCameraFrame | null>(null);
  const [measuredFps, setMeasuredFps] = useState(0);
  const [selSize, setSelSize] = useState('');
  const [selQuality, setSelQuality] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [lastMsg, setLastMsg] = useState('');
  const [lastError, setLastError] = useState('');
  const imageUrlRef = useRef<string | null>(null);
  const liveEnabledRef = useRef(false);

  const fetchStatus = async () => {
    if (!connManager.getConnector().isConnected()) return;
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg('camera?action=status', {});
      const r = resp as any;
      if (r?.rslt === 'ok') {
        setStatus({
          enabled: r.enabled ?? false,
          ready: r.ready ?? false,
          size: r.size ?? '',
          quality: r.quality ?? 0,
          count: r.count ?? 0,
          imageDir: r.imageDir ?? '/images',
          fileSystem: r.fileSystem ?? 'local',
          publishTopic: r.publishTopic ?? 'Camera',
        });
      }
    } catch (e) {
      console.warn('Failed to fetch camera status', e);
    }
  };

  // Send a subscription update for the camera publish topic
  const setCameraSubscription = async (rateHz: number) => {
    try {
      const systemUtils = connManager.getConnector().getRaftSystemUtils();
      const topic = status?.publishTopic || 'Camera';
      const cmd = '{"cmdName":"subscription","action":"update",' +
        '"pubRecs":[' +
        `{"name":"${topic}","trigger":"timeorchange","rateHz":${rateHz}}` +
        ']}';
      await systemUtils.getMsgHandler().sendRICRESTCmdFrame(cmd);
      if (rateHz > 0) {
        // Ensure the topic index->name map includes the camera topic
        await systemUtils.refreshPublishTopicMap();
      }
    } catch (e) {
      console.warn('Failed to update camera subscription', e);
      setLastError('Failed to update camera subscription');
    }
  };

  // Initial status fetch
  useEffect(() => {
    fetchStatus();
  }, []);

  // Clamp the live-view rate to the maximum sustainable for the current
  // resolution (larger frames take longer to capture/send)
  useEffect(() => {
    if (!status) return;
    const maxRate = maxRateForSize(status.size);
    if (liveRateHz > maxRate) {
      setLiveRateHz(maxRate);
      if (liveEnabled) {
        setCameraSubscription(maxRate);
      }
    }
  }, [status?.size]);

  // Track live-enabled state for unmount cleanup
  useEffect(() => {
    liveEnabledRef.current = liveEnabled;
  }, [liveEnabled]);

  // Subscribe to the camera feed store for new frames
  useEffect(() => {
    const unsubscribe = cameraFeedStore.subscribe(() => {
      const frame = cameraFeedStore.getLatestFrame();
      if (!frame) {
        setFrameMeta(null);
        if (imageUrlRef.current) {
          URL.revokeObjectURL(imageUrlRef.current);
          imageUrlRef.current = null;
        }
        setImageUrl(null);
        return;
      }
      const jpegCopy = new Uint8Array(frame.jpegData);
      const blob = new Blob([jpegCopy.buffer as ArrayBuffer], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = url;
      setImageUrl(url);
      setFrameMeta(frame);
      setMeasuredFps(cameraFeedStore.getStats().measuredFps);
    });
    return () => {
      unsubscribe();
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
        imageUrlRef.current = null;
      }
    };
  }, []);

  // Unsubscribe from the device topic on unmount if live view is on
  useEffect(() => {
    return () => {
      if (liveEnabledRef.current && connManager.getConnector().isConnected()) {
        setCameraSubscription(0);
      }
    };
  }, []);

  const handleLiveToggle = async () => {
    const enable = !liveEnabled;
    setLiveEnabled(enable);
    setLastError('');
    await setCameraSubscription(enable ? liveRateHz : 0);
  };

  const handleRateChange = async (rateHz: number) => {
    setLiveRateHz(rateHz);
    if (liveEnabled) {
      await setCameraSubscription(rateHz);
    }
  };

  const handleApplySettings = async () => {
    if (!selSize && !selQuality) return;
    setIsBusy(true);
    setLastError('');
    try {
      const params: string[] = [];
      if (selSize) params.push(`size=${selSize}`);
      if (selQuality) params.push(`quality=${selQuality}`);
      // Changing frame size can trigger a full camera re-init on the device
      // (several seconds) so use a long response timeout to avoid retry storms
      const resp = await connManager.getConnector().sendRICRESTMsg(
        `camera?action=set&${params.join('&')}`, {}, undefined, 15000
      );
      const r = resp as any;
      if (r?.rslt !== 'ok') {
        setLastError('Failed to apply camera settings');
      }
      await fetchStatus();
    } catch (e) {
      setLastError('Failed to apply camera settings');
    }
    setIsBusy(false);
  };

  const handleSnapshot = async () => {
    setIsBusy(true);
    setLastMsg('');
    setLastError('');
    try {
      // Large frame sizes can take several seconds to capture and write
      const resp = await connManager.getConnector().sendRICRESTMsg('camera?action=capture', {}, undefined, 15000);
      const r = resp as any;
      if (r?.rslt === 'ok') {
        setLastMsg(`Saved ${r.filename ?? ''} (${r.bytes ?? 0} bytes, ${r.width ?? 0}x${r.height ?? 0})`);
        onSnapshotTaken?.();
      } else {
        setLastError('Snapshot failed');
      }
      await fetchStatus();
    } catch (e) {
      setLastError('Snapshot failed');
    }
    setIsBusy(false);
  };

  if (!status) {
    return (
      <div className="info-box camera-panel">
        <h3>Camera</h3>
        <p className="camera-panel-note">Checking camera...</p>
      </div>
    );
  }

  if (!status.ready) {
    return (
      <div className="info-box camera-panel">
        <h3>Camera</h3>
        <p className="camera-panel-note">Camera present but not ready</p>
      </div>
    );
  }

  return (
    <div className="info-box camera-panel">
      <h3>Camera</h3>

      <div className="camera-controls-row">
        <button
          className={`action-button ${liveEnabled ? 'camera-live-active' : ''}`}
          onClick={handleLiveToggle}
        >
          {liveEnabled ? 'Stop Live View' : 'Start Live View'}
        </button>
        <label className="camera-rate-label">
          Rate:
          <select
            className="camera-select"
            value={liveRateHz}
            onChange={(e) => handleRateChange(parseFloat(e.target.value))}
          >
            {LIVE_RATES.map((r) => (
              <option key={r} value={r} disabled={r > maxRateForSize(status.size)}>
                {r} Hz{r > maxRateForSize(status.size) ? ' (too fast for size)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          className="action-button"
          onClick={handleSnapshot}
          disabled={isBusy}
          title="Capture a still image to the device filesystem"
        >
          Snapshot
        </button>
      </div>

      {liveEnabled && (
        <div className="camera-live-view">
          {imageUrl ? (
            <img className="camera-live-img" src={imageUrl} alt="Camera live view" />
          ) : (
            <div className="camera-live-waiting">Waiting for frames...</div>
          )}
          {frameMeta && (
            <div className="camera-frame-meta">
              {frameMeta.width}x{frameMeta.height} · q{frameMeta.jpegQuality} ·
              {' '}{(frameMeta.jpegData.length / 1024).toFixed(1)} KB ·
              {' '}#{frameMeta.imageCount} · {measuredFps.toFixed(1)} fps
            </div>
          )}
        </div>
      )}

      <div className="camera-controls-row camera-settings-row">
        <label className="camera-rate-label">
          Size:
          <select
            className="camera-select"
            value={selSize}
            onChange={(e) => setSelSize(e.target.value)}
          >
            <option value="">{`Current (${status.size})`}</option>
            {FRAME_SIZES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="camera-rate-label">
          Quality:
          <input
            className="camera-quality-input"
            type="number"
            min="0"
            max="63"
            placeholder={`${status.quality}`}
            value={selQuality}
            onChange={(e) => setSelQuality(e.target.value)}
          />
        </label>
        <button
          className="action-button"
          onClick={handleApplySettings}
          disabled={isBusy || (!selSize && !selQuality)}
        >
          Apply
        </button>
      </div>

      <div className="camera-info-line">
        Images captured: {status.count} · Default storage: {status.fileSystem}{status.imageDir}
      </div>

      {lastMsg && <div className="camera-panel-note">{lastMsg}</div>}
      {lastError && <div className="logging-error">{lastError}</div>}
    </div>
  );
}
