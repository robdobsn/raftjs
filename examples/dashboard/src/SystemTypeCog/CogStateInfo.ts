import { time } from "console";
import RaftLog from "../../../../src/RaftLog";
import { DeviceManager } from "../../../../src/RaftDeviceManager";
import RaftUtils from "../../../../src/RaftUtils";

// export interface IMUStateInfo {
//     gx: number;
//     gy: number;
//     gz: number;
//     ax: number;
//     ay: number;
//     az: number;
//     tsMs: number;
// }

// export interface DeviceLastTsState {
//     lastMs: number;
//     offsetMs: number;
// }

// export interface DeviceMsgJsonElem {
//     _t: string; // Device type
//     _o: string; // Device name
//     x: string; // Hex encoded message values
// }

// export interface DeviceMsgJsonBus {
//     [devAddr: string]: DeviceMsgJsonElem;
// }
  
// export interface DeviceMsgJson {
//     [busName: string]: DeviceMsgJsonBus;
// }

export class CogStateInfo {

    // LSM6DS: IMUStateInfo = {gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 0, tsMs: 0};

    // // Last timestamp for each device
    // private _deviceLastTs: {[devName: string]: DeviceLastTsState} = {};
    
    public constructor(private _deviceManager: DeviceManager) {
    }

    get deviceManager(): DeviceManager {
        return this._deviceManager; 
    }

    updateFromMsg(rxMsg: Uint8Array, frameTimeMs: number, isBinary: boolean): Array<string> {

        // Debug 
        // RaftLog.info(`CogStateInfo: updateFromMsg: rxMsg: ${rxMsg} frameTimeMs: ${frameTimeMs}`);

        if (isBinary) {
            // console.log(`CogStateInfo: updateFromMsg: ${RaftUtils.bufferToHex(rxMsg)}`);
            this._deviceManager.handleClientMsgBinary(rxMsg);
        } else {
            // Convert Uint8Array to string
            const decoder = new TextDecoder('utf-8');
            const jsonString = decoder.decode(rxMsg.slice(2));

            // Handle using device manager
            this._deviceManager.handleClientMsgJson(jsonString);
        }

    //     // Debug
    //     // RaftLog.info(`CogStateInfo: updateFromMsg: jsonString: ${jsonString}`);

    //     // Parse JSON string to TypeScript object
    //     const deviceMsg: DeviceMsgJson = JSON.parse(jsonString);

    //     // Debug
    //     // for (const busName in deviceMsg) {
    //     //     for (const devAddr in deviceMsg[busName]) {
    //     //         for (const attrGroupName in deviceMsg[busName][devAddr]) {
    //     //             RaftLog.info(`CogStateInfo: updateFromMsg: busName ${busName} devAddr ${devAddr} attrGroupName: ${attrGroupName}`);
    //     //             RaftLog.info(`CogStateInfo: updateFromMsg: attrValue: ${deviceMsg[busName][devAddr][attrGroupName]}`);
    //     //         }
    //     //     }
    //     // }

    //     // Iterate over values and extract
    //     for (const busName in deviceMsg) {
    //         for (const devAddr in deviceMsg[busName]) {

    //             // Validate
    //             if ((deviceMsg[busName][devAddr].x === undefined) || (deviceMsg[busName][devAddr]._t === undefined)) {
    //                 RaftLog.warn(`CogStateInfo: updateFromMsg: Invalid message`);
    //                 continue;
    //             }

    //             // Extract message and device type
    //             const msgHex = deviceMsg[busName][devAddr].x;
    //             const devType = deviceMsg[busName][devAddr]._t;

    //             // Check if message is empty
    //             if (msgHex === '') {
    //                 RaftLog.warn(`CogStateInfo: updateFromMsg: Empty message`);
    //                 continue;
    //             }

    //             // Convert the hex string to an arraybuffer by converting each pair of hex chars to a byte
    //             const msgBytes = this.hexToBytes(msgHex);

    //             // Convert to a Buffer
    //             const msgBuffer = Buffer.from(msgBytes);

    //             // Extract timestamp
    //             let timestamp = msgBuffer.readUInt16BE(0);
    //             if (this._deviceLastTs[devType] === undefined) {
    //                 this._deviceLastTs[devType] = {lastMs: 0, offsetMs: 0};
    //             }
    //             const devTsState = this._deviceLastTs[devType];
    //             if (timestamp < devTsState.lastMs) {
    //                 devTsState.offsetMs += 0x10000;
    //             }
    //             devTsState.lastMs = timestamp;
    //             timestamp += devTsState.offsetMs;
    //             let msgBufferOffset = 2;
    //             // RaftLog.info(`CogStateInfo: updateFromMsg: timestamp: ${timestamp}`);

    //             // Handle device types
    //             switch (devType) {
    //                 case 'LSM6DS':
    //                     // RaftLog.info(`CogStateInfo: updateFromMsg: IMU`);

    //                     // LSD6DS IMU data is coded as 16-bit signed integers little-endian
    //                     // gx, gy, gz, ax, ay, az
    //                     this.LSM6DS = {
    //                         gx: msgBuffer.readInt16LE(msgBufferOffset) / 16.384,
    //                         gy: msgBuffer.readInt16LE(msgBufferOffset + 2) / 16.384,
    //                         gz: msgBuffer.readInt16LE(msgBufferOffset + 4) / 16.384,
    //                         ax: msgBuffer.readInt16LE(msgBufferOffset + 6) / 8192,
    //                         ay: msgBuffer.readInt16LE(msgBufferOffset + 8) / 8192,
    //                         az: msgBuffer.readInt16LE(msgBufferOffset + 10) / 8192,
    //                         tsMs: timestamp
    //                     };

    //                     // Debug
    //                     // RaftLog.info(`CogStateInfo: updateFromMsg: LSM6DS: gx: ${this.LSM6DS.gx.toFixed(2)} gy: ${this.LSM6DS.gy.toFixed(2)} gz: ${this.LSM6DS.gz.toFixed(2)} ax: ${this.LSM6DS.ax.toFixed(2)} ay: ${this.LSM6DS.ay.toFixed(2)} az: ${this.LSM6DS.az.toFixed(2)} tsMs: ${this.LSM6DS.tsMs}`);



    //                     // const imu = deviceMsg[busName][devAddr] as DeviceMsgJsonElem;
    //                     // this.imu = {x: imu.x as number, y: imu.y as number, z: imu.z as number, lastMs: frameTimeMs};
    //                     break;
    //             }
    //         }
    //     }

        return [];

    }

    // private hexToBytes(hex: string): Uint8Array {
    //     const bytes = new Uint8Array(hex.length / 2);
    //     for (let i = 0; i < bytes.length; i++) {
    //         bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    //     }
    //     return bytes;
    // }    
  }