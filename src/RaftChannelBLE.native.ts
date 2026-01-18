/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftChannelPhoneBLE
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { BleError, BleManager, Characteristic, ConnectionPriority, Device, State, Subscription } from "react-native-ble-plx";
import RaftChannel from "./RaftChannel";
import { RaftConnEvent, RaftConnEventFn } from "./RaftConnEvents";
import RaftLog from "./RaftLog";
import RaftMsgHandler from "./RaftMsgHandler";
import RaftUtils from "./RaftUtils";
import RaftChannelBLEScanner from "./RaftChannelBLEScanner.native";
import { DiscoveredDevice } from "./RaftTypes";

const _bleManager = new BleManager();

export default class RaftChannelPhoneBLE implements RaftChannel {

  // Conn event fn
  private _onConnEvent: RaftConnEventFn | null = null;

  // Default command and response UUIDs
  _cmdUUID = 'aa76677e-9cfd-4626-a510-0d305be57c8e';
  _respUUID = 'aa76677e-9cfd-4626-a510-0d305be57c8f';
  _serviceUUIDs = ['aa76677e-9cfd-4626-a510-0d305be57c8d', 'da903f65-d5c2-4f4d-a065-d1aade7af874'];

  // BLE Scanner
  _bleScanner: RaftChannelBLEScanner;

  // Device to connect to using BLE
  _deviceToConnectTo: DiscoveredDevice | null = null;

  // Handle BLE disconnection through retry
  // May be set after connection checking (e.g. using LEDs)
  _retryConnectionIfLost: boolean = false;
  RECONNECT_ATTEMPTS_AFTER_CONN_LOST = 20;

  // BLE connection
  _bleSubscrOnRx: Subscription | null = null;
  _bleSubscrOnDisconnect: Subscription | null = null;
  _bleSubscrOnStateChange: Subscription | null = null;
  _bleDevice: Device | null = null;

  // MTU (Maximum Transmission Unit) size to request
  MTU_SIZE_TO_REQUEST = 512;

  // Message handler
  _raftMsgHandler: RaftMsgHandler | null = null;

  // Last message tx time
  private _msgTxTimeLast = Date.now();
  private _msgTxMinTimeBetweenMs = 15;
  private readonly maxRetries = 1;

  // File Handler parameters
  private _requestedBatchAckSize = 10;
  private _requestedFileBlockSize = 500;

  // Connected device UUID
  private _connectedDeviceServiceUUID?: string;

  constructor() {
    RaftLog.debug('BLEChannel constructor');

    // _bleManager.setLogLevel(LogLevel.Verbose);

    // Scanner
    this._bleScanner = new RaftChannelBLEScanner(
      _bleManager,
      this._serviceUUIDs,
      this.scanningEvent.bind(this),
    );

    // Listen for BLE state changes
    this._bleSubscrOnStateChange = _bleManager.onStateChange(state => {
      this._onBLEStateChange(state);
    }, true);
  }

  setConnectedDeviceUUID(serviceUUID: string) {
    this._connectedDeviceServiceUUID = serviceUUID;
  }

  getBleManager(): BleManager {
    return _bleManager;
  }


  fhBatchAckSize(): number { return this._requestedBatchAckSize; }
  fhFileBlockSize(): number { return this._requestedFileBlockSize; }

  pauseConnection(pause: boolean): void { RaftLog.verbose(`pauseConnection ${pause} - no effect for this channel type`); return; }

  // isConnected
  isConnected(): boolean {
    return this._bleDevice !== null;
  }

  setOnConnEvent(connEventFn: RaftConnEventFn): void {
    this._onConnEvent = connEventFn;
  }

  requiresSubscription(): boolean {
    return true;
  }

  isEnabled() {
    return true;
  }

  // Set message handler
  setMsgHandler(raftMsgHandler: RaftMsgHandler): void {
    this._raftMsgHandler = raftMsgHandler;
  }

  setRetryConnectionIfLost(retry: boolean): void {
    RaftLog.debug(`BLEChannel setRetryConnectionIfLost ${retry}`);
    this._retryConnectionIfLost = retry;
  }

  async discoveryStart(uuids: string[], tries = 10): Promise<boolean> {
    if (tries <= 0) {
      RaftLog.debug(`BLEChannel discoveryStart failed`);
      return false;
    }
    // Disconnect any existing connection
    // await this.disconnect();

    // wait until the bt is powered on
    const state = await _bleManager.state();
    if (state !== State.PoweredOn) {
      RaftLog.debug(`BLEChannel discoveryStart waiting for BLE powered on`);
      await new Promise(resolve => setTimeout(resolve, 500));
      return this.discoveryStart(uuids, tries - 1);
    }
    // Start scanning
    await this._bleScanner.scanningStart(uuids);

    // Event
    RaftLog.debug(`BLEChannel discoveryStart emitting BLE_SCANNING_STARTED`);
    this.emit(RaftConnEvent.BLE_SCANNING_STARTED);
    return true;
  }

  discoveryCancel(): void {
    // Stop scanning
    this._bleScanner.scanningStop();
  }

  _onBLEStateChange(state: State) {
    RaftLog.debug('BLEChannel state change ' + state);
    if (state === State.PoweredOn) {
      this.emit(RaftConnEvent.BLE_BLUETOOTH_STATE, {
        btEnabled: true,
      });
      RaftLog.debug('BLEChannel BLE powered on');
    } else if (state === State.PoweredOff) {
      this.emit(RaftConnEvent.BLE_BLUETOOTH_STATE, {
        btEnabled: false,
      });
    }
  }

  // Get connected locator
  getConnectedLocator(): string | Device {
    return this._bleDevice || '';
  }

  /**
   * Get RIC connection status
   *
   * @returns boolean (true if connected)
   *
   */
  async getIsConnected(forceCheck: boolean = false): Promise<boolean> {
    if (this._bleDevice === null) {
      return false;
    }
    if (!forceCheck) {
      return true;
    }
    return await this._bleDevice?.isConnected();
  }

  /**
   * Get the RSSI of the currently connected device
   *
   *  @return number (or null if not connected)
   *
   */
  async readRSSI(): Promise<number> {
    if (this._bleDevice) {
      const updatedDevice = await this._bleDevice.readRSSI();
      if (updatedDevice.rssi !== null) {
        return updatedDevice.rssi;
      }
    }
    // is this a sensible default? should show up as a very weak signal
    return -200;
  }

  /**
   * Connect to a RIC
   *
   * @returns boolean (true if connected)
   *
   */
  async connect(discoveredDevice: DiscoveredDevice): Promise<boolean> {
    RaftLog.debug('BLEChannel requested connection ' + JSON.stringify(discoveredDevice));
    this._connectedDeviceServiceUUID = discoveredDevice.serviceUUIDs ? discoveredDevice.serviceUUIDs[0] : undefined;

    this._retryConnectionIfLost = false;
    this._bleScanner.scanningStop();

    // Now connecting
    this.emit(RaftConnEvent.CONN_CONNECTING, { deviceId: discoveredDevice.id });

    // Connect
    this._deviceToConnectTo = discoveredDevice;
    const connOk = await this._configDeviceConnection();

    // Check if ok
    if (!connOk) {
      // Emit failure
      this.emit(RaftConnEvent.CONN_CONNECTION_FAILED);
      return false;
    }

    // Emit success
    this.emit(RaftConnEvent.CONN_CONNECTED, {
      deviceId: this._deviceToConnectTo.id,
      name: this._deviceToConnectTo.name,
    });
    return true;
  }

  /**
   * Disconnect from RIC
   *
   * @returns None
   *
   */
  async disconnect(): Promise<void> {
    RaftLog.debug('BLEChannel disconnect requested');
    this._retryConnectionIfLost = false;
    RaftLog.debug(`this._ricToConnectTo  ${this._deviceToConnectTo}`);
    const connectedRIC = this._deviceToConnectTo;
    this._deviceToConnectTo = null;

    // this._invalidateConnectionInfo(); // //

    // Remove disconnect subscription so it doesn't try to reconnect
    if (this._bleSubscrOnDisconnect) {
      this._bleSubscrOnDisconnect.remove();
      this._bleSubscrOnDisconnect = null;
    }
    // Disconnect from the connected device
    const connMarties = await _bleManager.connectedDevices(
      this._serviceUUIDs
    );
    if (connMarties.length == 0) {
      RaftLog.debug('BLEChannel disconnect - no devices connected');
    } else {
      for (const connRIC of connMarties) {
        RaftLog.debug(`Found connected device ${connRIC.id}`);
        RaftLog.debug(`ID to disconnect ${connectedRIC?.id}`);
        if (connectedRIC?.id === connRIC.id) {
          await _bleManager.cancelDeviceConnection(connRIC.id);
        }
      }
    }

    // Emit disconnected event
    this.emit(RaftConnEvent.CONN_DISCONNECTED);
    RaftLog.debug('BLEChannel disconnect clearing connected device');
    this._bleDevice = null;
  }

  /**
   * Configure device connection
   *
   * @returns None
   *
   */
  async _configDeviceConnection(): Promise<boolean> {
    // Check there is a RIC to connect to
    if (this._deviceToConnectTo === null) {
      return false;
    }

    let deviceConnected: Device | null = null;
    for (let connRetry = 0; connRetry < 5; connRetry++) {
      try {
        deviceConnected = await _bleManager.connectToDevice(
          this._deviceToConnectTo.id,
          {
            timeout: 3000,
          },
        );
        // this.handleLostDevice(); // //
        break;
      } catch (error) {
        RaftLog.debug(
          `BLEChannel configDeviceConnection failed at attempt ${connRetry + 1
          } error ${error}`,
        );
        deviceConnected = null;
      }
    }
    if (deviceConnected === null) {
      return false;
    }

    // Increase MTU size
    try {
      if (deviceConnected) {
        const updatedDevice = await deviceConnected.requestMTU(this.MTU_SIZE_TO_REQUEST);
        RaftLog.debug(
          `BLEChannel configDeviceConnection requestMTU ${this.MTU_SIZE_TO_REQUEST}, actualMTU ${updatedDevice.mtu}`,
        );
      }
    } catch (error) {
      RaftLog.debug(
        `BLEChannel configDeviceConnection requestMTU failed error ${error}`,
      );
      return false;
    }

    // Request high-priority connection
    try {
      await _bleManager.requestConnectionPriorityForDevice(
        this._deviceToConnectTo.id,
        ConnectionPriority.High,
      );
      RaftLog.debug(
        `BLEChannel configDeviceConnection request ConnPriority.High`,
      );
    } catch (error) {
      RaftLog.debug(
        `BLEChannel configDeviceConnection requestConnectionPriorityForDevice failed ${error}`,
      );
      return false;
    }

    // Discover services and characteristics
    try {
      if (deviceConnected) {
        this._bleDevice =
          await deviceConnected.discoverAllServicesAndCharacteristics();
      }
    } catch (error) {
      RaftLog.debug(
        `BLEChannel configDeviceConnection discoverAllServicesAndCharacteristics failed error ${error}`,
      );
      return false;
    }
    // Monitor the inbound characteristic
    try {
      if (this._bleDevice) {
        if (!this._connectedDeviceServiceUUID) {
          RaftLog.warn('BLEChannel _configDeviceConnection - no connected device service UUID');
          return false;
        }
        this._bleSubscrOnRx = this._bleDevice.monitorCharacteristicForService(
          this._connectedDeviceServiceUUID,
          this._respUUID,
          (error: BleError | null, characteristic: Characteristic | null) => {
            this._onMsgRx(error, characteristic);
          },
        );
      }
    } catch (error) {
      RaftLog.debug(
        `BLEChannel configDeviceConnection monitorCharacteristicForService failed ${error}`,
      );
      return false;
    }

    // Deal with future disconnections
    this._handleLostConnections();

    return true;
  }

  /**
   * Handle lost connections
   *
   * @returns None
   *
   */
  _handleLostConnections(): void {
    // Check device ok
    if (this._bleDevice === null) {
      return;
    }

    // Attach a disconnected listener
    this._bleSubscrOnDisconnect = _bleManager.onDeviceDisconnected(
      this._bleDevice.id,
      async () => {
        // this._storeConnectionInfo(); // //
        // this._invalidateConnectionInfo(); // //
        RaftLog.warn(`onDeviceDisconnected BLEManager says device disconnected`);
        // this.emit(RaftConnEvent.CONN_ISSUE_DETECTED);
        this.emit(RaftConnEvent.CONN_DISCONNECTED);
        try {
          if (this._bleSubscrOnRx) {
            this._bleSubscrOnRx.remove();
            this._bleSubscrOnRx = null;
          }

          if (this._bleSubscrOnDisconnect) {
            this._bleSubscrOnDisconnect.remove();
            this._bleSubscrOnDisconnect = null;
          }

          // Debug
          RaftLog.debug(`connection subscriptions removed`);

          // Device now null
          RaftLog.debug(`onDisconnect clearing connected device`);
          // this._ghostBleDevice = this._bleDevice; // //
          this._bleDevice = null;
        } catch (error) {
          RaftLog.debug(`Error in onDisconnected ${error}`);
        }

        // Attempt reconnection
        for (
          let reconnAttempt = 0;
          reconnAttempt < this.RECONNECT_ATTEMPTS_AFTER_CONN_LOST;
          reconnAttempt++
        ) {
          // Check if scan in progress - and stop reconn attempts if so
          const scanInProgress = this._bleScanner.isScanInProgress();
          RaftLog.debug(
            `onDeviceDisconnected considering reconnection RICToConnectTo ${this._deviceToConnectTo?.name} scanInProgress ${scanInProgress} retryConnectionIfLost ${this._retryConnectionIfLost}`,
          );
          if (
            !this._retryConnectionIfLost ||
            scanInProgress ||
            !this._deviceToConnectTo
          ) {
            RaftLog.debug(
              `onDeviceDisconnected DISCONNECTED_RIC RICToConnectTo ${this._deviceToConnectTo?.name} scanInProgress ${scanInProgress} retryConnectionIfLost ${this._retryConnectionIfLost}`,
            );
            if (this._retryConnectionIfLost) {
              // this.emit(RaftConnEvent.BLE_DISCONNECTED_RIC);
            } else {
              // this.emit(RaftConnEvent.BLE_CONNECTING_RIC_FAIL);
            }
            break;
          }
          if (await this._configDeviceConnection()) {
            RaftLog.debug(
              `onDeviceDisconnected successful reconn RICToConnectTo ${this._deviceToConnectTo?.name}`,
            );

            // Indicate connection issue resolved
            // this.emit(RaftConnEvent.CONN_ISSUE_RESOLVED);

            // await this.ricConnector.retrieveMartySystemInfo();
            return;
          }
          RaftLog.debug(
            `onDeviceDisconnected retrying reconn RICToConnectTo ${this._deviceToConnectTo?.name}`,
          );
        }
      },
    );
  }


  getMTU() {
    return this._bleDevice?.mtu;
  }

  emit(event: RaftConnEvent, data?: any): void {
    if (this._onConnEvent) {
      this._onConnEvent(event, data);
    }
  }

  _onMsgRx(error: BleError | null, characteristic: Characteristic | null) {
    if (error) {
      // this.emit(maybe dont want to emit here - just add to comms stats?);
      // this.reportError(error.message);
      return;
    }

    // Extract message
    const msgFrameBase64 = characteristic!.value;

    const rxFrame = RaftUtils.atob(msgFrameBase64!);

    // Debug
    // RaftLog.debug('_onMsgRx from BLE ' + RaftUtils.bufferToHex(rxFrame));

    // Send
    if (rxFrame !== null && this._raftMsgHandler) {
      this._raftMsgHandler.handleNewRxMsg(rxFrame);
    }
  }

  async scanningEvent(event: RaftConnEvent, data?: any): Promise<void> {
    if (this._onConnEvent) {
      this._onConnEvent(event, data);
    }
  }

  async sendTxMsg(
    msg: Uint8Array,
    // sendWithResponse: boolean,
  ): Promise<boolean> {
    // Check valid
    if (this._bleDevice === null) {
      return false;
    }

    for (let retryIdx = 0; retryIdx < this.maxRetries; retryIdx++) {

      // Check for min time between messages
      while (Date.now() - this._msgTxTimeLast < this._msgTxMinTimeBetweenMs) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      this._msgTxTimeLast = Date.now();

      // Convert to Base64
      const msgFrameBase64 = RaftUtils.btoa(msg);

      try {
        if (!this._connectedDeviceServiceUUID) {
          RaftLog.warn('BLEChannel sendTxMsg - no connected device service UUID');
          return false;
        }
        await this._bleDevice!.writeCharacteristicWithoutResponseForService(
          this._connectedDeviceServiceUUID,
          this._cmdUUID,
          msgFrameBase64!,
        );
        return true;
      } catch {
        if (retryIdx === this.maxRetries - 1) {
          RaftLog.debug(`sendTxMsg failed after ${this.maxRetries} attempts`);
          return false;
        }
        RaftLog.debug(`sendTxMsg failed, retrying`);
      }
    }
    return false;
  }

  async sendTxMsgNoAwait(
    msg: Uint8Array,
    // sendWithResponse: boolean,
  ): Promise<boolean> {
    // Check valid
    if (this._bleDevice === null) {
      return false;
    }

    // Retry upto maxRetries
    for (let retryIdx = 0; retryIdx < this.maxRetries; retryIdx++) {

      // Check for min time between messages
      while (Date.now() - this._msgTxTimeLast < this._msgTxMinTimeBetweenMs) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      this._msgTxTimeLast = Date.now();

      // Convert to Base64
      const msgFrameBase64 = RaftUtils.btoa(msg);

      try {
        if (!this._connectedDeviceServiceUUID) {
          RaftLog.warn('BLEChannel sendTxMsgNoAwait - no connected device service UUID');
          return false;
        }
        this._bleDevice!.writeCharacteristicWithoutResponseForService(
          this._connectedDeviceServiceUUID,
          this._cmdUUID,
          msgFrameBase64!,
        );
        return true;
      } catch {
        if (retryIdx === this.maxRetries - 1) {
          RaftLog.debug(`sendTxMsgNoAwait failed after ${this.maxRetries} attempts`);
          return false;
        }
        RaftLog.debug(`sendTxMsgNoAwait failed, retrying`);
      }
    }
    return false;
  }

  // RICREST command before disconnect
  ricRestCmdBeforeDisconnect(): string | null {
    return "bledisconnect";
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