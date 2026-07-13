import RaftChannelBLE from "./RaftChannelBLE.web";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeDevice(gatt: object): BluetoothDevice {
  return {
    name: "Cog",
    gatt,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as unknown as BluetoothDevice;
}

function makeCharacteristic(overrides: object = {}): BluetoothRemoteGATTCharacteristic {
  return {
    uuid: "characteristic",
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    startNotifications: jest.fn(async function () {
      return this;
    }),
    writeValueWithoutResponse: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as BluetoothRemoteGATTCharacteristic;
}

describe("RaftChannelBLE Web Bluetooth lifecycle", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("disconnects a GATT connection that completes after the connect timeout", async () => {
    const lateConnect = deferred<BluetoothRemoteGATTServer>();
    const gattState = {
      connected: false,
      connect: jest.fn(() => lateConnect.promise),
      disconnect: jest.fn(() => {
        gattState.connected = false;
      }),
      getPrimaryService: jest.fn(),
    };
    const gatt = gattState as unknown as BluetoothRemoteGATTServer;
    const channel = new RaftChannelBLE();
    const connectResult = channel.connect(makeDevice(gatt), { connTimeoutMs: 10 });

    await jest.advanceTimersByTimeAsync(10);
    await expect(connectResult).resolves.toBe(false);
    expect(gatt.disconnect).not.toHaveBeenCalled();

    gattState.connected = true;
    lateConnect.resolve(gatt);
    await Promise.resolve();
    await Promise.resolve();

    expect(gatt.disconnect).toHaveBeenCalledTimes(1);
    expect(gattState.connected).toBe(false);
    expect(channel.isConnected()).toBe(false);
  });

  it("disconnects GATT after the final service-discovery failure", async () => {
    const gatt = {
      connected: false,
      connect: jest.fn(async function () {
        this.connected = true;
        return this;
      }),
      disconnect: jest.fn(function () {
        this.connected = false;
      }),
      getPrimaryService: jest.fn(async () => {
        throw new Error("service unavailable");
      }),
    } as unknown as BluetoothRemoteGATTServer;
    const channel = new RaftChannelBLE();
    const connectResult = channel.connect(makeDevice(gatt), { connTimeoutMs: 1000 });

    await jest.runAllTimersAsync();

    await expect(connectResult).resolves.toBe(false);
    expect(gatt.connect).toHaveBeenCalledTimes(3);
    expect(gatt.disconnect).toHaveBeenCalledTimes(3);
    expect(gatt.connected).toBe(false);
  });

  it("treats notification setup failure as a failed connection", async () => {
    const txCharacteristic = makeCharacteristic();
    const rxCharacteristic = makeCharacteristic({
      startNotifications: jest.fn(async () => {
        throw new Error("notifications unavailable");
      }),
    });
    const service = {
      uuid: "service",
      getCharacteristic: jest.fn(async (uuid: string) =>
        uuid.endsWith("8e") ? txCharacteristic : rxCharacteristic),
    } as unknown as BluetoothRemoteGATTService;
    const gatt = {
      connected: false,
      connect: jest.fn(async function () {
        this.connected = true;
        return this;
      }),
      disconnect: jest.fn(function () {
        this.connected = false;
      }),
      getPrimaryService: jest.fn(async () => service),
    } as unknown as BluetoothRemoteGATTServer;
    const device = makeDevice(gatt);
    const channel = new RaftChannelBLE();
    const connectResult = channel.connect(device, { connTimeoutMs: 1000 });

    await jest.runAllTimersAsync();

    await expect(connectResult).resolves.toBe(false);
    expect(gatt.disconnect).toHaveBeenCalledTimes(3);
    expect(device.addEventListener).not.toHaveBeenCalled();
    expect(channel.isConnected()).toBe(false);
  });

  it("reports connected only after notifications are ready", async () => {
    const txCharacteristic = makeCharacteristic();
    const rxCharacteristic = makeCharacteristic();
    const service = {
      uuid: "service",
      getCharacteristic: jest.fn(async (uuid: string) =>
        uuid.endsWith("8e") ? txCharacteristic : rxCharacteristic),
    } as unknown as BluetoothRemoteGATTService;
    const gatt = {
      connected: false,
      connect: jest.fn(async function () {
        this.connected = true;
        return this;
      }),
      disconnect: jest.fn(function () {
        this.connected = false;
      }),
      getPrimaryService: jest.fn(async () => service),
    } as unknown as BluetoothRemoteGATTServer;
    const device = makeDevice(gatt);
    const channel = new RaftChannelBLE();
    const connectResult = channel.connect(device, { connTimeoutMs: 1000 });

    await jest.runAllTimersAsync();

    await expect(connectResult).resolves.toBe(true);
    expect(rxCharacteristic.startNotifications).toHaveBeenCalledTimes(1);
    expect(device.addEventListener).toHaveBeenCalledWith(
      "gattserverdisconnected",
      expect.any(Function)
    );
    expect(gatt.disconnect).not.toHaveBeenCalled();
    expect(channel.isConnected()).toBe(true);
  });

  it("reports failed or unavailable BLE writes as false", async () => {
    const failedWrite = jest.fn(async () => {
      throw new Error("write failed");
    });
    const txCharacteristic = makeCharacteristic({
      writeValueWithoutResponse: failedWrite,
    });
    const gatt = {
      connected: true,
      disconnect: jest.fn(),
    } as unknown as BluetoothRemoteGATTServer;
    const channel = new RaftChannelBLE();
    const channelState = channel as unknown as {
      _bleDevice: BluetoothDevice;
      _characteristicTx: BluetoothRemoteGATTCharacteristic | null;
      _msgTxTimeLast: number;
    };
    channelState._bleDevice = makeDevice(gatt);
    channelState._characteristicTx = null;
    channelState._msgTxTimeLast = 0;

    await expect(channel.sendTxMsg(Uint8Array.of(1))).resolves.toBe(false);

    channelState._characteristicTx = txCharacteristic;
    await expect(channel.sendTxMsg(Uint8Array.of(1))).resolves.toBe(false);
    expect(failedWrite).toHaveBeenCalledTimes(1);
  });
});
