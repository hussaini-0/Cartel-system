require("dotenv").config();

const dns = require("dns");
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const authMiddleware = require("./middleware/auth");
const authRoutes = require("./routes/authRoutes");
const Order = require("./models/Order");
const Counter = require("./models/Counter");
const offline = require("./offlineStore");
const runtimePaths = require("./runtimePaths");

const resolver = new dns.Resolver();
resolver.setServers(["8.8.8.8", "1.1.1.1"]);
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.resolveSrv = (hostname, cb) => resolver.resolveSrv(hostname, cb);
dns.resolveTxt = (hostname, cb) => resolver.resolveTxt(hostname, cb);
dns.resolve4 = (hostname, ...args) => resolver.resolve4(hostname, ...args);

["MONGO_URI", "ADMIN_PASSWORD", "JWT_SECRET"].forEach((key) => {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
});

const DIRECT_MONGO_URI = "mongodb://talalhussain00024_db_user:DVgHcESuP1vYkP4e@ac-tqty0su-shard-00-00.fr6imio.mongodb.net:27017,ac-tqty0su-shard-00-01.fr6imio.mongodb.net:27017,ac-tqty0su-shard-00-02.fr6imio.mongodb.net:27017/?ssl=true&replicaSet=atlas-4ybunq-shard-0&authSource=admin&retryWrites=true&w=majority&appName=Cartel-Cluster";
const SINGLE_NODE_URI = "mongodb://talalhussain00024_db_user:DVgHcESuP1vYkP4e@ac-tqty0su-shard-00-00.fr6imio.mongodb.net:27017/?ssl=true&authSource=admin&directConnection=true";

let offlineSyncRunning = false;
let mongoConnectPromise = null;

async function syncOfflineOrdersToMongo(app) {
  if (offlineSyncRunning || !offline.isMongoUp()) {
    return { synced: 0, pending: offline.getUnsyncedOrders().length, skipped: true };
  }

  const pendingOrders = offline.getUnsyncedOrders();
  if (pendingOrders.length === 0) {
    return { synced: 0, pending: 0 };
  }

  offlineSyncRunning = true;
  const syncedIds = [];

  try {
    console.log(`Syncing ${pendingOrders.length} offline order(s) to MongoDB...`);

    for (const order of pendingOrders) {
      const offlineSourceId = String(order._id);
      const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
      const normalizedCreatedAt = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;

      const existingOrder = await Order.findOne({
        $or: [
          { offlineSourceId },
          {
            orderId: order.orderId,
            customerName: order.customerName,
            total: order.total,
            createdAt: normalizedCreatedAt
          }
        ]
      });

      if (existingOrder) {
        if (!existingOrder.offlineSourceId) {
          existingOrder.offlineSourceId = offlineSourceId;
          existingOrder.syncedFromOffline = true;
          await existingOrder.save();
        }

        syncedIds.push(offlineSourceId);
        continue;
      }

      await Order.updateOne(
        { offlineSourceId },
        {
          $setOnInsert: {
            orderId: order.orderId,
            customerName: order.customerName,
            phone: order.phone,
            items: order.items,
            total: order.total,
            status: order.status,
            paymentMethod: order.paymentMethod,
            paymentStatus: order.paymentStatus,
            eta: order.eta,
            priority: Boolean(order.priority),
            createdAt: normalizedCreatedAt,
            offlineSourceId,
            syncedFromOffline: true
          }
        },
        { upsert: true }
      );

      syncedIds.push(offlineSourceId);
    }

    const highestOrderId = pendingOrders.reduce((max, order) => {
      const numericOrderId = Number(order.orderId);
      return Number.isFinite(numericOrderId) ? Math.max(max, numericOrderId) : max;
    }, 1000);

    const requiredSeq = highestOrderId - 1000;
    if (requiredSeq > 0) {
      const counter = await Counter.findById("orderId");
      if (!counter || Number(counter.seq) < requiredSeq) {
        await Counter.findByIdAndUpdate(
          "orderId",
          { $set: { seq: requiredSeq } },
          { upsert: true }
        );
      }
    }

    offline.markOrdersSynced(syncedIds);
    console.log(`Synced ${syncedIds.length} offline order(s) to MongoDB.`);

    const serverIo = app?.get("io");
    if (serverIo) {
      serverIo.emit("offline_orders_synced", { count: syncedIds.length });
    }

    return { synced: syncedIds.length, pending: offline.getUnsyncedOrders().length };
  } catch (err) {
    console.error("Offline order sync failed:", err.message);
    return { synced: syncedIds.length, pending: offline.getUnsyncedOrders().length, error: err.message };
  } finally {
    offlineSyncRunning = false;
  }
}

async function connectToMongo(app) {
  if (mongoConnectPromise) {
    return mongoConnectPromise;
  }

  mongoConnectPromise = (async () => {
    try {
      await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      console.log("MongoDB Connected (SRV)");
      await syncOfflineOrdersToMongo(app);
    } catch (srvErr) {
      console.log("SRV connection failed, trying direct connection...", srvErr.message);
      try {
        await mongoose.connect(DIRECT_MONGO_URI, { serverSelectionTimeoutMS: 10000 });
        console.log("MongoDB Connected (Direct Replica Set)");
        await syncOfflineOrdersToMongo(app);
      } catch (directErr) {
        console.log("Replica set connection failed, trying single node...", directErr.message);
        try {
          await mongoose.connect(SINGLE_NODE_URI, { serverSelectionTimeoutMS: 10000 });
          console.log("MongoDB Connected (Single Node)");
          await syncOfflineOrdersToMongo(app);
        } catch (singleErr) {
          console.log("All MongoDB connections failed:", singleErr.message);
          console.log("Running in offline mode - orders will be stored locally.");
        }
      }
    }
  })();

  return mongoConnectPromise;
}

function createApp() {
  const app = express();
  const server = http.createServer(app);
  const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5000";
  const socketOrigins = [
    process.env.CORS_ORIGIN || "http://localhost:5000",
    "http://localhost:5000",
    "http://127.0.0.1:5000"
  ];
  const io = new Server(server, {
    cors: { origin: socketOrigins }
  });

  app.use(cors({ origin: CORS_ORIGIN }));
  app.set("io", io);

  io.on("connection", (socket) => {
    console.log("Admin connected:", socket.id);
  });

  app.use(express.json());
  app.set("trust proxy", 1);

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Too many login attempts. Try again later." }
  });
  app.use("/auth", loginLimiter, authRoutes);

  const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 100 });
  app.use(globalLimiter);

  mongoose.connection.removeAllListeners("connected");
  mongoose.connection.on("connected", () => {
    syncOfflineOrdersToMongo(app);
  });

  const orderRoutes = require("./routes/orderRoutes");
  app.use("/orders", authMiddleware, orderRoutes);

  app.get("/health", (req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    res.json({ db: dbReady ? "connected" : "disconnected" });
  });

  app.get("/sync/offline/status", authMiddleware, (req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    const pending = offline.getUnsyncedOrders().length;
    res.json({
      db: dbReady ? "connected" : "disconnected",
      pending,
      running: offlineSyncRunning
    });
  });

  app.post("/sync/offline/run", authMiddleware, async (req, res) => {
    const result = await syncOfflineOrdersToMongo(app);
    res.json({
      db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      running: offlineSyncRunning,
      ...result
    });
  });

  app.use(express.static(path.join(__dirname, "admin")));
  app.use("/screenshots", authMiddleware, express.static(runtimePaths.screenshotsDir));

  app.get("/qr", authMiddleware, (req, res) => {
    if (!require("fs").existsSync(runtimePaths.qrFile)) {
      return res.status(404).send("QR not ready yet. Check back in 10 seconds.");
    }

    res.sendFile(runtimePaths.qrFile);
  });

  return { app, server };
}

async function startServer({ port = Number(process.env.PORT) || 5000 } = {}) {
  const { app, server } = createApp();
  await connectToMongo(app);

  await new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Server running on port ${port}`);
      resolve();
    });
  });

  return { app, server, port };
}

module.exports = {
  createApp,
  startServer,
  syncOfflineOrdersToMongo
};

if (require.main === module) {
  startServer().catch((err) => {
    console.error("Server failed to start:", err);
    process.exit(1);
  });
}
