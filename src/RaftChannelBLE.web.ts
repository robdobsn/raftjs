/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftChannelBLE
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import RaftChannel from "./RaftChannel";
import { RaftConnEvent, RaftConnEventFn } from "./RaftConnEvents";
import RaftLog from "./RaftLog";
import RaftMsgHandler from "./RaftMsgHandler";
import { ConnectorOptions } from "./RaftSystemType";
import RaftUtils from "./RaftUtils";

class RaftBLEConnectTimeoutError extends Error {
}

export default class RaftChannelBLE implements RaftChannel {

  // Default command and response UUIDs
  _cmdUUID = 'aa76677e-9cfd-4626-a510-0d305be57c8e';
  _respUUID = 'aa76677e-9cfd-4626-a510-0d305be57c8f';
  _serviceUUIDs = ['aa76677e-9cfd-4626-a510-0d305be57c8d', 'da903f65-d5c2-4f4d-a065-d1aade7af874'];

  // Device and characteristics
  private _bleDevice: BluetoothDevice | null = null;
  private _characteristicTx: BluetoothRemoteGATTCharacteristic | null = null;
  private _characteristicRx: BluetoothRemoteGATTCharacteristic | null = null;

  // Message handler
  private _raftMsgHandler: RaftMsgHandler | null = null;

  // Conn event fn
  private _onConnEvent: RaftConnEventFn | null = null;

  // Last message tx time
  private _msgTxTimeLast = Date.now();
  private _msgTxMinTimeBetweenMs = 1;
  private readonly maxRetries = 1;

  // Connected flag and retries
  private _isConnected = false;
  private readonly _maxConnRetries = 3;
  private readonly _connRetryDelayMs = 500;
  private _connectAttemptID = 0;
  private _disconnectRequested = false;

  // Event listener fn
  private _eventListenerFn: ((event: Event) => void) | null = null;

  // File Handler parameters
  private _requestedBatchAckSize = 10;
  private _requestedFileBlockSize = 500;

  // Max bytes per BLE write - messages larger than this are split into chunks.
  // Web Bluetooth doesn't expose the negotiated MTU, so use a conservative
  // default that works with BLE 4.2+ (ATT_MTU 251 → payload 244).
  private _maxBleWriteSize = 244;

  fhBatchAckSize(): number {
    return this._requestedBatchAckSize;
  }
  fhFileBlockSize(): number {
    return this._requestedFileBlockSize;
  }

  // Set message handler
  setMsgHandler(raftMsgHandler: RaftMsgHandler): void {
    this._raftMsgHandler = raftMsgHandler;
  }

  requiresSubscription(): boolean {
    return true;
  }

  // RICREST command before disconnect
  ricRestCmdBeforeDisconnect(): string | null {
    return "bledisconnect";
  }

  // isEnabled
  isEnabled() {
    if (navigator.bluetooth) {
      RaftLog.warn("Web Bluetooth is supported in your browser.");
      return true;
    } else {
      window.alert(
        "Web Bluetooth API is not available.\n" +
        'Please make sure the "Experimental Web Platform features" flag is enabled.'
      );
      return false;
    }
  }

  // isConnected
  isConnected(): boolean {
    return this._bleDevice?.gatt?.connected === true && this._isConnected;
  }

  // Set onConnEvent handler
  setOnConnEvent(connEventFn: RaftConnEventFn): void {
    this._onConnEvent = connEventFn;
  }

  // Disconnection event
  onDisconnected(event: Event): void {
    const device = event.target as BluetoothDevice;
    RaftLog.debug(`RaftChannelBLE.onDisconnected ${device.name}`);
    if (this._eventListenerFn) {
      device.removeEventListener(
        "gattserverdisconnected",
        this._eventListenerFn
      );
    }
    if (device !== this._bleDevice) {
      return;
    }
    this._isConnected = false;
    this._characteristicTx = null;
    this._characteristicRx = null;
    this._eventListenerFn = null;
    if (this._onConnEvent) {
      this._onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    }
  }

  // Get connected locator
  getConnectedLocator(): string | object {
    return this._bleDevice || "";
  }

  private async disconnectGattBeforeRetry(): Promise<void> {
    this._isConnected = false;
    this._characteristicTx = null;
    this._characteristicRx = null;

    if (!this._bleDevice?.gatt?.connected) {
      return;
    }

    try {
      await this._bleDevice.gatt.disconnect();
    } catch (error) {
      RaftLog.warn(`RaftChannelBLE.connect - cannot disconnect before retry ${error}`);
    }
  }

  private async connectGattWithTimeout(
    gatt: BluetoothRemoteGATTServer,
    timeoutMs: number,
    attemptID: number
  ): Promise<void> {
    const connectPromise = gatt.connect();
    let timeoutID: ReturnType<typeof setTimeout> | null = null;
    let didTimeout = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutID = setTimeout(() => {
        didTimeout = true;
        reject(new RaftBLEConnectTimeoutError(`GATT connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      await Promise.race([connectPromise, timeoutPromise]);
    } catch (error) {
      if (didTimeout) {
        // Web Bluetooth connections cannot be cancelled. If the browser completes
        // this connection after RaftJS has given up, tear it down immediately.
        void connectPromise.then(
          () => {
            if ((this._disconnectRequested || attemptID === this._connectAttemptID) &&
              !this._isConnected && gatt.connected) {
              try {
                gatt.disconnect();
              } catch (disconnectError) {
                RaftLog.warn(`RaftChannelBLE.connect - cannot disconnect late GATT connection ${disconnectError}`);
              }
            }
          },
          () => undefined
        );
      }
      throw error;
    } finally {
      if (timeoutID !== null) {
        clearTimeout(timeoutID);
      }
    }
  }

  // Connect to a device
  async connect(locator: string | object, _connectorOptions: ConnectorOptions): Promise<boolean> {
    this._bleDevice = locator as BluetoothDevice;
    this._disconnectRequested = false;
    this._isConnected = false;
    this._characteristicTx = null;
    this._characteristicRx = null;

    const gatt = this._bleDevice?.gatt;
    if (!gatt) {
      return false;
    }

    const operationTimeoutMs = _connectorOptions.connTimeoutMs ?? 5000;

    for (let connRetry = 0; connRetry < this._maxConnRetries; connRetry++) {
      const attemptID = ++this._connectAttemptID;

      try {
        await this.connectGattWithTimeout(gatt, operationTimeoutMs, attemptID);
        if (!gatt.connected) {
          throw new Error("GATT connect completed without a connection");
        }
        if (this._disconnectRequested || attemptID !== this._connectAttemptID) {
          throw new Error("connection attempt was superseded");
        }

        RaftLog.debug(
          `RaftChannelBLE.connect - OK attempt ${connRetry + 1} connection to device ${this._bleDevice.name}`
        );

        // Allow the GATT database to settle before service discovery.
        await new Promise(resolve => setTimeout(resolve, 100));
        if (this._disconnectRequested || attemptID !== this._connectAttemptID) {
          throw new Error("connection attempt was superseded");
        }

        let service: BluetoothRemoteGATTService | null = null;
        for (const serviceUUID of this._serviceUUIDs) {
          try {
            service = await RaftUtils.withTimeout(
              operationTimeoutMs,
              gatt.getPrimaryService(serviceUUID)
            );
            if (service) {
              break;
            }
          } catch (error) {
            RaftLog.warn(
              `RaftChannelBLE.connect - cannot get primary service ${error}`
            );
          }
        }

        if (!service) {
          throw new Error("cannot get a known primary service");
        }

        RaftLog.debug(
          `RaftChannelBLE.connect - found service: ${service.uuid}`
        );

        this._characteristicTx = await RaftUtils.withTimeout(
          operationTimeoutMs,
          service.getCharacteristic(this._cmdUUID)
        );
        RaftLog.debug(
          `RaftChannelBLE.connect - found char ${this._characteristicTx.uuid}`
        );

        this._characteristicRx = await RaftUtils.withTimeout(
          operationTimeoutMs,
          service.getCharacteristic(this._respUUID)
        );
        RaftLog.debug(
          `RaftChannelBLE.connect - found char ${this._characteristicRx.uuid}`
        );

        await RaftUtils.withTimeout(
          operationTimeoutMs,
          this._characteristicRx.startNotifications()
        );
        RaftLog.debug("RaftChannelBLE.connect - notifications started");

        // A disconnect request or a newer attempt may have superseded this
        // asynchronous setup while a browser operation was pending.
        if (this._disconnectRequested || attemptID !== this._connectAttemptID || !gatt.connected) {
          throw new Error("connection attempt was superseded");
        }

        this._characteristicRx.addEventListener(
          "characteristicvaluechanged",
          this._onMsgRx.bind(this)
        );

        this._eventListenerFn = this.onDisconnected.bind(this);
        this._bleDevice.addEventListener(
          "gattserverdisconnected",
          this._eventListenerFn
        );

        this._isConnected = true;
        RaftLog.debug(`RaftChannelBLE.connect ${this._bleDevice.name}`);
        return true;
      } catch (error: unknown) {
        const attemptIsCurrent = attemptID === this._connectAttemptID;
        if (!attemptIsCurrent && !this._disconnectRequested) {
          return false;
        }

        RaftLog.warn(
          `RaftChannelBLE.connect - attempt #${connRetry + 1} failed ${error}`
        );
        await this.disconnectGattBeforeRetry();

        if (error instanceof RaftBLEConnectTimeoutError ||
          this._disconnectRequested ||
          connRetry === this._maxConnRetries - 1) {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, this._connRetryDelayMs));
      }
    }

    return false;
  }

  // Disconnect
  async disconnect(): Promise<void> {
    this._disconnectRequested = true;
    this._connectAttemptID++;
    this._isConnected = false;
    this._characteristicTx = null;
    this._characteristicRx = null;

    if (this._bleDevice && this._bleDevice.gatt) {
      try {
        RaftLog.debug(`RaftChannelBLE.disconnect GATT`);
        await this._bleDevice.gatt.disconnect();
      } catch (error) {
        RaftLog.debug(`RaftChannelBLE.disconnect ${error}`);
      }
    }
  }

  pauseConnection(pause: boolean): void {
    RaftLog.verbose(
      `pauseConnection ${pause} - no effect for this channel type`
    );
    return;
  }

  // Handle notifications
  _onMsgRx(event: Event): void {
    // Get characteristic
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;

    // Get value
    const value = characteristic.value;
    if (value !== undefined) {
      const msg = new Uint8Array(value.buffer);

      // Handle message
      if (this._raftMsgHandler) {
        try {
          this._raftMsgHandler.handleNewRxMsg(msg);
        } catch (error) {
          RaftLog.debug(`RaftChannelBLE.onMsgRx ${error}`);
        }
      }
    }
  }

  // Write a single chunk to the BLE characteristic
  private async _writeChunk(data: Uint8Array): Promise<void> {
    if (!this._characteristicTx) {
      throw new Error("BLE transmit characteristic is unavailable");
    }
    const bs = RaftUtils.toBufferSource(data);
    if (this._characteristicTx.writeValueWithoutResponse) {
      await this._characteristicTx.writeValueWithoutResponse(bs);
    } else if (this._characteristicTx.writeValue) {
      await this._characteristicTx.writeValue(bs);
    } else if (this._characteristicTx.writeValueWithResponse) {
      await this._characteristicTx.writeValueWithResponse(bs);
    }
  }

  // Send a message, chunking if it exceeds the BLE write size
  async sendTxMsg(
    msg: Uint8Array
    //    _sendWithResponse: boolean
  ): Promise<boolean> {
    // Check valid
    if (!this._bleDevice?.gatt?.connected || !this._characteristicTx) {
      return false;
    }

    // Retry upto maxRetries
    for (let retryIdx = 0; retryIdx < this.maxRetries; retryIdx++) {
      // Check for min time between messages
      while (Date.now() - this._msgTxTimeLast < this._msgTxMinTimeBetweenMs) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      this._msgTxTimeLast = Date.now();

      // Write to the characteristic, chunking if necessary
      try {
        if (msg.length <= this._maxBleWriteSize) {
          await this._writeChunk(msg);
        } else {
          for (let offset = 0; offset < msg.length; offset += this._maxBleWriteSize) {
            const chunk = msg.subarray(offset, Math.min(offset + this._maxBleWriteSize, msg.length));
            await this._writeChunk(chunk);
          }
        }
        return true;
      } catch (error) {
        if (retryIdx === this.maxRetries - 1) {
          RaftLog.info(
            `RaftChannelBLE.sendTxMsg ${error} retried ${retryIdx} times`
          );
        }
      }
    }
    return false;
  }

  // Send message without awaiting response
  async sendTxMsgNoAwait(
    msg: Uint8Array
    //    _sendWithResponse: boolean
  ): Promise<boolean> {
    // Check valid
    if (!this._bleDevice?.gatt?.connected || !this._characteristicTx) {
      return false;
    }

    // Check for min time between messages
    while (Date.now() - this._msgTxTimeLast < this._msgTxMinTimeBetweenMs) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    this._msgTxTimeLast = Date.now();

    // Write to the characteristic, chunking if necessary
    if (this._characteristicTx) {
      if (msg.length <= this._maxBleWriteSize) {
        void this._writeChunk(msg).catch(error => {
          RaftLog.warn(`RaftChannelBLE.sendTxMsgNoAwait ${error}`);
        });
      } else {
        void (async () => {
          for (let offset = 0; offset < msg.length; offset += this._maxBleWriteSize) {
            const chunk = msg.subarray(offset, Math.min(offset + this._maxBleWriteSize, msg.length));
            await this._writeChunk(chunk);
          }
        })().catch(error => {
          RaftLog.warn(`RaftChannelBLE.sendTxMsgNoAwait ${error}`);
        });
      }
      return true;
    }
    return false;
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
