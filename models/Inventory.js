const mongoose = require("mongoose");

const inventorySchema = new mongoose.Schema({
  _id: {
    type: String,
    default: "main"
  },
  patties: {
    type: Number,
    default: 450,
    min: 0
  },
  buns: {
    type: Number,
    default: 350,
    min: 0
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("Inventory", inventorySchema);