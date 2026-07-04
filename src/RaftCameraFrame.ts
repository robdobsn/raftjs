/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftCameraFrame
// Decoder for binary camera frames published by the RaftCamera library (Camera SysMod)
// Part of RaftJS
//
// Rob Dobson 2026
// (C) 2020-2026 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// A published camera frame message has the following layout (after the 2-byte
// transport msgType prefix):
//
//   Byte  0    : envelope magic+version  (0xDB - same binary publish envelope as devbin)
//   Byte  1    : topicIndex              (0x00-0xFE; 0xFF = no topic)
//   Byte  2    : envelopeSeqNum          (uint8, wrapping - detects dropped frames)
//   Byte  3    : camera header version   (1)
//   Bytes 4-7  : image count             (uint32 LE)
//   Bytes 8-11 : timestamp ms            (uint32 LE, device millis)
//   Bytes 12-13: width                   (uint16 LE)
//   Bytes 14-15: height                  (uint16 LE)
//   Byte  16   : pixel format            (esp32-camera pixformat_t; 4 = JPEG)
//   Byte  17   : JPEG quality            (0-63, lower = higher quality)
//   Bytes 18-21: payload length          (uint32 LE, number of JPEG bytes)
//   Bytes 22.. : JPEG data

export interface RaftCameraFrame {
  version: number;
  imageCount: number;
  timestampMs: number;
  width: number;
  height: number;
  pixelFormat: number;
  jpegQuality: number;
  jpegData: Uint8Array;
}

export const RAFT_CAMERA_FRAME_HEADER_LEN = 19;
export const RAFT_CAMERA_FRAME_VERSION = 1;

const PUBLISH_MSG_TYPE_PREFIX_LEN = 2;
const PUBLISH_ENVELOPE_LEN = 3;
const PUBLISH_ENVELOPE_MAGIC_MIN = 0xDB;
const PUBLISH_ENVELOPE_MAGIC_MAX = 0xDF;

/**
 * Decode a camera frame header + JPEG data starting at the given offset
 * (the offset must point at the camera header version byte).
 * @param payload buffer containing the camera frame
 * @param offset offset of the camera header within the buffer
 * @returns decoded frame or null if the buffer is not a valid camera frame
 */
export function decodeCameraFrame(payload: Uint8Array, offset = 0): RaftCameraFrame | null {
  if (payload.length < offset + RAFT_CAMERA_FRAME_HEADER_LEN) {
    return null;
  }
  const dv = new DataView(payload.buffer, payload.byteOffset + offset);
  const version = dv.getUint8(0);
  if (version !== RAFT_CAMERA_FRAME_VERSION) {
    return null;
  }
  const imageCount = dv.getUint32(1, true);
  const timestampMs = dv.getUint32(5, true);
  const width = dv.getUint16(9, true);
  const height = dv.getUint16(11, true);
  const pixelFormat = dv.getUint8(13);
  const jpegQuality = dv.getUint8(14);
  const payloadLen = dv.getUint32(15, true);
  if (payload.length < offset + RAFT_CAMERA_FRAME_HEADER_LEN + payloadLen) {
    return null;
  }
  const jpegStart = offset + RAFT_CAMERA_FRAME_HEADER_LEN;
  const jpegData = payload.slice(jpegStart, jpegStart + payloadLen);
  return {
    version,
    imageCount,
    timestampMs,
    width,
    height,
    pixelFormat,
    jpegQuality,
    jpegData,
  };
}

/**
 * Decode a camera frame from a complete publish message as received by
 * rxOtherMsgType (including the 2-byte transport msgType prefix and, when
 * present, the 3-byte binary publish envelope).
 * @param payload complete publish message
 * @returns decoded frame or null if the message is not a valid camera frame
 */
export function decodeCameraFramePublishMsg(payload: Uint8Array): RaftCameraFrame | null {
  let offset = PUBLISH_MSG_TYPE_PREFIX_LEN;
  if (payload.length <= offset) {
    return null;
  }
  const firstByte = payload[offset];
  if ((firstByte >= PUBLISH_ENVELOPE_MAGIC_MIN) && (firstByte <= PUBLISH_ENVELOPE_MAGIC_MAX)) {
    offset += PUBLISH_ENVELOPE_LEN;
  }
  return decodeCameraFrame(payload, offset);
}
