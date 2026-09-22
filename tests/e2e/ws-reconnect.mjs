#!/usr/bin/env node
// Check that a WebSocket connection to a real device can be re-established, both explicitly
// (connect -> disconnect -> connect, repeated) and automatically (the socket is dropped under
// the connector, which must detect the loss, retry and report CONN_ISSUE_RESOLVED).
// Both paths must return to the URL of the first connect. The system type deliberately declares
// a wsSuffix that no firmware serves: connectorOptions are only known once the channel is up,
// so they must never leak into a later connect or a retry (they once did - the second connect
// silently failed). Run from the raftjs directory after `npm run build`:
//   AXIOM=192.168.86.136 node tests/e2e/ws-reconnect.mjs
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
const { RaftConnector, RaftConnEvent } = require("../../dist/web/main.js");

const AXIOM = String(process.env.AXIOM || "192.168.86.136").trim();
const NUM_CYCLES = Number(process.env.NUM_CYCLES || 3);
const RETRY_TIMEOUT_MS = Number(process.env.RETRY_TIMEOUT_MS || 20000);
const EXPECTED_URL = `ws://${AXIOM}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSystemType() {
  return {
    nameForDialogs: "Axiom (ws reconnect)", defaultWiFiHostname: "Axiom", firmwareDestName: "ricfw",
    normalFileDestName: "fs", connectorOptions: { wsSuffix: "not-served-by-any-firmware" },
    BLEServiceUUIDs: [], BLECmdUUID: "", BLERespUUID: "", capabilities: { tuning: {} },
    setup() {},
    subscribeForUpdates: async () => {},
    stateIsInvalid() {},
    rxOtherMsgType() {},
  };
}

let failures = 0;
function check(ok, what) {
  console.log(`   ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
  return ok;
}

async function main() {
  const connEvents = [];
  const connector = new RaftConnector(async () => makeSystemType());
  connector.setEventListener((evtType, eventEnum, eventName) => {
    if (evtType === "conn") connEvents.push({ eventEnum, eventName });
  });

  // Explicit connect / disconnect cycles - initializeChannel each time, as the dashboard does
  for (let cycle = 1; cycle <= NUM_CYCLES; cycle++) {
    console.log(`\n== connect cycle ${cycle} of ${NUM_CYCLES}`);
    connEvents.length = 0;
    await connector.initializeChannel("WebSocket");
    const connOk = await connector.connect(AXIOM);
    if (!check(connOk && connector.isConnected(), `connected to ${AXIOM}`)) break;
    // The previous cycle's socket closes asynchronously - its close event must not be
    // reported against this connection
    check(!connEvents.some((rec) => rec.eventEnum === RaftConnEvent.CONN_DISCONNECTED),
      `no stray DISCONNECTED during connect (events: ${connEvents.map((rec) => rec.eventName).join(", ")})`);
    check(connector.getConnLocator() === EXPECTED_URL, `connected URL is ${EXPECTED_URL} (got ${connector.getConnLocator()})`);
    const sysInfo = await connector.getRaftSystemUtils().getSystemInfo();
    check(Boolean(sysInfo?.SystemName), `system info read (${sysInfo?.SystemName} ${sysInfo?.SystemVersion})`);
    if (cycle < NUM_CYCLES) {
      await connector.disconnect();
      check(!connector.isConnected(), "disconnected");
      check(connEvents.some((rec) => rec.eventEnum === RaftConnEvent.CONN_DISCONNECTED),
        "DISCONNECTED reported by the time disconnect() returned");
    }
  }

  // Automatic retry - close the socket underneath the connector to simulate a lost link
  if (connector.isConnected()) {
    console.log("\n== lost link and automatic retry");
    connEvents.length = 0;
    const droppedSocket = connector.getRaftChannel()?._webSocket;
    if (check(Boolean(droppedSocket), "found the channel's socket to drop")) {
      droppedSocket.close();
      const t0 = Date.now();
      const sawEvent = (e) => connEvents.some((rec) => rec.eventEnum === e);
      while (Date.now() - t0 < RETRY_TIMEOUT_MS &&
        !sawEvent(RaftConnEvent.CONN_ISSUE_RESOLVED) &&
        !sawEvent(RaftConnEvent.CONN_RECOVERY_DEGRADED) &&
        !sawEvent(RaftConnEvent.CONN_DISCONNECTED)) {
        await sleep(100);
      }
      console.log(`   events: ${connEvents.map((rec) => rec.eventName).join(", ")} (${Date.now() - t0} ms)`);
      check(sawEvent(RaftConnEvent.CONN_ISSUE_DETECTED), "loss detected (ISSUE_DETECTED)");
      check(sawEvent(RaftConnEvent.CONN_ISSUE_RESOLVED), "retry restored the connection (ISSUE_RESOLVED)");
      check(connector.getConnLocator() === EXPECTED_URL, `retry returned to ${EXPECTED_URL} (got ${connector.getConnLocator()})`);
      const sysInfo = await connector.getRaftSystemUtils().getSystemInfo(true);
      check(Boolean(sysInfo?.SystemName), "system info read over the restored connection");
    }
  }

  await connector.disconnect();
  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("error:", e); process.exit(1); });
