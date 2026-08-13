import RaftChannel from "./RaftChannel";
import { RaftConnEvent } from "./RaftConnEvents";
import RaftConnector from "./RaftConnector";

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

function makeChannel(connect: () => Promise<boolean>): RaftChannel {
  return {
    connect: jest.fn(connect),
    disconnect: jest.fn(async () => undefined),
    isConnected: jest.fn(() => false),
  } as unknown as RaftChannel;
}

function makeDisconnectChannel(): RaftChannel {
  return {
    disconnect: jest.fn(async () => undefined),
    requiresSubscription: jest.fn(() => false),
    ricRestCmdBeforeDisconnect: jest.fn(() => null),
  } as unknown as RaftChannel;
}

function configureRetry(connector: RaftConnector, channel: RaftChannel, retryForMs: number): void {
  const connectorState = connector as unknown as {
    _raftChannel: RaftChannel;
    _channelConnLocator: object;
    _retryIfLostIsConnected: boolean;
    _retryIfLostForSecs: number;
    _retryIfLostRetryDelayMs: number;
  };
  connectorState._raftChannel = channel;
  connectorState._channelConnLocator = {};
  connectorState._retryIfLostIsConnected = true;
  connectorState._retryIfLostForSecs = retryForMs / 1000;
  connectorState._retryIfLostRetryDelayMs = 10;
}

describe("RaftConnector reconnect deadline", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("emits disconnected at the absolute deadline and cleans up a late connect", async () => {
    const lateConnect = deferred<boolean>();
    const channel = makeChannel(() => lateConnect.promise);
    const connector = new RaftConnector();
    const onEvent = jest.fn();
    connector.setEventListener(onEvent);
    configureRetry(connector, channel, 60);

    connector.onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    expect(onEvent).toHaveBeenCalledWith(
      "conn",
      RaftConnEvent.CONN_ISSUE_DETECTED,
      expect.any(String)
    );

    await jest.advanceTimersByTimeAsync(20);
    connector.onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    await jest.advanceTimersByTimeAsync(40);

    expect(onEvent).toHaveBeenCalledWith(
      "conn",
      RaftConnEvent.CONN_DISCONNECTED,
      expect.any(String)
    );
    expect(channel.disconnect).toHaveBeenCalledTimes(1);
    expect(connector.isConnected()).toBe(false);

    lateConnect.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(channel.disconnect).toHaveBeenCalledTimes(2);
    expect(connector.isConnected()).toBe(false);
  });

  it("emits issue resolved when reconnect succeeds before the deadline", async () => {
    const channel = makeChannel(async () => true);
    const connector = new RaftConnector();
    const onEvent = jest.fn();
    connector.setEventListener(onEvent);
    configureRetry(connector, channel, 60);

    connector.onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    await jest.advanceTimersByTimeAsync(10);

    expect(onEvent).toHaveBeenCalledWith(
      "conn",
      RaftConnEvent.CONN_ISSUE_RESOLVED,
      expect.any(String)
    );
    expect(channel.disconnect).not.toHaveBeenCalled();
    expect(connector.isConnected()).toBe(true);
  });

  it("emits disconnected exactly once when retry is disabled mid-window", async () => {
    const pendingConnect = deferred<boolean>();
    const channel = makeChannel(() => pendingConnect.promise);
    const connector = new RaftConnector();
    const onEvent = jest.fn();
    connector.setEventListener(onEvent);
    configureRetry(connector, channel, 100);
    channel.disconnect = jest.fn(() => {
      connector.onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
      return Promise.resolve();
    });

    connector.onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    await jest.advanceTimersByTimeAsync(10);
    expect(channel.connect).toHaveBeenCalledTimes(1);

    connector.setRetryConnectionIfLost(false, 100);

    expect(onEvent.mock.calls.filter(([, event]) =>
      event === RaftConnEvent.CONN_DISCONNECTED
    )).toHaveLength(1);
    expect(connector.isConnected()).toBe(false);
    expect(channel.disconnect).toHaveBeenCalledTimes(1);

    connector.setRetryConnectionIfLost(false, 100);
    expect(onEvent.mock.calls.filter(([, event]) =>
      event === RaftConnEvent.CONN_DISCONNECTED
    )).toHaveLength(1);
    expect(channel.disconnect).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(100);
    expect(channel.disconnect).toHaveBeenCalledTimes(1);

    pendingConnect.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(onEvent.mock.calls.filter(([, event]) =>
      event === RaftConnEvent.CONN_DISCONNECTED
    )).toHaveLength(1);
    expect(channel.disconnect).toHaveBeenCalledTimes(2);

    connector.onConnEvent(RaftConnEvent.CONN_CONNECTED);
    connector.onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    expect(onEvent.mock.calls.filter(([, event]) =>
      event === RaftConnEvent.CONN_DISCONNECTED
    )).toHaveLength(2);
  });

  it("does not emit issue resolved when disconnect starts during reconnect restoration", async () => {
    const channel = makeChannel(async () => true);
    (channel as unknown as { requiresSubscription: () => boolean }).requiresSubscription = () => true;
    const connector = new RaftConnector();
    const onEvent = jest.fn();
    connector.setEventListener(onEvent);
    configureRetry(connector, channel, 60);

    // System type whose re-subscription hangs until we release it, simulating
    // an explicit disconnect arriving mid-restoration.
    const subscribeGate = deferred<void>();
    (connector as unknown as { _systemType: object })._systemType = {
      subscribeForUpdates: jest.fn(() => subscribeGate.promise),
    };

    connector.onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    await jest.advanceTimersByTimeAsync(10);

    // Restoration is now awaited; explicit disconnect takes ownership.
    const connectorState = connector as unknown as {
      _raftChannel: RaftChannel | null;
      _retryIfLostGeneration: number;
      _retryIfLostIsConnected: boolean;
    };
    connectorState._raftChannel = null;
    connectorState._retryIfLostGeneration++;
    connectorState._retryIfLostIsConnected = false;

    subscribeGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onEvent.mock.calls.filter(([, event]) =>
      event === RaftConnEvent.CONN_ISSUE_RESOLVED
    )).toHaveLength(0);
    expect(onEvent.mock.calls.filter(([, event]) =>
      event === RaftConnEvent.CONN_RECOVERY_DEGRADED
    )).toHaveLength(0);
  });

  it("emits recovery degraded when reconnect subscription restoration fails", async () => {
    const channel = makeChannel(async () => true);
    (channel as unknown as { requiresSubscription: () => boolean }).requiresSubscription = () => true;
    const connector = new RaftConnector();
    const onEvent = jest.fn();
    connector.setEventListener(onEvent);
    configureRetry(connector, channel, 60);

    (connector as unknown as { _systemType: object })._systemType = {
      subscribeForUpdates: jest.fn(async () => {
        throw new Error("Injected reconnect subscription failure");
      }),
    };

    connector.onConnEvent(RaftConnEvent.CONN_DISCONNECTED);
    await jest.advanceTimersByTimeAsync(10);

    expect(onEvent.mock.calls.filter(([, event]) =>
      event === RaftConnEvent.CONN_ISSUE_RESOLVED
    )).toHaveLength(0);
    expect(onEvent.mock.calls.filter(([, event]) =>
      event === RaftConnEvent.CONN_RECOVERY_DEGRADED
    )).toHaveLength(1);
    expect(connector.isConnected()).toBe(true);
  });
});

describe("RaftConnector terminal disconnect", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("disconnects both the active channel and a channel in the normal disconnect grace period", async () => {
    const disconnectingChannel = makeDisconnectChannel();
    const activeChannel = makeDisconnectChannel();
    const connector = new RaftConnector();
    const connectorState = connector as unknown as { _raftChannel: RaftChannel };
    connectorState._raftChannel = disconnectingChannel;

    const normalDisconnect = connector.disconnect();
    connectorState._raftChannel = activeChannel;
    expect(disconnectingChannel.disconnect).not.toHaveBeenCalled();

    connector.disconnectForPageUnload();
    expect(disconnectingChannel.disconnect).toHaveBeenCalledTimes(1);
    expect(activeChannel.disconnect).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);
    await normalDisconnect;
    expect(disconnectingChannel.disconnect).toHaveBeenCalledTimes(2);
    expect(activeChannel.disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects every channel in overlapping normal disconnect grace periods", async () => {
    const firstChannel = makeDisconnectChannel();
    const secondChannel = makeDisconnectChannel();
    const connector = new RaftConnector();
    const connectorState = connector as unknown as { _raftChannel: RaftChannel };

    connectorState._raftChannel = firstChannel;
    const firstDisconnect = connector.disconnect();
    connectorState._raftChannel = secondChannel;
    const secondDisconnect = connector.disconnect();

    connector.disconnectForPageUnload();
    expect(firstChannel.disconnect).toHaveBeenCalledTimes(1);
    expect(secondChannel.disconnect).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);
    await Promise.all([firstDisconnect, secondDisconnect]);
    expect(firstChannel.disconnect).toHaveBeenCalledTimes(2);
    expect(secondChannel.disconnect).toHaveBeenCalledTimes(2);
  });
});
