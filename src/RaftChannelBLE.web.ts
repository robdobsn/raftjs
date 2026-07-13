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

interface GATTOwnership {
  readonly generation: number;
  connectPending: boolean;
  readonly onSuperseded: () => void;
}

// A BluetoothRemoteGATTServer can be shared by separate BluetoothDevice references
// and separate RaftChannelBLE instances. Track the latest RaftJS connection
// operation so cleanup from an older asynchronous operation cannot disconnect a
// newer owner.
const gattOwnerships = new WeakMap<BluetoothRemoteGATTServer, GATTOwnership>();
let nextGATTOwnershipGeneration = 0;

export default class RaftChannelBLE implements RaftChannel {

  // Default command and response UUIDs
  _cmdUUID = 'aa76677e-9cfd-4626-a510-0d305be57c8e';
  _respUUID = 'aa76677e-9cfd-4626-a510-0d305be57c8f';
  _serviceUUIDs = ['aa76677e-9cfd-4626-a510-0d305be57c8d', 'da903f65-d5c2-4f4d-a065-d1aade7af874'];

  // Device and characteristics
  private _bleDevice: BluetoothDevice | null = null;
  private _characteristicTx: BluetoothRemoteGATTCharacteristic | null = null;
  private _characteristicRx: BluetoothRemoteGATTCharacteristic | null = null;
  private _msgRxEventListenerFn: ((event: Event) => void) | null = null;

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
  private _gattOwnership: GATTOwnership | null = null;

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
    const gatt = this._bleDevice?.gatt;
    return gatt?.connected === true &&
      this._isConnected &&
      this._gattOwnership !== null &&
      gattOwnerships.get(gatt) === this._gattOwnership;
  }

  // Set onConnEvent handler
  setOnConnEvent(connEventFn: RaftConnEventFn): void {
    this._onConnEvent = connEventFn;
  }

  // Disconnection event
  onDisconnected(event: Event): void {
    const device = event.target as BluetoothDevice;
    RaftLog.debug(`RaftChannelBLE.onDisconnected ${device.name}`);
    if (device !== this._bleDevice) {
      return;
    }

    const gatt = device.gatt;
    const ownership = this._gattOwnership;
    if (!gatt || !ownership || !this.ownsGATT(gatt, ownership)) {
      // This channel was superseded. Remove only its own obsolete handler; a
      // newer channel may already be listening on the same BluetoothDevice.
      if (this._eventListenerFn) {
        device.removeEventListener(
          "gattserverdisconnected",
          this._eventListenerFn
        );
      }
      this._eventListenerFn = null;
      this._isConnected = false;
      this.clearRxListener();
      this._characteristicTx = null;
      this._characteristicRx = null;
      return;
    }

    // gattserverdisconnected is queued as a task. It can arrive after this same
    // device has already reconnected, in which case it must not tear down the
    // current owner or remove its active listener.
    if (gatt.connected) {
      return;
    }

    if (this._eventListenerFn) {
      device.removeEventListener(
        "gattserverdisconnected",
        this._eventListenerFn
      );
    }
    this._isConnected = false;
    this.clearRxListener();
    this._characteristicTx = null;
    this._characteristicRx = null;
    this._eventListenerFn = null;
    this.releaseGATTOwnership(gatt, ownership);
    if (this._onConnEvent) {
      this._onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    }
  }

  // Get connected locator
  getConnectedLocator(): string | object {
    return this._bleDevice || "";
  }

  private claimGATTOwnership(gatt: BluetoothRemoteGATTServer): GATTOwnership {
    const previousOwnership = gattOwnerships.get(gatt);
    const ownership: GATTOwnership = {
      generation: ++nextGATTOwnershipGeneration,
      connectPending: false,
      onSuperseded: () => this.handleGATTSuperseded(ownership),
    };
    gattOwnerships.set(gatt, ownership);
    this._gattOwnership = ownership;
    previousOwnership?.onSuperseded();
    return ownership;
  }

  private handleGATTSuperseded(ownership: GATTOwnership): void {
    if (this._gattOwnership !== ownership) {
      return;
    }

    const wasConnected = this._isConnected;
    this._connectAttemptID++;
    this._isConnected = false;
    this.clearRxListener();
    this._characteristicTx = null;
    this._characteristicRx = null;
    if (this._eventListenerFn && this._bleDevice) {
      this._bleDevice.removeEventListener(
        "gattserverdisconnected",
        this._eventListenerFn
      );
    }
    this._eventListenerFn = null;
    this._gattOwnership = null;
    if (wasConnected && this._onConnEvent) {
      this._onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    }
  }

  private ownsGATT(
    gatt: BluetoothRemoteGATTServer,
    ownership: GATTOwnership
  ): boolean {
    return gattOwnerships.get(gatt) === ownership;
  }

  private releaseGATTOwnership(
    gatt: BluetoothRemoteGATTServer,
    ownership: GATTOwnership
  ): void {
    if (this.ownsGATT(gatt, ownership)) {
      gattOwnerships.delete(gatt);
    }
    if (this._gattOwnership === ownership) {
      this._gattOwnership = null;
    }
  }

  private clearRxListener(): void {
    if (this._characteristicRx && this._msgRxEventListenerFn) {
      this._characteristicRx.removeEventListener(
        "characteristicvaluechanged",
        this._msgRxEventListenerFn
      );
    }
    this._msgRxEventListenerFn = null;
  }

  private async disconnectGATTIfOwned(
    gatt: BluetoothRemoteGATTServer,
    ownership: GATTOwnership,
    logContext: string
  ): Promise<boolean> {
    if (!this.ownsGATT(gatt, ownership)) {
      return false;
    }

    try {
      // Calling disconnect while connected is false is intentional: the Web
      // Bluetooth algorithm also uses it to abort pending GATT operations.
      await gatt.disconnect();
      return true;
    } catch (error) {
      RaftLog.warn(
        `${logContext} (GATT owner ${ownership.generation}) ${error}`
      );
      return false;
    }
  }

  private async disconnectLateGATTIfSafe(
    gatt: BluetoothRemoteGATTServer,
    ownership: GATTOwnership
  ): Promise<boolean> {
    const currentOwnership = gattOwnerships.get(gatt);
    // A newer live owner must be left alone. If that owner has already released
    // GATT, however, this late connection is unowned and must still be torn down.
    if (currentOwnership && currentOwnership !== ownership) {
      return false;
    }

    try {
      await gatt.disconnect();
      return true;
    } catch (error) {
      RaftLog.warn(
        `RaftChannelBLE.connect - cannot disconnect late GATT connection ` +
        `(GATT owner ${ownership.generation}) ${error}`
      );
      return false;
    }
  }

  private async disconnectGattBeforeRetry(
    gatt: BluetoothRemoteGATTServer,
    ownership: GATTOwnership
  ): Promise<void> {
    this._isConnected = false;
    this.clearRxListener();
    this._characteristicTx = null;
    this._characteristicRx = null;
    await this.disconnectGATTIfOwned(
      gatt,
      ownership,
      "RaftChannelBLE.connect - cannot disconnect failed GATT connection"
    );
  }

  private async connectGattWithTimeout(
    gatt: BluetoothRemoteGATTServer,
    timeoutMs: number,
    ownership: GATTOwnership
  ): Promise<void> {
    ownership.connectPending = true;
    let connectPromise: Promise<BluetoothRemoteGATTServer>;
    try {
      connectPromise = gatt.connect();
    } catch (error) {
      ownership.connectPending = false;
      throw error;
    }
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
      ownership.connectPending = false;
    } catch (error) {
      if (didTimeout) {
        // Some Web Bluetooth implementations can still complete connect() after
        // its caller has timed out. Retain the ownership token until the browser
        // promise settles, then clean up only if this operation still owns GATT.
        void connectPromise.then(
          async () => {
            ownership.connectPending = false;
            await this.disconnectLateGATTIfSafe(gatt, ownership);
            this.releaseGATTOwnership(gatt, ownership);
          },
          () => {
            ownership.connectPending = false;
            this.releaseGATTOwnership(gatt, ownership);
          }
        );

        // Per the Web Bluetooth disconnect algorithm this also aborts active
        // connection algorithms, even while gatt.connected is still false.
        await this.disconnectGATTIfOwned(
          gatt,
          ownership,
          "RaftChannelBLE.connect - cannot abort timed-out GATT connection"
        );
      } else {
        ownership.connectPending = false;
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
    this.clearRxListener();
    if (this._eventListenerFn && this._bleDevice) {
      this._bleDevice.removeEventListener(
        "gattserverdisconnected",
        this._eventListenerFn
      );
      this._eventListenerFn = null;
    }
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
    const ownership = this.claimGATTOwnership(gatt);

    for (let connRetry = 0; connRetry < this._maxConnRetries; connRetry++) {
      const attemptID = ++this._connectAttemptID;

      if (!this.ownsGATT(gatt, ownership)) {
        this.releaseGATTOwnership(gatt, ownership);
        return false;
      }

      try {
        await this.connectGattWithTimeout(
          gatt,
          operationTimeoutMs,
          ownership
        );
        if (!gatt.connected) {
          throw new Error("GATT connect completed without a connection");
        }
        if (this._disconnectRequested ||
          attemptID !== this._connectAttemptID ||
          !this.ownsGATT(gatt, ownership)) {
          throw new Error("connection attempt was superseded");
        }

        RaftLog.debug(
          `RaftChannelBLE.connect - OK attempt ${connRetry + 1} connection to device ${this._bleDevice.name}`
        );

        // Allow the GATT database to settle before service discovery.
        await new Promise(resolve => setTimeout(resolve, 100));
        if (this._disconnectRequested ||
          attemptID !== this._connectAttemptID ||
          !this.ownsGATT(gatt, ownership)) {
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
        if (this._disconnectRequested ||
          attemptID !== this._connectAttemptID ||
          !this.ownsGATT(gatt, ownership) ||
          !gatt.connected) {
          throw new Error("connection attempt was superseded");
        }

        this._msgRxEventListenerFn = this._onMsgRx.bind(this);
        this._characteristicRx.addEventListener(
          "characteristicvaluechanged",
          this._msgRxEventListenerFn
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
        if (attemptID !== this._connectAttemptID && !this._disconnectRequested) {
          return false;
        }

        if (!this.ownsGATT(gatt, ownership)) {
          this._isConnected = false;
          this.clearRxListener();
          this._characteristicTx = null;
          this._characteristicRx = null;
          this.releaseGATTOwnership(gatt, ownership);
          return false;
        }

        RaftLog.warn(
          `RaftChannelBLE.connect - attempt #${connRetry + 1} failed ${error}`
        );
        if (!(error instanceof RaftBLEConnectTimeoutError)) {
          await this.disconnectGattBeforeRetry(gatt, ownership);
        }

        if (error instanceof RaftBLEConnectTimeoutError ||
          this._disconnectRequested ||
          connRetry === this._maxConnRetries - 1) {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, this._connRetryDelayMs));
      }
    }

    if (!ownership.connectPending) {
      this.releaseGATTOwnership(gatt, ownership);
    }
    return false;
  }

  // Disconnect
  async disconnect(): Promise<void> {
    const wasConnected = this.isConnected();
    this._disconnectRequested = true;
    this._connectAttemptID++;
    this._isConnected = false;
    this.clearRxListener();
    this._characteristicTx = null;
    this._characteristicRx = null;

    const gatt = this._bleDevice?.gatt;
    const ownership = this._gattOwnership;
    if (!gatt) {
      return;
    }

    // A prior channel may still hold a reference to this shared GATT server.
    // Never let its later disconnect tear down the newer RaftJS owner.
    const currentOwnership = gattOwnerships.get(gatt);
    if (ownership && currentOwnership === ownership) {
      RaftLog.debug(`RaftChannelBLE.disconnect GATT`);
      const disconnected = await this.disconnectGATTIfOwned(
        gatt,
        ownership,
        "RaftChannelBLE.disconnect"
      );
      if (disconnected && !ownership.connectPending) {
        // A browser may dispatch gattserverdisconnected synchronously, although
        // it is normally queued. If that already released ownership it also
        // emitted the event, so do not emit a duplicate here.
        const eventAlreadyHandled = this._gattOwnership !== ownership;
        if (this._eventListenerFn) {
          this._bleDevice?.removeEventListener(
            "gattserverdisconnected",
            this._eventListenerFn
          );
          this._eventListenerFn = null;
        }
        this.releaseGATTOwnership(gatt, ownership);
        if (wasConnected && !eventAlreadyHandled && this._onConnEvent) {
          this._onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
        }
      }
    } else if (!currentOwnership) {
      // Preserve the legacy behaviour for channels which did not acquire GATT
      // through connect(), while still protecting any known newer owner.
      try {
        RaftLog.debug(`RaftChannelBLE.disconnect GATT`);
        await gatt.disconnect();
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
    const gatt = this._bleDevice?.gatt;
    const ownership = this._gattOwnership;
    if (!gatt || !ownership || !this.ownsGATT(gatt, ownership)) {
      return;
    }

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
    const gatt = this._bleDevice?.gatt;
    if (!gatt?.connected ||
      !this._characteristicTx ||
      (this._gattOwnership !== null &&
        gattOwnerships.get(gatt) !== this._gattOwnership)) {
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
    const gatt = this._bleDevice?.gatt;
    if (!gatt?.connected ||
      !this._characteristicTx ||
      (this._gattOwnership !== null &&
        gattOwnerships.get(gatt) !== this._gattOwnership)) {
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
