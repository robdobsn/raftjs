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
    expect(gatt.disconnect).toHaveBeenCalledTimes(1);
    expect(gattState.connected).toBe(false);

    gattState.connected = true;
    lateConnect.resolve(gatt);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(gatt.disconnect).toHaveBeenCalledTimes(2);
    expect(gattState.connected).toBe(false);
    expect(channel.isConnected()).toBe(false);
  });

  it("uses the default connect timeout when connTimeoutMs is zero", async () => {
    const pendingConnect = deferred<BluetoothRemoteGATTServer>();
    const gattState = {
      connected: false,
      connect: jest.fn(() => pendingConnect.promise),
      disconnect: jest.fn(() => {
        gattState.connected = false;
      }),
      getPrimaryService: jest.fn(),
    };
    const gatt = gattState as unknown as BluetoothRemoteGATTServer;
    const channel = new RaftChannelBLE();
    const connectResult = channel.connect(makeDevice(gatt), { connTimeoutMs: 0 });
    let didSettle = false;
    void connectResult.then(() => {
      didSettle = true;
    });

    await jest.advanceTimersByTimeAsync(4999);
    expect(didSettle).toBe(false);
    expect(gatt.disconnect).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await expect(connectResult).resolves.toBe(false);
    expect(gatt.disconnect).toHaveBeenCalledTimes(1);

    gattState.connected = true;
    pendingConnect.resolve(gatt);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(gatt.disconnect).toHaveBeenCalledTimes(2);
    expect(gattState.connected).toBe(false);
  });

  it("does not let an older late connection disconnect a newer GATT owner", async () => {
    const oldLateConnect = deferred<BluetoothRemoteGATTServer>();
    const txCharacteristic = makeCharacteristic();
    const rxCharacteristic = makeCharacteristic();
    const service = {
      uuid: "service",
      getCharacteristic: jest.fn(async (uuid: string) =>
        uuid.endsWith("8e") ? txCharacteristic : rxCharacteristic),
    } as unknown as BluetoothRemoteGATTService;
    let connectCallCount = 0;
    const gattState = {
      connected: false,
      connect: jest.fn(() => {
        connectCallCount++;
        if (connectCallCount === 1) {
          return oldLateConnect.promise;
        }
        gattState.connected = true;
        return Promise.resolve(gatt);
      }),
      disconnect: jest.fn(() => {
        gattState.connected = false;
      }),
      getPrimaryService: jest.fn(async () => service),
    };
    const gatt = gattState as unknown as BluetoothRemoteGATTServer;
    const device = makeDevice(gatt);
    const oldChannel = new RaftChannelBLE();
    const oldResult = oldChannel.connect(device, { connTimeoutMs: 10 });

    await jest.advanceTimersByTimeAsync(10);
    await expect(oldResult).resolves.toBe(false);
    expect(gatt.disconnect).toHaveBeenCalledTimes(1);

    const newChannel = new RaftChannelBLE();
    const newResult = newChannel.connect(device, { connTimeoutMs: 1000 });
    await jest.advanceTimersByTimeAsync(100);
    await expect(newResult).resolves.toBe(true);
    expect(newChannel.isConnected()).toBe(true);

    await oldChannel.disconnect();
    expect(gatt.disconnect).toHaveBeenCalledTimes(1);

    oldLateConnect.resolve(gatt);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(gatt.disconnect).toHaveBeenCalledTimes(1);
    expect(gattState.connected).toBe(true);
    expect(oldChannel.isConnected()).toBe(false);
    expect(newChannel.isConnected()).toBe(true);
  });

  it("allows a pending GATT connection to be superseded", async () => {
    const pendingConnect = deferred<BluetoothRemoteGATTServer>();
    const txCharacteristic = makeCharacteristic();
    const rxCharacteristic = makeCharacteristic();
    const service = {
      uuid: "service",
      getCharacteristic: jest.fn(async (uuid: string) =>
        uuid.endsWith("8e") ? txCharacteristic : rxCharacteristic),
    } as unknown as BluetoothRemoteGATTService;
    let connectCallCount = 0;
    const gattState = {
      connected: false,
      connect: jest.fn(() => {
        connectCallCount++;
        if (connectCallCount === 1) {
          return pendingConnect.promise;
        }
        gattState.connected = true;
        return Promise.resolve(gatt);
      }),
      disconnect: jest.fn(() => {
        gattState.connected = false;
      }),
      getPrimaryService: jest.fn(async () => service),
    };
    const gatt = gattState as unknown as BluetoothRemoteGATTServer;
    const oldChannel = new RaftChannelBLE();
    const oldConnEvent = jest.fn();
    oldChannel.setOnConnEvent(oldConnEvent);
    const oldResult = oldChannel.connect(makeDevice(gatt), { connTimeoutMs: 1000 });
    await Promise.resolve();

    const newChannel = new RaftChannelBLE();
    const newResult = newChannel.connect(makeDevice(gatt), { connTimeoutMs: 1000 });
    await jest.advanceTimersByTimeAsync(100);
    await expect(newResult).resolves.toBe(true);

    pendingConnect.resolve(gatt);
    await expect(oldResult).resolves.toBe(false);

    expect(gatt.connect).toHaveBeenCalledTimes(2);
    expect(gatt.disconnect).not.toHaveBeenCalled();
    expect(oldChannel.isConnected()).toBe(false);
    expect(newChannel.isConnected()).toBe(true);
    expect(oldConnEvent).not.toHaveBeenCalled();
  });

  it("disconnects a superseded pending connection that resolves unowned", async () => {
    const pendingConnect = deferred<BluetoothRemoteGATTServer>();
    const txCharacteristic = makeCharacteristic();
    const rxCharacteristic = makeCharacteristic();
    const service = {
      uuid: "service",
      getCharacteristic: jest.fn(async (uuid: string) =>
        uuid.endsWith("8e") ? txCharacteristic : rxCharacteristic),
    } as unknown as BluetoothRemoteGATTService;
    let connectCallCount = 0;
    const gattState = {
      connected: false,
      connect: jest.fn(() => {
        connectCallCount++;
        if (connectCallCount === 1) {
          return pendingConnect.promise;
        }
        gattState.connected = true;
        return Promise.resolve(gatt);
      }),
      disconnect: jest.fn(() => {
        gattState.connected = false;
      }),
      getPrimaryService: jest.fn(async () => service),
    };
    const gatt = gattState as unknown as BluetoothRemoteGATTServer;
    const oldChannel = new RaftChannelBLE();
    const oldResult = oldChannel.connect(makeDevice(gatt), { connTimeoutMs: 1000 });
    await Promise.resolve();

    const newChannel = new RaftChannelBLE();
    const newResult = newChannel.connect(makeDevice(gatt), { connTimeoutMs: 1000 });
    await jest.advanceTimersByTimeAsync(100);
    await expect(newResult).resolves.toBe(true);

    await newChannel.disconnect();
    expect(gatt.disconnect).toHaveBeenCalledTimes(1);
    expect(gattState.connected).toBe(false);

    gattState.connected = true;
    pendingConnect.resolve(gatt);
    await expect(oldResult).resolves.toBe(false);

    expect(gatt.disconnect).toHaveBeenCalledTimes(2);
    expect(gattState.connected).toBe(false);
    expect(oldChannel.isConnected()).toBe(false);
    expect(newChannel.isConnected()).toBe(false);
  });

  it("disconnects an older late connection after a newer owner has released GATT", async () => {
    const oldLateConnect = deferred<BluetoothRemoteGATTServer>();
    const txCharacteristic = makeCharacteristic();
    const rxCharacteristic = makeCharacteristic();
    const service = {
      uuid: "service",
      getCharacteristic: jest.fn(async (uuid: string) =>
        uuid.endsWith("8e") ? txCharacteristic : rxCharacteristic),
    } as unknown as BluetoothRemoteGATTService;
    let connectCallCount = 0;
    const gattState = {
      connected: false,
      connect: jest.fn(() => {
        connectCallCount++;
        if (connectCallCount === 1) {
          return oldLateConnect.promise;
        }
        gattState.connected = true;
        return Promise.resolve(gatt);
      }),
      disconnect: jest.fn(() => {
        gattState.connected = false;
      }),
      getPrimaryService: jest.fn(async () => service),
    };
    const gatt = gattState as unknown as BluetoothRemoteGATTServer;
    const device = makeDevice(gatt);
    const oldChannel = new RaftChannelBLE();
    const oldResult = oldChannel.connect(device, { connTimeoutMs: 10 });

    await jest.advanceTimersByTimeAsync(10);
    await expect(oldResult).resolves.toBe(false);
    expect(gatt.disconnect).toHaveBeenCalledTimes(1);

    const newChannel = new RaftChannelBLE();
    const newResult = newChannel.connect(device, { connTimeoutMs: 1000 });
    await jest.advanceTimersByTimeAsync(100);
    await expect(newResult).resolves.toBe(true);

    await newChannel.disconnect();
    expect(gatt.disconnect).toHaveBeenCalledTimes(2);
    expect(gattState.connected).toBe(false);

    gattState.connected = true;
    oldLateConnect.resolve(gatt);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(gatt.disconnect).toHaveBeenCalledTimes(3);
    expect(gattState.connected).toBe(false);
    expect(oldChannel.isConnected()).toBe(false);
    expect(newChannel.isConnected()).toBe(false);
  });

  it("disconnects to abort a pending connect while GATT reports disconnected", async () => {
    const pendingConnect = deferred<BluetoothRemoteGATTServer>();
    const gattState = {
      connected: false,
      connect: jest.fn(() => pendingConnect.promise),
      disconnect: jest.fn(() => {
        gattState.connected = false;
      }),
      getPrimaryService: jest.fn(),
    };
    const gatt = gattState as unknown as BluetoothRemoteGATTServer;
    const channel = new RaftChannelBLE();
    const connectResult = channel.connect(makeDevice(gatt), { connTimeoutMs: 1000 });

    await Promise.resolve();
    await channel.disconnect();

    expect(gattState.connected).toBe(false);
    expect(gatt.disconnect).toHaveBeenCalledTimes(1);

    gattState.connected = true;
    pendingConnect.resolve(gatt);
    await expect(connectResult).resolves.toBe(false);

    expect(gatt.disconnect).toHaveBeenCalledTimes(2);
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

  it("ignores a queued disconnect event after the same device reconnects", async () => {
    const txCharacteristic = makeCharacteristic();
    const rxCharacteristic = makeCharacteristic();
    const service = {
      uuid: "service",
      getCharacteristic: jest.fn(async (uuid: string) =>
        uuid.endsWith("8e") ? txCharacteristic : rxCharacteristic),
    } as unknown as BluetoothRemoteGATTService;
    const gattState = {
      connected: false,
      connect: jest.fn(async () => {
        gattState.connected = true;
        return gatt;
      }),
      disconnect: jest.fn(() => {
        gattState.connected = false;
      }),
      getPrimaryService: jest.fn(async () => service),
    };
    const gatt = gattState as unknown as BluetoothRemoteGATTServer;
    const device = makeDevice(gatt);
    const addEventListener = device.addEventListener as jest.Mock;
    const removeEventListener = device.removeEventListener as jest.Mock;
    const oldConnEvent = jest.fn();
    const newConnEvent = jest.fn();

    const oldChannel = new RaftChannelBLE();
    oldChannel.setOnConnEvent(oldConnEvent);
    const oldResult = oldChannel.connect(device, { connTimeoutMs: 1000 });
    await jest.runAllTimersAsync();
    await expect(oldResult).resolves.toBe(true);
    const oldListener = addEventListener.mock.calls[0][1] as (event: Event) => void;
    const oldRxListener = (rxCharacteristic.addEventListener as jest.Mock)
      .mock.calls[0][1] as (event: Event) => void;

    await oldChannel.disconnect();
    expect(oldConnEvent).toHaveBeenCalledTimes(1);
    expect(rxCharacteristic.removeEventListener).toHaveBeenCalledWith(
      "characteristicvaluechanged",
      oldRxListener
    );
    const newChannel = new RaftChannelBLE();
    newChannel.setOnConnEvent(newConnEvent);
    const newResult = newChannel.connect(device, { connTimeoutMs: 1000 });
    await jest.runAllTimersAsync();
    await expect(newResult).resolves.toBe(true);
    const newListener = addEventListener.mock.calls[1][1] as (event: Event) => void;
    const newRxListener = (rxCharacteristic.addEventListener as jest.Mock)
      .mock.calls[1][1] as (event: Event) => void;

    const queuedOldEvent = { target: device } as unknown as Event;
    oldListener(queuedOldEvent);
    newListener(queuedOldEvent);

    expect(gattState.connected).toBe(true);
    expect(newChannel.isConnected()).toBe(true);
    expect(oldConnEvent).toHaveBeenCalledTimes(1);
    expect(newConnEvent).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith(
      "gattserverdisconnected",
      oldListener
    );
    expect(removeEventListener).not.toHaveBeenCalledWith(
      "gattserverdisconnected",
      newListener
    );
    expect(rxCharacteristic.removeEventListener).not.toHaveBeenCalledWith(
      "characteristicvaluechanged",
      newRxListener
    );

    gattState.connected = false;
    newListener(queuedOldEvent);
    expect(newChannel.isConnected()).toBe(false);
    expect(newConnEvent).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith(
      "gattserverdisconnected",
      newListener
    );
    expect(rxCharacteristic.removeEventListener).toHaveBeenCalledWith(
      "characteristicvaluechanged",
      newRxListener
    );
  });

  it("does not supersede an established live GATT owner", async () => {
    const txCharacteristic = makeCharacteristic();
    const rxCharacteristic = makeCharacteristic();
    const service = {
      uuid: "service",
      getCharacteristic: jest.fn(async (uuid: string) =>
        uuid.endsWith("8e") ? txCharacteristic : rxCharacteristic),
    } as unknown as BluetoothRemoteGATTService;
    const gattState = {
      connected: false,
      connect: jest.fn(async () => {
        gattState.connected = true;
        return gatt;
      }),
      disconnect: jest.fn(() => {
        gattState.connected = false;
      }),
      getPrimaryService: jest.fn(async () => service),
    };
    const gatt = gattState as unknown as BluetoothRemoteGATTServer;
    const oldDevice = makeDevice(gatt);
    const newDevice = makeDevice(gatt);
    const oldConnEvent = jest.fn();
    const oldChannel = new RaftChannelBLE();
    oldChannel.setOnConnEvent(oldConnEvent);
    const oldResult = oldChannel.connect(oldDevice, { connTimeoutMs: 1000 });
    await jest.runAllTimersAsync();
    await expect(oldResult).resolves.toBe(true);
    const oldRxListener = (rxCharacteristic.addEventListener as jest.Mock)
      .mock.calls[0][1] as (event: Event) => void;

    const newChannel = new RaftChannelBLE();
    const newResult = newChannel.connect(newDevice, { connTimeoutMs: 1000 });
    await expect(newResult).resolves.toBe(false);

    expect(gatt.connect).toHaveBeenCalledTimes(1);
    expect(gatt.disconnect).not.toHaveBeenCalled();
    expect(oldChannel.isConnected()).toBe(true);
    expect(newChannel.isConnected()).toBe(false);
    expect(oldConnEvent).not.toHaveBeenCalled();
    expect(oldDevice.removeEventListener).not.toHaveBeenCalled();
    expect(newDevice.addEventListener).not.toHaveBeenCalled();
    expect(rxCharacteristic.removeEventListener).not.toHaveBeenCalledWith(
      "characteristicvaluechanged",
      oldRxListener
    );
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

  it("chunks BLE writes for an ATT MTU of 185", async () => {
    const writeValueWithoutResponse = jest.fn<
      Promise<void>,
      [BufferSource]
    >(() => Promise.resolve());
    const txCharacteristic = makeCharacteristic({
      writeValueWithoutResponse,
    });
    const gatt = {
      connected: true,
      disconnect: jest.fn(),
    } as unknown as BluetoothRemoteGATTServer;
    const channel = new RaftChannelBLE();
    const channelState = channel as unknown as {
      _bleDevice: BluetoothDevice;
      _characteristicTx: BluetoothRemoteGATTCharacteristic;
      _msgTxTimeLast: number;
    };
    channelState._bleDevice = makeDevice(gatt);
    channelState._characteristicTx = txCharacteristic;
    channelState._msgTxTimeLast = 0;

    await expect(channel.sendTxMsg(new Uint8Array(400))).resolves.toBe(true);

    expect(
      writeValueWithoutResponse.mock.calls.map(([chunk]) => chunk.byteLength)
    ).toEqual([182, 182, 36]);
  });
});
