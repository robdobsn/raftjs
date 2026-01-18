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

  // Event listener fn
  private _eventListenerFn: ((event: Event) => void) | null = null;

  // File Handler parameters
  private _requestedBatchAckSize = 10;
  private _requestedFileBlockSize = 500;

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
    return this._bleDevice !== null && this._isConnected;
  }

  // Set onConnEvent handler
  setOnConnEvent(connEventFn: RaftConnEventFn): void {
    this._onConnEvent = connEventFn;
  }

  // Disconnection event
  onDisconnected(event: Event): void {
    const device = event.target as BluetoothDevice;
    RaftLog.debug(`RaftChannelBLE.onDisconnected ${device.name}`);
    if (this._bleDevice && this._eventListenerFn) {
      this._bleDevice.removeEventListener(
        "gattserverdisconnected",
        this._eventListenerFn
      );
    }
    this._isConnected = false;
    if (this._onConnEvent) {
      this._onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    }
  }

  // Get connected locator
  getConnectedLocator(): string | object {
    return this._bleDevice || "";
  }

  // Connect to a device
  async connect(locator: string | object, _connectorOptions: ConnectorOptions): Promise<boolean> {
    // RaftLog.debug(`Selected device: ${deviceID}`);
    this._bleDevice = locator as BluetoothDevice;
    if (this._bleDevice && this._bleDevice.gatt) {
      try {
        // Connect
        for (let connRetry = 0; connRetry < this._maxConnRetries; connRetry++) {
          // Connect
          const connTimeoutMs = _connectorOptions.connTimeoutMs || 5000;
          await RaftUtils.withTimeout(connTimeoutMs, this._bleDevice.gatt.connect());
          RaftLog.debug(
            `RaftChannelBLE.connect - ${this._bleDevice.gatt.connected ? "OK" : "FAILED"
            } attempt ${connRetry + 1} connection to device ${this._bleDevice.name}`
          );

          if (this._bleDevice.gatt.connected) {

            // Delay a bit
            await new Promise(resolve => setTimeout(resolve, 100));

            // Get service
            try {
              let service: BluetoothRemoteGATTService | null = null;
              // iterate over known services
              for (const serviceUUID of this._serviceUUIDs) {
                try {
                  service = await this._bleDevice.gatt.getPrimaryService(serviceUUID);
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
                RaftLog.warn(
                  `RaftChannelBLE.connect - cannot get primary service - giving up`
                );
                return false;
              }
              RaftLog.debug(
                `RaftChannelBLE.connect - found service: ${service.uuid}`
              );

              try {
                // Get Tx and Rx characteristics
                this._characteristicTx = await service.getCharacteristic(
                  this._cmdUUID
                );
                RaftLog.debug(
                  `RaftChannelBLE.connect - found char ${this._characteristicTx.uuid}`
                );
                this._characteristicRx = await service.getCharacteristic(
                  this._respUUID
                );
                RaftLog.debug(
                  `RaftChannelBLE.connect - found char ${this._characteristicRx.uuid}`
                );

                // Notifications of received messages
                try {
                  await this._characteristicRx.startNotifications();
                  RaftLog.debug(
                    "RaftChannelBLE.connect - notifications started"
                  );
                  this._characteristicRx.addEventListener(
                    "characteristicvaluechanged",
                    this._onMsgRx.bind(this)
                  );
                } catch (error) {
                  RaftLog.debug(
                    "RaftChannelBLE.connnect - addEventListener failed " + error
                  );
                }

                // Connected ok
                RaftLog.debug(`RaftChannelBLE.connect ${this._bleDevice.name}`);

                // Add disconnect listener
                this._eventListenerFn = this.onDisconnected.bind(this);
                this._bleDevice.addEventListener(
                  "gattserverdisconnected",
                  this._eventListenerFn
                );

                // Connected
                this._isConnected = true;
                return true;
              } catch (error) {
                RaftLog.warn(
                  `RaftChannelBLE.connect - cannot find characteristic: ${error}`
                );
              }
            } catch (error) {
              if (connRetry === this._maxConnRetries - 1) {
                RaftLog.warn(
                  `RaftChannelBLE.connect - cannot get primary service ${error} - attempt #${connRetry + 1} - giving up`
                );
              } else {
                RaftLog.debug(
                  `RaftChannelBLE.connect - cannot get primary service - attempt #${connRetry + 1} ${error}`
                );
              }
            }
          }
        }
      } catch (error: unknown) {
        RaftLog.warn(`RaftChannelBLE.connect - cannot connect ${error}`);
      }

      // Disconnect
      if (
        this._bleDevice &&
        this._bleDevice.gatt &&
        this._bleDevice.gatt.connected
      ) {
        try {
          await this._bleDevice.gatt.disconnect();
        } catch (error) {
          RaftLog.warn(`RaftChannelBLE.connect - cannot disconnect ${error}`);
        }
      }
    }

    return false;
  }

  // Disconnect
  async disconnect(): Promise<void> {
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

  // Send a message
  async sendTxMsg(
    msg: Uint8Array
    //    _sendWithResponse: boolean
  ): Promise<boolean> {
    // Check valid
    if (this._bleDevice === null) {
      return false;
    }

    // Retry upto maxRetries
    for (let retryIdx = 0; retryIdx < this.maxRetries; retryIdx++) {
      // Check for min time between messages
      while (Date.now() - this._msgTxTimeLast < this._msgTxMinTimeBetweenMs) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      this._msgTxTimeLast = Date.now();

      // Write to the characteristic
      try {
        if (this._characteristicTx) {
          const bs = RaftUtils.toBufferSource(msg);
          if (this._characteristicTx.writeValueWithoutResponse) {
            await this._characteristicTx.writeValueWithoutResponse(bs);
          } else if (this._characteristicTx.writeValue) {
            await this._characteristicTx.writeValue(bs);
          } else if (this._characteristicTx.writeValueWithResponse) {
            await this._characteristicTx.writeValueWithResponse(bs);
          }
        }
        break;
      } catch (error) {
        if (retryIdx === this.maxRetries - 1) {
          RaftLog.info(
            `RaftChannelBLE.sendTxMsg ${error} retried ${retryIdx} times`
          );
        }
      }
    }
    return true;
  }

  // Send message without awaiting response
  async sendTxMsgNoAwait(
    msg: Uint8Array
    //    _sendWithResponse: boolean
  ): Promise<boolean> {
    // Check valid
    if (this._bleDevice === null) {
      return false;
    }

    // Check for min time between messages
    while (Date.now() - this._msgTxTimeLast < this._msgTxMinTimeBetweenMs) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    this._msgTxTimeLast = Date.now();

    // Write to the characteristic
    if (this._characteristicTx) {
      const bs = RaftUtils.toBufferSource(msg);
      if (this._characteristicTx.writeValueWithoutResponse) {
        this._characteristicTx.writeValueWithoutResponse(bs);
      } else if (this._characteristicTx.writeValue) {
        this._characteristicTx.writeValue(bs);
      } else if (this._characteristicTx.writeValueWithResponse) {
        this._characteristicTx.writeValueWithResponse(bs);
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