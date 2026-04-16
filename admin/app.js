const API_URL = "http://localhost:5000/orders";
const socket = io("http://localhost:5000");

const MENU_ITEMS = [
  { name: "Don OG", price: 849 },
  { name: "Underboss", price: 849 },
  { name: "The Godfather", price: 899 },
  { name: "Fries", price: 349 },
  { name: "Curly Fries with Sauce", price: 449 },
  { name: "Red Bull", price: 600 },
  { name: "Pepsi", price: 150 },
  { name: "7 Up", price: 150 },
  { name: "Water", price: 100 }
];

const defaultPaymentMethod = "cash";

let cart = {};
let orderCache = [];
let activeReceiptOrder = null;

function getToken() {
  return localStorage.getItem("adminToken") || "";
}

function logout() {
  localStorage.removeItem("adminToken");
  window.location.href = "./login.html";
}

async function authFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${getToken()}`
    }
  });

  if (res.status === 401) {
    localStorage.removeItem("adminToken");
    window.location.href = "./login.html";
  }

  return res;
}

function setActiveNav(targetId) {
  document.querySelectorAll(".nav-links button").forEach(button => {
    const isLogout = button.id === "logoutButton";
    if (isLogout) {
      button.classList.remove("active");
      return;
    }

    button.classList.toggle("active", button.dataset.section === targetId);
  });
}

function bindNavigation() {
  document.querySelectorAll(".nav-links [data-section]").forEach(button => {
    button.addEventListener("click", () => {
      showSection(button.dataset.section);
    });
  });

  const logoutButton = document.getElementById("logoutButton");
  if (logoutButton) {
    logoutButton.addEventListener("click", logout);
  }
}

function showSection(id) {
  document.querySelectorAll(".section").forEach(section => section.classList.remove("active"));

  const target = document.getElementById(id);
  if (!target) {
    console.error(`Section not found: ${id}`);
    return;
  }

  target.classList.add("active");
  setActiveNav(id);

  if (id === "inventory") {
    loadInventory();
  }

  if (id === "notifier") {
    loadQrCode();
  }
}

function timeAgo(date) {
  const diff = Math.floor((new Date() - new Date(date)) / 60000);

  if (diff < 1) return "Just now";
  if (diff < 60) return `${diff} min ago`;

  const hours = Math.floor(diff / 60);
  return `${hours} hr ago`;
}

function formatMoney(amount) {
  return `Rs ${Number(amount || 0).toLocaleString("en-PK")}`;
}

function formatDateTime(date) {
  return new Date(date).toLocaleString("en-PK", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function renderMenu() {
  const menuList = document.getElementById("menuList");
  if (!menuList) {
    return;
  }

  menuList.innerHTML = MENU_ITEMS.map(item => `
    <div class="menu-item">
      <span>${item.name} - ${formatMoney(item.price)}</span>
      <div class="controls">
        <button onclick="changeQty('${item.name}', ${item.price}, -1)">-</button>
        <span id="qty-${item.name}">0</span>
        <button onclick="changeQty('${item.name}', ${item.price}, 1)">+</button>
      </div>
    </div>
  `).join("");
}

function clearUI() {
  const confirmed = document.getElementById("confirmed");
  const preparing = document.getElementById("preparing");
  const ready = document.getElementById("ready");

  if (confirmed) confirmed.innerHTML = "<h2>Pending</h2>";
  if (preparing) preparing.innerHTML = "<h2>Preparing</h2>";
  if (ready) ready.innerHTML = "<h2>Ready</h2>";
}

function getOrderById(id) {
  return orderCache.find(order => order._id === id);
}

function addOrder(order) {
  if (order.status === "completed") {
    return;
  }

  const column = document.getElementById(order.status);
  if (!column) {
    return;
  }

  const div = document.createElement("div");
  div.className = `order-card ${order.status} ${order.paymentStatus !== "paid" ? "unpaid" : ""}`;
  div.id = order._id;

  const paymentAction = order.status === "confirmed" && order.paymentStatus !== "paid"
    ? `<button class="paid-btn" onclick="markPaid('${order._id}')">Mark Paid</button>`
    : `<span class="paid-label">${order.paymentStatus === "paid" ? "PAID" : "PENDING PAYMENT"}</span>`;

  const statusAction = order.status === "confirmed" && order.paymentStatus === "paid"
    ? `<button class="prepare-btn" onclick="markPreparing('${order._id}')">Start</button>`
    : order.status === "preparing"
      ? `<button class="ready-btn" onclick="markReady('${order._id}')">Ready</button>`
      : order.status === "ready"
        ? `<button class="deliver-btn" onclick="markDelivered('${order._id}')">Done</button>`
        : "";

  div.innerHTML = `
    <div class="order-header">
      <h3>#${order.orderId}</h3>
      <span class="time">${timeAgo(order.createdAt)}</span>
    </div>
    <div class="order-items">
      ${order.phone && order.phone !== "Walk-in" ? `<p>Customer: ${order.phone}</p>` : ""}
      ${order.items.map(item => `<p>${item.qty}x ${item.name}</p>`).join("")}
    </div>
    <div class="order-footer">
      <span class="total">${formatMoney(order.total)}</span>
      ${paymentAction}
    </div>
    <div class="actions">
      ${statusAction}
      <button class="receipt-btn" onclick="printReceipt('${order._id}')">Print Receipt</button>
    </div>
  `;

  column.prepend(div);
}

function renderCompleted() {
  const container = document.getElementById("completedList");
  if (!container) {
    return;
  }

  const completedOrders = orderCache.filter(order => order.status === "completed");

  if (completedOrders.length === 0) {
    container.innerHTML = "<p class='helper-text'>No completed orders yet.</p>";
    return;
  }

  container.innerHTML = completedOrders.map(order => `
    <div class="order-card ready">
      <div class="order-header">
        <h3>#${order.orderId}</h3>
        <span class="time">${formatDateTime(order.createdAt)}</span>
      </div>
      <div class="order-items">
        ${order.phone && order.phone !== "Walk-in" ? `<p>Customer: ${order.phone}</p>` : ""}
        ${order.items.map(item => `<p>${item.qty}x ${item.name}</p>`).join("")}
      </div>
      <div class="order-footer">
        <span class="total">${formatMoney(order.total)}</span>
        <span class="paid-label">PAID</span>
      </div>
      <div class="actions">
        <button class="receipt-btn" onclick="printReceipt('${order._id}')">Print Receipt</button>
      </div>
    </div>
  `).join("");
}

async function loadOrders() {
  try {
    const res = await authFetch(API_URL);
    if (!res.ok) {
      throw new Error(`Failed to load orders (${res.status})`);
    }

    orderCache = await res.json();
    clearUI();
    orderCache.forEach(addOrder);
    renderCompleted();
  } catch (err) {
    console.error("loadOrders failed", err);
  }
}

async function postOrderAction(path, actionName) {
  try {
    const res = await authFetch(path, { method: "POST" });
    if (!res.ok) {
      throw new Error(`${actionName} failed (${res.status})`);
    }

    await Promise.all([loadOrders(), loadInventory()]);
  } catch (err) {
    console.error(`${actionName} failed`, err);
    alert(`Failed to ${actionName.toLowerCase()}. Please try again.`);
  }
}

async function markPreparing(id) {
  await postOrderAction(`${API_URL}/${id}/preparing`, "Mark Preparing");
}

async function markReady(id) {
  await postOrderAction(`${API_URL}/${id}/ready`, "Mark Ready");
}

async function markDelivered(id) {
  await postOrderAction(`${API_URL}/${id}/delivered`, "Mark Delivered");
}

async function markPaid(id) {
  await postOrderAction(`${API_URL}/${id}/markPaid`, "Mark Paid");
}

function updateItemQtyLabel(name, qty) {
  const qtyEl = document.getElementById(`qty-${name}`);
  if (qtyEl) {
    qtyEl.textContent = String(qty);
  }
}

function renderOrderSummary() {
  const orderSummary = document.getElementById("orderSummary");
  const totalEl = document.getElementById("total");
  if (!orderSummary || !totalEl) {
    return;
  }

  const items = Object.values(cart).filter(item => item.qty > 0);
  const total = items.reduce((sum, item) => sum + (item.price * item.qty), 0);

  if (items.length === 0) {
    orderSummary.innerHTML = "<p>No items selected</p>";
  } else {
    orderSummary.innerHTML = items.map(item => `
      <p>${item.qty}x ${item.name} - ${formatMoney(item.qty * item.price)}</p>
    `).join("");
  }

  totalEl.textContent = total.toLocaleString("en-PK");
}

function changeQty(name, price, delta) {
  const current = cart[name]?.qty || 0;
  const next = Math.max(0, current + delta);

  if (next === 0) {
    delete cart[name];
  } else {
    cart[name] = { name, qty: next, price };
  }

  updateItemQtyLabel(name, next);
  renderOrderSummary();
}

function resetCartUI() {
  Object.keys(cart).forEach(name => updateItemQtyLabel(name, 0));
  cart = {};
  renderOrderSummary();
}

function setReceiptControlsDisabled(disabled) {
  const printButton = document.getElementById("printReceiptButton");
  const newOrderButton = document.getElementById("newOrderButton");

  if (printButton) {
    printButton.disabled = disabled;
  }

  if (newOrderButton) {
    newOrderButton.disabled = disabled;
  }
}

function clearReceiptPreview() {
  activeReceiptOrder = null;

  const frame = document.getElementById("receiptPreviewFrame");
  const receiptStatus = document.getElementById("receiptStatus");

  if (frame) {
    frame.srcdoc = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: #f7efe1;
            color: #6a5444;
            font-family: Arial, sans-serif;
          }
        </style>
      </head>
      <body>No receipt selected.</body>
      </html>
    `;
  }

  if (receiptStatus) {
    receiptStatus.textContent = "Create an order to review and print the receipt here.";
  }

  setReceiptControlsDisabled(true);
}

function renderInventory(inventory) {
  const inventoryPatties = document.getElementById("inventoryPatties");
  const inventoryBuns = document.getElementById("inventoryBuns");
  const inventoryPattiesInput = document.getElementById("inventoryPattiesInput");
  const inventoryBunsInput = document.getElementById("inventoryBunsInput");
  const posPatties = document.getElementById("posPatties");
  const posBuns = document.getElementById("posBuns");
  const updatedAt = document.getElementById("inventoryUpdatedAt");

  if (inventoryPatties) inventoryPatties.textContent = String(inventory.patties);
  if (inventoryBuns) inventoryBuns.textContent = String(inventory.buns);
  if (inventoryPattiesInput) inventoryPattiesInput.value = String(inventory.patties);
  if (inventoryBunsInput) inventoryBunsInput.value = String(inventory.buns);
  if (posPatties) posPatties.textContent = String(inventory.patties);
  if (posBuns) posBuns.textContent = String(inventory.buns);
  if (updatedAt) updatedAt.textContent = `Last updated: ${formatDateTime(inventory.updatedAt || new Date())}`;
}

async function loadInventory() {
  try {
    const res = await authFetch(`${API_URL}/inventory`);
    if (!res.ok) {
      throw new Error(`Failed to load inventory (${res.status})`);
    }

    const inventory = await res.json();
    renderInventory(inventory);

    const inventoryStatus = document.getElementById("inventoryStatus");
    if (inventoryStatus) {
      inventoryStatus.textContent = "";
    }
  } catch (err) {
    console.error("loadInventory failed", err);
    const inventoryStatus = document.getElementById("inventoryStatus");
    if (inventoryStatus) {
      inventoryStatus.textContent = "Could not load inventory.";
    }
  }
}

async function saveInventory() {
  const patties = Number(document.getElementById("inventoryPattiesInput")?.value);
  const buns = Number(document.getElementById("inventoryBunsInput")?.value);

  try {
    const res = await authFetch(`${API_URL}/inventory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patties, buns })
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Failed to save inventory.");
    }

    const inventory = await res.json();
    renderInventory(inventory);

    const inventoryStatus = document.getElementById("inventoryStatus");
    if (inventoryStatus) {
      inventoryStatus.textContent = "Inventory updated.";
    }
  } catch (err) {
    console.error("saveInventory failed", err);
    const inventoryStatus = document.getElementById("inventoryStatus");
    if (inventoryStatus) {
      inventoryStatus.textContent = err.message || "Failed to save inventory.";
    }
  }
}

async function loadQrCode() {
  const qrImage = document.getElementById("qrImage");
  const qrStatus = document.getElementById("qrStatus");

  if (!qrImage || !qrStatus) {
    return;
  }

  qrStatus.textContent = "Loading QR...";
  qrImage.style.display = "none";

  try {
    const res = await authFetch("http://localhost:5000/qr", {
      headers: { Accept: "image/png" }
    });

    if (res.status === 404) {
      qrStatus.textContent = "QR not ready yet. Start the notifier and refresh in a few seconds.";
      return;
    }

    if (!res.ok) {
      throw new Error(`Failed to load QR (${res.status})`);
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    qrImage.src = objectUrl;
    qrImage.style.display = "block";
    qrStatus.textContent = "Scan this QR with the business WhatsApp account.";
  } catch (err) {
    console.error("loadQrCode failed", err);
    qrStatus.textContent = "Could not load QR. Make sure the server and notifier are both running.";
  }
}

function buildReceiptHtml(order) {
  const buildReceiptCopy = (copyLabel) => `
    <section class="receipt copy-block">
      <div class="masthead">
        <span class="eyebrow">${copyLabel}</span>
        <h1>Cartel Burgers</h1>
        <p class="subtitle">POS Receipt</p>
      </div>
      <div class="receipt-body">
        <div class="section-title">Order Details</div>
        <div class="meta-grid">
          <div class="meta-card">
            <p class="label">Receipt</p>
            <p>#${order.orderId}</p>
          </div>
          <div class="meta-card">
            <p class="label">Payment</p>
            <p>${(order.paymentMethod || defaultPaymentMethod).toUpperCase()}</p>
          </div>
          <div class="meta-card">
            <p class="label">Date</p>
            <p>${formatDateTime(order.createdAt)}</p>
          </div>
          <div class="meta-card">
            <p class="label">Customer</p>
            <p>${order.phone || "Walk-in"}</p>
          </div>
        </div>
        <div class="items">
          <div class="section-title">Items</div>
          ${order.items.map(item => `
            <div class="item">
              <span><span class="item-qty">${item.qty}x</span><span class="item-name">${item.name}</span></span>
              <span class="item-price">${formatMoney(item.qty * item.price)}</span>
            </div>
          `).join("")}
        </div>
        <div class="totals">
          <p class="label">Final Total</p>
          <div class="item">
            <strong>Total</strong>
            <strong class="grand-total">${formatMoney(order.total)}</strong>
          </div>
        </div>
        <div class="footer-note">Fresh. Loud. Served at the window.</div>
      </div>
    </section>
  `;

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Receipt #${order.orderId}</title>
      <style>
        :root {
          --paper: #fbf5ea;
          --ink: #23120f;
          --muted: #7c665a;
          --brand: #5b001e;
          --brand-deep: #2e0011;
          --gold: #d4a017;
          --gold-soft: #edd48a;
          --line: rgba(91, 0, 30, 0.18);
        }

        * {
          box-sizing: border-box;
        }

        body {
          font-family: Georgia, "Times New Roman", serif;
          background:
            radial-gradient(circle at top, rgba(212, 160, 23, 0.14), transparent 32%),
            linear-gradient(180deg, #efe2c4 0%, #f7efe1 100%);
          color: var(--ink);
          margin: 0;
          padding: 24px;
        }

        .receipt-stack {
          max-width: 360px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }

        .receipt {
          background:
            linear-gradient(180deg, rgba(255,255,255,0.4), transparent 120px),
            var(--paper);
          border: 1px solid rgba(91, 0, 30, 0.24);
          border-radius: 20px;
          overflow: hidden;
          box-shadow: 0 18px 40px rgba(35, 18, 15, 0.18);
          break-inside: avoid;
        }

        h1,
        h2,
        p {
          margin: 0;
        }

        .masthead {
          background: linear-gradient(135deg, var(--brand-deep), var(--brand));
          color: #f8ecd1;
          padding: 22px 24px 18px;
          position: relative;
        }

        .masthead::after {
          content: "";
          position: absolute;
          left: 24px;
          right: 24px;
          bottom: 0;
          height: 3px;
          background: linear-gradient(90deg, transparent, var(--gold), transparent);
        }

        .eyebrow {
          display: inline-block;
          font-family: Arial, sans-serif;
          font-size: 10px;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: var(--gold-soft);
          margin-bottom: 8px;
        }

        h1 {
          font-size: 26px;
          line-height: 1;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
        }

        .subtitle {
          font-family: Arial, sans-serif;
          font-size: 11px;
          letter-spacing: 1.6px;
          text-transform: uppercase;
          color: rgba(248, 236, 209, 0.82);
        }

        .receipt-body {
          padding: 20px 24px 24px;
        }

        .section-title {
          font-family: Arial, sans-serif;
          font-size: 10px;
          letter-spacing: 1.8px;
          text-transform: uppercase;
          color: var(--muted);
          margin-bottom: 10px;
        }

        .totals {
          margin-top: 16px;
          padding-top: 12px;
          border-top: 1px dashed rgba(91, 0, 30, 0.3);
          position: relative;
        }

        .meta-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px 14px;
        }

        .meta-card {
          background: rgba(255, 255, 255, 0.5);
          border: 1px solid var(--line);
          border-radius: 12px;
          padding: 10px 12px;
        }

        .meta-card p:last-child {
          margin-top: 4px;
          font-family: Arial, sans-serif;
          font-size: 13px;
          font-weight: 700;
          color: var(--ink);
          word-break: break-word;
        }

        .items {
          margin-top: 18px;
          padding: 14px 0 2px;
          border-top: 1px solid var(--line);
          border-bottom: 1px solid var(--line);
        }

        .item {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          margin-top: 10px;
          font-size: 14px;
        }

        .label {
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 1px;
          font-size: 11px;
          margin-bottom: 6px;
        }

        .item-name {
          font-weight: 700;
        }

        .item-qty {
          display: inline-block;
          min-width: 34px;
          margin-right: 8px;
          color: var(--brand);
          font-family: Arial, sans-serif;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.4px;
        }

        .item-price {
          font-family: Arial, sans-serif;
          font-weight: 700;
          white-space: nowrap;
        }

        .totals::before {
          content: "PAID";
          position: absolute;
          top: 10px;
          right: 0;
          border: 1px solid rgba(34, 120, 74, 0.35);
          color: #1f6b47;
          background: rgba(34, 197, 94, 0.08);
          border-radius: 999px;
          padding: 4px 10px;
          font-family: Arial, sans-serif;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 1.2px;
        }

        .grand-total {
          font-size: 18px;
          color: var(--brand);
        }

        .footer-note {
          margin-top: 18px;
          padding-top: 12px;
          border-top: 1px dashed rgba(91, 0, 30, 0.22);
          text-align: center;
          font-family: Arial, sans-serif;
          font-size: 11px;
          letter-spacing: 1px;
          text-transform: uppercase;
          color: var(--muted);
        }

        @media print {
          body {
            background: white;
            padding: 0;
          }

          .receipt-stack {
            gap: 12px;
          }

          .receipt {
            box-shadow: none;
            border-radius: 0;
          }
        }
      </style>
    </head>
    <body>
      <main class="receipt-stack">
        ${buildReceiptCopy("Cartel Counter Copy")}
        ${buildReceiptCopy("Customer Copy")}
      </main>
    </body>
    </html>
  `;
}

function renderReceiptPreview(order) {
  if (!order) {
    alert("Receipt data is not available for this order.");
    return;
  }

  activeReceiptOrder = order;

  const frame = document.getElementById("receiptPreviewFrame");
  const receiptStatus = document.getElementById("receiptStatus");

  if (frame) {
    frame.srcdoc = buildReceiptHtml(order);
  }

  if (receiptStatus) {
    receiptStatus.textContent = `Receipt #${order.orderId} is ready. Review it below and print when payment is complete.`;
  }

  setReceiptControlsDisabled(false);
}

function printReceipt(id) {
  showSection("takeOrder");
  renderReceiptPreview(getOrderById(id));
}

function printCurrentReceipt() {
  const frame = document.getElementById("receiptPreviewFrame");

  if (!activeReceiptOrder || !frame?.contentWindow) {
    alert("No receipt is ready to print.");
    return;
  }

  frame.contentWindow.focus();
  frame.contentWindow.print();
}

function startNextOrder() {
  clearReceiptPreview();
  const phoneInput = document.getElementById("customerPhone");
  if (phoneInput) {
    phoneInput.focus();
  }
}

async function submitOrder() {
  const items = Object.values(cart).filter(item => item.qty > 0);
  if (items.length === 0) {
    alert("Please add at least one item.");
    return;
  }

  const createBtn = document.getElementById("createOrderButton");
  const phoneInput = document.getElementById("customerPhone");
  const phone = phoneInput ? phoneInput.value.trim() : "";

  if (!phone) {
    alert("Customer WhatsApp number is required.");
    if (phoneInput) {
      phoneInput.focus();
    }
    return;
  }

  try {
    if (createBtn) {
      createBtn.disabled = true;
    }

    const res = await authFetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone,
        items: items.map(item => ({ name: item.name, qty: item.qty })),
        paymentMethod: defaultPaymentMethod
      })
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Failed to create order.");
    }

    const order = await res.json();
    resetCartUI();

    if (phoneInput) {
      phoneInput.value = "";
    }

    await Promise.all([loadOrders(), loadInventory()]);
    renderReceiptPreview(order);
    showSection("takeOrder");
  } catch (err) {
    console.error("submitOrder failed", err);
    alert(err.message || "Could not create order.");
  } finally {
    if (createBtn) {
      createBtn.disabled = false;
    }
  }
}

socket.on("new_order", async () => {
  await Promise.all([loadOrders(), loadInventory()]);
});

socket.on("order_updated", async () => {
  await Promise.all([loadOrders(), loadInventory()]);
});

bindNavigation();
renderMenu();
renderOrderSummary();
clearReceiptPreview();
loadOrders();
loadInventory();
setActiveNav("dashboard");
