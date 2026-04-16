const express = require("express");
const router = express.Router();

const {
  createOrder,
  getOrders,
  markPreparing,
  markReady,
  markPaid,
  markDelivered,
  verifyPayment,
  getPaymentStats,
  getInventory,
  updateInventory
} = require("../controllers/orderController");

// 🆕 CREATE ORDER
router.post("/", createOrder);

// 📦 GET ORDERS
router.get("/", getOrders);

router.get("/inventory", getInventory);
router.post("/inventory", updateInventory);

// 🍳 PREPARING (NEW)
router.post("/:id/preparing", markPreparing);

// ✅ READY
router.post("/:id/ready", markReady);

// 💰 PAID
router.post("/:id/markPaid", markPaid);

router.post("/:id/delivered", markDelivered);
router.post("/:id/verifyPayment", verifyPayment);
router.get("/stats/payments", getPaymentStats);

module.exports = router;