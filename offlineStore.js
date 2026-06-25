// CSV-backed fallback store when MongoDB is unreachable.
const fs = require("fs");
const path = require("path");
const runtimePaths = require("./runtimePaths");

const ORDER_FILE_PREFIX = runtimePaths.orderFilePrefix;
const ORDER_FILE_PATTERN = /^offline-orders-\d{4}-\d{2}-\d{2}\.csv$/;
const DATA_DIR = runtimePaths.baseDir;
const INVENTORY_FILE = runtimePaths.inventoryFile;
const LEGACY_BACKUP_FILE = runtimePaths.legacyOrdersFile;

const ORDER_HEADERS = [
  "_id",
  "orderId",
  "customerName",
  "phone",
  "status",
  "paymentMethod",
  "paymentStatus",
  "total",
  "eta",
  "priority",
  "createdAt",
  "updatedAt",
  "offline",
  "syncedAt",
  "items"
];

let orders = [];
let orderSeq = 1000;
let inventory = { patties: 450, buns: 350 };

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getOrderFilePath(date = new Date()) {
  return path.join(DATA_DIR, `${ORDER_FILE_PREFIX}-${getLocalDateKey(date)}.csv`);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      field += '"';
      index++;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      fields.push(field);
      field = "";
      continue;
    }

    field += char;
  }

  fields.push(field);
  return fields;
}

function serializeItems(items) {
  return (items || []).map(item => [
    encodeURIComponent(String(item.name ?? "")),
    Number(item.qty) || 0,
    Number(item.price) || 0
  ].join("|")).join(";");
}

function deserializeItems(value) {
  if (!value) return [];

  return String(value).split(";").filter(Boolean).map(part => {
    const [name, qty, price] = part.split("|");
    return {
      name: decodeURIComponent(name || ""),
      qty: Number(qty) || 0,
      price: Number(price) || 0
    };
  });
}

function orderToRow(order) {
  return ORDER_HEADERS.map(header => {
    if (header === "items") return escapeCsv(serializeItems(order.items));
    return escapeCsv(order[header]);
  }).join(",");
}

function rowToOrder(fields, headers = ORDER_HEADERS) {
  const record = Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ""]));

  return {
    _id: record._id,
    orderId: Number(record.orderId) || record.orderId,
    customerName: record.customerName,
    phone: record.phone,
    status: record.status,
    paymentMethod: record.paymentMethod,
    paymentStatus: record.paymentStatus,
    total: Number(record.total) || 0,
    eta: Number(record.eta) || 0,
    priority: record.priority === "true",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    offline: record.offline === "true",
    syncedAt: record.syncedAt || "",
    items: deserializeItems(record.items)
  };
}

function loadOrders() {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(file => ORDER_FILE_PATTERN.test(file)).sort();

    if (files.length === 0 && fs.existsSync(LEGACY_BACKUP_FILE)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_BACKUP_FILE, "utf8"));
      orders = Array.isArray(legacy.orders) ? legacy.orders : [];
      orderSeq = Number(legacy.orderSeq) || orderSeq;
      inventory = legacy.inventory || inventory;
      save();
      console.log(`Migrated ${orders.length} legacy offline orders to daily CSV backup`);
      return;
    }

    orders = files.flatMap(file => {
      const lines = fs.readFileSync(path.join(DATA_DIR, file), "utf8").trim().split(/\r?\n/);
      if (lines.length < 2 || !lines[0]) return [];

      const headers = parseCsvLine(lines[0]);
      return lines.slice(1).filter(Boolean).map(line => rowToOrder(parseCsvLine(line), headers));
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const highestOrderId = orders.reduce((max, order) => {
      const id = Number(order.orderId);
      return Number.isFinite(id) ? Math.max(max, id) : max;
    }, 1000);

    orderSeq = Math.max(orderSeq, highestOrderId);
    console.log(`Loaded ${orders.length} offline orders from CSV backup`);
  } catch (e) {
    // Keep the POS usable if a backup file is temporarily unavailable.
  }
}

function loadInventory() {
  try {
    if (!fs.existsSync(INVENTORY_FILE)) return;

    const lines = fs.readFileSync(INVENTORY_FILE, "utf8").trim().split(/\r?\n/);
    if (lines.length < 2) return;

    const [patties, buns] = parseCsvLine(lines[1]).map(Number);
    if (Number.isFinite(patties) && Number.isFinite(buns)) {
      inventory = { patties, buns };
    }
  } catch (e) {
    // Defaults are good enough when offline inventory backup cannot be read.
  }
}

function writeOrdersByDate() {
  const grouped = new Map();

  for (const file of fs.readdirSync(DATA_DIR).filter(entry => ORDER_FILE_PATTERN.test(entry))) {
    fs.unlinkSync(path.join(DATA_DIR, file));
  }

  for (const order of orders) {
    const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
    const dateKey = Number.isNaN(createdAt.getTime()) ? getLocalDateKey() : getLocalDateKey(createdAt);

    if (!grouped.has(dateKey)) grouped.set(dateKey, []);
    grouped.get(dateKey).push(order);
  }

  for (const [dateKey, dayOrders] of grouped.entries()) {
    const filePath = path.join(__dirname, `${ORDER_FILE_PREFIX}-${dateKey}.csv`);
    const csv = [
      ORDER_HEADERS.join(","),
      ...dayOrders.map(orderToRow)
    ].join("\n");

    fs.writeFileSync(filePath, `${csv}\n`);
  }
}

function saveInventory() {
  const csv = [
    "patties,buns,updatedAt",
    [inventory.patties, inventory.buns, new Date().toISOString()].map(escapeCsv).join(",")
  ].join("\n");

  fs.writeFileSync(INVENTORY_FILE, `${csv}\n`);
}

function save() {
  try {
    writeOrdersByDate();
    saveInventory();
  } catch (e) {
    // Offline mode should not crash the API if disk persistence fails.
  }
}

function isMongoUp() {
  const mongoose = require("mongoose");
  return mongoose.connection.readyState === 1;
}

loadOrders();
loadInventory();

exports.isMongoUp = isMongoUp;

exports.createOrder = function({ customerName, phone, items, total, paymentMethod }) {
  orderSeq++;
  const now = new Date().toISOString();
  const order = {
    _id: `offline-${orderSeq}`,
    orderId: orderSeq,
    customerName,
    phone: phone || "Walk-in",
    items,
    total,
    paymentMethod: paymentMethod || "cash",
    paymentStatus: "paid",
    status: "preparing",
    eta: 15,
    priority: false,
    createdAt: now,
    updatedAt: now,
    offline: true,
    syncedAt: ""
  };

  orders.unshift(order);
  save();
  return order;
};

exports.getOrders = function() {
  return orders;
};

exports.getUnsyncedOrders = function() {
  return orders.filter(order => !order.syncedAt);
};

exports.markOrdersSynced = function(ids) {
  const idSet = new Set(ids.map(String));
  const syncedAt = new Date().toISOString();

  orders.forEach(order => {
    if (idSet.has(String(order._id))) {
      order.syncedAt = syncedAt;
    }
  });

  save();
};

exports.findById = function(id) {
  return orders.find(o => o._id === id);
};

exports.updateStatus = function(id, status) {
  const order = orders.find(o => o._id === id);
  if (order) {
    order.status = status;
    order.updatedAt = new Date().toISOString();
    save();
  }
  return order;
};

exports.updatePaymentStatus = function(id, paymentStatus) {
  const order = orders.find(o => o._id === id);
  if (order) {
    order.paymentStatus = paymentStatus;
    order.updatedAt = new Date().toISOString();
    save();
  }
  return order;
};

exports.getInventory = function() {
  return { _id: "main", ...inventory, updatedAt: new Date().toISOString() };
};

exports.updateInventory = function(patties, buns) {
  inventory.patties = patties;
  inventory.buns = buns;
  save();
  return { _id: "main", ...inventory, updatedAt: new Date().toISOString() };
};

exports.deductInventory = function(patties, buns) {
  if (inventory.patties < patties || inventory.buns < buns) return false;
  inventory.patties -= patties;
  inventory.buns -= buns;
  save();
  return true;
};

exports.getPaymentStats = function() {
  const completed = orders.filter(o => o.status === "completed");
  const totalRevenue = completed.reduce((sum, o) => sum + (o.total || 0), 0);
  const cashRevenue = completed.filter(o => o.paymentMethod === "cash").reduce((sum, o) => sum + (o.total || 0), 0);
  const jazzRevenue = completed.filter(o => o.paymentMethod === "jazzcash").reduce((sum, o) => sum + (o.total || 0), 0);
  return { totalRevenue, cashRevenue, jazzRevenue, pendingVerification: [] };
};

exports.save = save;
exports.getOrderFilePath = getOrderFilePath;

Object.defineProperty(exports, "orders", {
  get() {
    return orders;
  },
  set(nextOrders) {
    orders = Array.isArray(nextOrders) ? nextOrders : [];
    save();
  }
});
