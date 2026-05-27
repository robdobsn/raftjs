/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftCommStats
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export default class RaftCommsStats {
  _msgRxCount = 0;
  _msgRxCountInWindow = 0;
  _msgRxLastCalcMs = 0;
  _msgRxRate = 0;
  _msgTooShort = 0;
  _msgTxCount = 0;
  _msgTxCountInWindow = 0;
  _msgTxLastCalcMs = 0;
  _msgTxRate = 0;
  _msgNumCollisions = 0;
  _msgNumUnmatched = 0;
  _msgRoundtripWorstMs = 0;
  _msgRoundtripBestMs = 0;
  _msgRoundtripLastMs = 0;
  _msgTimeout = 0;
  _msgRetry = 0;

  _msgNoConnection = 0;
  _streamBytes = 0;
  _fileBytes = 0;

  clear() {
    this._msgRxCount = 0;
    this._msgRxCountInWindow = 0;
    this._msgRxLastCalcMs = Date.now();
    this._msgRxRate = 0;
    this._msgTooShort = 0;
    this._msgTxCount = 0;
    this._msgTxCountInWindow = 0;
    this._msgTxLastCalcMs = Date.now();
    this._msgTxRate = 0;
    this._msgNumCollisions = 0;
    this._msgNumUnmatched = 0;
    this._msgRoundtripBestMs = 0;
    this._msgRoundtripWorstMs = 0;
    this._msgRoundtripLastMs = 0;
    this._msgTimeout = 0;
    this._msgRetry = 0;
    this._msgNoConnection = 0;
    this._streamBytes = 0;
    this._fileBytes = 0;
  }

  msgRx(): void {
    this._msgRxCount++;
    this._msgRxCountInWindow++;
  }

  getMsgRxRate(): number {
    if (this._msgRxLastCalcMs + 1000 < Date.now()) {
      this._msgRxRate =
        (1000.0 * this._msgRxCountInWindow) /
        (Date.now() - this._msgRxLastCalcMs);
      this._msgRxLastCalcMs = Date.now();
      this._msgRxCountInWindow = 0;
    }
    return this._msgRxRate;
  }

  msgTooShort(): void {
    this._msgTooShort++;
  }

  msgTx(): void {
    this._msgTxCount++;
    this._msgTxCountInWindow++;
  }

  getMsgTxCount(): number {
    return this._msgTxCount;
  }

  getMsgRxCount(): number {
    return this._msgRxCount;
  }

  getMsgTxRate(): number {
    if (this._msgTxLastCalcMs + 1000 < Date.now()) {
      this._msgTxRate =
        (1000.0 * this._msgTxCountInWindow) /
        (Date.now() - this._msgTxLastCalcMs);
      this._msgTxLastCalcMs = Date.now();
      this._msgTxCountInWindow = 0;
    }
    return this._msgTxRate;
  }

  getRTWorstMs(): number {
    return this._msgRoundtripWorstMs;
  }

  getRTLastMs(): number {
    return this._msgRoundtripLastMs;
  }

  getRTBestMs(): number {
    return this._msgRoundtripBestMs;
  }

  getRetries(): number {
    return this._msgRetry;
  }

  recordMsgNumCollision(): void {
    this._msgNumCollisions++;
  }

  recordMsgNumUnmatched(): void {
    this._msgNumUnmatched++;
  }

  recordMsgResp(roundTripMs: number): void {
    if (this._msgRoundtripWorstMs < roundTripMs)
      this._msgRoundtripWorstMs = roundTripMs;
    if (this._msgRoundtripBestMs == 0 || this._msgRoundtripBestMs > roundTripMs)
      this._msgRoundtripBestMs = roundTripMs;
    this._msgRoundtripLastMs = roundTripMs;
  }

  recordMsgTimeout(): void {
    this._msgTimeout++;
  }

  recordMsgNoConnection(): void {
    this._msgNoConnection++;
  }

  recordMsgRetry(): void {
    this._msgRetry++;
  }

  recordStreamBytes(bytes: number): void {
    this._streamBytes += bytes;
  }

  recordFileBytes(bytes: number): void {
    this._fileBytes += bytes;
  }

  /**
   * One-line health summary suitable for periodic DEBUG logging. Includes
   * counters that indicate anomalies (collisions, unmatched, retries,
   * timeouts) plus round-trip latency so an observer can tell at a glance
   * whether the link is healthy without enabling per-message VERBOSE traffic.
   */
  getSummary(): string {
    return (
      `tx ${this._msgTxCount} rx ${this._msgRxCount}` +
      ` txRate ${this.getMsgTxRate().toFixed(1)}/s rxRate ${this.getMsgRxRate().toFixed(1)}/s` +
      ` retries ${this._msgRetry} timeouts ${this._msgTimeout}` +
      ` collisions ${this._msgNumCollisions} unmatched ${this._msgNumUnmatched}` +
      ` noConn ${this._msgNoConnection} tooShort ${this._msgTooShort}` +
      ` rtt last/best/worst ${this._msgRoundtripLastMs}/${this._msgRoundtripBestMs}/${this._msgRoundtripWorstMs}ms` +
      ` stream ${this._streamBytes}B file ${this._fileBytes}B`
    );
  }
}
