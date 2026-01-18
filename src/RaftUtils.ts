/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftUtils
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import RaftLog from "./RaftLog";

export default class RaftUtils {
  static _isEndianSet = false;
  static _isLittleEndian = false;

  /**
   *
   * Add a string to a Uint8Array buffer
   *
   * @param buffer - buffer to add to
   * @param strToAdd - string to be added
   * @param startPos - start position in buffer (i.e. offset to place string at)
   */
  static addStringToBuffer(
    buffer: Uint8Array,
    strToAdd: string,
    startPos: number
  ): void {
    // Check valid
    if (buffer.length < startPos + strToAdd.length + 1) {
      RaftLog.warn("addStringToBuffer buffer too short");
      return;
    }
    let curPos = startPos;
    for (let i = 0; i < strToAdd.length; i++) {
      let charAt = strToAdd.charCodeAt(i);
      if (charAt > 255) charAt = 255;
      buffer.set([charAt], curPos++);
    }
    buffer.set([0], buffer.length - 1);
  }

  /**
   *
   * Get a string from a Uint8Array buffer
   *
   * @param buffer - buffer to get from
   * @param startPos - start position in buffer (i.e. offset to start of string at)
   * @param strLen - length of string to get
   * @returns strGot - string got from buffer
   */
  static getStringFromBuffer(
    buffer: Uint8Array,
    startPos: number,
    strLen: number
  ): string {
    // Check valid
    if (buffer.length < startPos + strLen) {
      strLen = buffer.length - startPos;
      if (strLen <= 0) return "";
    }
    let curPos = startPos;
    let outStr = "";
    for (let i = 0; i < strLen; i++) {
      outStr += String.fromCharCode(buffer[curPos++]);
    }
    return outStr;
  }

  /**
   *
   * Debug code to format a Uint8Array to string for logging
   *
   * @param buffer - Uint8Array to be converted to hex string
   */
  static bufferToHex(buffer: Uint8Array | null): string {
    if (buffer == null) return "null";
    return Array.from(new Uint8Array(buffer))
      .map((b) => RaftUtils.padStartFn(b.toString(16), 2, "0"))
      .join("");
  }

  /**
   *
   * Extract a big-endian float from a uint8array
   *
   * @param buf - Uint8Array containing float
   * @returns float
   */
  static getBEFloatFromBuf(buf: Uint8Array): number {
    const revBuf = new Uint8Array(4);
    if (RaftUtils.isLittleEndian()) {
      for (let i = 0; i < 4; i++) revBuf[3 - i] = buf[i];
    } else {
      for (let i = 0; i < 4; i++) revBuf[i] = buf[i];
    }

    const floatVal = new Float32Array(revBuf.buffer);
    // RaftUtils.debug('revFloat ' + RaftUtils.bufferToHex(revBuf) + floatVal[0]);
    return floatVal[0];
  }

  /**
   * Extract a big-endian uint64 from a uint8array
   *
   * @param buf - Uint8Array containing uint64
   * @param pos - position (offset in buf) to get from
   * @returns uint64
   */

  static getBEUint64FromBuf(buf: Uint8Array, bufPos: number): number {
    if (RaftUtils.isLittleEndian())
      return (
        (buf[bufPos] << 56) +
        (buf[bufPos + 1] << 48) +
        (buf[bufPos + 2] << 40) +
        (buf[bufPos + 3] << 32) +
        (buf[bufPos + 4] << 24) +
        (buf[bufPos + 5] << 16) +
        (buf[bufPos + 6] << 8) +
        buf[bufPos + 7]
      );
    return (
      (buf[bufPos + 7] << 56) +
      (buf[bufPos + 6] << 48) +
      (buf[bufPos + 5] << 40) +
      (buf[bufPos + 4] << 32) +
      (buf[bufPos + 3] << 24) +
      (buf[bufPos + 2] << 16) +
      (buf[bufPos + 1] << 8) +
      buf[bufPos]
    );
  }

  /**
   *
   * Extract a big-endian uint32 from a uint8array
   *
   * @param buf - Uint8Array containing uint32
   * @param pos - position (offset in buf) to get from
   * @returns uint32
   */
  static getBEUint32FromBuf(buf: Uint8Array, bufPos: number): number {
    if (RaftUtils.isLittleEndian())
      return (
        (buf[bufPos] << 24) +
        (buf[bufPos + 1] << 16) +
        (buf[bufPos + 2] << 8) +
        buf[bufPos + 3]
      );
    return (
      (buf[bufPos + 3] << 24) +
      (buf[bufPos + 2] << 16) +
      (buf[bufPos + 1] << 8) +
      buf[bufPos]
    );
  }

  /**
   *
   * Extract a big-endian int16 from a uint8array
   *
   * @param buf - Uint8Array containing int16
   * @param pos - position (offset in buf) to get from
   * @returns int16
   */
  static getBEInt16FromBuf(buf: Uint8Array, bufPos: number): number {
    if (RaftUtils.isLittleEndian()) {
      const val = buf[bufPos] * 256 + buf[bufPos + 1];
      return val > 32767 ? val - 65536 : val;
    }
    const val = buf[bufPos + 1] * 256 + buf[bufPos];
    return val > 32767 ? val - 65536 : val;
  }

  /**
   *
   * Extract a big-endian uint16 from a uint8array
   *
   * @param buf - Uint8Array containing uint16
   * @param pos - position (offset in buf) to get from
   * @returns int16
   */
  static getBEUint16FromBuf(buf: Uint8Array, bufPos: number): number {
    if (RaftUtils.isLittleEndian()) return buf[bufPos] * 256 + buf[bufPos + 1];
    return buf[bufPos + 1] * 256 + buf[bufPos];
  }

  /**
   *
   * Extract a big-endian uint8 from a uint8array
   *
   * @param buf - Uint8Array containing uint8
   * @param pos - position (offset in buf) to get from
   * @returns int16
   */
  static getBEUint8FromBuf(buf: Uint8Array, pos: number): number {
    return buf[pos];
  }

  /**
   *
   * Extract a big-endian int8 from a uint8array
   *
   * @param buf - Uint8Array containing int8
   * @param pos - position (offset in buf) to get from
   * @returns int16
   */
  static getBEInt8FromBuf(buf: Uint8Array, pos: number): number {
    return buf[pos] > 127 ? buf[pos] - 256 : buf[pos];
  }

  static isLittleEndian(): boolean {
    // If already known just return
    if (this._isEndianSet) return this._isLittleEndian;

    // Figure out endian-ness
    const a = new Uint32Array([0x12345678]);
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    this._isEndianSet = true;
    this._isLittleEndian = b[0] != 0x12;
    return this._isLittleEndian;
    // RaftUtils.debug("bigendian " + BigEndian);

    // let buf = new ArrayBuffer(2);
    // let shView = new Uint16Array(buf);
    // buf[0] = 1;
    // buf[1] = 0;
    // RaftUtils.debug("Resulting short " + shView[0]);
    // return shView[0] == 1;
  }

  // The following code from https://github.com/jsdom/abab
  /**
   * Implementation of atob() according to the HTML and Infra specs, except that
   * instead of throwing INVALID_CHARACTER_ERR we return null.
   *
   * @param data - string containing base64 representation
   * @returns Uint8Array
   *
   */
  static atob(data: string): Uint8Array | null {
    // Web IDL requires DOMStrings to just be converted using ECMAScript
    // ToString, which in our case amounts to using a template literal.
    data = `${data}`;
    // "Remove all ASCII whitespace from data."
    data = data.replace(/[ \t\n\f\r]/g, "");
    // "If data's length divides by 4 leaving no remainder, then: if data ends
    // with one or two U+003D (=) code points, then remove them from data."
    if (data.length % 4 === 0) {
      data = data.replace(/==?$/, "");
    }
    // "If data's length divides by 4 leaving a remainder of 1, then return
    // failure."
    //
    // "If data contains a code point that is not one of
    //
    // U+002B (+)
    // U+002F (/)
    // ASCII alphanumeric
    //
    // then return failure."
    if (data.length % 4 === 1 || /[^+/0-9A-Za-z]/.test(data)) {
      return null;
    }
    // "Let output be an empty byte sequence."
    const output = new Uint8Array((data.length * 3) / 4 + 1);
    // "Let buffer be an empty buffer that can have bits appended to it."
    //
    // We append bits via left-shift and or.  accumulatedBits is used to track
    // when we've gotten to 24 bits.
    let buffer = 0;
    let accumulatedBits = 0;
    // "Let position be a position variable for data, initially pointing at the
    // start of data."
    //
    // "While position does not point past the end of data:"
    let bytePos = 0;
    for (let i = 0; i < data.length; i++) {
      // "Find the code point pointed to by position in the second column of
      // Table 1: The Base 64 Alphabet of RFC 4648. Let n be the number given in
      // the first cell of the same row.
      //
      // "Append to buffer the six bits corresponding to n, most significant bit
      // first."
      //
      // atobLookup() implements the table from RFC 4648.
      buffer <<= 6;
      const atobVal = RaftUtils.atobLookup(data[i]);
      if (atobVal !== undefined) {
        buffer |= atobVal;
      }
      accumulatedBits += 6;
      // "If buffer has accumulated 24 bits, interpret them as three 8-bit
      // big-endian numbers. Append three bytes with values equal to those
      // numbers to output, in the same order, and then empty buffer."
      if (accumulatedBits === 24) {
        output[bytePos++] = (buffer & 0xff0000) >> 16;
        output[bytePos++] = (buffer & 0xff00) >> 8;
        output[bytePos++] = buffer & 0xff;
        buffer = accumulatedBits = 0;
      }
      // "Advance position by 1."
    }
    // "If buffer is not empty, it contains either 12 or 18 bits. If it contains
    // 12 bits, then discard the last four and interpret the remaining eight as
    // an 8-bit big-endian number. If it contains 18 bits, then discard the last
    // two and interpret the remaining 16 as two 8-bit big-endian numbers. Append
    // the one or two bytes with values equal to those one or two numbers to
    // output, in the same order."
    if (accumulatedBits === 12) {
      buffer >>= 4;
      output[bytePos++] = buffer & 0xff;
    } else if (accumulatedBits === 18) {
      buffer >>= 2;
      output[bytePos++] = (buffer & 0xff00) >> 8;
      output[bytePos++] = buffer & 0xff;
    }
    // "Return output."
    return output.slice(0, bytePos);
  }

  /**
   * A lookup table for atob(), which converts an ASCII character to the
   * corresponding six-bit number.
   */
  static atobLookup(chr: string): number | undefined {
    if (/[A-Z]/.test(chr)) {
      return chr.charCodeAt(0) - "A".charCodeAt(0);
    }
    if (/[a-z]/.test(chr)) {
      return chr.charCodeAt(0) - "a".charCodeAt(0) + 26;
    }
    if (/[0-9]/.test(chr)) {
      return chr.charCodeAt(0) - "0".charCodeAt(0) + 52;
    }
    if (chr === "+") {
      return 62;
    }
    if (chr === "/") {
      return 63;
    }
    // Throw exception; should not be hit in tests
    return undefined;
  }

  /**
   * btoa() as defined by the HTML and Infra specs, which mostly just references
   * RFC 4648.
   *
   * @param data - Uint8Array
   * @returns string containing base64 representation
   *
   */
  static btoa(inBuf: Uint8Array): string {
    let i;
    // String conversion as required by Web IDL.
    // s = `${s}`;
    // "The btoa() method must throw an "InvalidCharacterError" DOMException if
    // data contains any character whose code point is greater than U+00FF."
    // for (i = 0; i < s.length; i++) {
    //   if (s.charCodeAt(i) > 255) {
    //     return null;
    //   }
    // }
    let out = "";
    for (i = 0; i < inBuf.length; i += 3) {
      const groupsOfSix: Array<number | undefined> = [
        undefined,
        undefined,
        undefined,
        undefined,
      ];
      groupsOfSix[0] = inBuf[i] >> 2;
      groupsOfSix[1] = (inBuf[i] & 0x03) << 4;
      if (inBuf.length > i + 1) {
        groupsOfSix[1] |= inBuf[i + 1] >> 4;
        groupsOfSix[2] = (inBuf[i + 1] & 0x0f) << 2;
        if (inBuf.length > i + 2) {
          groupsOfSix[2] |= inBuf[i + 2] >> 6;
          groupsOfSix[3] = inBuf[i + 2] & 0x3f;
        }
      }
      for (let j = 0; j < groupsOfSix.length; j++) {
        if (typeof groupsOfSix[j] === "undefined") {
          out += "=";
        } else {
          out += this.btoaLookup(groupsOfSix[j]);
        }
      }
    }
    return out;
  }

  /**
   * Lookup table for btoa(), which converts a six-bit number into the
   * corresponding ASCII character.
   */
  static btoaLookup(idx: number | undefined): string | undefined {
    if (idx === undefined) {
      return undefined;
    }
    if (idx < 26) {
      return String.fromCharCode(idx + "A".charCodeAt(0));
    }
    if (idx < 52) {
      return String.fromCharCode(idx - 26 + "a".charCodeAt(0));
    }
    if (idx < 62) {
      return String.fromCharCode(idx - 52 + "0".charCodeAt(0));
    }
    if (idx === 62) {
      return "+";
    }
    if (idx === 63) {
      return "/";
    }
    // Throw INVALID_CHARACTER_ERR exception here -- won't be hit in the tests.
    return undefined;
  }

  static buf2hex(buffer: Uint8Array) {
    return Array.prototype.map
      .call(buffer, (x: number) => ("00" + x.toString(16)).slice(-2))
      .join("");
  }

  static padStartFn(
    inStr: string,
    targetLength: number,
    padString: string
  ): string {
    targetLength = targetLength >> 0; //truncate if number or convert non-number to 0;
    padString = String(typeof padString !== "undefined" ? padString : " ");
    if (inStr.length > targetLength) {
      return String(inStr);
    } else {
      targetLength = targetLength - inStr.length;
      if (targetLength > padString.length) {
        padString += padString.repeat(targetLength / padString.length); //append to original to ensure we are longer than needed
      }
      return padString.slice(0, targetLength) + String(inStr);
    }
  }

  static semverGt(v1: string, v2: string): boolean {
    const [major1, minor1, patch1] = v1.split('.').map(Number);
    const [major2, minor2, patch2] = v2.split('.').map(Number);
    if (major1 !== major2) return major1 > major2;
    if (minor1 !== minor2) return minor1 > minor2;
    return patch1 > patch2;
  }

  static isVersionGreater(v1: string, v2: string) {
    try {
      const [major1, minor1, patch1] = v1.split('.').map(Number);
      const [major2, minor2, patch2] = v2.split('.').map(Number);
      if (major1 !== major2) return major1 > major2;
      if (minor1 !== minor2) return minor1 > minor2;
      return patch1 > patch2;
    } catch (e) {
      // one of the two versions is invalid, return true
      RaftLog.warn(`isVersionGreater - invalid version ${v1} or ${v2} ${e}`);
      return true;
    }
  }

  static isVersionEqual(v1: string, v2: string) {
    try {
      return v1 === v2;
    } catch (e) {
      // one of the two versions is invalid, return false
      RaftLog.warn(`isVersionEqual - invalid version ${v1} or ${v2} ${e}`);
      return false;
    }
  }

  static withTimeout(ms: number, promise: Promise<any>) {
    let id: NodeJS.Timeout;
    const timeout = new Promise((_, reject) => {
      id = setTimeout(() => {
        clearTimeout(id);
        reject('Timed out in ' + ms + 'ms.')
      }, ms)
    })

    return Promise.race([
      promise,
      timeout
    ])
  }

  static toBufferSource(u8: Uint8Array<ArrayBufferLike>): BufferSource {
    if (u8.buffer instanceof ArrayBuffer) {
      // Respect byteOffset/byteLength
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    }
    // e.g., SharedArrayBuffer -> copy into a real ArrayBuffer
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return ab;
  }
  static toArrayBufferView(u8: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
    if (u8.buffer instanceof ArrayBuffer) {
      // keep the same bytes/offset/length, but the return type is now locked to ArrayBuffer
      return new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
    }
    // e.g., SharedArrayBuffer → copy into a real ArrayBuffer
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return new Uint8Array(ab);
  }
}
