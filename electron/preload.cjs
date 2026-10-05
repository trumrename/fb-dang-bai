const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fbDangBai", {
  pickFolder(options = {}) {
    return ipcRenderer.invoke("fbdangbai:pick-folder", {
      title: String(options.title || "Chọn thư mục"),
      initialDir: String(options.initialDir || ""),
    });
  },
  pickFile(options = {}) {
    return ipcRenderer.invoke("fbdangbai:pick-file", {
      title: String(options.title || "Chọn file"),
      initialDir: String(options.initialDir || ""),
    });
  },
  openExternal(url) {
    return ipcRenderer.invoke("fbdangbai:open-external", String(url || ""));
  },
  applyUpdate() {
    return ipcRenderer.invoke("fbdangbai:apply-update");
  },
});
