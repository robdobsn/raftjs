import RaftCommsStats from "./RaftCommsStats";
import RaftConnector from "./RaftConnector";
import RaftMsgHandler from "./RaftMsgHandler";
import RaftStreamHandler from "./RaftStreamHandler";

type StreamHandlerState = {
  _streamBuffer: Uint8Array<ArrayBuffer>;
  _soktoPos: number;
  _soktoReceived: boolean;
};

function makeStreamHandler(): RaftStreamHandler {
  return new RaftStreamHandler(
    {} as RaftMsgHandler,
    {} as RaftCommsStats,
    {} as RaftConnector,
  );
}

describe("RaftStreamHandler SOKTO handling", () => {
  it("ignores the normal final stream acknowledgement", () => {
    const streamHandler = makeStreamHandler();
    const state = streamHandler as unknown as StreamHandlerState;
    state._streamBuffer = new Uint8Array(4);

    streamHandler.onSoktoMsg(4);

    expect(state._soktoPos).toBe(4);
    expect(state._soktoReceived).toBe(false);
  });

  it("retains an incomplete acknowledgement as streaming feedback", () => {
    const streamHandler = makeStreamHandler();
    const state = streamHandler as unknown as StreamHandlerState;
    state._streamBuffer = new Uint8Array(4);

    streamHandler.onSoktoMsg(2);

    expect(state._soktoPos).toBe(2);
    expect(state._soktoReceived).toBe(true);
  });
});
