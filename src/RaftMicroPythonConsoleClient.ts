import RaftConnector from "./RaftConnector";
import { RaftRtStreamDataCBType, RaftRtStreamHandle } from "./RaftTypes";

const REPL_NEWLINE = "\r";

export type RaftMicroPythonConsoleStatus = {
  rslt?: string;
  running?: string;
  replEnabled?: boolean;
  replRunning?: boolean;
  mode?: string;
  streamAttached?: boolean;
  mirrorToSerial?: boolean;
  inputBuffered?: number;
  outputBuffered?: number;
  outputSeq?: number;
  inputDropped?: number;
  outputDropped?: number;
};

export type RaftMicroPythonConsoleOutput = {
  rslt?: string;
  seq?: number;
  missed?: number;
  dropped?: number;
  data?: string;
};

export default class RaftMicroPythonConsoleClient {
  constructor(private _connector: RaftConnector) {}
  private readonly _streamDrainMs = 1200;

  async status(): Promise<RaftMicroPythonConsoleStatus> {
    return this._connector.sendRICRESTMsg("upy/repl/status", {}) as Promise<RaftMicroPythonConsoleStatus>;
  }

  async output(since: number): Promise<RaftMicroPythonConsoleOutput> {
    return this._connector.sendRICRESTMsg("upy/repl/output", { since }) as Promise<RaftMicroPythonConsoleOutput>;
  }

  // The text is URL-encoded (sendRICRESTMsg encodes params) so spaces, &, ?, quotes etc. reach the REPL intact.
  // The newline is added by the firmware (newline=1) rather than sent as a trailing \r because firmware before
  // the RaftMicroPy raw-query fix trims whitespace from query values, which removed the \r.
  async input(data: string, newline = true): Promise<{ rslt?: string }> {
    return this._connector.sendRICRESTMsg(
      "upy/repl/input",
      { data, newline: newline ? 1 : 0 }
    ) as Promise<{ rslt?: string }>;
  }

  async interrupt(): Promise<{ rslt?: string }> {
    return this._connector.sendRICRESTMsg("upy/repl/interrupt", {}) as Promise<{ rslt?: string }>;
  }

  async openStream(onData: RaftRtStreamDataCBType): Promise<RaftRtStreamHandle> {
    return this._connector.openRtStream({
      fileName: "upyconsole",
      endpoint: "upyconsole",
      onData,
    });
  }

  async streamInput(
    data: string,
    newline = true,
    onData: RaftRtStreamDataCBType = () => {}
  ): Promise<boolean> {
    const payload = newline ? `${data}${REPL_NEWLINE}` : data;
    const streamHandle = await this.openStream(onData);
    try {
      return await streamHandle.sendText(payload);
    } finally {
      setTimeout(() => {
        streamHandle.close().catch(() => {
          // The firmware may close short-lived console sessions first.
        });
      }, this._streamDrainMs);
    }
  }
}
