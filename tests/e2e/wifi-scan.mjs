#!/usr/bin/env node
// Run RaftSystemUtils.wifiScan() against a real device over the wsjson WebSocket, printing the
// progress callbacks and the outcome. Scans twice by default so that the second scan shows the
// previous results during the scan and the new/lost counts. Works with current firmware (scan
// status object) and older firmware (results fail while the scan is in progress).
// Run from the raftjs directory after `npm run build`:
//   AXIOM=192.168.86.136 node tests/e2e/wifi-scan.mjs
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
const { RaftConnector, RaftDeviceManager } = require("../../dist/web/main.js");

const AXIOM = String(process.env.AXIOM || "192.168.86.136").trim();
const NUM_SCANS = Number(process.env.NUM_SCANS || 2);

function makeSystemType() {
  const dm = new RaftDeviceManager();
  return {
    nameForDialogs: "Axiom (wifi scan)", defaultWiFiHostname: "Axiom", firmwareDestName: "ricfw",
    normalFileDestName: "fs", connectorOptions: { wsSuffix: "wsjson" },
    BLEServiceUUIDs: [], BLECmdUUID: "", BLERespUUID: "", capabilities: { tuning: {} },
    setup(s) { dm.setup(s); },
    subscribeForUpdates: async () => {},
    stateIsInvalid() {},
    rxOtherMsgType() {},
    deviceMgrIF: dm,
  };
}

async function main() {
  const connector = new RaftConnector(async () => makeSystemType());
  await connector.initializeChannel("WebSocket");
  if (!(await connector.connect(AXIOM)) || !connector.isConnected()) {
    console.error("Failed to connect"); process.exit(1);
  }
  console.log(`connected to ${AXIOM}`);
  const systemUtils = connector.getRaftSystemUtils();
  let allOk = true;
  for (let scanIdx = 0; scanIdx < NUM_SCANS; scanIdx++) {
    // Firmware doesn't start a new scan within 1s of the previous one completing
    if (scanIdx > 0) await new Promise((r) => setTimeout(r, 1500));
    console.log(`\n== scan ${scanIdx + 1} of ${NUM_SCANS}`);
    const outcome = await systemUtils.wifiScan({
      resumeWifiIfPaused: true,
      onProgress: (p) => console.log(`   progress ${p.elapsedMs}ms legacy=${p.legacyFirmware} scan=${JSON.stringify(p.scan)} prevScanWifi=${p.prevScanWifi.length}`),
    });
    console.log(`   outcome ok=${outcome.ok} legacy=${outcome.legacyFirmware} error=${outcome.error} wifiResumed=${outcome.wifiResumed} scan=${JSON.stringify(outcome.scan)}`);
    for (const ap of outcome.wifi) {
      console.log(`   ${ap.ssid.padEnd(32)} ${String(ap.rssi).padStart(4)}dBm ch${String(ap.ch1).padEnd(3)} ${ap.auth.padEnd(14)} ${ap.bssid}${ap.new ? " NEW" : ""}`);
    }
    allOk = allOk && outcome.ok;
  }
  await connector.disconnect();
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error("error:", e); process.exit(1); });
