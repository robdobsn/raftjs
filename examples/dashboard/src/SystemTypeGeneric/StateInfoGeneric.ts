import { time } from "console";
import RaftLog from "../../../../src/RaftLog";
import { DeviceManager } from "../../../../src/RaftDeviceManager";

export class StateInfoGeneric {

    public constructor(private _deviceManager: DeviceManager) {
    }

    async handleBinaryPayload(rxMsg: Uint8Array): Promise<void> {
        await this._deviceManager.handleClientMsgBinary(rxMsg);
    }

    async handleJsonPayload(jsonString: string): Promise<void> {
        await this._deviceManager.handleClientMsgJson(jsonString);
    }

    updateFromMsg(rxMsg: Uint8Array, frameTimeMs: number, isBinary: boolean): Array<string> {

        // Debug 
        // RaftLog.info(`StateInfoGeneric: updateFromMsg: rxMsg: ${rxMsg} frameTimeMs: ${frameTimeMs}`);

        // Handle binary or JSON
        if (isBinary) {
            // Handle using device manager
            this.handleBinaryPayload(rxMsg);
        } else {
            // Convert Uint8Array to string
            const decoder = new TextDecoder('utf-8');
            const jsonString = decoder.decode(rxMsg.slice(2));

            // Handle using device manager
            this.handleJsonPayload(jsonString);
        }
        return [];

    }
}