import React, { useEffect, useRef, useState } from 'react';
import ConnManager from './ConnManager';
import { inspectPublishFrame, RaftEventFn } from '../../../src/main';
import './styles.css';

const connManager = ConnManager.getInstance();

// Frame sizes supported by the camera driver (RaftCameraDriver::frameSizeFromName).
const FRAME_SIZES = ['QQVGA', 'QVGA', 'CIF', 'VGA', 'SVGA', 'XGA', 'HD', 'SXGA', 'UXGA'];

// Camera binary publish header (see CameraSysMod::publishGenMsg).
//   [0]      version (==1)
//   [1..4]   image count        (uint32 LE)
//   [5..8]   timestamp ms       (uint32 LE)
//   [9..10]  width              (uint16 LE)
//   [11..12] height             (uint16 LE)
//   [13]     pixel format
//   [14]     jpeg quality
//   [15..18] payload length     (uint32 LE)
//   [19..]   JPEG bytes
const CAMERA_FRAME_VERSION = 1;
const CAMERA_HEADER_LEN = 19;

interface CameraStatus {
  enabled?: boolean;
  ready?: boolean;
  size?: string;
  quality?: number;
  count?: number;
  imageDir?: string;
}

interface CaptureInfo {
  filename: string;
  bytes: number;
  width: number;
  height: number;
  quality: number;
  count: number;
}

interface DecodedFrame {
  count: number;
  timestampMs: number;
  width: number;
  height: number;
  format: number;
  quality: number;
  jpeg: Uint8Array;
}

const readU16LE = (buf: Uint8Array, pos: number): number =>
  buf[pos] | (buf[pos + 1] << 8);

const readU32LE = (buf: Uint8Array, pos: number): number =>
  (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0;

// Decode a publish payload into a camera frame, or null if it isn't one.
// The camera frame is published without a devbin envelope, so it is identified
// by its version byte (1) at the binary payload offset, distinct from devbin
// frames which start 0xDB-0xDF.
function decodeCameraFrame(payload: Uint8Array): DecodedFrame | null {
  const meta = inspectPublishFrame(payload, (idx) =>
    connManager.getConnector().getRaftSystemUtils().getPublishTopicName(idx)
  );
  if (meta.frameType !== 'binary' || meta.binaryHasEnvelope) return null;
  const offset = meta.binaryPayloadOffset;
  if (offset === undefined) return null;
  if (payload.length < offset + CAMERA_HEADER_LEN) return null;
  if (payload[offset] !== CAMERA_FRAME_VERSION) return null;

  const count = readU32LE(payload, offset + 1);
  const timestampMs = readU32LE(payload, offset + 5);
  const width = readU16LE(payload, offset + 9);
  const height = readU16LE(payload, offset + 11);
  const format = payload[offset + 13];
  const quality = payload[offset + 14];
  const payloadLen = readU32LE(payload, offset + 15);

  const jpegStart = offset + CAMERA_HEADER_LEN;
  if (jpegStart + payloadLen > payload.length) return null;

  return {
    count,
    timestampMs,
    width,
    height,
    format,
    quality,
    jpeg: payload.slice(jpegStart, jpegStart + payloadLen),
  };
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

// Strip a leading slash so a filename returned by the firmware (e.g.
// "/images/x.jpg") becomes a "local/images/x.jpg" file-system path.
const toLocalPath = (filename: string): string =>
  `local/${filename.replace(/^\/+/, '')}`;

export default function CameraPanel() {
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [sizeInput, setSizeInput] = useState('');
  const [qualityInput, setQualityInput] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [lastError, setLastError] = useState('');

  // Captured-still preview
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [captureInfo, setCaptureInfo] = useState<CaptureInfo | null>(null);
  const imageUrlRef = useRef<string | null>(null);

  // Gallery
  const [files, setFiles] = useState<{ name: string; size: number }[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);

  // Live preview
  const [previewActive, setPreviewActive] = useState(false);
  const [previewFps, setPreviewFps] = useState(2);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewInfo, setPreviewInfo] = useState<DecodedFrame | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const previewActiveRef = useRef(false);

  // Replace the captured-still image URL, revoking the previous one.
  const setImage = (url: string | null) => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = url;
    setImageUrl(url);
  };

  // Replace the live preview image URL, revoking the previous one.
  const setPreviewImage = (url: string | null) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setPreviewUrl(url);
  };

  const fetchStatus = async () => {
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg('camera?action=status', {});
      const r = resp as any;
      if (r?.rslt === 'ok') {
        setStatus(r);
        if (sizeInput === '' && typeof r.size === 'string') setSizeInput(r.size);
        if (qualityInput === '' && typeof r.quality === 'number') setQualityInput(String(r.quality));
      } else {
        setLastError('Camera not available');
      }
    } catch (e) {
      console.warn('Camera status failed', e);
      setLastError('Failed to get camera status');
    }
  };

  const fetchGallery = async () => {
    if (!connManager.getConnector().isConnected()) return;
    const imageDir = (status?.imageDir || '/images').replace(/^\/+/, '');
    setGalleryLoading(true);
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg(`filelist/local/${imageDir}`, {});
      const fileList = typeof resp === 'string' ? JSON.parse(resp) : (resp as any);
      setFiles(
        (fileList.files || []).sort((a: { name: string }, b: { name: string }) =>
          b.name.localeCompare(a.name)
        )
      );
    } catch (e) {
      console.warn('Failed to get image list', e);
    }
    setGalleryLoading(false);
  };

  // Initial status + gallery on mount
  useEffect(() => {
    fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status) fetchGallery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.imageDir]);

  // Clean up object URLs and the subscription on unmount
  useEffect(() => {
    return () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (previewActiveRef.current) {
        void setCameraSubscription(0);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleApplySettings = async () => {
    setIsBusy(true);
    setLastError('');
    try {
      const params: string[] = [];
      if (sizeInput) params.push(`size=${encodeURIComponent(sizeInput)}`);
      const q = parseInt(qualityInput, 10);
      if (!isNaN(q)) params.push(`quality=${q}`);
      const resp = await connManager
        .getConnector()
        .sendRICRESTMsg(`camera?action=set${params.length ? '&' + params.join('&') : ''}`, {});
      const r = resp as any;
      if (r?.rslt === 'ok') {
        setStatus(r);
      } else {
        setLastError('Failed to apply settings');
      }
    } catch (e) {
      console.warn('Camera set failed', e);
      setLastError('Error applying settings');
    }
    setIsBusy(false);
  };

  const handleCapture = async () => {
    setIsBusy(true);
    setLastError('');
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg('camera?action=capture', {});
      const r = resp as any;
      if (r?.rslt !== 'ok' || !r.filename) {
        setLastError(r?.error || 'Capture failed');
        setIsBusy(false);
        return;
      }
      setCaptureInfo({
        filename: r.filename,
        bytes: r.bytes ?? 0,
        width: r.width ?? 0,
        height: r.height ?? 0,
        quality: r.quality ?? 0,
        count: r.count ?? 0,
      });
      // Download the freshly captured image and display it
      const result = await connManager
        .getConnector()
        .fsGetContents(toLocalPath(r.filename), 'fs', undefined);
      if (result.downloadedOk && result.fileData) {
        const blob = new Blob([result.fileData], { type: 'image/jpeg' });
        setImage(URL.createObjectURL(blob));
      } else {
        setLastError('Captured but failed to download image');
      }
      await fetchStatus();
      await fetchGallery();
    } catch (e) {
      console.warn('Capture failed', e);
      setLastError('Error capturing image');
    }
    setIsBusy(false);
  };

  const handleViewFile = async (file: { name: string; size: number }) => {
    setLastError('');
    try {
      const imageDir = (status?.imageDir || '/images').replace(/^\/+/, '');
      const result = await connManager
        .getConnector()
        .fsGetContents(`local/${imageDir}/${file.name}`, 'fs', undefined);
      if (result.downloadedOk && result.fileData) {
        const blob = new Blob([result.fileData], { type: 'image/jpeg' });
        setImage(URL.createObjectURL(blob));
        setCaptureInfo({
          filename: file.name,
          bytes: file.size,
          width: 0,
          height: 0,
          quality: 0,
          count: 0,
        });
      } else {
        setLastError(`Failed to download ${file.name}`);
      }
    } catch (e) {
      console.warn('View failed', e);
      setLastError(`Error viewing ${file.name}`);
    }
  };

  const handleDownloadCurrent = () => {
    if (!imageUrlRef.current || !captureInfo) return;
    const a = document.createElement('a');
    a.href = imageUrlRef.current;
    a.download = captureInfo.filename.replace(/^.*\//, '') || 'camera.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDeleteFile = async (file: { name: string; size: number }) => {
    if (!window.confirm(`Delete ${file.name} (${formatBytes(file.size)})?`)) return;
    setLastError('');
    try {
      const imageDir = (status?.imageDir || '/images').replace(/^\/+/, '');
      const resp = await connManager
        .getConnector()
        .sendRICRESTMsg(`filedelete/local/${imageDir}/${file.name}`, {});
      const r = resp as any;
      if (r?.rslt === 'ok') {
        await fetchGallery();
      } else {
        setLastError(`Failed to delete ${file.name}`);
      }
    } catch (e) {
      console.warn('Delete failed', e);
      setLastError(`Error deleting ${file.name}`);
    }
  };

  // Send (or clear, with rateHz 0) a subscription for the Camera publish topic.
  const setCameraSubscription = async (rateHz: number) => {
    const topic = (status as any)?.publishTopic || 'Camera';
    const sub =
      '{"cmdName":"subscription","action":"update","pubRecs":[' +
      (rateHz > 0
        ? `{"name":"${topic}","trigger":"timeorchange","rateHz":${rateHz},"minMs":50}`
        : `{"name":"${topic}","rateHz":0}`) +
      ']}';
    await connManager.getConnector().getRaftSystemUtils().getMsgHandler().sendRICRESTCmdFrame(sub);
  };

  // Live preview: subscribe to the Camera topic and render decoded frames
  useEffect(() => {
    if (!previewActive) return;

    const listener: RaftEventFn = (eventType, _eventEnum, _eventName, data) => {
      if (eventType !== 'pub' || !data || typeof data !== 'object') return;
      const payload = (data as { payload?: Uint8Array }).payload;
      if (!payload) return;
      const frame = decodeCameraFrame(payload);
      if (!frame) return;
      const blob = new Blob([frame.jpeg], { type: 'image/jpeg' });
      setPreviewImage(URL.createObjectURL(blob));
      setPreviewInfo(frame);
    };

    const removeListener = connManager.addEventListener(listener);
    previewActiveRef.current = true;
    setCameraSubscription(previewFps).catch((e) => {
      console.warn('Camera subscribe failed', e);
      setLastError('Failed to start preview');
    });

    return () => {
      removeListener();
      previewActiveRef.current = false;
      setCameraSubscription(0).catch(() => {
        /* best-effort unsubscribe */
      });
      setPreviewImage(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewActive, previewFps]);

  return (
    <div className="info-box camera-panel">
      <div className="camera-header">
        <h3>Camera</h3>
        <button
          className="camera-refresh-button"
          onClick={() => {
            fetchStatus();
            fetchGallery();
          }}
          title="Refresh"
        >
          ↻
        </button>
      </div>

      {/* Status */}
      <div className="info camera-status">
        <div className="info-line">
          <span className="info-label">Ready</span>
          <span className="info-value">{status?.ready ? 'yes' : 'no'}</span>
        </div>
        <div className="info-line">
          <span className="info-label">Size</span>
          <span className="info-value">{status?.size ?? '-'}</span>
        </div>
        <div className="info-line">
          <span className="info-label">Quality</span>
          <span className="info-value">{status?.quality ?? '-'}</span>
        </div>
        <div className="info-line">
          <span className="info-label">Captured</span>
          <span className="info-value">{status?.count ?? 0}</span>
        </div>
      </div>

      {/* Settings */}
      <div className="camera-settings">
        <label>
          Size
          <select value={sizeInput} onChange={(e) => setSizeInput(e.target.value)}>
            {FRAME_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quality
          <input
            type="number"
            min={0}
            max={63}
            value={qualityInput}
            onChange={(e) => setQualityInput(e.target.value)}
          />
        </label>
        <button className="action-button" onClick={handleApplySettings} disabled={isBusy}>
          Apply
        </button>
      </div>

      {/* Capture + live preview controls */}
      <div className="camera-controls">
        <button className="action-button" onClick={handleCapture} disabled={isBusy}>
          {isBusy ? 'Working...' : 'Capture Still'}
        </button>
        <button
          className="action-button"
          onClick={() => setPreviewActive((a) => !a)}
          disabled={!status?.ready}
        >
          {previewActive ? 'Stop Preview' : 'Start Preview'}
        </button>
        {previewActive && (
          <label className="camera-fps">
            FPS
            <input
              type="number"
              min={1}
              max={30}
              value={previewFps}
              onChange={(e) => setPreviewFps(Math.max(1, parseInt(e.target.value, 10) || 1))}
            />
          </label>
        )}
      </div>

      {/* Live preview image */}
      {previewActive && (
        <div className="camera-image-container">
          {previewUrl ? (
            <img src={previewUrl} alt="Live preview" className="camera-image" />
          ) : (
            <div className="camera-image-placeholder">Waiting for frames...</div>
          )}
          {previewInfo && (
            <div className="camera-caption">
              live {previewInfo.width}×{previewInfo.height} · frame {previewInfo.count}
            </div>
          )}
        </div>
      )}

      {/* Captured still image */}
      {!previewActive && imageUrl && (
        <div className="camera-image-container">
          <img src={imageUrl} alt="Captured" className="camera-image" />
          {captureInfo && (
            <div className="camera-caption">
              {captureInfo.filename}
              {captureInfo.width > 0 && ` · ${captureInfo.width}×${captureInfo.height}`}
              {captureInfo.bytes > 0 && ` · ${formatBytes(captureInfo.bytes)}`}
            </div>
          )}
          <button className="action-button" onClick={handleDownloadCurrent}>
            Download
          </button>
        </div>
      )}

      {/* Gallery */}
      <div className="camera-gallery">
        <div className="camera-gallery-header">
          <span>Images</span>
          <button className="camera-refresh-button" onClick={fetchGallery} title="Refresh images">
            ↻
          </button>
        </div>
        {galleryLoading ? (
          <div className="camera-gallery-empty">Loading...</div>
        ) : files.length === 0 ? (
          <div className="camera-gallery-empty">No images found</div>
        ) : (
          <div className="camera-gallery-list">
            {files.map((file) => (
              <div key={file.name} className="camera-gallery-item">
                <div className="camera-gallery-name" title={file.name}>
                  {file.name}
                </div>
                <div className="camera-gallery-size">{formatBytes(file.size)}</div>
                <div className="camera-gallery-actions">
                  <button
                    className="camera-gallery-button"
                    onClick={() => handleViewFile(file)}
                    title={`View ${file.name}`}
                  >
                    👁
                  </button>
                  <button
                    className="camera-gallery-button"
                    onClick={() => handleDeleteFile(file)}
                    title={`Delete ${file.name}`}
                  >
                    🗑
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {lastError && <div className="logging-error">{lastError}</div>}
    </div>
  );
}
