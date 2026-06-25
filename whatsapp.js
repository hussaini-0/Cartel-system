require("dotenv").config();

const mongoose = require("mongoose");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const { priceMap: menu, calculateOrderPricing } = require("./services/menu");
const runtimePaths = require("./runtimePaths");

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

function parseOrder(text) {
  const items = [];
  const warnings = [];
  const sortedKeys = Object.keys(menu).sort((a, b) => b.length - a.length);
  let remaining = text;

  for (const item of sortedKeys) {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regexWithQty = new RegExp(`(\\d+)\\s*${escaped}`);
    const regexBare = new RegExp(escaped);

    let quantity = 0;
    const matchWithQty = remaining.match(regexWithQty);

    if (matchWithQty) {
      quantity = parseInt(matchWithQty[1], 10);
      remaining = remaining.replace(matchWithQty[0], "");
    } else if (regexBare.test(remaining)) {
      quantity = 1;
      remaining = remaining.replace(regexBare, "");
    }

    if (quantity > 50) {
      return { error: "Order too large. Please contact staff." };
    }

    if (quantity > 10) {
      quantity = 10;
      warnings.push(`Max 10 ${item} allowed`);
    }

    if (quantity > 0) {
      items.push({ name: item, qty: quantity, price: menu[item] });
    }
  }

  const { total } = calculateOrderPricing(items);
  return { items, total, warnings };
}

let mongoConnectPromise = null;

async function connectBotMongo() {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return;
  }

  if (!mongoConnectPromise) {
    mongoConnectPromise = mongoose.connect(process.env.MONGO_URI)
      .then(() => console.log("MongoDB Connected (Bot)"))
      .catch((err) => {
        console.log(err);
      });
  }

  return mongoConnectPromise;
}

async function startWhatsAppNotifier({ serverUrl = "http://localhost:5000" } = {}) {
  await connectBotMongo();

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: runtimePaths.whatsappAuthDir }),
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

  const { io: socketClient } = require("socket.io-client");
  const serverSocket = socketClient(serverUrl);

  client.on("qr", async (qr) => {
    await QRCode.toFile(runtimePaths.qrFile, qr);
    console.log(`\nQR code saved. Scan this file:\n   ${runtimePaths.qrFile}\n`);
  });

  client.on("ready", () => {
    console.log("WhatsApp Notifier Ready");

    serverSocket.on("connect", () => {
      console.log("Bot connected to server socket for notifications");
    });

    serverSocket.on("order_updated", async (order) => {
      console.log(`order_updated received - status: ${order.status}, phone: ${order.phone}`);
      try {
        if (!order.phone) {
          return;
        }

        const digitsOnly = normalizePhoneForWhatsApp(order.phone);
        if (!digitsOnly || digitsOnly.length < 10) {
          console.log(`Skipping notification - invalid phone: "${order.phone}"`);
          return;
        }

        let message;
        if (order.status === "ready") {
          message = `Your order #${order.orderId} is READY for pickup!`;
        } else if (order.status === "completed") {
          message = `Your order #${order.orderId} has been completed. Enjoy!`;
        } else {
          return;
        }

        let chatId;
        if (order.phone.includes("@lid")) {
          try {
            const contact = await client.getContactById(order.phone);
            chatId = `${contact.number}@c.us`;
          } catch {
            console.log(`Could not resolve LID: ${order.phone}`);
            return;
          }
        } else {
          chatId = order.phone.includes("@c.us")
            ? order.phone
            : `${digitsOnly}@c.us`;
        }

        await client.sendMessage(chatId, message);
        console.log(`Notified ${chatId} - status: ${order.status}`);
      } catch (err) {
        console.error("Notification failed:", err?.message || err);
      }
    });
  });

  client.on("disconnected", (reason) => {
    console.log("WhatsApp disconnected:", reason, "- Reconnecting...");
    client.initialize();
  });

  client.on("message", async () => {});
  client.initialize();

  return {
    client,
    parseOrder,
    serverSocket
  };
}

module.exports = {
  normalizePhoneForWhatsApp,
  parseOrder,
  startWhatsAppNotifier
};

if (require.main === module) {
  startWhatsAppNotifier().catch((err) => {
    console.error("WhatsApp notifier failed to start:", err);
    process.exit(1);
  });
}
