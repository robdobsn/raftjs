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
    return this._webSocket;
  }

  // Connect to a device
  async connect(locator: string | object, connectorOptions: ConnectorOptions): Promise<boolean> {

    // Debug
    RaftLog.debug("RaftChannelWebSocket.connect " + locator.toString());

    // Get ws suffix
    const wsSuffix = connectorOptions ? (connectorOptions.wsSuffix ? connectorOptions.wsSuffix : "ws") : "ws";

    // Connect
    const connOk = await this._wsConnect("ws://" + locator + "/" + wsSuffix);
    return connOk;
  }

  // Disconnect
  async disconnect(): Promise<void> {
    
    // Not connected
    this._isConnected = false;
    
    // Disconnect websocket
    this._webSocket?.close(1000);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Close the websocket
    if (this._webSocket) {
      this._webSocket.onmessage = null;
      this._webSocket.onclose = null;
      this._webSocket.onerror = null;
      this._webSocket = null;
      // Debug
      RaftLog.debug(`RaftChannelWebSocket.disconnect attempting to close websocket`);
    } else {
      RaftLog.debug(`RaftChannelWebSocket.disconnect - websocket already closed`);
    }
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

    // Connect to websocket
    // try {
    //     this._webSocket = await this._webSocketOpen(wsURL);
    // } catch (error: any) {
    //     RaftLog.debug(`Unable to create WebSocket ${error.toString()}`);
    //     return false;
    // }
    this._webSocket = null;
    return new Promise((resolve: (value: boolean | PromiseLike<boolean>) => void,
      reject: (reason?: unknown) => void) => {
      this._webSocketOpen(wsURL).then((ws) => {
        this._webSocket = ws;
        RaftLog.debug(`_wsConnect - opened connection`);

        // Handle messages
        this._webSocket.onmessage = (evt: WebSocket.MessageEvent) => {
          // RaftLog.debug("WebSocket rx");
          if (evt.data instanceof ArrayBuffer) {
            const msg = new Uint8Array(evt.data);
            this._onMsgRx(msg);
          }
        }

        // Handle close event
        this._webSocket.onclose = (evt: WebSocket.CloseEvent) => {
          RaftLog.info(`_wsConnect - closed code ${evt.code} wasClean ${evt.wasClean} reason ${evt.reason}`);
          this._webSocket = null;
          this._isConnected = false;

          // Event handler
          if (this._onConnEvent) {
            this._onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
          }
        }

        // Resolve the promise - success
        resolve(true);
      }).catch((err: unknown) => {
        if (err instanceof Error) {
          RaftLog.warn(`WS open failed: ${err.message}`);
        } else if (err && typeof err === 'object') {
            const errorDetails = JSON.stringify(err, Object.getOwnPropertyNames(err));
            RaftLog.warn(`WS open failed: ${errorDetails}`);
        } else {
            RaftLog.warn(`WS open failed: ${err}`);
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
        const webSocket = new WebSocket(url);

        // Open socket
        webSocket.binaryType = "arraybuffer";
        webSocket.onopen = (_evt: WebSocket.Event) => {
          RaftLog.debug(`RaftChannelWebSocket._webSocketOpen - onopen ${_evt.toString()}`);
          // // We're connected
          this._isConnected = true;
          resolve(webSocket);
        };
        webSocket.onerror = function (evt: WebSocket.ErrorEvent) {
          RaftLog.warn(`RaftChannelWebSocket._webSocketOpen - onerror: ${evt.message}`);
          reject(evt);
        }
      } catch (error: unknown) {
        RaftLog.warn(`RaftChannelWebSocket._webSocketOpen - open failed ${error}`);
        reject(error);
      }
    });
  }
}
