// The system type for any Raft device: only commands are sent (no device data is subscribed to)

import { RaftEventFn, RaftSystemType, RaftSystemUtils, SystemCapabilities } from "../../../src/main";

export default class SystemTypeDevTypes implements RaftSystemType {
    nameForDialogs = "Raft device";
    defaultWiFiHostname = "Raft";
    firmwareDestName = "ricfw";
    normalFileDestName = "fs";
    connectorOptions = { wsSuffix: "ws", bleConnItvlMs: 50 };
    BLEServiceUUIDs = ["aa76677e-9cfd-4626-a510-0d305be57c8d", "da903f65-d5c2-4f4d-a065-d1aade7af874"];
    BLECmdUUID = "aa76677e-9cfd-4626-a510-0d305be57c8e";
    BLERespUUID = "aa76677e-9cfd-4626-a510-0d305be57c8f";
    capabilities: SystemCapabilities = { tuning: { bleMaxWriteSize: 244 } };

    setup(_systemUtils: RaftSystemUtils, _onEvent: RaftEventFn | null): void {
        // nothing to set up
    }

    subscribeForUpdates = null;
    stateIsInvalid = null;
    rxOtherMsgType = null;
}
