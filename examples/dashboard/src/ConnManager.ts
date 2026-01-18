import { RaftConnector, RaftEventFn, RaftLog, RaftSystemUtils, RaftSysTypeManager } from "../../../src/main";
import SettingsManager from "./SettingsManager";
import SystemTypeCog from "./SystemTypeCog/SystemTypeCog";
import SystemTypeGeneric from "./SystemTypeGeneric/SystemTypeGeneric";
import SystemTypeMarty from "./SystemTypeMarty/SystemTypeMarty";

const sysTypeManager = RaftSysTypeManager.getInstance();
const settingsManager = SettingsManager.getInstance();

sysTypeManager.addSystemType('Cog', () => new SystemTypeCog());
sysTypeManager.addSystemType('Marty', () => new SystemTypeMarty());
sysTypeManager.addDefaultSystemType(() => new SystemTypeGeneric());

export default class ConnManager {

  // Singleton
  private static _instance: ConnManager;

  // Connector
  private _connector = new RaftConnector(async (systemUtils: RaftSystemUtils) => {
    const systemInfo = await systemUtils.getSystemInfo();
    const sysType = sysTypeManager.createSystemType(systemInfo.SystemName) || sysTypeManager.createDefaultSystemType();
    if (sysType && sysType.deviceMgrIF) {
      sysType.deviceMgrIF.setMaxDataPointsToStore(settingsManager.getSetting("maxDatapointsToStore"));
    }
    return sysType;
  });

  // Callback on connection event
  private _onConnectionEvent: RaftEventFn | null = null;

  // Get instance
  public static getInstance(): ConnManager {
    if (!ConnManager._instance) {
      ConnManager._instance = new ConnManager();
    }
    return ConnManager._instance;
  }

  // Set connection event listener
  public setConnectionEventListener(listener: RaftEventFn) {
    this._onConnectionEvent = listener;
  }

  // Check if connected
  public isConnected(): boolean {
    return this._connector.isConnected();
  }

  public getConnector(): RaftConnector {
    return this._connector;
  }

  private async getBleDevice(uuids: string[], serialNo: string | null = null): Promise<BluetoothDevice | null> {

    // Filter by main service UUID if no serial number provided
    let filtersArray = uuids.map((uuid) => ({ services: [ uuid] }));

    // Check if a serial number is provided
    if ((serialNo !== null) && (serialNo !== "")) {
      
      // Generate a UUID from the base UUID xored with serial number in BCD form
      const baseUUID = "aa76677e-9cfd-4626-0000-000000000000";
      const modifiedUUID = this.generateServiceFilterUUID(baseUUID, serialNo);
      filtersArray = [{ services: [modifiedUUID] }];

      // console.log(`getBleDevice - modified UUID: ${modifiedUUID}`);
    }

    try {
      const dev = await navigator.bluetooth.requestDevice({
        filters: filtersArray,
        optionalServices: []
      });
      return dev;
    } catch (e) {
      RaftLog.warn(`getBleDevice - failed to get device ${e}`);
      return null;
    }
  }

  // Connect
  public async connect(method: string, locator: string | object, uuids: string[], serialNo: string | null = null): Promise<boolean> {

    // Hook up the connector
    this._connector.setEventListener((evtType, eventEnum, eventName, eventData) => {
      RaftLog.verbose(`ConnManager - event ${eventName}`);
      if (this._onConnectionEvent) {
        this._onConnectionEvent(evtType, eventEnum, eventName, eventData);
      }
    });
    await this._connector.initializeChannel(method);
    // Set the connector websocket suffix
    if (method === "WebBLE") {
      const dev = await this.getBleDevice(uuids, serialNo);
      return this._connector.connect(dev as object);
    }
    return this._connector.connect(locator);
  }

  // Disconnect
  public disconnect(): Promise<void> {
    return this._connector.disconnect();
  }

  ///////////////////////////////////////////////////////////////////////////////////
  /// @brief Generate a UUID for service filtering based on device serial number
  /// @param baseUUID Base UUID string (e.g., "aa76677e-9cfd-4626-0000-000000000000")
  /// @param serialNo Serial number as an ASCII string (e.g., "1234567890123456")
  /// @returns Modified UUID string
  public generateServiceFilterUUID(baseUUID: string, serialNo: string): string {
    const UUID_128_BYTES = 16;

    // Convert UUID string to byte array
    let uuidBytes = this.uuidToByteArray(baseUUID);

    // Convert serial number assuming it is decimal (or hex) digits to bytes
    let serialBytes = this.hexStringToBytes(serialNo);

    // Limit to 16 bytes (UUID size)
    const bytesToProc = Math.min(serialBytes.length, UUID_128_BYTES);

    // console.log(`generateServiceFilterUUID - serialBCD: ${serialBCD} bytesToProc: ${bytesToProc}`);

    // XOR the serial BCD bytes with the UUID bytes
    for (let i = 0; i < bytesToProc; i++) {
        uuidBytes[15 - i] ^= serialBytes[bytesToProc - 1 - i];
    }

    // Convert back to UUID string format
    return this.byteArrayToUUID(uuidBytes);
  }

  /////////////////////////////////////////////////////////////////////////////
  /// @brief Convert UUID string to byte array (Big Endian order)
  public uuidToByteArray(uuid: string): Uint8Array {
    return new Uint8Array(
        uuid.replace(/-/g, "") // Remove dashes
            .match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)) // Convert hex pairs to bytes
    );
  }

  /////////////////////////////////////////////////////////////////////////////
  /// @brief Convert byte array back to UUID string
  public byteArrayToUUID(bytes: Uint8Array): string {
    return [...bytes]
        .map(b => b.toString(16).padStart(2, "0")) // Convert to hex
        .join("")
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"); // Format as UUID
  }

  /////////////////////////////////////////////////////////////////////////////
  /// @brief Convert an hex string to bytes
  /// @param hex string - e.g. "1234567890123456" -> [0x12, 0x34, 0x56, 0x78, 0x90, 0x12, 0x34, 0x56]
  /// @returns byte array
  public hexStringToBytes(hex: string): Uint8Array {
    // Pad to ensure even number of characters
    if (hex.length % 2 !== 0) {
        hex = "0" + hex;
    }

    return new Uint8Array(
        hex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
    );
}
}
