import { RaftConnEvent } from "./RaftConnEvents";
import RaftChannelWebSocket from "./RaftChannelWebSocket";

// Minimal stand-in for a WebSocket: opens on the next microtask and, like a real
// socket, delivers its close event asynchronously - only when the test asks
interface FakeSocket {
  url: string;
  onopen: ((evt: object) => void) | null;
  onclose: ((evt: object) => void) | null;
  onmessage: ((evt: object) => void) | null;
  close: jest.Mock;
  deliverCloseEvent: (code: number) => void;
}

jest.mock("isomorphic-ws", () => {
  class MockWebSocket {
    static instances: MockWebSocket[] = [];
    binaryType = "";
    onopen: ((evt: object) => void) | null = null;
    onerror: ((evt: object) => void) | null = null;
    onclose: ((evt: object) => void) | null = null;
    onmessage: ((evt: object) => void) | null = null;
    close = jest.fn();
    constructor(public url: string) {
      MockWebSocket.instances.push(this);
      void Promise.resolve().then(() => this.onopen?.({}));
    }
    deliverCloseEvent(code: number): void {
      this.onclose?.({ code, wasClean: code === 1000, reason: "" });
    }
  }
  return { __esModule: true, default: MockWebSocket };
});

function socketInstances(): FakeSocket[] {
  return (jest.requireMock("isomorphic-ws") as { default: { instances: FakeSocket[] } }).default.instances;
}

async function connectedChannel(): Promise<{ channel: RaftChannelWebSocket; socket: FakeSocket; onConnEvent: jest.Mock }> {
  const channel = new RaftChannelWebSocket();
  const onConnEvent = jest.fn();
  channel.setOnConnEvent(onConnEvent);
  expect(await channel.connect("192.168.1.10", {})).toBe(true);
  const sockets = socketInstances();
  return { channel, socket: sockets[sockets.length - 1], onConnEvent };
}

describe("RaftChannelWebSocket disconnect", () => {
  beforeEach(() => {
    socketInstances().length = 0;
  });

  it("connects a bare host to the ws path", async () => {
    const { channel, socket } = await connectedChannel();
    expect(socket.url).toBe("ws://192.168.1.10/ws");
    expect(channel.getConnectedLocator()).toBe("ws://192.168.1.10/ws");
  });

  it("reports an explicit disconnect before returning and ignores the late close event", async () => {
    const { channel, socket, onConnEvent } = await connectedChannel();

    await channel.disconnect();
    expect(socket.close).toHaveBeenCalledWith(1000);
    expect(channel.isConnected()).toBe(false);
    expect(onConnEvent).toHaveBeenCalledTimes(1);
    expect(onConnEvent).toHaveBeenCalledWith(RaftConnEvent.CONN_DISCONNECTED);

    // The socket's close event arrives later - possibly during a following
    // connect - and must not be reported again
    socket.deliverCloseEvent(1000);
    expect(onConnEvent).toHaveBeenCalledTimes(1);
  });

  it("still reports a close that was not requested", async () => {
    const { channel, socket, onConnEvent } = await connectedChannel();

    socket.deliverCloseEvent(1006);
    expect(channel.isConnected()).toBe(false);
    expect(onConnEvent).toHaveBeenCalledTimes(1);
    expect(onConnEvent).toHaveBeenCalledWith(RaftConnEvent.CONN_DISCONNECTED);
  });

  it("reports nothing when disconnected without a socket", async () => {
    const channel = new RaftChannelWebSocket();
    const onConnEvent = jest.fn();
    channel.setOnConnEvent(onConnEvent);

    await channel.disconnect();
    expect(onConnEvent).not.toHaveBeenCalled();
  });
});
