const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");

let mainWindow = null;
let serverHandle = null;
let notifierHandle = null;

async function waitForHealthcheck(url, timeoutMs = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (_) {
      // Wait for the local server to finish booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    autoHideMenuBar: true,
    backgroundColor: "#111111",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL("http://127.0.0.1:5000");
}

async function bootstrapDesktopApp() {
  process.env.CARTEL_DATA_DIR = app.getPath("userData");
  process.env.PORT = process.env.PORT || "5000";
  process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://127.0.0.1:5000";

  const { startServer } = require("../server");
  const { startWhatsAppNotifier } = require("../whatsapp");

  serverHandle = await startServer({ port: Number(process.env.PORT) || 5000 });
  notifierHandle = await startWhatsAppNotifier({ serverUrl: "http://127.0.0.1:5000" });
  await waitForHealthcheck("http://127.0.0.1:5000/health");
}

async function shutdownDesktopApp() {
  if (notifierHandle?.serverSocket) {
    notifierHandle.serverSocket.close();
  }

  if (notifierHandle?.client) {
    try {
      await notifierHandle.client.destroy();
    } catch (_) {
      // Ignore Chromium shutdown errors.
    }
  }

  if (serverHandle?.server) {
    await new Promise((resolve) => {
      serverHandle.server.close(() => resolve());
    });
  }
}

app.whenReady().then(async () => {
  try {
    await bootstrapDesktopApp();
    await createWindow();
  } catch (err) {
    dialog.showErrorBox("Cartel Desktop Startup Failed", err?.stack || String(err));
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (!app.isQuitting) {
    event.preventDefault();
    app.isQuitting = true;
    shutdownDesktopApp().finally(() => app.quit());
  }
});
