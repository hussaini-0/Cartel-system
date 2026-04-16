require("dotenv").config();
const mongoose = require("mongoose");
const Order = require("./models/Order");
const Counter = require("./models/Counter");

const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const { priceMap: menu } = require("./services/menu");

function normalizePhoneForWhatsApp(phone) {
  const digitsOnly = String(phone || "").replace(/\D/g, "");

  if (!digitsOnly) {
    return null;
  }

  if (digitsOnly.startsWith("00")) {
    return digitsOnly.slice(2);
  }

  if (digitsOnly.startsWith("0") && digitsOnly.length === 11) {
    return `92${digitsOnly.slice(1)}`;
  }

  if (digitsOnly.startsWith("92") && digitsOnly.length >= 12) {
    return digitsOnly;
  }

  return digitsOnly;
}

// 🧠 STATE
const userState = {};
const lastMessage = {};
const activeSessions = new Set();

// 🧾 MENU TEXT
const menuText = `
🍔 *Cartel Burgers Menu*

🍔 Don OG - Rs. 849
🍔 Underboss - Rs. 849
🍔 The Godfather - Rs. 899

🍟 Curly Fries - Rs. 349
🍟 Curly Fries with Sauce - Rs. 449

🥤 Red Bull - Rs. 600
🥤 Pepsi - Rs. 150
🥤 7 Up - Rs. 150
💧 Water - Rs. 100

👉 Example: "2 don og + 3 fries"
`;

// 🧠 PARSER
function parseOrder(text) {
  let items = [];
  let total = 0;
  let warnings = [];

  // Sort keys longest-first so "the godfather" matches before "godfather",
  // and "curly fries with sauce" matches before "curly fries" before "fries"
  const sortedKeys = Object.keys(menu).sort((a, b) => b.length - a.length);

  let remaining = text;

  for (const item of sortedKeys) {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regexWithQty = new RegExp(`(\\d+)\\s*${escaped}`);
    const regexBare = new RegExp(escaped);

    let quantity = 0;

    const matchWithQty = remaining.match(regexWithQty);
    if (matchWithQty) {
      quantity = parseInt(matchWithQty[1]);
      // Consume matched portion so shorter aliases don't re-match
      remaining = remaining.replace(matchWithQty[0], "");
    } else if (regexBare.test(remaining)) {
      quantity = 1;
      remaining = remaining.replace(regexBare, "");
    }

    if (quantity > 50) {
      return { error: "❌ Order too large. Please contact staff." };
    }

    if (quantity > 10) {
      quantity = 10;
      warnings.push(`⚠️ Max 10 ${item} allowed`);
    }

    if (quantity > 0) {
      items.push({ name: item, qty: quantity, price: menu[item] });
      total += menu[item] * quantity;
    }
  }

  return { items, total, warnings };
}

// 🔌 DB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected (Bot)"))
  .catch(err => console.log(err));

// 🤖 CLIENT
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  }
});

client.on("qr", async (qr) => {
  const qrPath = path.join(__dirname, "qr.png");
  await QRCode.toFile(qrPath, qr);
  console.log(`\n✅ QR code saved! Open this file and scan it:\n   ${qrPath}\n`);
});

// Module-level server socket for emitting events to the API
const { io: socketClient } = require("socket.io-client");
const serverSocket = socketClient("http://localhost:5000");

client.on("ready", () => {
  console.log("WhatsApp Notifier Ready ✅");

  serverSocket.on("connect", () => {
    console.log("🔗 Bot connected to server socket for notifications");
  });

  serverSocket.on("order_updated", async (order) => {
    console.log(`📡 order_updated received — status: ${order.status}, phone: ${order.phone}`);
    try {
      if (!order.phone) return;

      // Phone must be digits only, at least 10 chars (e.g. 923001234567)
      const digitsOnly = normalizePhoneForWhatsApp(order.phone);
      if (!digitsOnly || digitsOnly.length < 10) {
        console.log(`⚠️ Skipping notification — invalid phone: "${order.phone}"`);
        return;
      }

      let message;
      if (order.status === "ready") {
        message = `🍔 Your order #${order.orderId} is READY for pickup!`;
      } else if (order.status === "completed") {
        message = `✅ Your order #${order.orderId} has been completed. Enjoy!`;
      } else {
        return;
      }

      // Resolve @lid to @c.us if needed
      let chatId;
      if (order.phone.includes("@lid")) {
        try {
          const contact = await client.getContactById(order.phone);
          chatId = `${contact.number}@c.us`;
        } catch {
          console.log(`⚠️ Could not resolve LID: ${order.phone}`);
          return;
        }
      } else {
        chatId = order.phone.includes("@c.us")
          ? order.phone
          : `${digitsOnly}@c.us`;
      }

      await client.sendMessage(chatId, message);
      console.log(`📲 Notified ${chatId} — status: ${order.status}`);
    } catch (err) {
      console.error("⚠️ Notification failed:", err?.message || err);
    }
  });
});

client.on("disconnected", (reason) => {
  console.log("⚠️ WhatsApp disconnected:", reason, "— Reconnecting...");
  client.initialize();
});

// Notifier-only mode: do not auto-reply to any incoming chats or groups.
client.on("message", async () => {});

client.initialize();