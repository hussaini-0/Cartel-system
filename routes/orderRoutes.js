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
  updateInventory,
  getMenu,
  saveMenuItem,
  deleteMenuItem,
  markAllReady,
  markAllDelivered,
  editOrder,
  deleteOrder
} = require("../controllers/orderController");

// 🆕 CREATE ORDER
router.post("/", createOrder);

// 📦 GET ORDERS
router.get("/", getOrders);

router.get("/inventory", getInventory);
router.post("/inventory", updateInventory);
router.get("/menu", getMenu);
router.post("/menu", saveMenuItem);
router.delete("/menu/:key", deleteMenuItem);
router.post("/bulk/ready", markAllReady);
router.post("/bulk/delivered", markAllDelivered);

// 🍳 PREPARING (NEW)
router.post("/:id/preparing", markPreparing);

// ✅ READY
router.post("/:id/ready", markReady);

// 💰 PAID
router.post("/:id/markPaid", markPaid);

router.post("/:id/delivered", markDelivered);
router.post("/:id/verifyPayment", verifyPayment);
router.get("/stats/payments", getPaymentStats);

// ✏️ EDIT ORDER
router.patch("/:id", editOrder);

// 🗑️ DELETE ORDER
router.delete("/:id", deleteOrder);

module.exports = router;
