/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftChannelSimulated.ts
// Part of RaftJS
//
// Rob Dobson 2020-2025
// (C) 2020-2025 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import RaftChannel from "./RaftChannel";
import RaftMsgHandler from "./RaftMsgHandler";
import RaftLog from "./RaftLog";
import { RaftConnEvent, RaftConnEventFn } from "./RaftConnEvents";
import { RaftCommsMsgTypeCode } from './RaftProtocolDefs';
import { ConnectorOptions } from "./RaftSystemType";
import { DeviceTypeInfoRecs, DeviceTypeInfo } from "./RaftDeviceInfo";

interface SimulatedDeviceInfo {
  name: string;
  publishRatePerSecond: number;
}

export default class RaftChannelSimulated implements RaftChannel {

  // Message handler
  private _raftMsgHandler: RaftMsgHandler | null = null;

  // Is connected
  private _isConnected = false;

  // Simulated device name and rate
  private _simulatedDeviceInfo: Array<SimulatedDeviceInfo> | null = null;

  // Simulated device information timer
  private _simulatedDeviceInfoTimers: Array<NodeJS.Timeout> | null = null;
  private _simulatedDeviceInfoTimeMs: Array<number> = [];

  // Conn event fn
  private _onConnEvent: RaftConnEventFn | null = null;

  // File Handler parameters
  private _requestedBatchAckSize = 10;
  private _requestedFileBlockSize = 500;

  fhBatchAckSize(): number { return this._requestedBatchAckSize; }
  fhFileBlockSize(): number { return this._requestedFileBlockSize; }
  
  // isConnected
  isConnected(): boolean {
    return this._isConnected;
  }

  // Set message handler
  setMsgHandler(raftMsgHandler: RaftMsgHandler): void {
    this._raftMsgHandler = raftMsgHandler;
    this._raftMsgHandler.setRawMsgMode(true);
  }

  // WebSocket interfaces require subscription to published messages
  requiresSubscription(): boolean {
    return true;
  }

  // RICREST command before disconnect
  ricRestCmdBeforeDisconnect(): string | null {
    return null;
  }

  // Set onConnEvent handler
  setOnConnEvent(connEventFn: RaftConnEventFn): void {
    this._onConnEvent = connEventFn;
  }

  // Get connected locator
  getConnectedLocator(): string | object {
    return "simulated";
  }

  // Connect to a device
  async connect(locator: string | object, connectorOptions: ConnectorOptions): Promise<boolean> {

    // Debug
    RaftLog.debug(`RaftChannelSimulated.connect connected ${locator.toString()} options ${JSON.stringify(connectorOptions)}`);

    // Extract SimulatedDeviceInfo from JSON locator
    if (typeof locator === 'string') {
      try {
        const parsedLocator = JSON.parse(locator);
        if (parsedLocator && Array.isArray(parsedLocator)) {
          this._simulatedDeviceInfo = parsedLocator;
        }
      } catch (e) {
        RaftLog.warn(`RaftChannelSimulated.connect - error parsing locator ${locator}, ${e}`);
        return false;
      }
    }

    // Handle simulated devices
    if (this._simulatedDeviceInfo) {
      // Create timers for simulated devices
      this._simulatedDeviceInfoTimers = [];
      for (let i = 0; i < this._simulatedDeviceInfo.length; i++) {
        const deviceInfo = this._simulatedDeviceInfo[i];
        const deviceName = deviceInfo.name ? deviceInfo.name : `SimulatedDevice${i}`;
        this._simulatedDeviceInfoTimeMs.push(0);
        const deviceRate = deviceInfo.publishRatePerSecond ? deviceInfo.publishRatePerSecond : 1;
        let deviceIntervalMs = 911;
        if ((deviceRate > 0.01) && (deviceRate < 1000)) {
          deviceIntervalMs = Math.floor(1000 / deviceRate);
        }
        const deviceTypeInfo = this._deviceTypeInfo[deviceName];
        if (deviceTypeInfo) {
          const timer = setInterval(() => {
            const msg = this._createSimulatedDeviceInfoMsg(
              deviceIntervalMs,
              deviceName,
              deviceTypeInfo,
              this._simulatedDeviceInfoTimeMs[i]
            );
            this._raftMsgHandler?.handleNewRxMsgRaw(msg, RaftCommsMsgTypeCode.MSG_TYPE_PUBLISH, 0, this._simulatedDeviceInfoTimeMs[i]);
            this._simulatedDeviceInfoTimeMs[i] += deviceIntervalMs;
          }, deviceIntervalMs);
          this._simulatedDeviceInfoTimers.push(timer);
        } else {
          RaftLog.warn(`RaftChannelSimulated.connect - device type info not found for ${deviceName}`);
        }
      }
    } else {
      RaftLog.warn(`RaftChannelSimulated.connect - no simulated devices found`);
    }

    // Connected
    this._isConnected = true;    
    return true;
  }

  // Disconnect
  async disconnect(): Promise<void> {
    
    // Not connected
    this._isConnected = false;

    // Clear timers
    if (this._simulatedDeviceInfoTimers) {
      for (const timer of this._simulatedDeviceInfoTimers) {
        clearInterval(timer);
      }
      this._simulatedDeviceInfoTimers = null;
    }

    // Notify connection event
    if (this._onConnEvent) {
      this._onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    }
    
    // Debug
    RaftLog.debug(`RaftChannelSimulated.disconnect closed`);
  }

  pauseConnection(pause: boolean): void { 
    RaftLog.debug(`pauseConnection ${pause} - no effect for this channel type`); 
    return; 
  }

  // Send a message
  async sendTxMsg(
    msg: Uint8Array,
    sendWithResponse: boolean
  ): Promise<boolean> {

    // Check connected
    if (!this._isConnected)
      return false;

    // Debug
    RaftLog.debug(`RaftChannelSimulated.sendTxMsg ${msg.toString()} sendWithResp ${sendWithResponse.toString()}`);
    return true;
  }

  async sendTxMsgNoAwait(
    msg: Uint8Array,
    sendWithResponse: boolean
  ): Promise<boolean> {

    // Check connected
    if (!this._isConnected)
      return false;

    // Debug
    RaftLog.debug(`RaftChannelSimulated.sendTxMsgNoAwait ${msg.toString()} sendWithResp ${sendWithResponse.toString()}`);
    return true;
  }

  // Method used for testing and simulation should never be called
  sendTxMsgRaw(msg: string): boolean {
    RaftLog.debug(`sendTxMsgRaw - not implemented ${msg}`);
    return false;
  }

  // Method used for testing and simulation should never be called
  sendTxMsgRawAndWaitForReply<T>(msgPayload: Uint8Array): T {
    RaftLog.debug(`sendTxMsgRawAndWaitForReply ${msgPayload}`);

    // Decode the message from Uint8Array to string
    const textDecoder = new TextDecoder('utf-8');
    const decodedString = textDecoder.decode(msgPayload.slice(1)).replace("\0", "").trim()
    
    RaftLog.debug(`sendTxMsgRawAndWaitForReply ${decodedString}`);
    
    // Check for version request
    if (decodedString === "v") {
      // R"({"req":"%s","rslt":"ok","SystemName":"%s","SystemVersion":"%s","Friendly":"%s","SerialNo":"%s","MAC":"%s",%s})",
      const response = {
        req: "v",
        rslt: "ok",
        SystemName: "Simulated",
        SystemVersion: "1.0.0",
        Friendly: "Simulated",
        SerialNo: "123456",
        MAC: "00:00:00:00:00:00"
      }
      return response as T;
    }

    else if (decodedString.startsWith("sub")) {
      const response = {
        req: decodedString,
        rslt: "ok"
      }
      return response as T;
    }

    // Check if this is a device type info request
    else if (decodedString.startsWith("devman/typeinfo?")) {
      // Extract the type parameter from the request
      const match = decodedString.match(/type=([^&]+)/);
      if (match && match[1]) {
        const deviceType = match[1];
        
        // Look up the device type in the _deviceTypeInfo
        if (deviceType in this._deviceTypeInfo) {
          // Prepare response with the device type info
          const response = {
            req: decodedString,
            rslt: "ok",
            devinfo: this._deviceTypeInfo[deviceType]
          };
          
          RaftLog.debug(`Device type info for ${deviceType} found, returning response`);
          return response as T;
        } else {
          // Device type not found
          const response = {
            req: decodedString,
            rslt: "err",
            msg: `Device type ${deviceType} not found`
          };
          
          RaftLog.warn(`Device type info for ${deviceType} not found`);
          return response as T;
        }
      }
    } 
    
    // Unknown message
    const response = {
      req: decodedString,
      rslt: "err",
      msg: `Unknown request`
    };
    return response as T;
  }

  // Create simulated device info message
  private _createSimulatedDeviceInfoMsg(
    deviceIntervalMs: number,
    deviceName: string,
    deviceTypeInfo: DeviceTypeInfo,
    deviceTimeMs: number
  ): Uint8Array {
    // Make sure we have response metadata
    if (!deviceTypeInfo?.resp?.a) {
      return new Uint8Array(0);
    }

    const attributes = deviceTypeInfo.resp.a;
    const dataBlockSizeBytes = deviceTypeInfo.resp.b;

    // Create a buffer for the data
    const dataBuffer = new ArrayBuffer(dataBlockSizeBytes + 2);
    const dataView = new DataView(dataBuffer);
    let bytePos = 0;

    // Add 16 bit big endian deviceTimeMs mod 65536 to the buffer
    dataView.setUint16(bytePos, deviceTimeMs % 65536, false);
    bytePos += 2;

    const handledByCustomGenerator = this._fillCustomRawData(
      deviceTypeInfo,
      dataView,
      bytePos,
      dataBlockSizeBytes,
      deviceIntervalMs,
      deviceTimeMs
    );

    if (!handledByCustomGenerator) {
      const numAttributes = attributes.length;
      const numSamplesPerCycle = 10;
      const frequencyHz = (deviceIntervalMs > 0)
        ? (1000 / deviceIntervalMs) / numSamplesPerCycle
        : 0.1;
      const timeRadians = deviceTimeMs * frequencyHz * (2 * Math.PI) / 1000;

      // Iterate through attributes and fill the payload
      for (let attrIdx = 0; attrIdx < numAttributes; attrIdx++) {
        const attr = attributes[attrIdx];
        const { typeCode, repeatCount, littleEndian } = this._parseAttrType(attr.t);
        const scaledValues = this._generateAttributeScaledValues(
          attr,
          attrIdx,
          repeatCount,
          numAttributes,
          timeRadians,
          deviceTimeMs
        );

        if (scaledValues.length !== repeatCount) {
          RaftLog.warn(`RaftChannelSimulated._createSimulatedDeviceInfoMsg - value count mismatch for ${attr.n}`);
          continue;
        }

        for (let elemIdx = 0; elemIdx < repeatCount; elemIdx++) {
          const scaledValue = scaledValues[elemIdx];
          const rawValue = this._prepareRawValue(attr, typeCode, scaledValue);
          const nextBytePos = this._writeRawValueToBuffer(
            dataView,
            bytePos,
            typeCode,
            littleEndian,
            rawValue
          );

          if (nextBytePos < 0) {
            RaftLog.warn(`RaftChannelSimulated._createSimulatedDeviceInfoMsg - buffer overflow writing ${attr.n}`);
            break;
          }

          bytePos = nextBytePos;
        }
      }
    } else {
      bytePos += dataBlockSizeBytes;
    }

    // Convert the buffer to a byte array
    const dataBytes = new Uint8Array(dataBuffer);

    // Create the JSON message structure (bus key is numeric string to match firmware convention)
    const message = {
      "1": {
        [deviceName]: {
          "_t": deviceTypeInfo.type,
          "_o": 1,  // Device is online
          "pub": this._bytesToHexStr(dataBytes)
        }
      }
    };
    
    // Convert the JSON to a string and then to Uint8Array with prepended timestamp
    const jsonString = JSON.stringify(message);
    const encodedMsg = new TextEncoder().encode(jsonString);
    const msgWithPrefix = new ArrayBuffer(2 + encodedMsg.byteLength);
    const msgWithPrefixView = new DataView(msgWithPrefix);
    const msgPrefixBytes = new Uint8Array(msgWithPrefix);
    msgWithPrefixView.setUint16(0, 0, false);
    msgPrefixBytes.set(encodedMsg, 2);
    return msgPrefixBytes;    

  }

  private _parseAttrType(attrType: string): { typeCode: string; repeatCount: number; littleEndian: boolean } {
    const repeatMatch = attrType.match(/\[(\d+)\]\s*$/);
    const repeatCount = repeatMatch ? parseInt(repeatMatch[1], 10) : 1;
    const coreType = repeatMatch ? attrType.slice(0, repeatMatch.index) : attrType;
    let littleEndian = false;
    let typeCode = coreType.trim();

    if (typeCode.startsWith("<")) {
      littleEndian = true;
      typeCode = typeCode.slice(1);
    } else if (typeCode.startsWith(">")) {
      littleEndian = false;
      typeCode = typeCode.slice(1);
    } else if (typeCode === "f") {
      // Match previous behaviour - plain "f" treated as little endian floats
      littleEndian = true;
    }

    return { typeCode, repeatCount, littleEndian };
  }

  private _generateAttributeScaledValues(
    attr: any,
    attrIdx: number,
    repeatCount: number,
    numAttributes: number,
    timeRadians: number,
    deviceTimeMs: number
  ): number[] {
    const amplitude = 0.8;

    if (repeatCount > 1) {
      const useThermalGrid = (attr && typeof attr.resolution === "string") || repeatCount >= 16;
      if (useThermalGrid) {
        return this._generateThermalGridValues(attr, repeatCount, timeRadians, deviceTimeMs);
      }

      const values: number[] = [];
      for (let elemIdx = 0; elemIdx < repeatCount; elemIdx++) {
        const phaseOffset = (2 * Math.PI * (attrIdx + elemIdx / repeatCount)) / Math.max(1, numAttributes);
        const sinValue = Math.sin(timeRadians + phaseOffset);

        if (Array.isArray(attr.r) && attr.r.length >= 2) {
          const minValue = attr.r[0];
          const maxValue = attr.r[1];
          const midPoint = (maxValue + minValue) / 2;
          const range = (maxValue - minValue) / 2;
          const value = midPoint + sinValue * range * amplitude;
          values.push(Math.min(maxValue, Math.max(minValue, value)));
        } else {
          values.push(sinValue * 1000 * amplitude);
        }
      }
      return values;
    }

    const phaseOffset = numAttributes > 0 ? (2 * Math.PI * attrIdx) / numAttributes : 0;
    const sinValue = Math.sin(timeRadians + phaseOffset);

    if (Array.isArray(attr.r) && attr.r.length >= 2) {
      const minValue = attr.r[0];
      const maxValue = attr.r[1];
      const midPoint = (maxValue + minValue) / 2;
      const range = (maxValue - minValue) / 2;
      const value = midPoint + sinValue * range * amplitude;
      return [Math.min(maxValue, Math.max(minValue, value))];
    }

    return [sinValue * 1000 * amplitude];
  }

  private _generateThermalGridValues(
    attr: any,
    repeatCount: number,
    timeRadians: number,
    deviceTimeMs: number
  ): number[] {
    const { rows, cols } = this._getGridDimensions(attr, repeatCount);
    const values: number[] = [];
    const ambientBase = 24 + 2 * Math.sin(deviceTimeMs / 7000);
    const hotspotPhase = deviceTimeMs / 3200;
    const hotspotRow = (Math.sin(hotspotPhase) + 1) * (rows - 1) / 2;
    const hotspotCol = (Math.cos(hotspotPhase) + 1) * (cols - 1) / 2;
    const hotspotAmplitude = 6;
    const rawSigma = Math.max(rows, cols) / 3;
    const sigma = Number.isFinite(rawSigma) ? rawSigma : 1;

    for (let idx = 0; idx < repeatCount; idx++) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const dist = Math.hypot(row - hotspotRow, col - hotspotCol);
      const hotspot = hotspotAmplitude * Math.exp(-(dist * dist) / (2 * sigma * sigma));
      const gentleWave = 0.5 * Math.sin(timeRadians + row * 0.35 + col * 0.25);
      let value = ambientBase + hotspot + gentleWave;

      if (Array.isArray(attr.r) && attr.r.length >= 2) {
        value = Math.min(attr.r[1], Math.max(attr.r[0], value));
      }

      values.push(value);
    }

    return values;
  }

  private _fillCustomRawData(
    deviceTypeInfo: DeviceTypeInfo,
    dataView: DataView,
    bytePos: number,
    dataBlockSizeBytes: number,
    deviceIntervalMs: number,
    deviceTimeMs: number
  ): boolean {
    switch (deviceTypeInfo.type) {
      case "LTR-329": {
        if (dataBlockSizeBytes < 4) {
          return false;
        }

        const frequencyHz = (deviceIntervalMs > 0)
          ? (1000 / deviceIntervalMs) / 10
          : 0.1;
        const timeRadians = deviceTimeMs * frequencyHz * (2 * Math.PI) / 1000;

        const range = deviceTypeInfo.resp?.a?.[0]?.r ?? [0, 64000];
        const minLux = range[0] ?? 0;
        const maxLux = range[1] ?? 64000;

        const baseLux = (maxLux + minLux) / 4;
        const amplitudeLux = (maxLux - minLux) / 6;
        let combined = Math.round(baseLux + amplitudeLux * Math.sin(timeRadians));
        combined = Math.max(minLux, Math.min(maxLux, combined));

        const irBase = combined * 0.35;
        const irVariance = (combined * 0.15) * Math.sin(timeRadians + Math.PI / 4);
        let ir = Math.round(irBase + irVariance);
        ir = Math.max(minLux, Math.min(combined, ir));

        dataView.setUint16(bytePos, combined, true);
        dataView.setUint16(bytePos + 2, ir, true);

        return true;
      }
      case "LTR-390": {
        if (dataBlockSizeBytes < 5) {
          return false;
        }

        const numerator = (deviceIntervalMs > 0) ? (1000 / deviceIntervalMs) : 0;
        const timeRadians = deviceTimeMs * numerator * (2 * Math.PI) / 1000 / 10;
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

        const ambientLux = clamp(8000 + 4500 * Math.sin(timeRadians), 0, 64000);
        const ambientRaw = clamp(Math.round(ambientLux * 1.25), 0, 0xFFFFF);
        dataView.setUint8(bytePos, ambientRaw & 0xFF);
        dataView.setUint8(bytePos + 1, (ambientRaw >> 8) & 0xFF);
        dataView.setUint8(bytePos + 2, (ambientRaw >> 16) & 0x0F);

        const uviIndex = clamp(3.5 + 1.8 * Math.sin(timeRadians + Math.PI / 3), 0, 12);
        const uviRaw = clamp(Math.round(uviIndex * 24), 0, 0xFFFF);
        dataView.setUint16(bytePos + 3, uviRaw, true);

        return true;
      }
      case "VL53L4CD": {
        if (dataBlockSizeBytes < 3) {
          return false;
        }

        const rangeMinMm = 40;
        const rangeMaxMm = 1300;
        const cycleMs = 9000;
        const timeInCycle = deviceTimeMs % cycleMs;

        // Simulate periods where the sensor reports invalid readings (target lost)
        const invalidReading =
          timeInCycle < 600 ||
          (timeInCycle > 4200 && timeInCycle < 5100) ||
          (timeInCycle > 7800);
        const isValid = !invalidReading;

        // Generate a smooth oscillating distance while valid
        const phase = (deviceTimeMs % cycleMs) / cycleMs;
        const smoothWave = 0.5 * (1 - Math.cos(phase * 2 * Math.PI));
        const slowDrift = 0.05 * Math.sin(deviceTimeMs / 5000);
        const fastRipple = 0.02 * Math.sin(deviceTimeMs / 200);
        const normalized = Math.min(1, Math.max(0, smoothWave + slowDrift + fastRipple));
        let distanceMm = Math.round(rangeMinMm + normalized * (rangeMaxMm - rangeMinMm));

        // Clamp to the reported range
        distanceMm = Math.max(rangeMinMm, Math.min(rangeMaxMm, distanceMm));

        if (!isValid) {
          distanceMm = 0;
        }

        const statusRaw = isValid ? 0x00 : 0x04;
        dataView.setUint8(bytePos, statusRaw);
        dataView.setUint16(bytePos + 1, distanceMm, false);

        return true;
      }
      case "RoboticalLEDRing": {
        if (dataBlockSizeBytes < 1) {
          return false;
        }

        const animationPhase = (deviceTimeMs % 6000) / 6000;
        const patternIndex = Math.floor(animationPhase * 6) % 6;
        const brightness = Math.round((Math.sin(deviceTimeMs / 600) + 1) * 127.5);
        const isAnimating = Math.sin(deviceTimeMs / 1500) > 0;
        const status = ((patternIndex & 0x07) << 4) | Math.min(0x0F, brightness >> 4) | (isAnimating ? 0x80 : 0x00);

        dataView.setUint8(bytePos, status & 0xFF);

        return true;
      }
      case "RoboticalDCMotor": {
        if (dataBlockSizeBytes < 4) {
          return false;
        }

        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
        const cycleMs = 3200;
        const cycleIndex = Math.floor(deviceTimeMs / cycleMs);
        const direction = (cycleIndex % 2 === 0) ? 1 : -1;
        const progress = (deviceTimeMs % cycleMs) / cycleMs;
        const baseAngle = (progress * 360) - 180;
        const angleDegrees = direction > 0 ? baseAngle : -baseAngle;

        const angleRaw = clamp(Math.round(angleDegrees * 10), -1800, 1800);
        const ripple = 6 * Math.sin((deviceTimeMs % cycleMs) / 180);
        const loadComponent = Math.abs(baseAngle) * 0.12;
        const currentRaw = clamp(Math.round(24 + loadComponent + ripple), -128, 127);

        const highLoad = Math.abs(loadComponent) > 8;
        const directionBit = direction > 0 ? 0x01 : 0x00;
        const stateRaw = 0x02 | directionBit | (highLoad ? 0x04 : 0x00);

        dataView.setInt16(bytePos, angleRaw, false);
        dataView.setInt8(bytePos + 2, currentRaw);
        dataView.setUint8(bytePos + 3, stateRaw);

        return true;
      }
      case "RoboticalServo": {
        if (dataBlockSizeBytes < 6) {
          return false;
        }

        const swingAmplitudeDeg = 90;
        const cycleMs = 4000;
        const angularSpeedRadPerMs = (2 * Math.PI) / cycleMs;
        const phaseRadians = (deviceTimeMs % cycleMs) * angularSpeedRadPerMs;

        const angleDegrees = swingAmplitudeDeg * Math.sin(phaseRadians);
        const velocityDegPerSec = swingAmplitudeDeg * angularSpeedRadPerMs * 1000 * Math.cos(phaseRadians);
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

        const angleRaw = clamp(Math.round(angleDegrees * 10), -1800, 1800);
        let velocityRaw = Math.round(velocityDegPerSec);
        velocityRaw = clamp(velocityRaw, -32768, 32767);

        let currentRaw = Math.round(20 + 0.08 * Math.abs(velocityDegPerSec));
        currentRaw = clamp(currentRaw, 0, 127);

        const isMoving = Math.abs(velocityDegPerSec) > 5;
        const stateRaw = (0x02) | (isMoving ? 0x01 : 0);

        dataView.setInt16(bytePos, angleRaw, false);
        dataView.setInt8(bytePos + 2, currentRaw);
        dataView.setUint8(bytePos + 3, stateRaw);
        dataView.setInt16(bytePos + 4, velocityRaw, false);

        return true;
      }
      default:
        return false;
    }
  }

  private _getGridDimensions(attr: any, repeatCount: number): { rows: number; cols: number } {
    if (attr && typeof attr.resolution === "string") {
      const match = attr.resolution.match(/(\d+)\s*x\s*(\d+)/i);
      if (match) {
        const rows = parseInt(match[1], 10);
        const cols = parseInt(match[2], 10);
        if (rows > 0 && cols > 0) {
          return { rows, cols };
        }
      }
    }

    const side = Math.round(Math.sqrt(repeatCount));
    if (side > 0 && side * side === repeatCount) {
      return { rows: side, cols: side };
    }

    return { rows: repeatCount, cols: 1 };
  }

  private _prepareRawValue(attr: any, typeCode: string, scaledValue: number): number {
    if (this._isFloatType(typeCode)) {
      return scaledValue;
    }

    let raw = scaledValue;

    if (attr && typeof attr.a === "number") {
      raw -= attr.a;
    }
    if (attr && typeof attr.d === "number") {
      raw *= attr.d;
    }
    if (attr && typeof attr.s === "number" && attr.s !== 0) {
      const shift = attr.s;
      const shiftFactor = Math.pow(2, Math.abs(shift));
      if (shift > 0) {
        raw *= shiftFactor;
      } else {
        raw /= shiftFactor;
      }
    }

    return Math.round(raw);
  }

  private _writeRawValueToBuffer(
    dataView: DataView,
    bytePos: number,
    typeCode: string,
    littleEndian: boolean,
    rawValue: number
  ): number {
    const valueSize = this._byteSizeForType(typeCode);
    if (valueSize <= 0 || bytePos + valueSize > dataView.byteLength) {
      return -1;
    }

    switch (typeCode) {
      case "b":
        dataView.setInt8(bytePos, this._clampRawValue(rawValue, typeCode));
        break;
      case "c":
        dataView.setInt8(bytePos, this._clampRawValue(rawValue, typeCode));
        break;
      case "B":
      case "C":
        dataView.setUint8(bytePos, this._clampRawValue(rawValue, typeCode));
        break;
      case "?":
        dataView.setUint8(bytePos, rawValue ? 1 : 0);
        break;
      case "h":
        dataView.setInt16(bytePos, this._clampRawValue(rawValue, typeCode), littleEndian);
        break;
      case "H":
        dataView.setUint16(bytePos, this._clampRawValue(rawValue, typeCode), littleEndian);
        break;
      case "i":
      case "l":
        dataView.setInt32(bytePos, this._clampRawValue(rawValue, typeCode), littleEndian);
        break;
      case "I":
      case "L":
        dataView.setUint32(bytePos, this._clampRawValue(rawValue, typeCode), littleEndian);
        break;
      case "f":
        dataView.setFloat32(bytePos, rawValue, littleEndian);
        break;
      case "d":
        dataView.setFloat64(bytePos, rawValue, littleEndian);
        break;
      default:
        RaftLog.warn(`RaftChannelSimulated._writeRawValueToBuffer - unsupported attribute type ${typeCode}`);
        return -1;
    }

    return bytePos + valueSize;
  }

  private _byteSizeForType(typeCode: string): number {
    switch (typeCode) {
      case "b":
      case "B":
      case "c":
      case "C":
      case "?":
        return 1;
      case "h":
      case "H":
        return 2;
      case "i":
      case "I":
      case "l":
      case "L":
      case "f":
        return 4;
      case "d":
        return 8;
      default:
        return 0;
    }
  }

  private _clampRawValue(rawValue: number, typeCode: string): number {
    const value = Math.round(rawValue);

    switch (typeCode) {
      case "b":
      case "c":
        return Math.max(-128, Math.min(127, value));
      case "B":
      case "C":
      case "?":
        return Math.max(0, Math.min(255, value));
      case "h":
        return Math.max(-32768, Math.min(32767, value));
      case "H":
        return Math.max(0, Math.min(65535, value));
      case "i":
      case "l":
        return Math.max(-2147483648, Math.min(2147483647, value));
      case "I":
      case "L":
        return Math.max(0, Math.min(4294967295, value));
      default:
        return value;
    }
  }

  private _isFloatType(typeCode: string): boolean {
    return typeCode === "f" || typeCode === "d";
  }

  // Helper function to convert bytes to hex string
  private _bytesToHexStr(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  // Simulated device type information - this is a copy of part of DeviceTypeInfo in RaftCore
  private _deviceTypeInfo: DeviceTypeInfoRecs = 
  {
    "AMG8833": {
      "name": "AMG8833",
      "desc": "Thermal Camera",
      "manu": "Panasonic",
      "type": "AMG8833",
      "clas": ["TCAM"],
      "resp": {
          "b": 128,
          "a": [
              {
                  "n": "temp",
                  "t": "<h[64]",
                  "resolution": "8x8",
                  "u": "&deg;C",
                  "r": [-55, 125],
                  "s": -4,
                  "d": 64,
                  "f": ".2f",
                  "o": "float"
              }
          ]
       }
    },
    "LSM6DS": {
      "name": "LSM6DS",
      "desc": "6-Axis IMU",
      "manu": "ST",
      "type": "LSM6DS",
      "clas": ["ACC","GYRO"],
      "resp": {
          "b": 12,
          "a": [
              {
                  "n": "gx",
                  "t": "<h",
                  "u": "&deg;/s",
                  "r": [-2000, 2000],
                  "d": 16.384,
                  "f": ".2f",
                  "o": "float"
              },
              {
                  "n": "gy",
                  "t": "<h",
                  "u": "&deg;/s",
                  "r": [-2000, 2000],
                  "d": 16.384,
                  "f": ".2f",
                  "o": "float"
              },
              {
                  "n": "gz",
                  "t": "<h",
                  "u": "&deg;/s",
                  "r": [-2000, 2000],
                  "d": 16.384,
                  "f": ".2f",
                  "o": "float"
              },
              {
                  "n": "ax",
                  "t": "<h",
                  "u": "g",
                  "r": [-4.0, 4.0],
                  "d": 8192,
                  "f": ".2f",
                  "o": "float"
              },
              {
                  "n": "ay",
                  "t": "<h",
                  "u": "g",
                  "r": [-4.0,4.0],
                  "d": 8192,
                  "f": ".2f",
                  "o": "float"
              },
              {
                  "n": "az",
                  "t": "<h",
                  "u": "g",
                  "r": [-4.0,4.0],
                  "d": 8192,
                  "f": ".2f",
                  "o": "float"
              }
          ]
       }
    },
    "LTR-329": {
      "name": "LTR-329",
      "desc": "Visible light and IR Sensor",
      "manu": "Lite On",
      "type": "LTR-329",
      "clas": ["LGHT"],
      "resp": {
        "b": 4,
        "a": [
          {
            "n": "ir",
            "t": "<h",
            "u": "lux",
            "r": [0, 64000],
            "f": "d",
            "o": "uint16"
          },
          {
            "n": "visible",
            "t": "<h",
            "u": "lux",
            "r": [0, 64000],
            "f": "d",
            "o": "uint16"
          }
        ],
        "c": {
          "n": "ltr329_light_calc",
          "c": "int combined = buf[0] + (((uint16_t)buf[1])<<8); out.ir = buf[2] + (((uint16_t)buf[3])<<8); out.visible = combined - out.ir;",
          "j": "let combined = buf[0] + (buf[1] << 8); let ir = buf[2] + (buf[3] << 8); attrValues['ir'].push(ir); attrValues['visible'].push(Math.max(0, combined - ir));"
        }
      }
    },
    "LTR-390": {
      "name": "LTR-390",
      "desc": "UV and Visible light sensor",
      "manu": "Lite On",
      "type": "LTR-390",
      "clas": ["LGHT"],
      "resp": {
        "b": 5,
        "a": [
          {
            "n": "ambient",
            "t": "<H",
            "u": "lux",
            "r": [0, 64000],
            "d": 1.25,
            "f": ".2f",
            "o": "float"
          },
          {
            "n": "UVI",
            "at": 3,
            "t": "<H",
            "u": "index",
            "r": [0, 64000],
            "d": 24,
            "f": ".3f",
            "o": "float"
          }
        ]
      },
      "actions": []
    },
    "VL53L4CD": {
      "name": "VL53L4CD",
      "desc": "ToF distance sensor with range 0-1.3m",
      "manu": "ST",
      "type": "VL53L4CD",
      "clas": ["DIST"],
      "resp": {
        "b": 3,
        "a": [
          {
            "n": "valid",
            "t": "B",
            "u": "",
            "r": [0, 1],
            "m": "0x04",
            "x": "0x04",
            "s": 2,
            "f": "b",
            "o": "bool",
            "vs": false
          },
          {
            "n": "dist",
            "t": ">H",
            "u": "mm",
            "r": [0, 65535],
            "f": "3d",
            "o": "uint16",
            "vft": "valid"
          }
        ],
        "us": 100000
      }
    },
    "RoboticalServo": {
      "name": "Robotical Servo",
      "desc": "Servo",
      "manu": "Robotical",
      "type": "RoboticalServo",
      "clas": ["SRVO"],
      "resp": {
        "b": 6,
        "a": [
          {
            "n": "angle",
            "t": ">h",
            "r": [-180.0, 180.0],
            "f": ".1f",
            "d": 10,
            "o": "int16",
            "u": "degrees"
          },
          {
            "n": "current",
            "t": "b",
            "r": [-128, 127],
            "f": "d",
            "o": "int8"
          },
          {
            "n": "state",
            "t": "B",
            "r": [0, 255],
            "f": "02x",
            "o": "uint8"
          },
          {
            "n": "velocity",
            "t": ">h",
            "r": [-32768, 32767],
            "f": "d",
            "o": "int16"
          }
        ]
      },
      "actions": [
        {
          "n": "angle",
          "t": ">h",
          "w": "0001",
          "wz": "0064",
          "f": ".1f",
          "mul": 10,
          "sub": 0,
          "r": [-180.0, 180.0],
          "d": 0
        },
        {
          "n": "enable",
          "t": "B",
          "w": "20",
          "f": "b",
          "r": [0, 1],
          "d": 1
        }
      ]
    },
    "RoboticalDCMotor": {
      "name": "Robotical DC Motor",
      "desc": "DCmotor",
      "manu": "Robotical",
      "type": "RoboticalDCMotor",
      "clas": ["MOTR"],
      "resp": {
        "b": 4,
        "a": [
          {
            "n": "angle",
            "t": ">h",
            "r": [-180.0, 180.0],
            "f": ".1f",
            "d": 10,
            "o": "int16",
            "u": "degrees"
          },
          {
            "n": "current",
            "t": "b",
            "r": [-128, 127],
            "f": "d",
            "o": "int8"
          },
          {
            "n": "state",
            "t": "B",
            "r": [0, 255],
            "f": "02x",
            "o": "uint8"
          }
        ]
      },
      "actions": [
        {
          "n": "power",
          "t": ">h",
          "w": "0001",
          "wz": "0064",
          "f": ".1f",
          "mul": 10,
          "sub": 0,
          "r": [-180.0,180.0],
          "d": 0
        },
        {
          "n": "enable",
          "t": "B",
          "w": "20",
          "f": "b",
          "r": [0,1],
          "d": 1
        }
      ]
    },
    "RoboticalLEDRing": {
      "name": "Robotical LED Ring",
      "desc": "12 RGB LED Ring",
      "manu": "Robotical",
      "type": "RoboticalLEDRing",
      "clas": ["LED"],
      "resp": {
        "b": 1,
        "a": [
          {
            "n": "status",
            "t": "B",
            "r": [0, 255],
            "f": "02x",
            "o": "uint8"
          }
        ]
      },
      "actions": [
        {
          "n": "pixels",
          "t": "BBBB",
          "w": "04",
          "f": "LEDPIX",
          "NX": 3,
          "NY": 1,
          "concat": false,
          "r": [0,255]
        },
        {
          "n": "brightness",
          "t": "B",
          "w": "FF01",
          "wz": "&p100",
          "f": "b",
          "r": [0,255],
          "d": 100
        }
      ]
    }
  };
 
}