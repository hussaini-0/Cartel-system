require("dotenv").config();

// ✅ ENV VALIDATION
["MONGO_URI", "ADMIN_PASSWORD", "JWT_SECRET"].forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
});

const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const authMiddleware = require("./middleware/auth");
const authRoutes = require("./routes/authRoutes");

const app = express();
const server = http.createServer(app);

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5000";

const socketOrigins = [
  process.env.CORS_ORIGIN || "http://localhost:5000",
  "http://localhost:5000",
];
const io = new Server(server, {
  cors: { origin: socketOrigins },
});

app.use(cors({ origin: CORS_ORIGIN }));

app.set("io", io);


io.on("connection", (socket) => {
  console.log("Admin connected:", socket.id);
});

app.use(express.json());
app.set("trust proxy", 1);

// 🔐 LOGIN — strict rate limit (10 attempts / 15 min)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts. Try again later." }
});
app.use("/auth", loginLimiter, authRoutes);

// 🛡️ GLOBAL rate limit (100 req / min)
const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 100 });
app.use(globalLimiter);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log(err));

// routes
const orderRoutes = require("./routes/orderRoutes");
app.use("/orders", authMiddleware, orderRoutes);

// 🌐 SERVE ADMIN PANEL
app.use(express.static(path.join(__dirname, "admin")));

// 📸 SERVE SCREENSHOTS
app.use("/screenshots", authMiddleware, express.static(path.join(__dirname, "screenshots")));

// 📷 VIEW QR CODE (for WhatsApp notifications login)
app.get("/qr", authMiddleware, (req, res) => {
  const qrPath = path.join(__dirname, "qr.png");
  if (!require("fs").existsSync(qrPath)) {
    return res.status(404).send("QR not ready yet. Check back in 10 seconds.");
  }
  res.sendFile(qrPath);
});

// ⚠️ IMPORTANT: use server.listen (not app.listen)
server.listen(5000, () => {
  console.log("Server running on port 5000");
});