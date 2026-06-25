const fs = require("fs");
const path = require("path");

const baseDir = process.env.CARTEL_DATA_DIR
  ? path.resolve(process.env.CARTEL_DATA_DIR)
  : __dirname;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

const screenshotsDir = ensureDir(path.join(baseDir, "screenshots"));
const whatsappAuthDir = ensureDir(path.join(baseDir, ".wwebjs_auth"));
const whatsappCacheDir = ensureDir(path.join(baseDir, ".wwebjs_cache"));

module.exports = {
  baseDir,
  screenshotsDir,
  whatsappAuthDir,
  whatsappCacheDir,
  qrFile: path.join(baseDir, "qr.png"),
  inventoryFile: path.join(baseDir, "offline-inventory.csv"),
  legacyOrdersFile: path.join(baseDir, "offline-orders.json"),
  orderFilePrefix: "offline-orders",
  menuDataFile: path.join(baseDir, "menu-data.json")
};
