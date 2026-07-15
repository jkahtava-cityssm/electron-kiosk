const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");

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
  const win = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    dialog.showErrorBox("Network Error", `Failed to load ${url}: ${errorDescription}`);
  });

  win.loadURL(url);
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
      nodeIntegration: true, // Simple for setup window
      contextIsolation: false,
    },
  });

  // Inline HTML for the setup UI
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([]));

  // Handle URL registration from the setup window
  ipcMain.on("save-url", (event, url) => {
    if (saveConfiguredUrl(url)) {
      app.relaunch();
      app.exit();
    }
  });

  // Main logic
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
