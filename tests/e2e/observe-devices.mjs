#!/usr/bin/env node
// Observe what an Axiom publishes to a raftjs client (the same path the dashboard uses):
// connect over the /ws (RICSerial) WebSocket, subscribe to devbin, dwell, then print per-device
// sample counts, last values and last timestamps. Run from the raftjs directory:
//   AXIOM=192.168.86.136 node tests/e2e/observe-devices.mjs   (from the raftjs directory)
import Module from "node:module";
import { createRequire } from "node:module";

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "./RaftChannelBLE" || request.endsWith("/RaftChannelBLE")) {
    return origResolve.call(this, `${request}.web`, ...rest);
  }
  return origResolve.call(this, request, ...rest);
};
const require = createRequire(import.meta.url);
const raft = require("../../dist/web/main.js");
const { RaftConnector, RaftDeviceManager, inspectPublishFrame } = raft;

const AXIOM = String(process.env.AXIOM || "192.168.86.136").trim();
const DWELL_MS = Number(process.env.DWELL_MS || 12000);
const SUB_RATE_HZ = Number(process.env.SUB_RATE_HZ || 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let frames = {};
// Raw-record dump: find device records by their header signature [addr 4 bytes][devTypeIdx 2 bytes]
// (the record starts 3 bytes earlier: 2-byte length + status byte) and print the payload that
// follows, which is the device's raw poll response (for the LSM6DS: 4 FIFO status bytes then
// FIFO words). Limited to a few occurrences per device.
const SIGS = { "LSM6DS 1_76a": [0x00,0x00,0x07,0x6a,0x00,0x09], "Thermo 1_121": [0x00,0x00,0x01,0x21,0x00,0x29] };
const dumped = {};
function dumpRecords(buf) {
  for (const [name, sig] of Object.entries(SIGS)) {
    dumped[name] = dumped[name] || 0;
    if (dumped[name] >= 6) continue;
    outer: for (let i = 3; i + sig.length <= buf.length; i++) {
      for (let j = 0; j < sig.length; j++) if (buf[i + j] !== sig[j]) continue outer;
      const recLen = (buf[i - 3] << 8) | buf[i - 2];
      const status = buf[i - 1];
      const payloadStart = i + sig.length;
      const payloadEnd = Math.min(buf.length, i - 1 + recLen);
      const payload = Array.from(buf.slice(payloadStart, payloadEnd));
      console.log(`RAW ${name}: recLen=${recLen} status=0x${status.toString(16)} online=${(status & 0x80) !== 0} payload(${payload.length})=${payload.map(b => b.toString(16).padStart(2, "0")).join(" ").slice(0, 160)}`);
      dumped[name]++;
      break;
    }
  }
}
function makeSystemType() {
  const dm = new RaftDeviceManager();
  let su = null;
  return {
    nameForDialogs: "Axiom (observe)", defaultWiFiHostname: "Axiom", firmwareDestName: "ricfw",
    normalFileDestName: "fs", connectorOptions: { wsSuffix: "ws" },
    BLEServiceUUIDs: [], BLECmdUUID: "", BLERespUUID: "", capabilities: { tuning: {} },
    setup(s) { su = s; dm.setup(s); },
    subscribeForUpdates: async (s, enable) => {
      const off = `{"cmdName":"subscription","action":"update","pubRecs":[{"name":"devbin","rateHz":0}]}`;
      const on = `{"cmdName":"subscription","action":"update","pubRecs":[{"name":"devbin","trigger":"timeorchange","rateHz":${SUB_RATE_HZ},"minMs":10}]}`;
      const resp = await s.getMsgHandler().sendRICRESTCmdFrame(enable ? on : off);
      console.log("subscription response:", JSON.stringify(resp).slice(0, 300));
      s.updatePublishTopicMapFromSubscriptionResponse(resp);
      if (enable) await s.refreshPublishTopicMap();
    },
    stateIsInvalid() {},
    rxOtherMsgType(payload) {
      dumpRecords(payload);
      const meta = inspectPublishFrame(payload, (i) => su?.getPublishTopicName(i));
      const k = `${meta.frameType}/${meta.topicName}/env=${meta.binaryHasEnvelope}`;
      const st = (frames[k] = frames[k] || { n: 0, bytes: 0 });
      st.n++; st.bytes += payload.length;
      if (meta.frameType === "binary") {
        if (!meta.binaryHasEnvelope || meta.topicName === "devbin") dm.handleClientMsgBinary(payload);
      } else if (meta.frameType === "json" && meta.jsonString !== undefined) {
        dm.handleClientMsgJson(meta.jsonString);
      }
    },
    deviceMgrIF: dm,
  };
}

function summarise(dm) {
  const states = dm.getDevicesState();
  for (const [key, st] of Object.entries(states)) {
    const type = st?.deviceTypeInfo?.type ?? st?.deviceTypeInfo?.name ?? "?";
    const tl = st?.deviceTimeline;
    const ts = tl?.timestampsUs ?? tl?.timestamps ?? [];
    const lastTs = ts.length ? ts[ts.length - 1] : null;
    const online = st?.onlineState;
    let stats = null;
    try { stats = dm.getDeviceStats(key); } catch (e) {}
    console.log(`\n== ${key}  type=${type}  online=${online}  timeline samples=${ts.length} lastTs=${lastTs}`);
    if (stats) console.log("   stats:", JSON.stringify(stats).slice(0, 300));
    const attrs = st?.deviceAttributes ?? {};
    for (const [an, as] of Object.entries(attrs)) {
      const vals = as?.values ?? [];
      const last = vals.length ? vals.slice(-Math.max(1, as?.elemsPerSample ?? 1)) : [];
      console.log(`   ${an.padEnd(12)} n=${String(vals.length).padStart(5)} newData=${as?.newData} last=${JSON.stringify(last)}`);
    }
    if (!Object.keys(attrs).length) console.log("   (no attributes) state keys:", Object.keys(st ?? {}).join(","));
  }
}

async function main() {
  const sysType = makeSystemType();
  const connector = new RaftConnector(async () => sysType);
  await connector.initializeChannel("WebSocket");
  if (!(await connector.connect(AXIOM)) || !connector.isConnected()) {
    console.error("Failed to connect"); process.exit(1);
  }
  console.log(`connected to ${AXIOM}; dwelling ${DWELL_MS} ms`);
  const dm = connector.getSystemType()?.deviceMgrIF || sysType.deviceMgrIF;
  const t0 = Date.now();
  while (Date.now() - t0 < DWELL_MS) {
    await sleep(3000);
    console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s devices: ${Object.keys(dm.getDevicesState()).join(", ") || "(none yet)"}`);
  }
  console.log("\nframes received:", JSON.stringify(frames));
  summarise(dm);
  await connector.disconnect();
  process.exit(0);
}
main().catch((e) => { console.error("error:", e); process.exit(1); });
