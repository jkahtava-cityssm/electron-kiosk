const { app, BrowserWindow, Menu, dialog } = require("electron");

function parseOnlyUrlArg(argv) {
  // Account for Electron/Node entry points: [exe, entry, ...args]
  const userArgs = argv.slice(process.defaultApp ? 2 : 1);
  let urlValue = null;
  let consumedIndex = -1;

  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i];

    if (arg.startsWith("--url=")) {
      urlValue = arg.split("=")[1];
      consumedIndex = i;
    } else if (arg === "--url") {
      const next = userArgs[i + 1];
      if (!next || next.startsWith("--")) throw new Error("Missing value for --url");
      urlValue = next;
      consumedIndex = i;
      i++; // Skip the value in next iteration
    } else {
      // If we encounter any other flag or unexpected positional arg
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!urlValue) throw new Error("Required option --url is missing");

  try {
    return { url: new URL(urlValue.trim()).href };
  } catch {
    throw new Error(`Invalid URL: ${urlValue}`);
  }
}

const createWindow = (url) => {
  const win = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false, // Security best practice
    },
  });

  win.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    console.error(`Page failed to load: ${errorDescription}`);
    dialog.showErrorBox("Network Error", `Failed to load ${url}: ${errorDescription}`);
  });

  win.loadURL(url);
};

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([]));

  let command = null;

  try {
    command = parseOnlyUrlArg(process.argv);
    createWindow(command.url);
  } catch (err) {
    // Use console.error for visibility in terminal

    dialog.showErrorBox("Launch Error", err.message);

    console.error(`\x1b[31m[Launch Error]: ${err.message}\x1b[0m`);

    // Exit immediately before the app is ready
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
