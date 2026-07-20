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

function getConfiguredUrl() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return data.url || null;
    }
  } catch (e) {
    logToFile("Failed to read config", e);
  }
  return null;
}

function saveConfiguredUrl(url) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ url: url.trim() }), "utf-8");
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

  // Helper to push history availability down to the renderer without polling
  const pushNavigationState = () => {
    const history = win.webContents.navigationHistory;
    const canGoBack = !isMainWindow || (history ? history.canGoBack() : false);

    if (!win.isDestroyed()) {
      win.webContents.send("update-navigation-state", canGoBack);
    }
  };

  // 1. Intercept Standard Link Clicks
  win.webContents.on("will-navigate", (event, navigationUrl) => {
    const check = sanitizeAndCleanUrl(navigationUrl, `${context}-WillNavigate`);
    if (check.success && check.altered) {
      event.preventDefault();
      win.loadURL(check.url);
    }
  });

  // 2. Intercept Server-Side HTTP Redirects
  win.webContents.on("will-redirect", (event, navigationUrl) => {
    const check = sanitizeAndCleanUrl(navigationUrl, `${context}-Redirect`);
    if (check.success && check.altered) {
      event.preventDefault();
      win.loadURL(check.url);
    }
  });

  // 3. Track History State changes to tell UI whether back button should render
  win.webContents.on("did-navigate", pushNavigationState);
  win.webContents.on("did-navigate-in-page", pushNavigationState); // Handles hash/SPA route changes

  win.webContents.on("did-update-navigation-history", pushNavigationState);

  // 4. Handle Window Freezes
  win.webContents.on("unresponsive", () => {
    logToFile(`${context} window unresponsive! Attempting reload...`);
    win.reload();
  });

  // 5. Handle Render Process Crashes
  win.webContents.on("render-process-gone", (event, details) => {
    logToFile(`${context} renderer process gone. Reason: ${details.reason}, Exit Code: ${details.exitCode}`);
    if (details.reason !== "clean-exit") {
      logToFile(`Re-launching ${context} window due to crash...`);
      win.reload();
    }
  });

  // 6. Handle Recursive Window Spawning (window.open inside child windows too)
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

  // Connection Fail-Safe (Specific to Main landing window initialization)
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
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: true,
    title: "Kiosk Setup",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "setup-preload.js"),
    },
  });
  setupWin.loadFile(path.join(__dirname, "setup.html"));
};

// IPC Global Event Navigation Management
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([]));

  ipcMain.on("save-url", (event, url) => {
    if (saveConfiguredUrl(url)) {
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
    const savedUrl = getConfiguredUrl();
    const history = webContents.navigationHistory;

    if (win && savedUrl) {
      if (win !== mainKioskWindow) {
        win.close();
      } else {
        win.loadURL(savedUrl);
        if (history) history.clear();
        webContents.session.clearStorageData({
          storages: ["cookies", "localstorage", "cache"],
        });
      }
    }
  });

  const savedUrl = getConfiguredUrl();
  if (savedUrl) {
    createWindow(savedUrl);
  } else {
    createSetupWindow();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
