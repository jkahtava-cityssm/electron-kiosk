const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

// --- CRITICAL GOOGLE CHROME COMPATIBILITY ---
app.commandLine.appendSwitch("ignore-gpu-blocklist");

// --- GLOBAL APP STATE & PATHS ---
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
const LOG_PATH = path.join(app.getPath("userData"), "debug.log");
let mainKioskWindow = null;
let kioskReloadTimeout = null; // Declared globally to prevent infinite timers/crashes

// Robust User-Agent Spoofing String
const cleanChromeUA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * Append messages to debug.log
 */
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

/**
 * Clean and strip tracking parameters from any URL, logging every action.
 */
function sanitizeAndCleanUrl(rawUrl, contextName = "Navigation") {
  try {
    const parsedUrl = new URL(rawUrl);

    // Tracking prefixes and exact keys to purge
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

    // Identify tracking parameters
    parsedUrl.searchParams.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      const isTracking =
        exactTrackingKeys.includes(lowerKey) || trackingPrefixes.some((prefix) => lowerKey.startsWith(prefix));

      if (isTracking) {
        keysToDelete.push(key);
      }
    });

    // Delete identified tracking parameters
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

// Helper: Read configured URL
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

// Helper: Save configured URL
function saveConfiguredUrl(url) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ url: url.trim() }), "utf-8");
    return true;
  } catch (e) {
    dialog.showErrorBox("Error", "Failed to save configuration.");
    return false;
  }
}

// Programmatic Child Window Spawner (Guarantees URL is Clean & Configs Match)
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

  childWindow.webContents.setUserAgent(cleanChromeUA);

  // Intercept standard link navigations inside child window to strip tracking parameters
  childWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    const check = sanitizeAndCleanUrl(navigationUrl, "Child-WillNavigate");
    if (check.success && check.altered) {
      event.preventDefault();
      childWindow.loadURL(check.url);
    }
  });

  // Apply freeze recovery to child windows
  childWindow.webContents.on("unresponsive", () => {
    logToFile(`Child window unresponsive! Reloading: ${cleanUrl}`);
    childWindow.reload();
  });

  childWindow.webContents.on("render-process-gone", (event, details) => {
    if (details.reason !== "clean-exit") {
      logToFile(`Child window crashed (${details.reason})! Reloading...`);
      childWindow.reload();
    }
  });

  childWindow.loadURL(cleanUrl);
};

// Create the main Kiosk window
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

  mainKioskWindow.webContents.setUserAgent(cleanChromeUA);

  // --- 1. STRIP PARAMETERS ON STANDARD CLICKED LINKS ---
  mainKioskWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    const check = sanitizeAndCleanUrl(navigationUrl, "Main-WillNavigate");
    if (check.success && check.altered) {
      event.preventDefault();
      mainKioskWindow.loadURL(check.url);
    }
  });

  // --- 2. STRIP PARAMETERS ON HTTP REDIRECTS ---
  mainKioskWindow.webContents.on("will-redirect", (event, navigationUrl) => {
    const check = sanitizeAndCleanUrl(navigationUrl, "Main-Redirect");
    if (check.success && check.altered) {
      event.preventDefault();
      mainKioskWindow.loadURL(check.url);
    }
  });

  // --- 3. DETECT HANGS/FREEZES ---
  mainKioskWindow.webContents.on("unresponsive", () => {
    logToFile("Renderer process became unresponsive! Attempting reload...");
    mainKioskWindow.reload();
  });

  // --- 4. DETECT CRASHES OR OUT-OF-MEMORY ---
  mainKioskWindow.webContents.on("render-process-gone", (event, details) => {
    logToFile(`Renderer process is gone. Reason: ${details.reason}, Exit Code: ${details.exitCode}`);
    if (details.reason !== "clean-exit") {
      logToFile("Re-launching window due to crash...");
      mainKioskWindow.reload();
    }
  });

  // Self-Healing Fail Safe (With active timer resetting to avoid overlap memory leaks)
  mainKioskWindow.webContents.on("did-fail-load", (event, code, desc) => {
    logToFile(`Failed to load: ${desc}. Retrying in 5 seconds...`);

    if (kioskReloadTimeout) {
      clearTimeout(kioskReloadTimeout);
    }

    kioskReloadTimeout = setTimeout(() => {
      if (mainKioskWindow && !mainKioskWindow.isDestroyed()) {
        mainKioskWindow.reload();
      }
    }, 5000);
  });

  // --- 5. INTERCEPT NEW POPUPS (Target="_blank" / window.open) ---
  mainKioskWindow.webContents.setWindowOpenHandler(({ url }) => {
    logToFile(`[WindowOpenHandler] Intercepted request for popup: ${url}`);

    const check = sanitizeAndCleanUrl(url, "WindowOpenHandler");
    createChildWindow(check.url);

    return { action: "deny" };
  });

  // Boot load the main window
  const bootCheck = sanitizeAndCleanUrl(url, "BootLoad");
  mainKioskWindow.loadURL(bootCheck.url);
};

// Create setup window (Secured, Sandbox-Compliant)
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
      nodeIntegration: false, // Secured
      contextIsolation: true, // Secured
      preload: path.join(__dirname, "setup-preload.js"),
    },
  });

  setupWin.loadFile(path.join(__dirname, "setup.html"));
};

// IPC Global Event Navigation Management
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([]));

  // Handle URL registration from the setup window
  ipcMain.on("save-url", (event, url) => {
    if (saveConfiguredUrl(url)) {
      app.relaunch();
      app.exit();
    }
  });

  // Handle Back Navigation (Safely checks navigationHistory API)
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

  // Handle Home Navigation (Safely checks navigationHistory API)
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
        if (history) {
          history.clear();
        }

        webContents.session.clearStorageData({
          storages: ["cookies", "localstorage", "cache"],
        });
      }
    }
  });

  // Help the preload file decide whether to display the back button
  ipcMain.handle("kiosk-can-go-back", (event) => {
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);
    const history = webContents.navigationHistory;

    if (win && win !== mainKioskWindow) {
      return true;
    }
    return history ? history.canGoBack() : false;
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
