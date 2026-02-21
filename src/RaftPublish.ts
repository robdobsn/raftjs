/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftSystem
// Part of RaftJS
//
// Rob Dobson 2025
// (C) 2020-2025 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { RaftPublishFrameMeta } from "./RaftTypes";

const RAFT_PUBLISH_PREFIX_LEN = 2;
const DEVBIN_MAGIC_MIN = 0xDB;
const DEVBIN_MAGIC_MAX = 0xDF;
const DEVBIN_VERSION_BASE = 0xDA;

export function inspectPublishFrame(
  payload: Uint8Array,
  topicLookup?: (topicIndex: number) => string | undefined,
): RaftPublishFrameMeta {

  if (payload.length < RAFT_PUBLISH_PREFIX_LEN) {
    return { frameType: "unknown" };
  }

  const payloadStartPos = RAFT_PUBLISH_PREFIX_LEN;
  if (payload.length <= payloadStartPos) {
    return { frameType: "unknown" };
  }

  // Try JSON first
  if (payload[payloadStartPos] === 0x7B) {
    try {
      const jsonString = new TextDecoder("utf-8").decode(payload.slice(payloadStartPos));
      const jsonObj = JSON.parse(jsonString) as Record<string, unknown>;

      let topicIndex: number | undefined = undefined;
      let topicName: string | undefined = undefined;
      if (typeof jsonObj._t === "number") {
        topicIndex = jsonObj._t;
        topicName = topicLookup ? topicLookup(topicIndex) : undefined;
      } else if (typeof jsonObj._t === "string") {
        topicName = jsonObj._t;
      }

      const version = typeof jsonObj._v === "number" ? jsonObj._v : undefined;

      return {
        frameType: "json",
        topicIndex,
        topicName,
        version,
        jsonString,
      };
    } catch {
      return { frameType: "unknown" };
    }
  }

  // Binary (devbin legacy or enveloped)
  const firstBinaryByte = payload[payloadStartPos];
  if ((firstBinaryByte & 0xF0) === 0xD0) {
    if (firstBinaryByte < DEVBIN_MAGIC_MIN || firstBinaryByte > DEVBIN_MAGIC_MAX) {
      return {
        frameType: "binary",
        binaryHasEnvelope: true,
      };
    }

    const topicIndex = payload.length > payloadStartPos + 1 ? payload[payloadStartPos + 1] : undefined;
    const topicName = (topicIndex !== undefined && topicIndex !== 0xFF && topicLookup)
      ? topicLookup(topicIndex)
      : undefined;

    return {
      frameType: "binary",
      topicIndex,
      topicName,
      version: firstBinaryByte - DEVBIN_VERSION_BASE,
      binaryHasEnvelope: true,
      binaryPayloadOffset: payloadStartPos + 2,
    };
  }

  // Legacy binary format (no envelope)
  return {
    frameType: "binary",
    binaryHasEnvelope: false,
    binaryPayloadOffset: payloadStartPos,
  };
}
