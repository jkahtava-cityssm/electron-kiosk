const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
let mainKioskWindow = null; // Track the primary window

// Helper: Read configured URL
function getConfiguredUrl() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return data.url || null;
    }
  } catch (e) {
    console.error("Failed to read config", e);
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
    },
  });

  mainKioskWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    dialog.showErrorBox("Network Error", `Failed to load ${url}: ${errorDescription}`);
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

  mainKioskWindow.webContents.on("did-fail-load", (event, code, desc) => {
    console.log(`Failed to load: ${desc}. Retrying in 5 seconds...`);
    setTimeout(() => {
      mainKioskWindow.reload();
    }, 5000);
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

  // Handle Back Navigation (Smart check: handles child windows too!)
  ipcMain.on("kiosk-back", (event) => {
    const webContents = event.sender;
    if (webContents.canGoBack()) {
      webContents.goBack();
    } else {
      // If we can't go back, check if this is a secondary (child) window
      const win = BrowserWindow.fromWebContents(webContents);
      if (win && win !== mainKioskWindow) {
        win.close(); // Close the child window, bringing them back to the main session!
      }
    }
  });

  // Handle Home Navigation
  ipcMain.on("kiosk-home", (event) => {
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);
    const savedUrl = getConfiguredUrl();

    if (win && savedUrl) {
      // 1. If inside a child window, just close it to return to main
      if (win !== mainKioskWindow) {
        win.close();
      } else {
        // 2. If inside the main window, perform the "Reset"
        // We navigate to 'about:blank' first to wipe the history stack
        // then load the URL, making it the new "start" point.
        win.loadURL("about:blank").then(() => {
          win.loadURL(savedUrl);
        });

        // Optional: Clear cache/cookies if you want a truly 'clean' session
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

    // Always show the back button on secondary windows (so users can close them)
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
