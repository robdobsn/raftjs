import RaftCommsStats from "./RaftCommsStats";
import RaftFileHandler from "./RaftFileHandler";
import RaftMsgHandler from "./RaftMsgHandler";
import RaftMiniHDLC from "./RaftMiniHDLC";
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

// ===== Downloads =====

// A device that sends a file as the firmware's FileDownloadOKTOProtocol does: blocks as fast as the ack window
// (batch) allows; when nothing is acked for `ackTimeoutMs` it goes back to the last position acked - with blocks of
// half the size if `fallback` (RaftCore after 1.67.0), the same size otherwise. `deliverMax`: the largest block its
// transport delivers (bigger ones are lost, as a serial console that offers more than its transmit buffer takes)
class SimDownloadDevice {
  starts: number[] = [];
  acks: number[] = [];
  cancels = 0;
  blocksDelivered = 0;
  crcOverride?: string;
  handler?: RaftFileHandler;
  private data: Uint8Array = new Uint8Array(0);
  private block = 0;
  private batch = 0;
  private okto = 0;
  private sentUpto = 0;
  private lastProgressMs = 0;
  private session = 0;
  private timer?: ReturnType<typeof setInterval>;
  // As the firmware: the first block waits for the client's first ack (or 200 ms)
  private ready = false;
  private startMs = 0;
  startedByAck = 0;

  constructor(private contents: Uint8Array, private deliverMax = Infinity, private fallback = false,
              private ackTimeoutMs = 100, private blockMax = 5000) {}

  msgHandler(): RaftMsgHandler {
    return {
      sendRICREST: async (cmd: string) => {
        const json = JSON.parse(cmd);
        if (json.cmdName === "dfStart") {
          this.starts.push(json.batchMsgSize);
          this.data = this.contents;
          this.block = Math.min(json.batchMsgSize, this.blockMax);
          this.batch = json.batchAckSize;
          this.okto = this.sentUpto = 0;
          this.lastProgressMs = Date.now();
          this.ready = false;
          this.startMs = Date.now();
          const session = ++this.session;
          clearInterval(this.timer);
          this.timer = setInterval(() => this.service(session), 5);
          setTimeout(() => this.service(session), 0);
          return { rslt: "ok", batchMsgSize: this.block, batchAckSize: this.batch, streamID: 7, fileLen: this.data.length };
        }
        if (json.cmdName === "dfEnd") {
          clearInterval(this.timer);
          const crc = this.crcOverride ?? RaftMiniHDLC.crc16(this.data).toString(16).padStart(4, "0");
          return { rslt: "ok", crc16: crc };
        }
        return { rslt: "ok" };
      },
      sendRICRESTNoResp: async (cmd: string) => {
        const json = JSON.parse(cmd);
        if (json.cmdName === "dfAck") {
          this.acks.push(json.okto);
          if (!this.ready) {
            this.ready = true;
            this.startedByAck++;
            this.lastProgressMs = Date.now();
          }
          if (json.okto > this.okto) {
            this.okto = json.okto;
            this.lastProgressMs = Date.now();
          }
          this.service(this.session);
        } else if (json.cmdName === "dfCancel") {
          this.cancels++;
          this.session++;
          clearInterval(this.timer);
        }
        return true;
      },
    } as unknown as RaftMsgHandler;
  }

  stop() {
    clearInterval(this.timer);
  }

  private service(session: number) {
    if (session !== this.session) return;
    if (!this.ready) {
      if (Date.now() - this.startMs < 200) return;
      this.ready = true;
      this.lastProgressMs = Date.now();
    }
    if (Date.now() - this.lastProgressMs > this.ackTimeoutMs) {
      this.sentUpto = this.okto;
      this.lastProgressMs = Date.now();
      if (this.fallback) this.block = Math.max(Math.floor(this.block / 2), 64);
    }
    this.sentUpto = Math.max(this.sentUpto, this.okto);
    while (this.sentUpto < this.data.length && Math.ceil((this.sentUpto - this.okto) / this.block) < this.batch) {
      const pos = this.sentUpto;
      const bytes = this.data.slice(pos, pos + this.block);
      this.sentUpto += bytes.length;
      if (bytes.length <= this.deliverMax) {
        this.blocksDelivered++;
        this.handler?.onFileBlock(((7 << 24) | pos) >>> 0, bytes);
      }
    }
  }
}

function downloadSetup(fileLen: number, deliverMax = Infinity, fallback = false, blockMax = 5000) {
  const contents = Uint8Array.from({ length: fileLen }, (_, i) => (i * 7 + (i >> 8)) & 0xff);
  const device = new SimDownloadDevice(contents, deliverMax, fallback, 100, blockMax);
  const handler = new RaftFileHandler(device.msgHandler(), new RaftCommsStats());
  device.handler = handler;
  const intact = (data: Uint8Array | null) => !!data && data.length === fileLen && data.every((b, i) => b === contents[i]);
  return { device, handler, intact };
}

describe("RaftFileHandler download", () => {
  it("acks each batch as it arrives, so the device isn't left waiting", async () => {
    // 200 blocks in batches of 4: 50 batches. Acked on the 50ms poll (as before) that took over 2.5s
    const { device, handler, intact } = downloadSetup(200 * 500, Infinity, false, 500);
    const start = Date.now();
    const result = await handler.fileReceive("test.bin", "fs", undefined);
    device.stop();
    expect(result.downloadedOk).toBe(true);
    expect(intact(result.fileData)).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(device.starts).toEqual([5000]);
    // An ack at the start, then for each batch (4 blocks of 500), and the final one
    expect(device.acks.slice(0, 4)).toEqual([0, 2000, 4000, 6000]);
    expect(device.acks[device.acks.length - 1]).toBe(100000);
    // The device's first block waited for that first ack (not for its 200ms start time)
    expect(device.startedByAck).toBe(1);
  });

  it("starts again with smaller blocks when none arrive (firmware that offers more than it can send)", async () => {
    const { device, handler, intact } = downloadSetup(9000, 1300);
    handler.FILE_RX_STALL_MS = 150;
    const result = await handler.fileReceive("test.bin", "fs", undefined);
    expect(intact(result.fileData)).toBe(true);
    expect(device.starts).toEqual([5000, 2500, 1250]);
    expect(device.cancels).toBe(2);
    // The size that worked is asked for first from then on
    const again = await handler.fileReceive("test.bin", "fs", undefined);
    device.stop();
    expect(intact(again.fileData)).toBe(true);
    expect(device.starts).toEqual([5000, 2500, 1250, 1250]);
  });

  it("fails when even the smallest blocks don't arrive", async () => {
    const { device, handler } = downloadSetup(3000, 100);
    handler.FILE_RX_STALL_MS = 50;
    (handler as unknown as { BLOCK_ACK_TIMEOUT_MS: number }).BLOCK_ACK_TIMEOUT_MS = 300;
    await expect(handler.fileReceive("test.bin", "fs", undefined)).rejects.toThrow("fileReceive failed");
    device.stop();
    expect(device.starts).toEqual([5000, 2500, 1250, 625, 312]);
  });

  it("takes smaller blocks than the device said (firmware that halves its block size)", async () => {
    const { device, handler, intact } = downloadSetup(20000, 700, true, 2400);
    const start = Date.now();
    const result = await handler.fileReceive("test.bin", "fs", undefined);
    device.stop();
    expect(intact(result.fileData)).toBe(true);
    expect(device.starts).toEqual([5000]);
    // Two fallbacks by the device (100ms each), then blocks acked a batch at a time (not on the 1s ack timer)
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("fails a download whose data doesn't match the device's CRC", async () => {
    const { device, handler } = downloadSetup(3000);
    device.crcOverride = "0000";
    const result = await handler.fileReceive("test.bin", "fs", undefined);
    device.stop();
    expect(result.downloadedOk).toBe(false);
  });
});
