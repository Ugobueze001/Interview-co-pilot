"use strict";
const electron = require("electron");
const api = {
  stealth: {
    getStatus: () => electron.ipcRenderer.invoke("stealth:get-status"),
    setClickThrough: (enabled) => electron.ipcRenderer.invoke("stealth:set-click-through", enabled),
    onClickThroughChanged: (callback) => {
      const listener = (_event, enabled) => callback(enabled);
      electron.ipcRenderer.on("stealth:click-through-changed", listener);
    }
  },
  db: {
    saveProfile: (profile) => electron.ipcRenderer.invoke("db:save-profile", profile),
    getLatestProfile: () => electron.ipcRenderer.invoke("db:get-latest-profile")
  },
  config: {
    getOpenRouterKey: () => electron.ipcRenderer.invoke("config:get-openrouter-key"),
    getOpenRouterKeys: () => electron.ipcRenderer.invoke("config:get-openrouter-keys"),
    getDeepgramKey: () => electron.ipcRenderer.invoke("config:get-deepgram-key")
  },
  stt: {
    isAvailable: () => electron.ipcRenderer.invoke("stt:is-available"),
    transcribe: (wav) => electron.ipcRenderer.invoke("stt:transcribe", wav)
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
