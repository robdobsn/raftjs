import { RaftCameraFrame, decodeCameraFramePublishMsg } from '../../../src/main';

// Singleton store for the latest camera frame received via the Camera publish
// topic. Frames are pushed in from the connection event listener (Main.tsx)
// and consumed by CameraPanel. Kept outside React state so frame arrival does
// not force re-renders of the whole app.

export interface CameraFeedStats {
  framesReceived: number;
  lastFrameTimeMs: number;
  measuredFps: number;
}

type CameraFeedListener = () => void;

const FPS_WINDOW_MS = 5000;

export default class CameraFeedStore {
  private static _instance: CameraFeedStore;

  private _latestFrame: RaftCameraFrame | null = null;
  private _framesReceived = 0;
  private _lastFrameTimeMs = 0;
  private _frameTimesMs: number[] = [];
  private _listeners = new Set<CameraFeedListener>();

  public static getInstance(): CameraFeedStore {
    if (!CameraFeedStore._instance) {
      CameraFeedStore._instance = new CameraFeedStore();
    }
    return CameraFeedStore._instance;
  }

  // Handle a raw publish message (including transport prefix and envelope).
  // Returns true if the message decoded as a camera frame.
  public handlePublishFrame(payload: Uint8Array): boolean {
    const frame = decodeCameraFramePublishMsg(payload);
    if (!frame) return false;
    this._latestFrame = frame;
    this._framesReceived++;
    const now = Date.now();
    this._lastFrameTimeMs = now;
    this._frameTimesMs.push(now);
    while (this._frameTimesMs.length > 0 && this._frameTimesMs[0] < now - FPS_WINDOW_MS) {
      this._frameTimesMs.shift();
    }
    this._listeners.forEach((cb) => cb());
    return true;
  }

  public subscribe(listener: CameraFeedListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  public getLatestFrame(): RaftCameraFrame | null {
    return this._latestFrame;
  }

  public getStats(): CameraFeedStats {
    const now = Date.now();
    const windowFrames = this._frameTimesMs.filter((t) => t >= now - FPS_WINDOW_MS);
    return {
      framesReceived: this._framesReceived,
      lastFrameTimeMs: this._lastFrameTimeMs,
      measuredFps: windowFrames.length / (FPS_WINDOW_MS / 1000),
    };
  }

  public clear(): void {
    this._latestFrame = null;
    this._framesReceived = 0;
    this._lastFrameTimeMs = 0;
    this._frameTimesMs = [];
    this._listeners.forEach((cb) => cb());
  }
}
