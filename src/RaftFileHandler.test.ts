import RaftCommsStats from "./RaftCommsStats";
import RaftFileHandler from "./RaftFileHandler";
import RaftMsgHandler from "./RaftMsgHandler";
import { RaftFileSendType } from "./RaftTypes";

// A device that takes uploads as the firmware's FileUploadOKTOProtocol does: every block it receives counts towards
// the ack batch, including blocks at the wrong position (which it drops); it acks after the first block, after each
// batch and after the last block, and on a timer when blocks stop arriving. All its acks look the same
// ({"req":"ufBlock","rslt":"ok","okto":N}), so the handler only sees the position.
class SimDevice {
  data: number[] = [];
  blocksReceived = 0;
  timerAcks = 0;
  private len = 0;
  private batch = 0;
  private batchCount = 0;
  private blockCount = 0;
  private active = false;
  private outOfSequenceAcked = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lose: Set<number>;
  handler?: RaftFileHandler;

  // `lose`: file positions whose first block is lost on the way; `timerMs` is the device's (1s).
  // `ackOutOfSequence`: as RaftCore from 2026-10-23 - the first block out of sequence is acked at once, the rest
  // aren't counted towards the batch, and a timer ack starts the batch count again
  constructor(lose: number[], private ackOutOfSequence = false, private ackDelayMs = 2, private timerMs = 1000) {
    this.lose = new Set(lose);
  }

  start(len: number, batch: number) {
    Object.assign(this, { data: [], len, batch, batchCount: 0, blockCount: 0, active: true });
  }

  block(pos: number, bytes: Uint8Array) {
    this.blocksReceived++;
    if (this.lose.has(pos)) {
      this.lose.delete(pos);
      return;
    }
    if (!this.active) return;
    if (this.ackOutOfSequence && pos !== this.data.length) {
      if (!this.outOfSequenceAcked) {
        this.outOfSequenceAcked = true;
        this.batchCount = 0;
        this.ack();
      }
      this.armTimer();
      return;
    }
    this.outOfSequenceAcked = false;
    this.batchCount++;
    let isFinal = false;
    if (pos === this.data.length) {
      this.data.push(...bytes);
      this.blockCount++;
      isFinal = this.data.length >= this.len;
    }
    if (this.batchCount === this.batch || this.blockCount === 1 || isFinal) {
      this.batchCount = 0;
      this.ack();
    }
    if (isFinal) {
      this.active = false;
      clearTimeout(this.timer);
    } else {
      this.armTimer();
    }
  }

  private ack() {
    const okto = this.data.length;
    setTimeout(() => this.handler?.onOktoMsg(okto), this.ackDelayMs);
  }

  private armTimer() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.active) return;
      this.timerAcks++;
      if (this.ackOutOfSequence) this.batchCount = 0;
      this.ack();
      this.armTimer();
    }, this.timerMs);
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
  }
}

// Upload a file to a SimDevice. `sendMs` is how long each block takes to send (0: an instant link)
async function upload(fileLen: number, block: number, batch: number, lose: number[] = [], sendMs = 0,
                      ackOutOfSequence = false) {
  const device = new SimDevice(lose, ackOutOfSequence);
  const msgHandler = {
    sendRICREST: async (cmd: string) => {
      const json = JSON.parse(cmd);
      if (json.cmdName === "ufStart") {
        device.start(json.fileLen, batch);
        return { rslt: "ok", batchMsgSize: block, batchAckSize: batch, streamID: 1 };
      }
      return { rslt: "ok" };
    },
    sendFileBlock: async (bytes: Uint8Array, pos: number) => {
      // Blocks in flight: sent beyond the position the handler knows is acked
      const acked = (handler as unknown as { _ackedFilePos: number })._ackedFilePos;
      maxInFlight = Math.max(maxInFlight, Math.ceil((pos + bytes.length - acked) / block));
      if (sendMs > 0) await new Promise((resolve) => setTimeout(resolve, sendMs));
      device.block(pos, bytes);
      return true;
    },
  } as unknown as RaftMsgHandler;
  let maxInFlight = 0;
  const handler = new RaftFileHandler(msgHandler, new RaftCommsStats());
  device.handler = handler;
  const contents = Uint8Array.from({ length: fileLen }, (_, i) => (i * 7) & 0xff);
  const start = Date.now();
  const ok = await handler.fileSend("test.bin", RaftFileSendType.NORMAL_FILE, "fs", contents, undefined);
  device.stop();
  return {
    ok,
    intact: device.data.length === fileLen && device.data.every((b, i) => b === contents[i]),
    blocksSent: device.blocksReceived,
    blocksNeeded: Math.ceil(fileLen / block),
    timerAcks: device.timerAcks,
    maxInFlight,
    ms: Date.now() - start,
  };
}

// Lost blocks (file positions) in a 100-block file of 100-byte blocks, batches of 10
const MID_BATCH = [2300, 5400, 8600];
const BATCH_START = [2000, 5000, 8000];

describe("RaftFileHandler upload", () => {
  it("sends each block once when none are lost", async () => {
    const r = await upload(5000, 100, 10);
    expect([r.ok, r.intact]).toEqual([true, true]);
    expect(r.blocksSent).toBe(r.blocksNeeded);
    expect(r.timerAcks).toBe(0);
    expect(r.maxInFlight).toBeLessThanOrEqual(10);
  }, 30000);

  // Current firmware (RaftCore from 2026-10-23) acks the first block out of sequence at once and keeps its acks in
  // step with the batches: little is sent twice, and a lost block mid-batch needs no timer ack
  it.each([
    ["mid-batch", MID_BATCH, 0],
    ["at the start of a batch", BATCH_START, 1],
  ])("recovers from blocks lost %s with current firmware", async (_name, lose, maxTimerAcks) => {
    const r = await upload(10000, 100, 10, lose as number[], 15, true);
    expect([r.ok, r.intact]).toEqual([true, true]);
    expect(r.timerAcks).toBeLessThanOrEqual(maxTimerAcks as number);
    expect(r.blocksSent).toBeLessThanOrEqual(r.blocksNeeded + 3 * 10);
    expect(r.maxInFlight).toBeLessThanOrEqual(10);
  }, 60000);

  // Older firmware counts the blocks it drops after a loss, so its acks fall part-way through batches. Before this
  // handler counted acks arriving while a batch was going out, each later batch then waited for the device's 1s
  // timer ack (13 of them after one loss in a 200-block file)
  it.each([
    ["mid-batch", MID_BATCH],
    ["at the start of a batch", BATCH_START],
  ])("doesn't wait for timer acks after blocks lost %s with older firmware", async (_name, lose) => {
    const r = await upload(10000, 100, 10, lose as number[], 15);
    expect([r.ok, r.intact]).toEqual([true, true]);
    expect(r.timerAcks).toBeLessThanOrEqual(1);
    expect(r.maxInFlight).toBeLessThanOrEqual(10);
  }, 60000);

  it.each([[false], [true]])("recovers the last block lost (current firmware %s)", async (currentFirmware) => {
    const r = await upload(5000, 100, 10, [4900], 0, currentFirmware);
    expect([r.ok, r.intact]).toEqual([true, true]);
    expect(r.blocksSent).toBe(r.blocksNeeded + 1);
  }, 30000);

  it("ignores a late ack behind one already received", () => {
    const handler = new RaftFileHandler({} as RaftMsgHandler, new RaftCommsStats());
    const state = handler as unknown as { _ackedFilePos: number; _batchAckReceived: boolean };
    handler.onOktoMsg(800);
    state._batchAckReceived = false;
    handler.onOktoMsg(400);
    expect(state._ackedFilePos).toBe(800);
    expect(state._batchAckReceived).toBe(false);
  });
});
