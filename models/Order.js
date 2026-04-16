const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({
  orderId: Number,
  phone: String,

  // ✅ STRUCTURED ITEMS
  items: [
    {
      name: String,
      qty: Number,
      price: Number
    }
  ],

  total: Number,

  status: {
    type: String,
    enum: ["pending", "confirmed", "preparing", "ready", "completed"],
    default: "pending"
  },

  paymentMethod: String,

  paymentStatus: {
    type: String,
    enum: ["pending", "screenshot_received", "paid"],
    default: "pending"
  },

  screenshotPath: {
    type: String,
    default: null
  },

  eta: Number,

  // 🔥 PRIORITY FLAG
  priority: {
    type: Boolean,
    default: false
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("Order", orderSchema);