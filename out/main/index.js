"use strict";
const electron = require("electron");
const path = require("path");
const Database = require("better-sqlite3");
const child_process = require("child_process");
const fs = require("fs");
const promises = require("fs/promises");
const os = require("os");
let db = null;
function getDb() {
  if (db) return db;
  const userDataPath = electron.app.getPath("userData");
  db = new Database(path.join(userDataPath, "interview-assistant.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      resume TEXT NOT NULL DEFAULT '',
      job_title TEXT NOT NULL DEFAULT '',
      job_description TEXT NOT NULL DEFAULT '',
      key_skills TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS interview_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES candidate_profiles(id),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS qa_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER REFERENCES interview_sessions(id),
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'audio',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_qa_session ON qa_log(session_id);
  `);
  return db;
}
function saveProfile(profile) {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO candidate_profiles (full_name, resume, job_title, job_description, key_skills)
    VALUES (@fullName, @resume, @jobTitle, @jobDescription, @keySkills)
  `);
  const info = stmt.run({
    fullName: profile.fullName,
    resume: profile.resume,
    jobTitle: profile.jobTitle,
    jobDescription: profile.jobDescription,
    keySkills: JSON.stringify(profile.keySkills)
  });
  return getProfileById(info.lastInsertRowid);
}
function getLatestProfile() {
  const database = getDb();
  return database.prepare("SELECT * FROM candidate_profiles ORDER BY updated_at DESC LIMIT 1").get();
}
function getProfileById(id) {
  const database = getDb();
  const row = database.prepare("SELECT * FROM candidate_profiles WHERE id = ?").get(id);
  if (!row) throw new Error(`Failed to save profile (id=${id})`);
  return row;
}
function getWhisperPaths() {
  const base = path.join(electron.app.getPath("userData"), "whisper");
  return {
    bin: process.env["WHISPER_BIN"] ?? path.join(base, "whisper-cli.exe"),
    model: process.env["WHISPER_MODEL"] ?? path.join(base, "models", "ggml-tiny.bin")
  };
}
function isWhisperAvailable() {
  const { bin, model } = getWhisperPaths();
  return fs.existsSync(bin) && fs.existsSync(model);
}
async function transcribeWav(wavBuffer) {
  const { bin, model } = getWhisperPaths();
  if (!fs.existsSync(bin) || !fs.existsSync(model)) {
    throw new Error(
      "Whisper not installed. Place whisper-cli.exe and ggml-tiny.bin under " + path.join(electron.app.getPath("userData"), "whisper")
    );
  }
  const workDir = path.join(os.tmpdir(), "ai-interview-assistant");
  await promises.mkdir(workDir, { recursive: true });
  const wavPath = path.join(workDir, `seg-${Date.now()}.wav`);
  await promises.writeFile(wavPath, wavBuffer);
  try {
    return await new Promise((resolve, reject) => {
      const proc = child_process.spawn(bin, [
        "-m",
        model,
        "-f",
        wavPath,
        "-nt",
        // no timestamps
        "-np",
        // no prints
        "-t",
        "4"
        // threads
      ]);
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error("Whisper transcription timed out (10s)"));
      }, 1e4);
      proc.stdout.on("data", (d) => stdout += d.toString());
      proc.stderr.on("data", (d) => stderr += d.toString());
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`whisper-cli exited ${code}: ${stderr.slice(-500)}`));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  } finally {
    void promises.unlink(wavPath).catch(() => {
    });
  }
}
function loadEnvFile() {
  try {
    const content = fs.readFileSync(path.join(process.cwd(), ".env"), "utf-8");
    const newline = String.fromCharCode(10);
    for (const rawLine of content.split(newline)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === void 0) process.env[key] = value;
    }
  } catch {
  }
}
loadEnvFile();
console.log(
  "[config] OpenRouter key:",
  process.env["OPENROUTER_API_KEY"] ? "FOUND" : "MISSING"
);
console.log(
  "[config] Deepgram key:",
  process.env["DEEPGRAM_API_KEY"] ? "FOUND" : "MISSING"
);
const gotTheLock = electron.app.requestSingleInstanceLock();
if (!gotTheLock) {
  electron.app.quit();
}
let mainWindow = null;
let isClickThrough = false;
function createWindow() {
  const isMac = process.platform === "darwin";
  mainWindow = new electron.BrowserWindow({
    width: 480,
    height: 640,
    show: false,
    frame: false,
    transparent: isMac,
    backgroundColor: isMac ? "#00000000" : void 0,
    // macOS: NSPanel floats over fullscreen Spaces; normal window elsewhere.
    // focusable MUST stay true so onboarding / Start Listening remain clickable.
    type: isMac ? "panel" : void 0,
    fullscreenable: !isMac,
    hasShadow: !isMac,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    hiddenInMissionControl: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setContentProtection(true);
  mainWindow.setSkipTaskbar(true);
  const forceOverlay = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    if (process.platform === "darwin") {
      mainWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true
      });
      mainWindow.setFullScreenable(false);
    }
    console.log("[window] FORCE overlay re-applied (screen-saver + visibleOnFullScreen)");
  };
  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
    forceOverlay();
  });
  mainWindow.on("show", forceOverlay);
  mainWindow.on("focus", forceOverlay);
  mainWindow.on("blur", forceOverlay);
  mainWindow.on("restore", forceOverlay);
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12" && input.type === "keyDown") {
      _event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
function toggleClickThrough() {
  if (!mainWindow) return;
  isClickThrough = !isClickThrough;
  mainWindow.setIgnoreMouseEvents(isClickThrough, { forward: isClickThrough });
  mainWindow.webContents.send("stealth:click-through-changed", isClickThrough);
}
electron.app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
electron.app.whenReady().then(() => {
  if (!gotTheLock) return;
  electron.session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      electron.desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
        const primary = sources[0];
        if (!primary) {
          callback({});
          return;
        }
        callback({
          video: primary,
          audio: "loopback"
        });
      });
    },
    { useSystemPicker: false }
  );
  createWindow();
  electron.globalShortcut.register("CommandOrControl+Shift+X", toggleClickThrough);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  electron.globalShortcut.unregisterAll();
  if (process.platform !== "darwin") electron.app.quit();
});
electron.app.on("will-quit", () => {
  electron.globalShortcut.unregisterAll();
});
electron.ipcMain.handle("stealth:get-status", () => ({
  contentProtected: true,
  clickThrough: isClickThrough,
  alwaysOnTop: mainWindow ? mainWindow.isAlwaysOnTop() : false
}));
electron.ipcMain.handle("stealth:set-click-through", (_e, enabled) => {
  if (!mainWindow) return false;
  isClickThrough = enabled;
  mainWindow.setIgnoreMouseEvents(enabled, { forward: enabled });
  return enabled;
});
electron.ipcMain.handle("db:save-profile", (_e, profile) => {
  try {
    const row = saveProfile(profile);
    return { ok: true, profile: row };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
electron.ipcMain.handle("db:get-latest-profile", () => {
  try {
    getDb();
    const row = getLatestProfile();
    return { ok: true, profile: row ?? null };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
electron.ipcMain.handle("config:get-openrouter-key", () => {
  if (process.env["OPENROUTER_API_KEY"]) return process.env["OPENROUTER_API_KEY"];
  try {
    return fs.readFileSync(path.join(process.cwd(), "openrouter.key"), "utf-8").trim();
  } catch {
    return "";
  }
});
electron.ipcMain.handle("config:get-openrouter-keys", () => {
  const keys = [];
  const envKey = process.env["OPENROUTER_API_KEY"];
  if (envKey && envKey.trim()) keys.push(envKey.trim());
  try {
    const fileKey = fs.readFileSync(path.join(process.cwd(), "openrouter.key"), "utf-8").trim();
    if (fileKey) keys.push(fileKey);
  } catch {
  }
  return Array.from(new Set(keys));
});
electron.ipcMain.handle("config:get-deepgram-key", () => {
  if (process.env["DEEPGRAM_API_KEY"]) return process.env["DEEPGRAM_API_KEY"];
  try {
    return fs.readFileSync(path.join(process.cwd(), "deepgram.key"), "utf-8").trim();
  } catch {
    return "";
  }
});
electron.ipcMain.handle("stt:is-available", () => isWhisperAvailable());
electron.ipcMain.handle("stt:transcribe", async (_e, wavArrayBuffer) => {
  try {
    const text = await transcribeWav(Buffer.from(wavArrayBuffer));
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
