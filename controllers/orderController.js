const Order = require("../models/Order");
const mongoose = require("mongoose");
const Counter = require("../models/Counter");
const Inventory = require("../models/Inventory");
const offline = require("../offlineStore");
const {
  getInventoryUsage,
  calculateOrderPricing,
  getPublicMenuItems,
  upsertMenuItem,
  removeMenuItem,
  createSoldCountSeed,
  normalizeSoldCountKey,
  buildSoldCountRows
} = require("../services/menu");

const INVENTORY_ID = "main";

function emitBulkOrderUpdate(req, payload) {
  const io = req.app.get("io");
  if (io) io.emit("orders_bulk_updated", payload);
}

function isOfflineOrderId(id) {
  return String(id || "").startsWith("offline-");
}

function orderDateKey(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function localDayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function mergeMongoAndOfflineOrders(mongoOrders) {
  const mongoRows = mongoOrders.map(order => (
    typeof order.toObject === "function" ? order.toObject() : order
  ));
  const mongoOfflineIds = new Set(mongoRows.map(order => order.offlineSourceId).filter(Boolean));
  const mongoFallbackKeys = new Set(mongoRows.map(order => [
    order.orderId,
    order.customerName || "",
    Number(order.total) || 0,
    orderDateKey(order.createdAt)
  ].join("|")));

  const csvOnlyOrders = offline.getOrders().filter(order => {
    const fallbackKey = [
      order.orderId,
      order.customerName || "",
      Number(order.total) || 0,
      orderDateKey(order.createdAt)
    ].join("|");

    return !mongoOfflineIds.has(order._id) && !mongoFallbackKeys.has(fallbackKey);
  });

  return [...mongoRows, ...csvOnlyOrders]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function buildPaymentStats(orders, selectedDate = "") {
  const filteredOrders = selectedDate
    ? orders.filter(order => localDayKey(order.createdAt) === selectedDate)
    : orders;

  const completed = filteredOrders.filter(order => order.status === "completed");
  const totalRevenue = completed.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
  const cashRevenue = completed
    .filter(order => order.paymentMethod === "cash")
    .reduce((sum, order) => sum + (Number(order.total) || 0), 0);
  const jazzRevenue = completed
    .filter(order => order.paymentMethod === "jazzcash")
    .reduce((sum, order) => sum + (Number(order.total) || 0), 0);
  const pendingVerification = filteredOrders
    .filter(order => order.paymentStatus === "screenshot_received")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    date: selectedDate || "all",
    totalOrders: filteredOrders.length,
    completedOrders: completed.length,
    totalRevenue,
    cashRevenue,
    jazzRevenue,
    pendingVerification
  };
}

function getRequestedIds(req) {
  return Array.isArray(req.body?.ids)
    ? req.body.ids.map(String).filter(Boolean)
    : [];
}

function splitRequestedIds(ids) {
  return {
    offlineIds: ids.filter(isOfflineOrderId),
    mongoIds: ids.filter(id => !isOfflineOrderId(id) && mongoose.isValidObjectId(id))
  };
}

async function ensureInventoryDocument() {
  let inventory = await Inventory.findById(INVENTORY_ID);

  if (!inventory) {
    inventory = await Inventory.create({ _id: INVENTORY_ID });
  }

  return inventory;
}

function calculateInventoryUsage(items) {
  return items.reduce((usage, item) => {
    const itemUsage = getInventoryUsage(item.name);

    usage.patties += itemUsage.patties * item.qty;
    usage.buns += itemUsage.buns * item.qty;

    return usage;
  }, { patties: 0, buns: 0 });
}

function buildSoldCountsFromOrders(orders, selectedDate = "") {
  const soldCounts = createSoldCountSeed();
  const filteredOrders = selectedDate
    ? orders.filter(order => localDayKey(order.createdAt) === selectedDate)
    : orders;

  for (const order of filteredOrders) {
    for (const item of order.items || []) {
      const key = normalizeSoldCountKey(item.name);
      if (!Object.prototype.hasOwnProperty.call(soldCounts, key)) {
        continue;
      }

      soldCounts[key] += Number(item.qty) || 0;
    }
  }

  return buildSoldCountRows(soldCounts);
}

async function buildInventoryResponse(inventoryDoc, selectedDate = "") {
  const mongoOrders = await Order.find({}, { items: 1, createdAt: 1, orderId: 1, customerName: 1, total: 1, offlineSourceId: 1 }).lean();
  const orders = mergeMongoAndOfflineOrders(mongoOrders);

  return {
    ...(typeof inventoryDoc.toObject === "function" ? inventoryDoc.toObject() : inventoryDoc),
    soldCounts: buildSoldCountsFromOrders(orders, selectedDate),
    soldCountsDate: selectedDate || "all"
  };
}

// ✅ PROCESS ITEMS (BULLETPROOF)
const processItems = (items) => calculateOrderPricing(items);

exports.getMenu = (req, res) => {
  res.json({ items: getPublicMenuItems() });
};

exports.saveMenuItem = (req, res) => {
  try {
    const item = upsertMenuItem(req.body);
    const io = req.app.get("io");
    if (io) io.emit("menu_updated", { items: getPublicMenuItems() });
    res.json({ item, items: getPublicMenuItems() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteMenuItem = (req, res) => {
  try {
    if (!removeMenuItem(req.params.key)) {
      return res.status(404).json({ error: "Menu item not found" });
    }

    const io = req.app.get("io");
    if (io) io.emit("menu_updated", { items: getPublicMenuItems() });
    res.json({ items: getPublicMenuItems() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 🆕 CREATE ORDER
exports.createOrder = async (req, res) => {
  try {
    console.log("📩 Incoming Body:", req.body); // 🔥 DEBUG

    const { customerName, phone, items, paymentMethod } = req.body;

    if (!customerName || !String(customerName).trim()) {
      return res.status(400).json({ error: "Customer name is required" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Items must be a non-empty array" });
    }
    console.log("BODY:", req.body);

    const { structuredItems, total } = processItems(items);

    if (structuredItems.length === 0) {
      return res.status(400).json({ error: "No valid items found" });
    }

    // ⚡ OFFLINE FALLBACK
    if (!offline.isMongoUp()) {
      console.log("⚠️ MongoDB offline — using in-memory store");
      const inventoryUsage = calculateInventoryUsage(structuredItems);
      if (inventoryUsage.patties > 0 || inventoryUsage.buns > 0) {
        if (!offline.deductInventory(inventoryUsage.patties, inventoryUsage.buns)) {
          const inv = offline.getInventory();
          return res.status(400).json({ error: `Insufficient inventory. Remaining: ${inv.patties} patties, ${inv.buns} buns.` });
        }
      }
      const newOrder = offline.createOrder({
        customerName: String(customerName).trim(),
        phone, items: structuredItems, total, paymentMethod
      });
      const io = req.app.get("io");
      if (io) io.emit("new_order", newOrder);
      return res.json(newOrder);
    }

    await ensureInventoryDocument();

    const counter = await Counter.findByIdAndUpdate(
      "orderId",
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    const orderId = 1000 + counter.seq;

    const activeOrders = await Order.countDocuments({
      status: { $in: ["confirmed", "preparing"] }
    });

    const eta = 15 + (activeOrders * 5);

    const inventoryUsage = calculateInventoryUsage(structuredItems);

    if (inventoryUsage.patties > 0 || inventoryUsage.buns > 0) {
      const updatedInventory = await Inventory.findOneAndUpdate(
        {
          _id: INVENTORY_ID,
          patties: { $gte: inventoryUsage.patties },
          buns: { $gte: inventoryUsage.buns }
        },
        {
          $inc: {
            patties: -inventoryUsage.patties,
            buns: -inventoryUsage.buns
          },
          $set: { updatedAt: new Date() }
        },
        { new: true }
      );

      if (!updatedInventory) {
        const currentInventory = await ensureInventoryDocument();
        return res.status(400).json({
          error: `Insufficient inventory. Remaining stock: ${currentInventory.patties} patties, ${currentInventory.buns} buns.`
        });
      }
    }

    // 🔥 PRIORITY LOGIC
    const totalQty = structuredItems.reduce((sum, i) => sum + i.qty, 0);
    const priority = totalQty >= 5;

    const newOrder = new Order({
      orderId,
      customerName: String(customerName).trim(),
      phone: phone || "Walk-in",
      items: structuredItems,
      total,
      paymentMethod: paymentMethod || "cash",
      paymentStatus: "paid",
      status: "preparing",
      eta,
      priority
    });

    await newOrder.save();

    // 🔥 SOCKET EMIT
    const io = req.app.get("io");
    if (io) io.emit("new_order", newOrder);

    res.json(newOrder);

  } catch (err) {
    console.error("❌ CREATE ORDER ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

// 📦 GET ORDERS
exports.getOrders = async (req, res) => {
  try {
    if (!offline.isMongoUp()) {
      return res.json(offline.getOrders());
    }
    const orders = await Order.find().sort({ createdAt: -1 }).lean();
    res.json(mergeMongoAndOfflineOrders(orders));
  } catch (err) {
    // Fallback to offline on any DB error
    res.json(offline.getOrders());
  }
};

// 🍳 MARK PREPARING
exports.markPreparing = async (req, res) => {
  try {
    if (!offline.isMongoUp()) {
      const order = offline.updateStatus(req.params.id, "preparing");
      if (!order) return res.status(404).json({ error: "Order not found" });
      const io = req.app.get("io"); if (io) io.emit("order_updated", order);
      return res.json(order);
    }
    const order = await Order.findById(req.params.id);

    if (!order) return res.status(404).json({ error: "Order not found" });

    order.status = "preparing";
    await order.save();

    const io = req.app.get("io");
    if (io) io.emit("order_updated", order);

    res.json(order);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✅ MARK READY
exports.markReady = async (req, res) => {
  try {
    if (!offline.isMongoUp() || isOfflineOrderId(req.params.id)) {
      const order = offline.updateStatus(req.params.id, "ready");
      if (!order) return res.status(404).json({ error: "Order not found" });
      const io = req.app.get("io"); if (io) io.emit("order_updated", order);
      return res.json(order);
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }
    const order = await Order.findById(req.params.id);

    if (!order) return res.status(404).json({ error: "Order not found" });

    order.status = "ready";
    await order.save();

    const io = req.app.get("io");
    if (io) io.emit("order_updated", order);

    res.json(order);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 💰 MARK PAID
exports.markAllReady = async (req, res) => {
  try {
    const requestedIds = getRequestedIds(req);
    const { offlineIds, mongoIds } = splitRequestedIds(requestedIds);
    const hasRequestedIds = requestedIds.length > 0;

    if (!offline.isMongoUp()) {
      const updatedOrders = offline.getOrders()
        .filter(order => !hasRequestedIds || offlineIds.includes(String(order._id)))
        .filter(order => order.status === "confirmed" || order.status === "preparing")
        .map(order => offline.updateStatus(order._id, "ready"))
        .filter(Boolean);

      emitBulkOrderUpdate(req, { action: "ready", updated: updatedOrders.length });
      return res.json({ updated: updatedOrders.length, orders: updatedOrders });
    }

    const updatedOfflineOrders = offline.getOrders()
      .filter(order => !hasRequestedIds || offlineIds.includes(String(order._id)))
      .filter(order => order.status === "confirmed" || order.status === "preparing")
      .map(order => offline.updateStatus(order._id, "ready"))
      .filter(Boolean);

    const mongoFilter = { status: { $in: ["confirmed", "preparing"] } };
    if (hasRequestedIds) {
      mongoFilter._id = { $in: mongoIds };
    }

    const orders = await Order.find(mongoFilter);

    if (orders.length === 0) {
      emitBulkOrderUpdate(req, { action: "ready", updated: updatedOfflineOrders.length });
      return res.json({ updated: updatedOfflineOrders.length, orders: updatedOfflineOrders });
    }

    const orderIds = orders.map(order => order._id);

    await Order.updateMany(
      { _id: { $in: orderIds } },
      { $set: { status: "ready" } }
    );

    const updatedOrders = await Order.find({ _id: { $in: orderIds } }).lean();

    const allUpdatedOrders = [...updatedOrders, ...updatedOfflineOrders];
    emitBulkOrderUpdate(req, { action: "ready", updated: allUpdatedOrders.length });

    res.json({ updated: allUpdatedOrders.length, orders: allUpdatedOrders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.markAllDelivered = async (req, res) => {
  try {
    const requestedIds = getRequestedIds(req);
    const { offlineIds, mongoIds } = splitRequestedIds(requestedIds);
    const hasRequestedIds = requestedIds.length > 0;

    if (!offline.isMongoUp()) {
      const updatedOrders = offline.getOrders()
        .filter(order => !hasRequestedIds || offlineIds.includes(String(order._id)))
        .filter(order => order.status === "ready")
        .map(order => offline.updateStatus(order._id, "completed"))
        .filter(Boolean);

      emitBulkOrderUpdate(req, { action: "delivered", updated: updatedOrders.length });
      return res.json({ updated: updatedOrders.length, orders: updatedOrders });
    }

    const updatedOfflineOrders = offline.getOrders()
      .filter(order => !hasRequestedIds || offlineIds.includes(String(order._id)))
      .filter(order => order.status === "ready")
      .map(order => offline.updateStatus(order._id, "completed"))
      .filter(Boolean);

    const mongoFilter = { status: "ready" };
    if (hasRequestedIds) {
      mongoFilter._id = { $in: mongoIds };
    }

    const orders = await Order.find(mongoFilter);

    if (orders.length === 0) {
      emitBulkOrderUpdate(req, { action: "delivered", updated: updatedOfflineOrders.length });
      return res.json({ updated: updatedOfflineOrders.length, orders: updatedOfflineOrders });
    }

    const orderIds = orders.map(order => order._id);

    await Order.updateMany(
      { _id: { $in: orderIds } },
      { $set: { status: "completed" } }
    );

    const updatedOrders = await Order.find({ _id: { $in: orderIds } }).lean();

    const allUpdatedOrders = [...updatedOrders, ...updatedOfflineOrders];
    emitBulkOrderUpdate(req, { action: "delivered", updated: allUpdatedOrders.length });

    res.json({ updated: allUpdatedOrders.length, orders: allUpdatedOrders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.markPaid = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) return res.status(404).json({ error: "Order not found" });

    order.paymentStatus = "paid";
    await order.save();

    const io = req.app.get("io");
    if (io) io.emit("order_updated", order);

    res.json(order);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.markDelivered = async (req, res) => {
  try {
    if (!offline.isMongoUp() || isOfflineOrderId(req.params.id)) {
      const order = offline.updateStatus(req.params.id, "completed");
      if (!order) return res.status(404).json({ error: "Order not found" });
      const io = req.app.get("io"); if (io) io.emit("order_updated", order);
      return res.json(order);
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }
    const order = await Order.findById(req.params.id);

    if (!order) return res.status(404).json({ error: "Order not found" });

    order.status = "completed"; // 🔥 NEW STATUS
    await order.save();

    const io = req.app.get("io");
    if (io) io.emit("order_updated", order);

    res.json(order);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.verifyPayment = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) return res.status(404).json({ error: "Order not found" });

    order.paymentStatus = "paid";
    await order.save();

    const io = req.app.get("io");
    if (io) io.emit("order_updated", order);

    res.json(order);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getPaymentStats = async (req, res) => {
  try {
    const selectedDate = String(req.query?.date || "").trim();

    if (!offline.isMongoUp()) {
      return res.json(buildPaymentStats(offline.getOrders(), selectedDate));
    }

    const mongoOrders = await Order.find().lean();
    res.json(buildPaymentStats(mergeMongoAndOfflineOrders(mongoOrders), selectedDate));

  } catch (err) {
    res.json(buildPaymentStats(offline.getOrders(), String(req.query?.date || "").trim()));
  }
};

exports.getInventory = async (req, res) => {
  try {
    const selectedDate = String(req.query?.date || "").trim();

    if (!offline.isMongoUp()) {
      const inv = offline.getInventory();
      return res.json({
        ...inv,
        soldCounts: buildSoldCountsFromOrders(offline.getOrders(), selectedDate),
        soldCountsDate: selectedDate || "all"
      });
    }
    const inventory = await ensureInventoryDocument();
    res.json(await buildInventoryResponse(inventory, selectedDate));
  } catch (err) {
    const inv = offline.getInventory();
    const selectedDate = String(req.query?.date || "").trim();
    res.json({
      ...inv,
      soldCounts: buildSoldCountsFromOrders(offline.getOrders(), selectedDate),
      soldCountsDate: selectedDate || "all"
    });
  }
};

exports.updateInventory = async (req, res) => {
  try {
    const nextPatties = Number(req.body?.patties);
    const nextBuns = Number(req.body?.buns);

    if (!Number.isFinite(nextPatties) || nextPatties < 0 || !Number.isFinite(nextBuns) || nextBuns < 0) {
      return res.status(400).json({ error: "Patties and buns must be non-negative numbers." });
    }

    if (!offline.isMongoUp()) {
      const selectedDate = String(req.query?.date || "").trim();
      const inv = offline.updateInventory(nextPatties, nextBuns);
      return res.json({
        ...inv,
        soldCounts: buildSoldCountsFromOrders(offline.getOrders(), selectedDate),
        soldCountsDate: selectedDate || "all"
      });
    }

    const inventory = await Inventory.findByIdAndUpdate(
      INVENTORY_ID,
      {
        $set: {
          patties: nextPatties,
          buns: nextBuns,
          updatedAt: new Date()
        }
      },
      {
        new: true,
        upsert: true
      }
    );

    res.json(await buildInventoryResponse(inventory, String(req.query?.date || "").trim()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✏️ EDIT ORDER (name + phone only)
exports.deleteOrder = async (req, res) => {
  try {
    if (!offline.isMongoUp() || isOfflineOrderId(req.params.id)) {
      const order = offline.findById(req.params.id);
      if (!order) return res.status(404).json({ error: "Order not found" });
      offline.orders = offline.orders.filter(o => String(o._id) !== req.params.id);
      if (offline.save) offline.save();
      const io = req.app.get("io"); if (io) io.emit("order_deleted", { _id: req.params.id });
      return res.json({ message: "Order deleted" });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const io = req.app.get("io");
    if (io) io.emit("order_deleted", { _id: req.params.id });

    res.json({ message: "Order deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.editOrder = async (req, res) => {
  try {
    const { customerName, phone } = req.body;

    if (customerName !== undefined && !String(customerName).trim()) {
      return res.status(400).json({ error: "Customer name cannot be empty." });
    }

    if (!offline.isMongoUp() || isOfflineOrderId(req.params.id)) {
      const order = offline.findById(req.params.id);
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (customerName !== undefined) order.customerName = String(customerName).trim();
      if (phone !== undefined) order.phone = phone;
      offline.save ? offline.save() : null;
      const io = req.app.get("io"); if (io) io.emit("order_updated", order);
      return res.json(order);
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (customerName !== undefined) order.customerName = String(customerName).trim();
    if (phone !== undefined) order.phone = phone;
    await order.save();

    const io = req.app.get("io");
    if (io) io.emit("order_updated", order);

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
