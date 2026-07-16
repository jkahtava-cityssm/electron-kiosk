const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

// --- CRITICAL GOOGLE CHROME / ZENDESK COMPATIBILITY FLAGS ---
app.commandLine.appendSwitch("disable-features", "SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
let mainKioskWindow = null; // Track the primary window

const LOG_PATH = path.join(app.getPath("userData"), "debug.log");

function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage.trim()); // Print to terminal too
  try {
    fs.appendFileSync(LOG_PATH, logMessage, "utf-8");
  } catch (err) {
    console.error("Failed to write to debug.log", err);
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

// Create the main Kiosk window
const createWindow = (url) => {
  mainKioskWindow = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"), // Link the preload script
      allowRunningInsecureContent: false,
      webSecurity: true,
    },
  });

  // --- CRITICAL USER-AGENT SPOOFING (Robust Version) ---
  const originalUA = mainKioskWindow.webContents.getUserAgent();
  const userAgent = originalUA
    .replace(/Electron\/[0-9\.]+(\s|$)/, "")
    .replace(/AppAppName\/[0-9\.]+(\s|$)/, "")
    .trim();

  mainKioskWindow.webContents.setUserAgent(userAgent);
  // -----------------------------------------------------

  // --- 1. DETECT HANGS/FREEZES ---
  mainKioskWindow.webContents.on("unresponsive", () => {
    logToFile("Renderer process became unresponsive! Attempting reload...");
    mainKioskWindow.reload();
  });

  // --- 2. DETECT CRASHES OR OUT-OF-MEMORY ---
  mainKioskWindow.webContents.on("render-process-gone", (event, details) => {
    logToFile(`Renderer process is gone. Reason: ${details.reason}, Exit Code: ${details.exitCode}`);
    if (details.reason !== "clean-exit") {
      logToFile("Re-launching window due to crash...");
      mainKioskWindow.reload();
    }
  });

  // Self-Healing Fail Safe
  mainKioskWindow.webContents.on("did-fail-load", (event, code, desc) => {
    logToFile(`Failed to load: ${desc}. Retrying in 5 seconds...`);
    setTimeout(() => {
      if (mainKioskWindow && !mainKioskWindow.isDestroyed()) {
        mainKioskWindow.reload();
      }
    }, 5000);
  });

  // Intercept new window requests natively and apply kiosk constraints
  mainKioskWindow.webContents.setWindowOpenHandler(({ url }) => {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        fullscreen: true,
        kiosk: true,
        alwaysOnTop: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.js"), // Inject the nav controls to child windows
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    };
  });

  // Ensure newly created child windows ALSO inherit our spoofed User-Agent
  mainKioskWindow.webContents.on("did-create-window", (childWindow) => {
    childWindow.webContents.setUserAgent(userAgent);

    // Apply the same freeze recovery to child windows
    childWindow.webContents.on("unresponsive", () => {
      logToFile("Child window became unresponsive! Reloading...");
      childWindow.reload();
    });

    childWindow.webContents.on("render-process-gone", (event, details) => {
      if (details.reason !== "clean-exit") {
        logToFile("Child window crashed! Reloading...");
        childWindow.reload();
      }
    });
  });

  mainKioskWindow.loadURL(url);
};

// Create a small, clean setup window if no URL is set
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
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: sans-serif; padding: 20px; background: #f3f4f6; color: #333; }
        h3 { margin-top: 0; }
        input { width: 100%; padding: 10px; margin: 10px 0; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
        button { background: #0076ff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; float: right;}
        button:hover { background: #0060d0; }
      </style>
    </head>
    <body>
      <h3>Configure Kiosk URL</h3>
      <p>Please enter the default URL for this kiosk display:</p>
      <input type="url" id="urlInput" placeholder="https://example.com" value="https://">
      <button onclick="save()">Save & Launch</button>

      <script>
        const { ipcRenderer } = require('electron');
        function save() {
          const url = document.getElementById('urlInput').value;
          if (url.startsWith('http://') || url.startsWith('https://')) {
            ipcRenderer.send('save-url', url);
          } else {
            alert('Please enter a valid URL starting with http:// or https://');
          }
        }
      </script>
    </body>
    </html>
  `;

  setupWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
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

  // Handle Back Navigation
  ipcMain.on("kiosk-back", (event) => {
    const webContents = event.sender;
    if (webContents.canGoBack()) {
      webContents.goBack();
    } else {
      const win = BrowserWindow.fromWebContents(webContents);
      if (win && win !== mainKioskWindow) {
        win.close();
      }
    }
  });

  // Handle Home Navigation
  ipcMain.on("kiosk-home", (event) => {
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);
    const savedUrl = getConfiguredUrl();

    const { navigationHistory } = webContents;

    if (win && savedUrl) {
      if (win !== mainKioskWindow) {
        win.close();
      } else {
        navigationHistory.clear();
        win.loadURL(savedUrl);

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

    if (win && win !== mainKioskWindow) {
      return true;
    }
    return webContents.canGoBack();
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
