#!/usr/bin/env node
/* eslint-disable no-console */
//
// VCP signal locator - answers "which input is the signal actually on?"
//
// Puts every RoboticalVCP found into mode 1 (4-channel scan, so all inputs report at once)
// and prints min / max / peak-to-peak for each channel. A quiet input sits at a few mV;
// a driven one swings volts, so the answer is unambiguous at a glance.
//
// Run this before drawing any conclusion from a capture: it tells "wrong channel" and
// "wrong board" apart from "the generator is off", which otherwise look identical.
//
//   VCP_E2E_AXIOM=192.168.86.136 node tests/e2e/vcp-find-signal.mjs
//

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

const AXIOM = String(process.env.VCP_E2E_AXIOM || "").trim();
const CAPTURE_MS = Number(process.env.VCP_E2E_CAPTURE_MS || 4000);
const SUB_RATE_HZ = Number(process.env.VCP_E2E_SUB_RATE_HZ || 50);
if (!AXIOM) {
  console.error("VCP_E2E_AXIOM is not set");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSystemType() {
  const dm = new RaftDeviceManager();
  let su = null;
  return {
    nameForDialogs: "Axiom (find-signal)",
    defaultWiFiHostname: "Axiom",
    firmwareDestName: "ricfw",
    normalFileDestName: "fs",
    connectorOptions: { wsSuffix: "ws" },
    BLEServiceUUIDs: [], BLECmdUUID: "", BLERespUUID: "",
    capabilities: { tuning: {} },
    setup(s) { su = s; dm.setup(s); },
    subscribeForUpdates: async (s, enable) => {
      const off = `{"cmdName":"subscription","action":"update","pubRecs":[{"name":"devbin","rateHz":0}]}`;
      const on = `{"cmdName":"subscription","action":"update","pubRecs":[{"name":"devbin","trigger":"timeorchange","rateHz":${SUB_RATE_HZ},"minMs":10}]}`;
      const resp = await s.getMsgHandler().sendRICRESTCmdFrame(enable ? on : off);
      s.updatePublishTopicMapFromSubscriptionResponse(resp);
      if (enable) await s.refreshPublishTopicMap();
    },
    stateIsInvalid() {},
    rxOtherMsgType(payload) {
      const meta = inspectPublishFrame(payload, (i) => su?.getPublishTopicName(i));
      if (process.env.VCP_E2E_FRAMES) {
        globalThis.__frameStats = globalThis.__frameStats || {};
        const k = `${meta.frameType}/${meta.topicName}/env=${meta.binaryHasEnvelope}`;
        const st = (globalThis.__frameStats[k] = globalThis.__frameStats[k] || { n: 0, bytes: 0, max: 0 });
        st.n++; st.bytes += payload.length; st.max = Math.max(st.max, payload.length);
      }
      if (meta.frameType === "binary") {
        if (!meta.binaryHasEnvelope || meta.topicName === "devbin") dm.handleClientMsgBinary(payload);
      } else if (meta.frameType === "json" && meta.jsonString !== undefined) {
        dm.handleClientMsgJson(meta.jsonString);
      }
    },
    deviceMgrIF: dm,
  };
}

async function main() {
  const sysType = makeSystemType();
  const connector = new RaftConnector(async () => sysType);
  await connector.initializeChannel("WebSocket");
  if (!(await connector.connect(AXIOM)) || !connector.isConnected()) {
    console.error("Failed to connect");
    process.exit(1);
  }
  const dm = connector.getSystemType()?.deviceMgrIF || sysType.deviceMgrIF;

  // Let devices be discovered. Dwell for the WHOLE window rather than stopping at the
  // first hit - devices are identified as the scanner reaches them, so returning early
  // silently examines only whichever board happened to be found first.
  const DISCOVER_MS = Number(process.env.VCP_E2E_DISCOVER_MS || 12000);
  const deadline = Date.now() + DISCOVER_MS;
  let keys = [];
  while (Date.now() < deadline) {
    keys = Object.entries(dm.getDevicesState())
      .filter(([, st]) => st?.deviceTypeInfo?.type === "RoboticalVCP")
      .map(([k]) => k);
    await sleep(500);
  }
  console.log(`(all devices seen: ${Object.keys(dm.getDevicesState()).join(", ")})`);
  if (!keys.length) {
    console.error("No RoboticalVCP found");
    await connector.disconnect();
    process.exit(1);
  }
  console.log(`Found VCPs: ${keys.join(", ")}`);

  // Mode 1 so every channel reports simultaneously. VCP_E2E_NO_CONFIG=1 skips this, to
  // observe whatever state the devices are already in without disturbing it.
  if (!process.env.VCP_E2E_NO_CONFIG) {
    for (const key of keys) {
      const st = dm.getDeviceState(key);
      const modeAction = (st?.deviceTypeInfo?.actions || []).find((a) => a.n === "mode");
      if (modeAction) await dm.sendAction(key, modeAction, [1]);
      await dm.setSampleRate(key, 100);
    }
  } else {
    console.log("(VCP_E2E_NO_CONFIG - observing existing device state)");
  }
  await sleep(2500);

  const acc = {};
  let cbTotal = 0;
  const seenKeys = new Set();
  const cb = (d) => {
    cbTotal++;
    seenKeys.add(d.deviceKey);
    if (!keys.includes(d.deviceKey)) return;
    acc[d.deviceKey] = acc[d.deviceKey] || {};
    for (const [attr, vals] of Object.entries(d.attrValues || {})) {
      const a = (acc[d.deviceKey][attr] = acc[d.deviceKey][attr] || { min: Infinity, max: -Infinity, n: 0 });
      for (const v of vals) {
        const x = Number(v);
        if (!Number.isFinite(x)) continue;
        if (x < a.min) a.min = x;
        if (x > a.max) a.max = x;
        a.n++;
      }
    }
  };
  dm.addDecodedDataCallback(cb);
  console.log(`Capturing for ${CAPTURE_MS} ms in mode 1 ...`);
  await sleep(CAPTURE_MS);
  dm.removeDecodedDataCallback(cb);
  console.log(`(decoded callbacks: ${cbTotal}; from devices: ${[...seenKeys].join(", ") || "none"}; connected: ${connector.isConnected()})`);
  if (process.env.VCP_E2E_FRAMES) {
    console.log("  frames received:");
    for (const [k, v] of Object.entries(globalThis.__frameStats || {})) {
      console.log(`    ${k}: n=${v.n} totalBytes=${v.bytes} maxFrame=${v.max}`);
    }
  }
  await connector.disconnect();

  if (process.env.VCP_E2E_LENCHECK) {
    console.log("Array-length check (the chart pairs timestampsUs[i] with values[i] positionally):");
    for (const key of keys) {
      const st = dm.getDeviceState(key);
      const tl = st?.deviceTimeline?.timestampsUs?.length ?? -1;
      const parts = Object.entries(st?.deviceAttributes || {})
        .map(([n, a]) => `${n}=${a.values.length}${a.values.length === tl ? "" : " <-- MISMATCH"}`);
      console.log(`  ${key}: timestampsUs=${tl}  ${parts.join("  ")}`);
    }
  }
  console.log("\ndevice    channel    n     min       max      pk-pk");
  console.log("--------------------------------------------------------");
  let found = false;
  for (const key of keys) {
    for (const attr of ["V1", "V2", "V3", "I", "ovf"]) {
      const a = acc[key]?.[attr];
      if (!a || !a.n) { console.log(`${key.padEnd(9)} ${attr.padEnd(9)} -`); continue; }
      const pk = a.max - a.min;
      const flag = pk > 0.05 ? "  <== SIGNAL HERE" : "";
      if (pk > 0.05) found = true;
      console.log(`${key.padEnd(9)} ${attr.padEnd(9)} ${String(a.n).padEnd(5)} ${a.min.toFixed(3).padStart(7)} ${a.max.toFixed(3).padStart(9)} ${pk.toFixed(3).padStart(9)}${flag}`);
    }
  }
  if (!found) console.log("\nNo channel is moving - the generator output is not reaching either board.");
  process.exit(found ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
