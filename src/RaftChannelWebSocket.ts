/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftChannelWebSockets
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import RaftChannel from "./RaftChannel";
import WebSocket from "isomorphic-ws";
import RaftMsgHandler from "./RaftMsgHandler";
import RaftLog from "./RaftLog";
import RaftUtils from "./RaftUtils";
import { RaftConnEvent, RaftConnEventFn } from "./RaftConnEvents";
import { ConnectorOptions } from "./RaftSystemType";

export default class RaftChannelWebSocket implements RaftChannel {

  // Message handler
  private _raftMsgHandler: RaftMsgHandler | null = null;

  // Websocket we are connected to
  private _webSocket: WebSocket | null = null;

  // URL used by the current WebSocket connection
  private _connectedLocator = "";

  // Last message tx time
  // private _msgTxTimeLast = Date.now();
  // private _msgTxMinTimeBetweenMs = 15;

  // Is connected
  private _isConnected = false;

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
    return this._connectedLocator;
  }

  // Connect to a device
  async connect(locator: string | object, connectorOptions: ConnectorOptions): Promise<boolean> {

    // Debug
    const locatorStr = locator.toString();
    RaftLog.debug("RaftChannelWebSocket.connect " + locatorStr);

    // Get ws suffix
    const wsSuffix = connectorOptions ? (connectorOptions.wsSuffix ? connectorOptions.wsSuffix : "ws") : "ws";

    // A complete WebSocket URL is authoritative. Bare host locators retain the
    // legacy behaviour of using ws:// and the system type's configured suffix.
    const wsURL = /^wss?:\/\//i.test(locatorStr)
      ? locatorStr
      : "ws://" + locatorStr + "/" + wsSuffix;

    // Connect
    const connOk = await this._wsConnect(wsURL);
    return connOk;
  }

  // Disconnect
  async disconnect(): Promise<void> {
    
    // Not connected
    this._isConnected = false;
    this._connectedLocator = "";
    
    // Disconnect websocket
    this._webSocket?.close(1000);

    // Debug
    RaftLog.debug(`RaftChannelWebSocket.disconnect attempting to close websocket`);
  }

  pauseConnection(pause: boolean): void { RaftLog.verbose(`pauseConnection ${pause} - no effect for this channel type`); return; }

  // Handle notifications
  _onMsgRx(msg: Uint8Array | null): void {

    // Debug
    if (msg !== null) {
      RaftLog.verbose(`RaftChannelWebSocket._onMsgRx ${RaftUtils.bufferToHex(msg)}`);
    }

    // Handle message
    if (msg !== null && this._raftMsgHandler) {
      this._raftMsgHandler.handleNewRxMsg(msg);
    }

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
    RaftLog.verbose(`RaftChannelWebSocket.sendTxMsg ${msg.toString()} sendWithResp ${sendWithResponse.toString()}`);

    // Send over websocket
    try {
      await this._webSocket?.send(msg);
    } catch (error: unknown) {
      RaftLog.warn(`RaftChannelWebSocket.sendTxMsg - send failed ${error}`);
      return false;
    }
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
    RaftLog.verbose(`RaftChannelWebSocket.sendTxMsgNoAwait ${msg.toString()} sendWithResp ${sendWithResponse.toString()}`);

    // Send over websocket
    this._webSocket?.send(msg);

    return true;
  }

  async _wsConnect(locator: string | object): Promise<boolean> {

    // Check already connected
    if (await this.isConnected()) {
      return true;
    }

    // Form websocket address
    const wsURL = locator.toString();

    // Capture and deliberately close any existing socket before replacement.
    // Detach its handlers first so a late close event from the obsolete socket
    // cannot clear the replacement socket's shared state.
    const existingSocket = this._webSocket;
    this._webSocket = null;
    if (existingSocket) {
      RaftLog.verbose(`[RaftChannelWebSocket._wsConnect] Closing existing WebSocket...`);
      try {
        existingSocket.onmessage = () => { /* detached */ };
        existingSocket.onclose = () => { /* detached */ };
        existingSocket.close(1000);
      } catch (e) {
        RaftLog.warn(`[RaftChannelWebSocket._wsConnect] Error closing existing WebSocket: ${e}`);
      }
    }
    return new Promise((resolve: (value: boolean | PromiseLike<boolean>) => void,
      reject: (reason?: unknown) => void) => {
      this._webSocketOpen(wsURL).then((ws) => {
        this._webSocket = ws;
        this._isConnected = true;
        this._connectedLocator = wsURL;
        RaftLog.debug(`_wsConnect - opened connection`);

        // Handle messages (owner check guards against a stale socket's events)
        ws.onmessage = (evt: WebSocket.MessageEvent) => {
          if (this._webSocket !== ws) return;
          // RaftLog.debug("WebSocket rx");
          if (evt.data instanceof ArrayBuffer) {
            const msg = new Uint8Array(evt.data);
            this._onMsgRx(msg);
          }
        }

        // Handle close event - only the socket that still owns the channel may
        // clear shared state and report disconnection; a late close from an
        // obsolete socket must not erase a newer live connection.
        ws.onclose = (evt: WebSocket.CloseEvent) => {
          if (this._webSocket !== ws) {
            RaftLog.info(`_wsConnect - stale socket closed code ${evt.code} - ignored (ownership transferred)`);
            return;
          }
          RaftLog.info(`_wsConnect - closed code ${evt.code} wasClean ${evt.wasClean} reason ${evt.reason}`);
          this._webSocket = null;
          this._isConnected = false;
          this._connectedLocator = "";

          // Event handler
          if (this._onConnEvent) {
            this._onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
          }
        }

        // Resolve the promise - success
        resolve(true);
      }).catch((err: unknown) => {
        this._connectedLocator = "";
        if (err instanceof Error) {
          RaftLog.verbose(`WS open failed ${err.toString()}`)
        }
        // Resolve - failed
        reject(false);
      })
    });
  }

  private async _webSocketOpen(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {

      // Debug
      // RaftLog.debug('Attempting WebSocket connection');

      // Open the socket
      try {
        RaftLog.verbose(`[RaftChannelWebSocket._webSocketOpen] Creating WebSocket: ${url}`);
        const webSocket = new WebSocket(url);

        // Open socket
        webSocket.binaryType = "arraybuffer";
        webSocket.onopen = (_evt: WebSocket.Event) => {
          RaftLog.debug(`RaftChannelWebSocket._webSocketOpen - onopen ${_evt.toString()}`);
          // Shared connected state is assigned by _wsConnect when this socket
          // takes ownership, not here - a socket that never becomes the owner
          // must not mark the channel connected.
          resolve(webSocket);
        };
        webSocket.onerror = (evt: WebSocket.ErrorEvent) => {
          RaftLog.warn(`RaftChannelWebSocket._webSocketOpen - onerror: ${evt.message}`);
          reject(evt);
        };
        webSocket.onclose = (evt: WebSocket.CloseEvent) => {
          RaftLog.info(`[RaftChannelWebSocket._webSocketOpen] onclose fired! code: ${evt.code} reason: ${evt.reason} wasClean: ${evt.wasClean}`);
        };
      } catch (error: unknown) {
        RaftLog.warn(`RaftChannelWebSocket._webSocketOpen - open failed ${error}`);
        reject(error);
      }
    });
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
