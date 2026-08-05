const { app, BrowserWindow, Menu } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = 8000;
const URL = `http://${HOST}:${PORT}/`;
const projectRoot = path.resolve(__dirname, "..", "..");
let backend;

function startBackend() {
  backend = spawn("python", ["-m", "uvicorn", "backend.app.main:app", "--host", HOST, "--port", String(PORT)], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  });

  backend.on("error", (error) => {
    console.error(`Could not start Python backend: ${error.message}`);
  });
}

async function waitForBackend(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${URL}health`);
      if (response.ok) return true;
    } catch {
      // Backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function createWindow() {
  const ready = await waitForBackend();
  if (!ready) {
    console.error("Python backend did not become ready.");
    app.quit();
    return;
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "Lequidity Trader",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);
  window.setMenuBarVisibility(false);

  let zoomFactor = 1;
  const updateZoom = (nextZoom) => {
    zoomFactor = Math.max(0.5, Math.min(2, nextZoom));
    window.webContents.setZoomFactor(zoomFactor);
  };

  window.webContents.on("before-input-event", (event, input) => {
    const modifier = input.control || input.meta;
    if (!modifier) return;

    if (input.type === "keyDown" && (input.key === "+" || input.key === "=")) {
      event.preventDefault();
      updateZoom(zoomFactor + 0.1);
    } else if (input.type === "keyDown" && input.key === "-") {
      event.preventDefault();
      updateZoom(zoomFactor - 0.1);
    } else if (input.type === "keyDown" && input.key === "0") {
      event.preventDefault();
      updateZoom(1);
    } else if (input.type === "mouseWheel" && input.control) {
      event.preventDefault();
      updateZoom(zoomFactor + (input.deltaY > 0 ? -0.1 : 0.1));
    }
  });

  await window.loadURL(URL);
}

app.whenReady().then(() => {
  startBackend();
  createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (backend && !backend.killed) backend.kill();
});
