/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RICJS
// Communications Library
//
// Rob Dobson & Chris Greening 2020-2022
// (C) 2020-2022
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export default class RICCommsStats {

  _msgSmartServos = 0;
  _msgIMU = 0;
  _msgPowerStatus = 0;
  _msgAddOnPub = 0;
  _msgRobotStatus = 0;

  _msgSmartServosPS = 0;
  _msgIMUPS = 0;
  _msgPowerStatusPS = 0;
  _msgAddOnPubPS = 0;
  _msgRobotStatusPS = 0;

  _msgSmartServosCountInWindow = 0;
  _msgIMUCountInWindow = 0;
  _msgPowerStatusCountInWindow = 0;
  _msgAddOnPubCountInWindow = 0;
  _msgRobotStatusCountInWindow = 0;

  _msgSmartServosLastCalcMs = 0;
  _msgIMULastCalcMs = 0;
  _msgPowerStatusLastCalcMs = 0;
  _msgAddOnPubLastCalcMs = 0;
  _msgRobotStatusLastCalcMs = 0;

  _msgOtherTopic = 0;

  _rosSerialRxRate = 0;
  _rosSerialRxTotalBytes = 0;
  _rosSerialRxTotalTimeMs = 0;

  clear() {
    this._msgSmartServos = 0;
    this._msgIMU = 0;
    this._msgPowerStatus = 0;
    this._msgAddOnPub = 0;
    this._msgRobotStatus = 0;
    this._msgSmartServosPS = 0;
    this._msgIMUPS = 0;
    this._msgPowerStatusPS = 0;
    this._msgAddOnPubPS = 0;
    this._msgRobotStatusPS = 0;
    this._msgSmartServosCountInWindow = 0;
    this._msgIMUCountInWindow = 0;
    this._msgPowerStatusCountInWindow = 0;
    this._msgAddOnPubCountInWindow = 0;
    this._msgRobotStatusCountInWindow = 0;
    this._msgSmartServosLastCalcMs = Date.now();
    this._msgIMULastCalcMs = Date.now();
    this._msgPowerStatusLastCalcMs = Date.now();
    this._msgAddOnPubLastCalcMs = Date.now();
    this._msgRobotStatusLastCalcMs = Date.now();
    this._rosSerialRxRate = 0;
    this._rosSerialRxTotalBytes = 0;
    this._rosSerialRxTotalTimeMs = 0;
  }

  getSmartServosRate(): number {
    if (this._msgSmartServosLastCalcMs + 1000 < Date.now()) {
      this._msgSmartServosPS =
        (1000.0 * this._msgSmartServosCountInWindow) /
        (Date.now() - this._msgSmartServosLastCalcMs);
      this._msgSmartServosLastCalcMs = Date.now();
      this._msgSmartServosCountInWindow = 0;
    }
    return this._msgSmartServosPS;
  }

  getIMURate(): number {
    if (this._msgIMULastCalcMs + 1000 < Date.now()) {
      this._msgIMUPS =
        (1000.0 * this._msgIMUCountInWindow) /
        (Date.now() - this._msgIMULastCalcMs);
      this._msgIMULastCalcMs = Date.now();
      this._msgIMUCountInWindow = 0;
    }
    return this._msgIMUPS;
  }

  getPowerStatusRate(): number {
    if (this._msgPowerStatusLastCalcMs + 1000 < Date.now()) {
      this._msgPowerStatusPS =
        (1000.0 * this._msgPowerStatusCountInWindow) /
        (Date.now() - this._msgPowerStatusLastCalcMs);
      this._msgPowerStatusLastCalcMs = Date.now();
      this._msgPowerStatusCountInWindow = 0;
    }
    return this._msgPowerStatusPS;
  }

  getAddOnPubRate(): number {
    if (this._msgAddOnPubLastCalcMs + 1000 < Date.now()) {
      this._msgAddOnPubPS =
        (1000.0 * this._msgAddOnPubCountInWindow) /
        (Date.now() - this._msgAddOnPubLastCalcMs);
      this._msgAddOnPubLastCalcMs = Date.now();
      this._msgAddOnPubCountInWindow = 0;
    }
    return this._msgAddOnPubPS;
  }

  getRobotStatusRate(): number {
    if (this._msgRobotStatusLastCalcMs + 1000 < Date.now()) {
      this._msgRobotStatusPS =
        (1000.0 * this._msgRobotStatusCountInWindow) /
        (Date.now() - this._msgRobotStatusLastCalcMs);
      this._msgRobotStatusLastCalcMs = Date.now();
      this._msgRobotStatusCountInWindow = 0;
    }
    return this._msgRobotStatusPS;
  }

  getROSSerialRate(): number {
    if (this._rosSerialRxTotalTimeMs > 0) {
      return (
        (1000.0 * this._rosSerialRxTotalBytes) / this._rosSerialRxTotalTimeMs
      );
    }
    return 0;
  }

  recordSmartServos(): void {
    this._msgSmartServos++;
    this._msgSmartServosCountInWindow++;
  }

  recordIMU(): void {
    this._msgIMU++;
    this._msgIMUCountInWindow++;
    // Don't call msgRx() as double counting msgs with smartServos
  }

  recordPowerStatus(): void {
    this._msgPowerStatus++;
    this._msgPowerStatusCountInWindow++;
  }

  recordAddOnPub(): void {
    this._msgAddOnPub++;
    this._msgAddOnPubCountInWindow++;
  }

  recordRobotStatus(): void {
    this._msgRobotStatus++;
    this._msgRobotStatusCountInWindow++;
  }

  recordOtherTopic(): void {
    this._msgOtherTopic++;
  }

  updateROSSerialRxRate(frameLen: number, timeMs: number): void {
    if ((frameLen != 0) && (timeMs != 0)) {
      this._rosSerialRxRate = (1000*frameLen) / timeMs;
      this._rosSerialRxTotalTimeMs += timeMs;
      this._rosSerialRxTotalBytes += frameLen;
    }
  }
}
