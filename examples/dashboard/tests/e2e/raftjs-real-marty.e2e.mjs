/* eslint-disable no-console */
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.resolve(THIS_DIR, "../..");
const REPO_DIR = path.resolve(DASHBOARD_DIR, "../..");
const HOST = "127.0.0.1";
const MARTY_NAME = String(
  process.env.RAFT_DASHBOARD_E2E_MARTY_NAME || ""
).trim();
const WIFI_LOCATOR = String(
  process.env.RAFT_DASHBOARD_E2E_WIFI_LOCATOR || ""
).trim();
const EXTERNAL_BASE_URL = String(
  process.env.RAFT_DASHBOARD_E2E_BASE_URL || ""
).trim();
const CONNECT_TIMEOUT_MS = Number(
  process.env.RAFT_DASHBOARD_E2E_CONNECT_TIMEOUT_MS || 90000
);
const DEVICE_TIMEOUT_MS = Number(
  process.env.RAFT_DASHBOARD_E2E_DEVICE_TIMEOUT_MS || 60000
);
const SERVER_TIMEOUT_MS = Number(
  process.env.RAFT_DASHBOARD_E2E_SERVER_TIMEOUT_MS || 120000
);
const BROWSER_TIMEOUT_MS = Math.max(CONNECT_TIMEOUT_MS, DEVICE_TIMEOUT_MS) + 5000;
const BROWSER_URL = String(
  process.env.RAFT_DASHBOARD_E2E_BROWSER_URL || ""
).trim();
const BROWSER_EXECUTABLE = String(
  process.env.RAFT_DASHBOARD_E2E_BROWSER_EXECUTABLE ||
    (process.platform === "darwin"
      ? path.join(
          process.env.HOME || "",
          "Applications/Google Chrome for Testing BLE.app/Contents/MacOS/Google Chrome for Testing"
        )
      : "")
).trim();

const SCENARIOS = [
  "marty-connect-disconnect-race",
  "marty-reconnect-disconnect-race",
  "marty-subscribe-failure-resolved",
  "marty-ble-write-size",
  "marty-websocket-stale-close",
];
const DEFAULT_SCENARIOS = [
  "marty-ble-write-size",
  "marty-connect-disconnect-race",
  "marty-reconnect-disconnect-race",
  "marty-subscribe-failure-resolved",
];
const requestedScenarios = String(
  process.env.RAFT_DASHBOARD_E2E_SCENARIOS || ""
)
  .split(",")
  .map((scenario) => scenario.trim())
  .filter(Boolean);
const SELECTED_SCENARIOS = requestedScenarios.length
  ? requestedScenarios
  : DEFAULT_SCENARIOS;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function waitForHttp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const attempt = () => {
      const request = http.get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (
            response.statusCode === 200 &&
            /<title>RaftJS Dashboard<\/title>/i.test(body)
          ) {
            resolve();
            return;
          }
          if (Date.now() - startedAt >= timeoutMs) {
            reject(new Error(`Dashboard was not ready at ${url}.`));
            return;
          }
          setTimeout(attempt, 500);
        });
      });
      request.once("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Dashboard was not reachable at ${url}.`));
          return;
        }
        setTimeout(attempt, 500);
      });
      request.setTimeout(3000, () => request.destroy());
    };
    attempt();
  });
}

function startDashboardServer(port) {
  const distDir = buildDashboard();
  return startStaticServer(distDir, port);
}

// Build the dashboard once (no watch). `parcel serve` relies on native file
// watching and an mmap'd LMDB cache, both of which fail on a WSL/9P filesystem
// exposed as a Windows mapped drive. A one-shot build + static serve is
// filesystem-agnostic and all we need for an E2E run.
function buildDashboard() {
  // Invoke parcel's JS entry with the current node executable rather than the
  // .bin/.cmd shim: newer Node versions refuse to spawn .cmd files without a
  // shell (CVE-2024-27980 hardening -> spawnSync EINVAL on Windows).
  const parcelJs = path.join(DASHBOARD_DIR, "node_modules", "parcel", "lib", "bin.js");
  if (!fsSync.existsSync(parcelJs)) {
    throw new Error(
      `Dashboard dependencies are missing. Run npm install in ${DASHBOARD_DIR}.`
    );
  }
  const distDir = path.join(DASHBOARD_DIR, "dist-e2e");
  // --no-cache: parcel's cache invalidation relies on file mtimes, which are
  // unreliable across a WSL/9P mapped drive - a stale cache silently serves an
  // old bundle. A clean build costs a few seconds and guarantees current source.
  const args = [parcelJs, "build", "src/index.html", "--dist-dir", distDir, "--no-optimize", "--no-cache"];
  if (process.platform === "win32") {
    // Keep Parcel's LMDB cache off the 9P mapped drive (mmap fails there).
    args.push("--cache-dir", path.join(os.tmpdir(), "raftjs-dashboard-e2e-cache"));
  }
  console.log("[server] Building dashboard (parcel build)...");
  execFileSync(process.execPath, args, {
    cwd: DASHBOARD_DIR,
    stdio: "inherit",
    env: { ...process.env },
  });
  return distDir;
}

const STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function startStaticServer(distDir, port) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const rel = path.normalize(urlPath).replace(/^([\\/]|\.\.[\\/])+/, "");
    const filePath = path.join(distDir, rel);
    if (!filePath.startsWith(distDir)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    fsSync.readFile(filePath, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.setHeader(
        "Content-Type",
        STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ||
          "application/octet-stream"
      );
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

function stopDashboardServer(server) {
  if (!server || typeof server.close !== "function") return;
  try {
    server.close();
  } catch {
    // The server may already have been closed.
  }
}

function waitForBrowserEndpoint(browserUrl, timeoutMs = 45000) {
  const endpoint = `${normalizeUrl(browserUrl)}/json/version`;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const attempt = () => {
      const request = http.get(endpoint, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const payload = JSON.parse(body);
            if (response.statusCode === 200 && payload.webSocketDebuggerUrl) {
              resolve();
              return;
            }
          } catch {
            // Retry an incomplete endpoint response.
          }
          if (Date.now() - startedAt >= timeoutMs) {
            reject(new Error(`Browser endpoint was not ready at ${endpoint}.`));
            return;
          }
          setTimeout(attempt, 500);
        });
      });
      request.once("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Browser endpoint was not reachable at ${endpoint}.`));
          return;
        }
        setTimeout(attempt, 500);
      });
      request.setTimeout(3000, () => request.destroy());
    };
    attempt();
  });
}

function appBundleFromExecutable(executable) {
  const match = executable.match(/^(.*?\.app)\//);
  return match?.[1] || "";
}

async function launchBrowser() {
  if (BROWSER_URL) {
    await waitForBrowserEndpoint(BROWSER_URL);
    return {
      browser: await puppeteer.connect({
        browserURL: normalizeUrl(BROWSER_URL),
        defaultViewport: null,
        protocolTimeout: BROWSER_TIMEOUT_MS,
      }),
      mode: "attach",
      launched: null,
    };
  }

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--enable-experimental-web-platform-features",
    "--enable-web-bluetooth-new-permissions-backend",
  ];

  if (process.platform !== "darwin") {
    return {
      browser: await puppeteer.launch({
        headless: false,
        args,
        ...(BROWSER_EXECUTABLE
          ? { executablePath: BROWSER_EXECUTABLE }
          : {}),
        defaultViewport: null,
        protocolTimeout: BROWSER_TIMEOUT_MS,
      }),
      mode: "puppeteer-launch",
      launched: null,
    };
  }

  if (!fsSync.existsSync(BROWSER_EXECUTABLE)) {
    throw new Error(
      `Bluetooth-enabled Chrome was not found at ${BROWSER_EXECUTABLE}. ` +
        "Set RAFT_DASHBOARD_E2E_BROWSER_EXECUTABLE or RAFT_DASHBOARD_E2E_BROWSER_URL."
    );
  }
  const appBundle = appBundleFromExecutable(BROWSER_EXECUTABLE);
  if (!appBundle) {
    throw new Error(`Could not resolve a macOS app bundle from ${BROWSER_EXECUTABLE}.`);
  }
  const port = await findOpenPort();
  const browserUrl = `http://${HOST}:${port}`;
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "raft-dashboard-e2e-browser-")
  );
  execFileSync(
    "open",
    [
      "-na",
      appBundle,
      "--args",
      ...args,
      "--use-mock-keychain",
      `--remote-debugging-port=${port}`,
      `--remote-debugging-address=${HOST}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  await waitForBrowserEndpoint(browserUrl);
  return {
    browser: await puppeteer.connect({
      browserURL: browserUrl,
      defaultViewport: null,
      protocolTimeout: BROWSER_TIMEOUT_MS,
    }),
    mode: "launch-services",
    launched: { userDataDir },
  };
}

async function stopBrowser(browserState) {
  if (!browserState) return;
  try {
    if (browserState.mode === "puppeteer-launch") {
      await browserState.browser.close();
    } else {
      await browserState.browser.disconnect();
    }
  } catch {
    // The browser may already have closed.
  }
  if (browserState.launched?.userDataDir) {
    try {
      execFileSync("pkill", ["-f", browserState.launched.userDataDir], {
        stdio: "ignore",
      });
    } catch {
      // Ignore cleanup of an already-closed browser.
    }
    await fs.rm(browserState.launched.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

function gitProvenance() {
  const command = (args) =>
    execFileSync("git", ["-C", REPO_DIR, ...args], { encoding: "utf8" }).trim();
  return {
    branch: command(["branch", "--show-current"]),
    commit: command(["rev-parse", "HEAD"]),
    dirty: Boolean(command(["status", "--porcelain"])),
  };
}

async function createPage(browser, baseUrl) {
  const page = await browser.newPage();
  page.setDefaultTimeout(CONNECT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(CONNECT_TIMEOUT_MS);
  await page.setViewport({ width: 1440, height: 900 });
  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error?.stack || error?.message || String(error));
  });
  await page.goto(baseUrl, {
    waitUntil: "domcontentloaded",
    timeout: CONNECT_TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => Boolean(window.__raftDashboardE2E?.connManager),
    { timeout: CONNECT_TIMEOUT_MS }
  );
  return { page, consoleMessages, pageErrors };
}

async function clickConnectionButton(page, heading) {
  const clicked = await page.evaluate((expectedHeading) => {
    const panel = Array.from(document.querySelectorAll(".info-box")).find(
      (candidate) =>
        candidate.querySelector("h3")?.textContent?.trim() === expectedHeading
    );
    const button = panel?.querySelector("button");
    if (!button) return false;
    button.click();
    return true;
  }, heading);
  assert.equal(clicked, true, `${heading} Connect button was unavailable.`);
}

async function selectMartyFromPrompt(page) {
  const grantedDevice = await page.evaluate(async (expectedName) => {
    const retainedDevice = window.__raftDashboardE2EDevice;
    const devices = retainedDevice
      ? [retainedDevice]
      : typeof navigator.bluetooth?.getDevices === "function"
        ? await navigator.bluetooth.getDevices()
        : [];
    const expectedLower = expectedName.toLowerCase();
    const device = devices.find((candidate) => {
      const name = String(candidate.name || "").trim();
      return name === expectedName || name.toLowerCase() === expectedLower;
    });
    if (!device) return null;

    const bluetooth = navigator.bluetooth;
    const originalRequestDevice = bluetooth.requestDevice;
    Object.defineProperty(bluetooth, "requestDevice", {
      configurable: true,
      value: async () => {
        Object.defineProperty(bluetooth, "requestDevice", {
          configurable: true,
          value: originalRequestDevice,
        });
        return device;
      },
    });
    return { id: device.id || null, name: device.name || null };
  }, MARTY_NAME);

  if (grantedDevice) {
    console.log(`[grant] Reusing ${grantedDevice.name || grantedDevice.id}`);
    await clickConnectionButton(page, "WebBLE");
    return { ...grantedDevice, selectionMode: "existing-grant" };
  }

  assert.equal(
    typeof page.waitForDevicePrompt,
    "function",
    "This Puppeteer/Chrome combination cannot automate Web Bluetooth prompts."
  );
  const promptPromise = page.waitForDevicePrompt({ timeout: DEVICE_TIMEOUT_MS });
  promptPromise.catch(() => {});
  await clickConnectionButton(page, "WebBLE");
  const prompt = await promptPromise;
  // Chrome's CDP device-request prompt frequently reports empty `name` fields
  // when the page filters by service UUID (as this dashboard does), so an
  // exact-name predicate can never resolve even though the native UI shows the
  // name. Poll the prompt: log each candidate, match by name when available,
  // and otherwise fall back to the sole Robotical device the service filter
  // already narrowed the chooser to.
  const expectedLower = MARTY_NAME.toLowerCase();
  // Chrome's CDP prompt shows placeholder names ("Unknown or Unsupported Device
  // (MAC)") and never resolves the real name, but the device `id` is the MAC.
  // Marty advertises as "Marty_<last 3 MAC bytes>" (e.g. Marty_287796 -> MAC
  // ...28:77:96), so match on the hex suffix of the expected name against the id.
  const expectedHexSuffix = (MARTY_NAME.match(/([0-9a-fA-F]{6,})\s*$/)?.[1] || "").toLowerCase();
  const NAME_GRACE_MS = 8000;
  const startWait = Date.now();
  const deadline = startWait + DEVICE_TIMEOUT_MS;
  const seen = new Set();
  let device;
  try {
    for (;;) {
      const devices = prompt.devices || [];
      for (const candidate of devices) {
        if (!seen.has(candidate.id)) {
          seen.add(candidate.id);
          console.log(
            `[chooser] candidate id=${candidate.id} name=${JSON.stringify(candidate.name || "")}`
          );
        }
      }
      device = devices.find((candidate) => {
        const name = String(candidate.name || "").trim();
        if (name === MARTY_NAME || name.toLowerCase() === expectedLower) return true;
        if (expectedHexSuffix) {
          const idHex = String(candidate.id || "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
          const nameHex = name.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
          if (idHex.includes(expectedHexSuffix) || nameHex.includes(expectedHexSuffix)) return true;
        }
        return false;
      });
      if (device) break;
      // Fallback: names still absent after a grace period -> take the only
      // (or first) device the service-UUID filter offered.
      if (
        devices.length >= 1 &&
        Date.now() - startWait > NAME_GRACE_MS &&
        devices.every((candidate) => !String(candidate.name || "").trim())
      ) {
        device = devices[0];
        console.log(
          `[chooser] no device names reported; selecting sole candidate ${device.id}`
        );
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `No Bluetooth device matching "${MARTY_NAME}" appeared in the prompt.`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } catch (error) {
    await prompt.cancel().catch(() => {});
    throw error;
  }
  console.log(`[chooser] Selecting ${device.name || device.id}`);
  await prompt.select(device);
  return {
    id: device.id || null,
    name: device.name || null,
    selectionMode: "chooser",
  };
}

async function waitForDashboardConnected(page, method) {
  await page.waitForFunction(
    (expectedMethod) =>
      Array.from(document.querySelectorAll("h3")).some(
        (heading) =>
          heading.textContent?.trim() === `Connected via ${expectedMethod}`
      ),
    { timeout: CONNECT_TIMEOUT_MS, polling: 50 },
    method
  );
}

async function connectMartyBLE(page) {
  const device = await selectMartyFromPrompt(page);
  await waitForDashboardConnected(page, "WebBLE");
  await page.evaluate(() => {
    const connector = window.__raftDashboardE2E.connManager.getConnector();
    window.__raftDashboardE2EDevice = connector
      .getRaftChannel()
      ?.getConnectedLocator?.();
  });
  return device;
}

async function clickDisconnect(page) {
  const clicked = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Disconnect"
    );
    if (!button) return false;
    button.click();
    return true;
  });
  assert.equal(clicked, true, "Dashboard Disconnect button was unavailable.");
}

async function waitForDashboardDisconnected(page) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".info-box h3")).some(
        (heading) => heading.textContent?.trim() === "WebBLE"
      ),
    { timeout: CONNECT_TIMEOUT_MS, polling: 50 }
  );
}

async function scenarioInitialConnectDisconnectRace(page, details) {
  await page.evaluate(() => {
    const connManager = window.__raftDashboardE2E.connManager;
    const connector = connManager.getConnector();
    const systemUtils = connector.getRaftSystemUtils();
    const originalGetSystemInfo = systemUtils.getSystemInfo;
    const originalConnect = connManager.connect;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const probe = {
      connManager,
      connector,
      systemUtils,
      originalGetSystemInfo,
      originalConnect,
      entered: false,
      released: false,
      connectStatus: "not-started",
      connectError: null,
      disconnectStatus: "not-started",
      release() {
        if (!this.released) {
          this.released = true;
          release();
        }
      },
    };
    systemUtils.getSystemInfo = async function gatedSystemInfo() {
      const info = await originalGetSystemInfo.apply(this, arguments);
      probe.entered = true;
      await gate;
      return info;
    };
    connManager.connect = function observedConnect() {
      probe.connectStatus = "pending";
      const operation = originalConnect.apply(this, arguments);
      void Promise.resolve(operation).then(
        () => {
          probe.connectStatus = "resolved";
        },
        (error) => {
          probe.connectStatus = "rejected";
          probe.connectError = String(error?.stack || error?.message || error);
        }
      );
      return operation;
    };
    window.__raftInitialRaceProbe = probe;
  });

  try {
    details.device = await selectMartyFromPrompt(page);
    await page.waitForFunction(
      () => window.__raftInitialRaceProbe?.entered === true,
      { timeout: CONNECT_TIMEOUT_MS, polling: 20 }
    );
    details.atSystemInfoBoundary = await page.evaluate(() => ({
      connected: window.__raftInitialRaceProbe.connector.isConnected(),
      channelPresent: Boolean(
        window.__raftInitialRaceProbe.connector.getRaftChannel()
      ),
    }));
    await page.evaluate(async () => {
      const probe = window.__raftInitialRaceProbe;
      probe.disconnectStatus = "pending";
      try {
        await probe.connManager.disconnect();
        probe.disconnectStatus = "resolved";
      } catch (error) {
        probe.disconnectStatus = "rejected";
        throw error;
      }
    });
    await page.evaluate(() => window.__raftInitialRaceProbe.release());
    await page.waitForFunction(
      () => window.__raftInitialRaceProbe?.connectStatus !== "pending",
      { timeout: CONNECT_TIMEOUT_MS, polling: 20 }
    );
    details.final = await page.evaluate(() => {
      const probe = window.__raftInitialRaceProbe;
      return {
        connectStatus: probe.connectStatus,
        connectError: probe.connectError,
        disconnectStatus: probe.disconnectStatus,
        connectorConnected: probe.connector.isConnected(),
        channelPresent: Boolean(probe.connector.getRaftChannel()),
      };
    });
    // Fix validation (issue #2): connect() pins its connection ownership and
    // stops quietly after disconnect - no null-channel crash, the connect
    // promise resolves (false), and the connector stays disconnected.
    assert.equal(details.final.disconnectStatus, "resolved");
    assert.equal(details.final.connectStatus, "resolved");
    assert.equal(details.final.connectError, null);
    assert.equal(details.final.connectorConnected, false);
    assert.equal(details.final.channelPresent, false);
    console.log(
      "[validated] connect() aborted quietly after explicit disconnect; " +
        "no stale continuation acted on the removed channel."
    );
  } finally {
    await page.evaluate(() => {
      const probe = window.__raftInitialRaceProbe;
      if (!probe) return;
      probe.release();
      probe.systemUtils.getSystemInfo = probe.originalGetSystemInfo;
      probe.connManager.connect = probe.originalConnect;
      delete window.__raftInitialRaceProbe;
    });
  }
}

async function installReconnectProbe(page, failSubscription) {
  await page.evaluate((shouldFailSubscription) => {
    const connManager = window.__raftDashboardE2E.connManager;
    const connector = connManager.getConnector();
    const systemType = connector.getSystemType();
    const channel = connector.getRaftChannel();
    const device = channel?.getConnectedLocator?.();
    if (!systemType?.subscribeForUpdates || !device?.gatt?.connected) {
      throw new Error("Connected Marty reconnect objects were unavailable.");
    }
    const originalSubscribe = systemType.subscribeForUpdates;
    const originalEvent = connector._onEventFn;
    const startedAt = performance.now();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const probe = {
      connManager,
      connector,
      systemType,
      channel,
      device,
      originalSubscribe,
      originalEvent,
      shouldFailSubscription,
      entered: false,
      released: false,
      failureCount: 0,
      events: [],
      disconnectRequestedAtMs: null,
      elapsed: () => Math.round((performance.now() - startedAt) * 10) / 10,
      release() {
        if (!this.released) {
          this.released = true;
          release();
        }
      },
    };
    systemType.subscribeForUpdates = async function observedSubscription(
      systemUtils,
      enable
    ) {
      if (enable) {
        probe.entered = true;
        if (probe.shouldFailSubscription) {
          probe.failureCount++;
          throw new Error("Injected reconnect subscription failure");
        }
        await gate;
      }
      return originalSubscribe.call(this, systemUtils, enable);
    };
    connector._onEventFn = function observedEvent(
      eventType,
      eventEnum,
      eventName,
      eventData
    ) {
      probe.events.push({
        elapsedMs: probe.elapsed(),
        eventType,
        eventEnum,
        eventName,
      });
      return originalEvent?.call(
        this,
        eventType,
        eventEnum,
        eventName,
        eventData
      );
    };
    window.__raftReconnectProbe = probe;
    device.gatt.disconnect();
  }, failSubscription);
}

async function reconnectProbeSnapshot(page) {
  return page.evaluate(() => {
    const probe = window.__raftReconnectProbe;
    return {
      entered: probe.entered,
      released: probe.released,
      failureCount: probe.failureCount,
      disconnectRequestedAtMs: probe.disconnectRequestedAtMs,
      events: probe.events.map((event) => ({ ...event })),
      connectorConnected: probe.connector.isConnected(),
      channelPresent: Boolean(probe.connector.getRaftChannel()),
      gattConnected: Boolean(probe.device.gatt?.connected),
    };
  });
}

async function restoreReconnectProbe(page) {
  await page.evaluate(() => {
    const probe = window.__raftReconnectProbe;
    if (!probe) return;
    probe.release();
    probe.systemType.subscribeForUpdates = probe.originalSubscribe;
    probe.connector._onEventFn = probe.originalEvent;
    delete window.__raftReconnectProbe;
  });
}

async function scenarioReconnectDisconnectRace(page, details) {
  details.device = await connectMartyBLE(page);
  await installReconnectProbe(page, false);
  try {
    await page.waitForFunction(
      () => window.__raftReconnectProbe?.entered === true,
      { timeout: CONNECT_TIMEOUT_MS, polling: 20 }
    );
    details.atSubscription = await reconnectProbeSnapshot(page);
    const clicked = await page.evaluate(() => {
      const probe = window.__raftReconnectProbe;
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === "Disconnect"
      );
      if (!button) return false;
      probe.disconnectRequestedAtMs = probe.elapsed();
      button.click();
      return true;
    });
    assert.equal(clicked, true, "Dashboard Disconnect button was unavailable.");
    await page.waitForFunction(
      () => !window.__raftReconnectProbe?.connector.getRaftChannel(),
      { timeout: CONNECT_TIMEOUT_MS, polling: 20 }
    );
    details.afterDisconnectStarted = await reconnectProbeSnapshot(page);
    await page.evaluate(() => window.__raftReconnectProbe.release());
    await waitForDashboardDisconnected(page);
    // Allow any stale late emit to surface before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    details.final = await reconnectProbeSnapshot(page);
    // Fix validation (issue #3): the retry loop revalidates ownership after
    // reconnect restoration, so no recovery event is emitted once an explicit
    // disconnect has begun.
    const lateRecovery = details.final.events.filter(
      (event) =>
        /ISSUE_RESOLVED|RECOVERY_DEGRADED/.test(String(event.eventName || "")) &&
        event.elapsedMs >= details.final.disconnectRequestedAtMs
    );
    assert.deepEqual(
      lateRecovery,
      [],
      `Recovery events were emitted after disconnect began: ${JSON.stringify(lateRecovery)}`
    );
    assert.equal(details.final.connectorConnected, false);
    assert.equal(details.final.channelPresent, false);
    console.log(
      "[validated] no recovery events after disconnect began at " +
        `${details.final.disconnectRequestedAtMs}ms; connector stayed disconnected.`
    );
  } finally {
    await restoreReconnectProbe(page).catch(() => {});
  }
}

async function scenarioSubscriptionFailureResolved(page, details) {
  details.device = await connectMartyBLE(page);
  await installReconnectProbe(page, true);
  try {
    await page.waitForFunction(
      () =>
        window.__raftReconnectProbe?.failureCount > 0 &&
        window.__raftReconnectProbe?.events.some((event) =>
          /RECOVERY_DEGRADED/.test(String(event.eventName || ""))
        ),
      { timeout: CONNECT_TIMEOUT_MS, polling: 20 }
    );
    details.observation = await reconnectProbeSnapshot(page);
    // Fix validation (issue #4): failed subscription restoration reports
    // degraded recovery, never full resolution.
    assert.equal(details.observation.failureCount, 1);
    assert.equal(details.observation.connectorConnected, true);
    assert.ok(
      !details.observation.events.some((event) =>
        /ISSUE_RESOLVED/.test(String(event.eventName || ""))
      ),
      "ISSUE_RESOLVED must not be emitted when subscription restoration failed."
    );
    console.log(
      "[validated] Subscription failure produced RECOVERY_DEGRADED, not ISSUE_RESOLVED."
    );
  } finally {
    await restoreReconnectProbe(page).catch(() => {});
    await clickDisconnect(page).catch(() => {});
    await waitForDashboardDisconnected(page).catch(() => {});
  }
}

async function scenarioBleWriteSize(page, details) {
  details.device = await connectMartyBLE(page);
  try {
    details.observation = await page.evaluate(() => {
      const connector = window.__raftDashboardE2E.connManager.getConnector();
      const systemType = connector.getSystemType();
      const channel = connector.getRaftChannel();
      return {
        reportedSystemName:
          connector.getRaftSystemUtils().getCachedSystemInfo()?.SystemName ?? null,
        systemTypeName: systemType?.nameForDialogs || null,
        // bleMaxWriteSize moved out of connectorOptions into capabilities.tuning
        configuredBleMaxWriteSize:
          systemType?.capabilities?.tuning?.bleMaxWriteSize ?? null,
        effectiveBleMaxWriteSize: channel?._maxBleWriteSize ?? null,
        fileBlockSize: channel?.fhFileBlockSize?.() ?? null,
        gattConnected: Boolean(channel?.getConnectedLocator?.()?.gatt?.connected),
      };
    });
    // Fix validation (issue #1): Marty reports SystemName "RIC"; the dashboard
    // must map that to its dedicated Marty system type and apply the
    // conservative 182-byte BLE write size, not the generic 244.
    assert.equal(details.observation.reportedSystemName, "RIC");
    assert.equal(details.observation.systemTypeName, "Robotical Marty");
    assert.equal(details.observation.configuredBleMaxWriteSize, 182);
    assert.equal(details.observation.effectiveBleMaxWriteSize, 182);
    assert.equal(details.observation.gattConnected, true);
    console.log(
      "[validated] Marty reported RIC, dashboard selected Robotical Marty, " +
        "and the BLE write size is the Marty-specific 182."
    );
  } finally {
    await clickDisconnect(page).catch(() => {});
    await waitForDashboardDisconnected(page).catch(() => {});
  }
}

async function scenarioWebSocketStaleClose(page, details) {
  await page.type("#ip-addr", WIFI_LOCATOR);
  await clickConnectionButton(page, "WebSocket");
  await waitForDashboardConnected(page, "WebSocket");
  details.connectedLocator = WIFI_LOCATOR;
  details.observation = await page.evaluate(async () => {
    const connector = window.__raftDashboardE2E.connManager.getConnector();
    const channel = connector.getRaftChannel();
    const oldSocket = channel?._webSocket;
    const locator = channel?.getConnectedLocator?.();
    const options = connector.getSystemType()?.connectorOptions || {};
    if (!channel || !oldSocket || !locator) {
      throw new Error("Connected WebSocket channel was unavailable.");
    }
    channel._isConnected = false;
    await channel.connect(locator, options);
    const newSocket = channel._webSocket;
    if (!newSocket || newSocket === oldSocket) {
      throw new Error("A second WebSocket was not created.");
    }
    connector.setRetryConnectionIfLost(false, 60);
    oldSocket.close(1000);
    // Allow any (stale) close handling to surface; with the fix the obsolete
    // socket's close must not disturb the replacement socket's state.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = {
      oldAndNewDiffer: oldSocket !== newSocket,
      channelSocketIsNew: channel._webSocket === newSocket,
      channelConnected: channel.isConnected(),
      newSocketReadyState: newSocket.readyState,
      openReadyState: WebSocket.OPEN,
    };
    newSocket.close(1000);
    return result;
  });
  // Fix validation (issue #5): a late close from the obsolete socket is ignored
  // - the replacement socket remains the owner and the channel stays connected.
  assert.equal(details.observation.oldAndNewDiffer, true);
  assert.equal(details.observation.channelSocketIsNew, true);
  assert.equal(details.observation.channelConnected, true);
  assert.equal(
    details.observation.newSocketReadyState,
    details.observation.openReadyState
  );
  console.log(
    "[validated] Stale WebSocket close was ignored; replacement socket stayed connected."
  );
}

const scenarioFunctions = {
  "marty-connect-disconnect-race": scenarioInitialConnectDisconnectRace,
  "marty-reconnect-disconnect-race": scenarioReconnectDisconnectRace,
  "marty-subscribe-failure-resolved": scenarioSubscriptionFailureResolved,
  "marty-ble-write-size": scenarioBleWriteSize,
  "marty-websocket-stale-close": scenarioWebSocketStaleClose,
};

async function runScenario(pageState, report, name) {
  const entry = {
    name,
    status: "running",
    startedAt: new Date().toISOString(),
    details: {},
  };
  report.scenarios.push(entry);
  console.log(`\n[scenario] ${name}`);
  const consoleStart = pageState.consoleMessages.length;
  const pageErrorStart = pageState.pageErrors.length;
  try {
    await scenarioFunctions[name](pageState.page, entry.details);
    entry.status = "passed";
    console.log(`[pass] ${name}`);
  } catch (error) {
    entry.status = "failed";
    entry.error = error?.stack || error?.message || String(error);
    console.error(`[fail] ${name}: ${error?.message || error}`);
  } finally {
    entry.finishedAt = new Date().toISOString();
    entry.consoleMessages = pageState.consoleMessages.slice(consoleStart);
    entry.pageErrors = pageState.pageErrors.slice(pageErrorStart);
  }
  return entry.status === "passed";
}

async function main() {
  const unknown = SELECTED_SCENARIOS.filter(
    (scenario) => !SCENARIOS.includes(scenario)
  );
  if (unknown.length) {
    throw new Error(
      `Unknown scenario(s): ${unknown.join(", ")}. Supported: ${SCENARIOS.join(", ")}.`
    );
  }
  const needsBLE = SELECTED_SCENARIOS.some(
    (scenario) => scenario !== "marty-websocket-stale-close"
  );
  if (needsBLE && !MARTY_NAME) {
    throw new Error(
      "Set RAFT_DASHBOARD_E2E_MARTY_NAME to the exact Web Bluetooth chooser name."
    );
  }
  if (
    SELECTED_SCENARIOS.includes("marty-websocket-stale-close") &&
    !WIFI_LOCATOR
  ) {
    throw new Error(
      "marty-websocket-stale-close requires RAFT_DASHBOARD_E2E_WIFI_LOCATOR."
    );
  }

  const outputDir = path.resolve(
    process.env.RAFT_DASHBOARD_E2E_OUTPUT ||
      path.join(DASHBOARD_DIR, "e2e-results", timestampForPath())
  );
  await fs.mkdir(outputDir, { recursive: true });
  const report = {
    title: "RaftJS dashboard real-Marty regression reproductions",
    selectedScenarios: SELECTED_SCENARIOS,
    martyName: MARTY_NAME || null,
    wifiLocator: WIFI_LOCATOR || null,
    provenance: gitProvenance(),
    startedAt: new Date().toISOString(),
    outputDir,
    scenarios: [],
  };

  let server;
  let browserState;
  try {
    let baseUrl;
    if (EXTERNAL_BASE_URL) {
      baseUrl = normalizeUrl(EXTERNAL_BASE_URL);
    } else {
      const port = await findOpenPort();
      baseUrl = `http://${HOST}:${port}`;
      server = await startDashboardServer(port);
    }
    report.baseUrl = baseUrl;
    console.log(`[server] Waiting for ${baseUrl}`);
    await waitForHttp(baseUrl, SERVER_TIMEOUT_MS);
    console.log(`[server] Ready at ${baseUrl}`);
    browserState = await launchBrowser();
    report.browserMode = browserState.mode;
    const pageState = await createPage(browserState.browser, baseUrl);
    for (const scenario of SELECTED_SCENARIOS) {
      const passed = await runScenario(
        pageState,
        report,
        scenario
      );
      if (!passed) break;
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.summary = {
      passed: report.scenarios.filter((scenario) => scenario.status === "passed")
        .length,
      failed: report.scenarios.filter((scenario) => scenario.status === "failed")
        .length,
    };
    await fs.writeFile(
      path.join(outputDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await stopBrowser(browserState);
    stopDashboardServer(server);
  }

  console.log(`\n[report] ${path.join(outputDir, "report.json")}`);
  console.log(
    `[summary] ${report.summary.passed} passed, ${report.summary.failed} failed`
  );
  if (report.summary.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
