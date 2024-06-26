"use strict";
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftCommStats
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
Object.defineProperty(exports, "__esModule", { value: true });
class RaftCommsStats {
    constructor() {
        this._msgRxCount = 0;
        this._msgRxCountInWindow = 0;
        this._msgRxLastCalcMs = 0;
        this._msgRxRate = 0;
        this._msgTooShort = 0;
        this._msgTxCount = 0;
        this._msgTxCountInWindow = 0;
        this._msgTxLastCalcMs = 0;
        this._msgTxRate = 0;
        this._msgNumCollisions = 0;
        this._msgNumUnmatched = 0;
        this._msgRoundtripWorstMs = 0;
        this._msgRoundtripBestMs = 0;
        this._msgRoundtripLastMs = 0;
        this._msgTimeout = 0;
        this._msgRetry = 0;
        this._msgNoConnection = 0;
        this._streamBytes = 0;
        this._fileBytes = 0;
    }
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
    msgRx() {
        this._msgRxCount++;
        this._msgRxCountInWindow++;
    }
    getMsgRxRate() {
        if (this._msgRxLastCalcMs + 1000 < Date.now()) {
            this._msgRxRate =
                (1000.0 * this._msgRxCountInWindow) /
                    (Date.now() - this._msgRxLastCalcMs);
            this._msgRxLastCalcMs = Date.now();
            this._msgRxCountInWindow = 0;
        }
        return this._msgRxRate;
    }
    msgTooShort() {
        this._msgTooShort++;
    }
    msgTx() {
        this._msgTxCount++;
        this._msgTxCountInWindow++;
    }
    getMsgTxRate() {
        if (this._msgTxLastCalcMs + 1000 < Date.now()) {
            this._msgTxRate =
                (1000.0 * this._msgTxCountInWindow) /
                    (Date.now() - this._msgTxLastCalcMs);
            this._msgTxLastCalcMs = Date.now();
            this._msgTxCountInWindow = 0;
        }
        return this._msgTxRate;
    }
    getRTWorstMs() {
        return this._msgRoundtripWorstMs;
    }
    getRTLastMs() {
        return this._msgRoundtripLastMs;
    }
    getRTBestMs() {
        return this._msgRoundtripBestMs;
    }
    getRetries() {
        return this._msgRetry;
    }
    recordMsgNumCollision() {
        this._msgNumCollisions++;
    }
    recordMsgNumUnmatched() {
        this._msgNumUnmatched++;
    }
    recordMsgResp(roundTripMs) {
        if (this._msgRoundtripWorstMs < roundTripMs)
            this._msgRoundtripWorstMs = roundTripMs;
        if (this._msgRoundtripBestMs == 0 || this._msgRoundtripBestMs > roundTripMs)
            this._msgRoundtripBestMs = roundTripMs;
        this._msgRoundtripLastMs = roundTripMs;
    }
    recordMsgTimeout() {
        this._msgTimeout++;
    }
    recordMsgNoConnection() {
        this._msgNoConnection++;
    }
    recordMsgRetry() {
        this._msgRetry++;
    }
    recordStreamBytes(bytes) {
        this._streamBytes += bytes;
    }
    recordFileBytes(bytes) {
        this._fileBytes += bytes;
    }
}
exports.default = RaftCommsStats;
//# sourceMappingURL=RaftCommsStats.js.map