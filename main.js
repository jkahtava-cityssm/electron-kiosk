const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

// --- CRITICAL GOOGLE CHROME COMPATIBILITY ---
app.commandLine.appendSwitch("ignore-gpu-blocklist");

// --- GLOBAL APP STATE & PATHS ---
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
const LOG_PATH = path.join(app.getPath("userData"), "debug.log");
let mainKioskWindow = null;
let kioskReloadTimeout = null;

const cleanChromeUA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage.trim());
  try {
    fs.appendFileSync(LOG_PATH, logMessage, "utf-8");
  } catch (err) {
    console.error("Failed to write to debug.log", err);
  }
}

function sanitizeAndCleanUrl(rawUrl, contextName = "Navigation") {
  try {
    const parsedUrl = new URL(rawUrl);
    const trackingPrefixes = ["utm_", "_hs", "mc_"];
    const exactTrackingKeys = [
      "_gl",
      "_ga",
      "_gac",
      "gclid",
      "gclsrc",
      "dclid",
      "wbraid",
      "gbraid",
      "fbclid",
      "msclkid",
      "ttclid",
      "sc_cid",
    ];

    let altered = false;
    const keysToDelete = [];

    parsedUrl.searchParams.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      const isTracking =
        exactTrackingKeys.includes(lowerKey) || trackingPrefixes.some((prefix) => lowerKey.startsWith(prefix));
      if (isTracking) keysToDelete.push(key);
    });

    if (keysToDelete.length > 0) {
      keysToDelete.forEach((key) => parsedUrl.searchParams.delete(key));
      altered = true;
    }

    const finalUrl = parsedUrl.toString();
    if (altered) {
      logToFile(
        `[${contextName}] SUCCESS: Stripped ${keysToDelete.length} parameter(s) [${keysToDelete.join(", ")}]. Resulting URL: ${finalUrl}`,
      );
    } else {
      logToFile(`[${contextName}] PASS: No tracking parameters present in: ${rawUrl}`);
    }

    return { success: true, url: finalUrl, altered };
  } catch (e) {
    logToFile(`[${contextName}] ERROR: Failed to parse URL "${rawUrl}" - Error: ${e.message}`);
    return { success: false, url: rawUrl, altered: false };
  }
}

// --- CONFIGURATION MANAGEMENT ---
function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) || {};
    }
  } catch (e) {
    logToFile("Failed to read config file: " + e.message);
  }
  return {};
}

function saveConfiguredData(url, navPosition) {
  try {
    const configData = {
      url: url.trim(),
      nav_position: navPosition || "bottom-left",
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configData, null, 2), "utf-8");
    return true;
  } catch (e) {
    dialog.showErrorBox("Error", "Failed to save configuration.");
    return false;
  }
}

/**
 * Centrally applies all navigation restrictions, crash recovery,
 * pop-up handling, and pushes navigation status updates over IPC.
 */
function applyKioskPolicies(win, isMainWindow = false) {
  win.webContents.setUserAgent(cleanChromeUA);

  const context = isMainWindow ? "Main" : "Child";
  const triggerPush = () => pushNavigationState(win);

  win.webContents.on("will-navigate", (event, navigationUrl) => {
    const check = sanitizeAndCleanUrl(navigationUrl, `${context}-WillNavigate`);
    if (check.success && check.altered) {
      event.preventDefault();
      win.loadURL(check.url);
    }
  });

  win.webContents.on("will-redirect", (event, navigationUrl) => {
    const check = sanitizeAndCleanUrl(navigationUrl, `${context}-Redirect`);
    if (check.success && check.altered) {
      event.preventDefault();
      win.loadURL(check.url);
    }
  });

  win.webContents.on("did-navigate", triggerPush);
  win.webContents.on("did-navigate-in-page", triggerPush);
  win.webContents.on("did-update-navigation-history", triggerPush);
  win.webContents.on("dom-ready", triggerPush);

  win.webContents.on("unresponsive", () => {
    logToFile(`${context} window unresponsive! Attempting reload...`);
    win.reload();
  });

  win.webContents.on("render-process-gone", (event, details) => {
    logToFile(`${context} renderer process gone. Reason: ${details.reason}, Exit Code: ${details.exitCode}`);
    if (details.reason !== "clean-exit") {
      logToFile(`Re-launching ${context} window due to crash...`);
      win.reload();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    logToFile(`[${context}-WindowOpenHandler] Intercepted request for popup: ${url}`);
    const check = sanitizeAndCleanUrl(url, `${context}-WindowOpenHandler`);
    createChildWindow(check.url);
    return { action: "deny" };
  });
}

const createChildWindow = (cleanUrl) => {
  logToFile(`[Child Window] Spawning child window for: ${cleanUrl}`);

  const childWindow = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: false,
      webSecurity: true,
    },
  });

  applyKioskPolicies(childWindow, false);
  childWindow.loadURL(cleanUrl);
};

const createWindow = (url) => {
  mainKioskWindow = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      allowRunningInsecureContent: false,
      webSecurity: true,
    },
  });

  applyKioskPolicies(mainKioskWindow, true);

  mainKioskWindow.webContents.on("did-fail-load", (event, code, desc) => {
    logToFile(`Failed to load: ${desc}. Retrying in 5 seconds...`);
    if (kioskReloadTimeout) clearTimeout(kioskReloadTimeout);

    kioskReloadTimeout = setTimeout(() => {
      if (mainKioskWindow && !mainKioskWindow.isDestroyed()) {
        mainKioskWindow.reload();
      }
    }, 5000);
  });

  const bootCheck = sanitizeAndCleanUrl(url, "BootLoad");
  mainKioskWindow.loadURL(bootCheck.url);
};

const createSetupWindow = () => {
  const setupWin = new BrowserWindow({
    width: 500,
    height: 380,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: true,
    title: "Kiosk Setup",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  setupWin.loadFile(path.join(__dirname, "setup.html"));
};

function pushNavigationState(win) {
  if (!win || win.isDestroyed()) return;

  const isMainWindow = win === mainKioskWindow;
  const history = win.webContents.navigationHistory;
  const canGoBack = !isMainWindow || (history ? history.canGoBack() : false);

  win.webContents.send("update-navigation-state", canGoBack);
}

// --- IPC EVENT MANAGEMENT ---
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([]));

  ipcMain.handle("request-navigation-state", (event) => {
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);
    if (!win || win.isDestroyed()) return { canGoBack: false, position: "bottom-left" };

    const isMainWindow = win === mainKioskWindow;
    const history = webContents.navigationHistory;
    const config = getConfig();

    return {
      canGoBack: !isMainWindow || (history ? history.canGoBack() : false),
      position: config.nav_position || "bottom-left",
    };
  });

  ipcMain.on("save-config", (event, config) => {
    if (saveConfiguredData(config.url, config.nav_position)) {
      app.relaunch();
      app.exit();
    }
  });

  ipcMain.on("kiosk-back", (event) => {
    const webContents = event.sender;
    const history = webContents.navigationHistory;

    if (history && history.canGoBack()) {
      history.goBack();
    } else {
      const win = BrowserWindow.fromWebContents(webContents);
      if (win && win !== mainKioskWindow) {
        win.close();
      }
    }
  });

  ipcMain.on("kiosk-home", (event) => {
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);
    const savedUrl = getConfig().url;

    if (win && savedUrl) {
      if (win !== mainKioskWindow) {
        win.close();
      } else {
        win.loadURL(savedUrl);

        win.webContents.send("update-navigation-state", false);
        webContents.session.clearStorageData({
          storages: ["cookies", "localstorage", "cache"],
        });

        webContents.once("did-finish-load", () => {
          const history = webContents.navigationHistory;
          if (history) {
            history.clear();
          }
          pushNavigationState(win);
        });
      }
    }
  });

  const savedUrl = getConfig().url;
  if (savedUrl) {
    createWindow(savedUrl);
  } else {
    createSetupWindow();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
