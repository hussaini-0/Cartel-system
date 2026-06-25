const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("cartelDesktop", {
  isDesktop: true
});
