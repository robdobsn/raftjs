import {
  decodeCameraFrame,
  decodeCameraFramePublishMsg,
  RAFT_CAMERA_FRAME_HEADER_LEN,
} from './RaftCameraFrame';

// Build a camera header + JPEG payload
function buildCameraFrame(opts?: {
  version?: number;
  imageCount?: number;
  timestampMs?: number;
  width?: number;
  height?: number;
  pixelFormat?: number;
  jpegQuality?: number;
  jpegData?: Uint8Array;
  payloadLenOverride?: number;
}): Uint8Array {
  const jpegData = opts?.jpegData ?? new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);
  const payloadLen = opts?.payloadLenOverride ?? jpegData.length;
  const buf = new Uint8Array(RAFT_CAMERA_FRAME_HEADER_LEN + jpegData.length);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, opts?.version ?? 1);
  dv.setUint32(1, opts?.imageCount ?? 42, true);
  dv.setUint32(5, opts?.timestampMs ?? 123456789, true);
  dv.setUint16(9, opts?.width ?? 320, true);
  dv.setUint16(11, opts?.height ?? 240, true);
  dv.setUint8(13, opts?.pixelFormat ?? 4);
  dv.setUint8(14, opts?.jpegQuality ?? 15);
  dv.setUint32(15, payloadLen, true);
  buf.set(jpegData, RAFT_CAMERA_FRAME_HEADER_LEN);
  return buf;
}

// Wrap a camera frame in the transport msgType prefix and (optionally) the publish envelope
function buildPublishMsg(cameraFrame: Uint8Array, withEnvelope: boolean, topicIndex = 2, seqNum = 7): Uint8Array {
  const prefix = new Uint8Array([0x00, 0x80]);
  const envelope = withEnvelope ? new Uint8Array([0xdb, topicIndex, seqNum]) : new Uint8Array(0);
  const msg = new Uint8Array(prefix.length + envelope.length + cameraFrame.length);
  msg.set(prefix, 0);
  msg.set(envelope, prefix.length);
  msg.set(cameraFrame, prefix.length + envelope.length);
  return msg;
}

describe('decodeCameraFrame', () => {
  it('decodes a valid frame', () => {
    const jpegData = new Uint8Array([0xff, 0xd8, 0x11, 0x22, 0x33, 0xff, 0xd9]);
    const buf = buildCameraFrame({ imageCount: 99, timestampMs: 55555, width: 640, height: 480, jpegQuality: 12, jpegData });
    const frame = decodeCameraFrame(buf);
    expect(frame).not.toBeNull();
    expect(frame!.version).toBe(1);
    expect(frame!.imageCount).toBe(99);
    expect(frame!.timestampMs).toBe(55555);
    expect(frame!.width).toBe(640);
    expect(frame!.height).toBe(480);
    expect(frame!.pixelFormat).toBe(4);
    expect(frame!.jpegQuality).toBe(12);
    expect(Array.from(frame!.jpegData)).toEqual(Array.from(jpegData));
  });

  it('decodes at a non-zero offset', () => {
    const inner = buildCameraFrame();
    const buf = new Uint8Array(5 + inner.length);
    buf.set(inner, 5);
    const frame = decodeCameraFrame(buf, 5);
    expect(frame).not.toBeNull();
    expect(frame!.imageCount).toBe(42);
  });

  it('rejects a truncated header', () => {
    const buf = buildCameraFrame().slice(0, RAFT_CAMERA_FRAME_HEADER_LEN - 1);
    expect(decodeCameraFrame(buf)).toBeNull();
  });

  it('rejects an unknown version', () => {
    const buf = buildCameraFrame({ version: 2 });
    expect(decodeCameraFrame(buf)).toBeNull();
  });

  it('rejects a frame with truncated JPEG data', () => {
    const buf = buildCameraFrame({ payloadLenOverride: 1000 });
    expect(decodeCameraFrame(buf)).toBeNull();
  });
});

describe('decodeCameraFramePublishMsg', () => {
  it('decodes a publish message with the binary publish envelope', () => {
    const msg = buildPublishMsg(buildCameraFrame({ imageCount: 7 }), true);
    const frame = decodeCameraFramePublishMsg(msg);
    expect(frame).not.toBeNull();
    expect(frame!.imageCount).toBe(7);
    expect(frame!.width).toBe(320);
    expect(frame!.height).toBe(240);
  });

  it('decodes a publish message without an envelope (legacy)', () => {
    const msg = buildPublishMsg(buildCameraFrame({ imageCount: 8 }), false);
    const frame = decodeCameraFramePublishMsg(msg);
    expect(frame).not.toBeNull();
    expect(frame!.imageCount).toBe(8);
  });

  it('rejects a message that is too short', () => {
    expect(decodeCameraFramePublishMsg(new Uint8Array([0x00, 0x80]))).toBeNull();
    expect(decodeCameraFramePublishMsg(new Uint8Array(0))).toBeNull();
  });

  it('rejects a devbin-style message that is not a camera frame', () => {
    // Envelope followed by devbin-style records (first byte after envelope is not version 1)
    const msg = new Uint8Array([0x00, 0x80, 0xdb, 0x01, 0x07, 0x00, 0x18, 0x81, 0x00, 0x00]);
    expect(decodeCameraFramePublishMsg(msg)).toBeNull();
  });
});
