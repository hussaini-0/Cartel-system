const Order = require("../models/Order");
const Counter = require("../models/Counter");
const Inventory = require("../models/Inventory");
const { priceMap: menu, getInventoryUsage } = require("../services/menu");

const INVENTORY_ID = "main";

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

// ✅ PROCESS ITEMS (BULLETPROOF)
const processItems = (items) => {
  let total = 0;

  const structuredItems = [];

  for (let item of items) {

    // ✅ STRING FORMAT ("Don OG")
    if (typeof item === "string") {
      const name = item.toLowerCase();
      const price = menu[name] || 0;

      total += price;

      structuredItems.push({
        name: item,
        qty: 1,
        price
      });

      continue;
    }

    // ❌ INVALID ITEM (skip instead of crashing)
    if (!item || typeof item !== "object" || !item.name) {
      console.log("⚠️ Invalid item skipped:", item);
      continue;
    }

    // ✅ SAFE OBJECT FORMAT
    const name = String(item.name).toLowerCase();
    const qty = Number(item.qty) > 0 ? Number(item.qty) : 1;
    const price = menu[name] || 0;

    total += price * qty;

    structuredItems.push({
      name: item.name,
      qty,
      price
    });
  }

  return { structuredItems, total };
};

// 🆕 CREATE ORDER
exports.createOrder = async (req, res) => {
  try {
    console.log("📩 Incoming Body:", req.body); // 🔥 DEBUG

    const { phone, items, paymentMethod } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Items must be a non-empty array" });
    }
    console.log("BODY:", req.body);

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

    const { structuredItems, total } = processItems(items);

    if (structuredItems.length === 0) {
      return res.status(400).json({ error: "No valid items found" });
    }

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
      phone: phone || "Walk-in",
      items: structuredItems,
      total,
      paymentMethod: paymentMethod || "cash",
      paymentStatus: "paid",
      status: "confirmed",
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
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 🍳 MARK PREPARING
exports.markPreparing = async (req, res) => {
  try {
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
    const orders = await Order.find({ status: "completed" });

    const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const cashRevenue = orders.filter(o => o.paymentMethod === "cash").reduce((sum, o) => sum + (o.total || 0), 0);
    const jazzRevenue = orders.filter(o => o.paymentMethod === "jazzcash").reduce((sum, o) => sum + (o.total || 0), 0);

    // Pending screenshot verifications
    const pendingVerification = await Order.find({ paymentStatus: "screenshot_received" }).sort({ createdAt: -1 });

    res.json({ totalRevenue, cashRevenue, jazzRevenue, pendingVerification });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getInventory = async (req, res) => {
  try {
    const inventory = await ensureInventoryDocument();
    res.json(inventory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateInventory = async (req, res) => {
  try {
    const nextPatties = Number(req.body?.patties);
    const nextBuns = Number(req.body?.buns);

    if (!Number.isFinite(nextPatties) || nextPatties < 0 || !Number.isFinite(nextBuns) || nextBuns < 0) {
      return res.status(400).json({ error: "Patties and buns must be non-negative numbers." });
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

    res.json(inventory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};