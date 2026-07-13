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
});
