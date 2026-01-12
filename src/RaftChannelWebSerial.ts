/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftChannelWebSerial
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import RaftChannel from "./RaftChannel";
import RaftMsgHandler from "./RaftMsgHandler";
import RaftLog from "./RaftLog";
import { RaftConnEvent, RaftConnEventFn } from "./RaftConnEvents";
import { ConnectorOptions } from "./RaftSystemType";

type TWebParityType = 'none' | 'even' | 'odd';
type TWebFlowControlType = 'none' | 'hardware';

interface TWebSerialOptions {
  baudRate: number;
  dataBits?: number | undefined;
  stopBits?: number | undefined;
  parity?: TWebParityType | undefined;
  bufferSize?: number | undefined;
  flowControl?: TWebFlowControlType | undefined;
}

declare class TWebSerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;

  open(options: TWebSerialOptions): Promise<void>;
  close(): Promise<void>;
  forget(): Promise<void>;

  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (this: this, ev: Event) => any,
    useCapture?: boolean): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    callback: (this: this, ev: Event) => any,
    useCapture?: boolean): void;
  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean): void;
}

interface TWebSerialPortFilter {
  usbVendorId?: number | undefined;
  usbProductId?: number | undefined;
}

interface TWebSerialPortRequestOptions {
  filters?: TWebSerialPortFilter[] | undefined;
}

declare class TWebSerial extends EventTarget {
  requestPort(options?: TWebSerialPortRequestOptions): Promise<TWebSerialPort>;
}

interface NavigatorWithSerial {
  readonly serial: TWebSerial;
}

export default class RaftChannelWebSerial implements RaftChannel {

  // Message handler
  private _raftMsgHandler: RaftMsgHandler | null = null;

  private _port: TWebSerialPort | null = null;
  private _reader?: ReadableStreamDefaultReader<Uint8Array>;

  // Last message tx time
  // private _msgTxTimeLast = Date.now();
  // private _msgTxMinTimeBetweenMs = 15;

  // Is connected
  private _isConnected = false;
  private _connPaused = false;

  private _serialBuffer: number[] = [];

  private _escapeSeqCode = 0;
  private _OVERASCII_ESCAPE_1 = 0x85;
  private _OVERASCII_ESCAPE_2 = 0x8E;
  private _OVERASCII_ESCAPE_3 = 0x8F;
  private _OVERASCII_MOD_CODE = 0x20;

  // Conn event fn
  private _onConnEvent: RaftConnEventFn | null = null;

  // File Handler parameters
  private _requestedBatchAckSize = 1;
  private _requestedFileBlockSize = 1200;

  fhBatchAckSize(): number { return this._requestedBatchAckSize; }
  fhFileBlockSize(): number { return this._requestedFileBlockSize; }

  // isConnected
  isConnected(): boolean {
    return this._isConnected;
  }

  // Set message handler
  setMsgHandler(raftMsgHandler: RaftMsgHandler): void {
    this._raftMsgHandler = raftMsgHandler;
  }

  // Serial interface will require subscription, but don't start it by default
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
    return this._port || "";
  }

  // Connect to a device
  async connect(locator: string | object, _connectorOptions: ConnectorOptions): Promise<boolean> {
    console.log("_connectorOptions", _connectorOptions);
    // Debug
    RaftLog.debug("RaftChannelWebSerial.connect " + locator.toString());

    // Check already connected
    if (await this.isConnected()) {
      return true;
    }

    try {
      if (('serial' in navigator) && (!this._port || locator != "reusePort")) {
        const port = await (navigator as NavigatorWithSerial).serial.requestPort();
        this._port = port;
      }
      // Connect
      if (!this._port)
        return false;

      try {
        RaftLog.info("opening port");
        await this._port.open({ baudRate: 115200 });
      } catch (err: any) {
        if (err.name == "InvalidStateError") {
          RaftLog.debug(`Opening port failed - already open ${err}`);
        } else {
          RaftLog.warn(`Opening port failed: ${err}`);
          throw err;
        }
      }

      this._isConnected = true;

      // start read loop
      this._readLoop();

      this._port.addEventListener('disconnect', (event) => {
        RaftLog.debug("WebSerial disconnect " + JSON.stringify(event));
        if (this._onConnEvent)
          this._onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
      });
      // TODO: handle errors
    } catch (err) {
      RaftLog.warn("RaftChannelWebSerial.connect fail. Error: " + JSON.stringify(err));
      return false;
    }

    return true;
  }

  // Disconnect
  async disconnect(): Promise<void> {

    // Not connected
    this._isConnected = false;

    RaftLog.debug(`RaftChannelWebSerial.disconnect attempting to close webserial`);

    while (this._reader) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Disconnect webserial
    try {
      if (this._port)
        await this._port.close();
    } catch (err) {
      console.debug(`Error closing port ${err}`);
    }
    if (this._onConnEvent)
      this._onConnEvent(RaftConnEvent.CONN_DISCONNECTED);

    RaftLog.debug("WebSerial port closed");
    return;
  }

  pauseConnection(pause: boolean): void {
    this._connPaused = pause;
  }

  private _overasciiDecodeByte(ch: number) {
    // Check if in escape sequence
    if (this._escapeSeqCode != 0) {
      const prevEscCode = this._escapeSeqCode;
      this._escapeSeqCode = 0;
      if (prevEscCode == 1) {
        return (ch ^ this._OVERASCII_MOD_CODE) & 0x7f;
      } else if (prevEscCode == 2) {
        return ch ^ this._OVERASCII_MOD_CODE;
      }
      return ch;
    } else if (ch == this._OVERASCII_ESCAPE_1) {
      this._escapeSeqCode = 1;
      return -1;
    } else if (ch == this._OVERASCII_ESCAPE_2) {
      this._escapeSeqCode = 2;
      return -1;
    } else if (ch == this._OVERASCII_ESCAPE_3) {
      this._escapeSeqCode = 3;
      return -1;
    } else {
      return ch & 0x7f;
    }
  }

  private _overasciiEncode(inData: Uint8Array) {
    /*
    Encode frame
    Values 0x00-0x0F map to ESCAPE_CODE_1, VALUE_XOR_20H_AND_MSB_SET
    Values 0x10-0x7f map to VALUE_WITH_MSB_SET
    Values 0x80-0x8F map to ESCAPE_CODE_2, VALUE_XOR_20H
    Values 0x90-0xff map to ESCAPE_CODE_3, VALUE
    Value ESCAPE_CODE_1 maps to ESCAPE_CODE_1 + VALUE
    Args:
      inData: data to encode (bytes)
    Returns:
      encoded frame (bytes)
    */
    // Iterate over frame
    const encodedFrame: number[] = [];
    for (let i = 0; i < inData.length; i++) {
      if (inData[i] <= 0x0f) {
        encodedFrame.push(this._OVERASCII_ESCAPE_1);
        encodedFrame.push((inData[i] ^ this._OVERASCII_MOD_CODE) | 0x80);
      } else if ((inData[i] >= 0x10) && (inData[i] <= 0x7f)) {
        encodedFrame.push(inData[i] | 0x80);
      } else if ((inData[i] >= 0x80) && (inData[i] <= 0x8f)) {
        encodedFrame.push(this._OVERASCII_ESCAPE_2);
        encodedFrame.push(inData[i] ^ this._OVERASCII_MOD_CODE);
      } else {
        encodedFrame.push(this._OVERASCII_ESCAPE_3);
        encodedFrame.push(inData[i]);
      }
    }
    return new Uint8Array(encodedFrame);
  }


  // Handle notifications
  _onMsgRx(msg: Uint8Array | null): void {

    if (msg === null) return;
    // Debug
    //const decoder = new TextDecoder();
    //RaftLog.debug(`RaftChannelWebSerial._onMsgRx ${decoder.decode(msg)}`);

    const overasciiBuffer: number[] = [];
    for (let i = 0; i < msg.length; i++) {
      if (msg[i] > 127) {
        const ch = this._overasciiDecodeByte(msg[i]);
        if (ch != -1) {
          overasciiBuffer.push(ch);
        }
      } else {
        this._serialBuffer.push(msg[i]);
      }
    }
    if (this._raftMsgHandler)
      this._raftMsgHandler.handleNewRxMsg(new Uint8Array(overasciiBuffer));

    // any output over the non overascii channel will be delimited by a new line character
    // scan for this, and log any lines as they occur before removing them from the buffer
    if (this._serialBuffer.includes(0x0a)) {
      const decoder = new TextDecoder();
      RaftLog.debug(decoder.decode(new Uint8Array(this._serialBuffer.slice(0, this._serialBuffer.indexOf(0x0a)))));
      this._serialBuffer.splice(0, this._serialBuffer.indexOf(0x0a) + 1);
    }
  }

  // Send a message
  async sendTxMsg(
    msg: Uint8Array,
    sendWithResponse: boolean
  ): Promise<boolean> {

    // Check connected
    if (!this._isConnected || !this._port)
      return false;

    // Debug
    const decoder = new TextDecoder();
    RaftLog.verbose(`RaftChannelWebSerial.sendTxMsg ${msg.toString()} ${decoder.decode(msg)} sendWithResp ${sendWithResponse.toString()}`);

    try {
      if (this._port.writable != null) {
        const writer = this._port.writable.getWriter();
        await writer.write(this._overasciiEncode(msg));
        writer.releaseLock();
      }
    } catch (err) {
      RaftLog.warn("sendMsg error: " + JSON.stringify(err));
      return false;
    }
    return true;
  }

  async sendTxMsgNoAwait(
    msg: Uint8Array,
    sendWithResponse: boolean
  ): Promise<boolean> {

    // Check connected
    if (!this._isConnected || !this._port)
      return false;

    // Debug
    RaftLog.verbose(`RaftChannelWebSerial.sendTxMsgNoAwait ${msg.toString()} sendWithResp ${sendWithResponse.toString()}`);

    try {
      if (this._port.writable != null) {
        const writer = this._port.writable.getWriter();
        writer.write(msg).then(() => { writer.releaseLock(); });
      }
    } catch (err) {
      RaftLog.warn("sendMsg error: " + JSON.stringify(err));
    }

    return true;
  }

  async _readLoop() {
    RaftLog.debug("Starting read loop");

    if (!this._port)
      return;

    let retries = 10;
    try {
      if (!this._port.readable) {
        RaftLog.warn("RaftChannelWebSerial _readLoop port is not readble");
        return;
      }
      this._reader = this._port.readable.getReader();
      while (this._port.readable && this._isConnected) {
        if (this._connPaused) {
          if (this._reader) {
            this._reader.releaseLock();
            this._reader = undefined;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        try {
          if (!this._reader) this._reader = this._port.readable.getReader();
          const { value, done } = await this._reader.read();
          if (done) {
            this._reader.releaseLock();
            break;
          }
          if (!value || value.length === 0) {
            continue;
          }

          this._onMsgRx(new Uint8Array(value));
        } catch (err) {
          RaftLog.warn("read loop issue: " + JSON.stringify(err));
          retries -= 1;
          if (!retries) break;
          await new Promise(resolve => setTimeout(resolve, 100));
          this._reader = this._port.readable.getReader();
        }
      }
      if (this._reader) this._reader.releaseLock();
      this._reader = undefined;
    } catch (err) {
      RaftLog.warn("Read loop got disconnected. err: " + JSON.stringify(err));
    }
    // Disconnected!
    this._isConnected = false;
    RaftLog.debug("Finished read loop");
  }

  // Method used for testing and simulation should never be called
  sendTxMsgRaw(): boolean {
    RaftLog.debug(`sendTxMsgRaw - not implemented`);
    return false;
  }

  // Method used for testing and simulation should never be called
  sendTxMsgRawAndWaitForReply<T>(): T {
    RaftLog.debug(`sendTxMsgRawAndWaitForReply - not implemented`);
    return null as T;
  }  
}