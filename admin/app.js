const API_URL = `${window.location.origin}/orders`;
const MENU_API_URL = `${API_URL}/menu`;
const socket = io(window.location.origin);

let MENU_ITEMS = [
    { name: "Don OG (Single Patty)", key: "don og (single)", price: 849 },
    { name: "Don OG (Double Patty)", key: "don og (double)", price: 1099 },
    { name: "Underboss (Single Patty)", key: "underboss (single)", price: 849 },
    { name: "Underboss (Double Patty)", key: "underboss (double)", price: 1099 },
    { name: "The Godfather (Single Patty)", key: "the godfather (single)", price: 899 },
    { name: "The Godfather (Double Patty)", key: "the godfather (double)", price: 1199 },
    { name: "Curly Fries", key: "fries", price: 349 },
    { name: "Curly Fries with Sauce", key: "curly fries with sauce", price: 449 },
    { name: "Lychee Heist", key: "lychee", price: 400 },
    { name: "Blueberry Boost", key: "blueberry", price: 400 },
    { name: "Peach Vendetta", key: "peach", price: 400 },
    { name: "Mango Mirage", key: "mango", price: 400 },
    { name: "Sunset Cartel (Peach Mango)", key: "peach mango", price: 500 },
    { name: "Blueberry Boost (Special)", key: "blueberry redbull", price: 900 },
    { name: "Red Bull", key: "red bull", price: 600 },
    { name: "Pepsi", key: "pepsi", price: 150 },
    { name: "7 Up", key: "7 up", price: 150 },
    { name: "Water", key: "water", price: 100 }
];

let BURGER_FAMILIES = [
  {
    title: "Don OG",
    items: ["don og (single)", "don og (double)"]
  },
  {
    title: "Underboss",
    items: ["underboss (single)", "underboss (double)"]
  },
  {
    title: "The Godfather",
    items: ["the godfather (single)", "the godfather (double)"]
  }
];

let SIGNATURE_DRINK_KEYS = ["lychee", "blueberry", "peach", "mango"];
let SPECIAL_KEYS = ["peach mango", "blueberry redbull"];
let FRIES_KEYS = ["fries", "curly fries with sauce"];
let DRINK_KEYS = ["red bull", "pepsi", "7 up", "water"];

let MENU_ITEM_INDEX = Object.fromEntries(MENU_ITEMS.map(item => [item.key, item]));
let COMBO_DRINK_KEYS = new Set(["lychee", "blueberry", "peach", "mango"]);
let BURGER_KEYS = new Set([
  "don og (single)",
  "don og (double)",
  "underboss (single)",
  "underboss (double)",
  "the godfather (single)",
  "the godfather (double)",
  "don og",
  "underboss",
  "the godfather",
  "godfather",
  "god father"
]);

const defaultPaymentMethod = "cash";

let cart = {};
let orderCache = [];
let activeReceiptOrder = null;
let followUpSearchTerm = "";
let selectedPaymentMethod = "cash";
let usingCachedData = false;
let lastDbOnline = null;
let selectedRevenueRange = "today";
let selectedRevenueDate = getLocalDateInputValue(new Date());
let selectedOrderFilter = "all";
let selectedOrderIds = new Set();
let bulkActionRunning = false;
let selectedCompletedRange = "today";
let selectedCompletedDate = getLocalDateInputValue(new Date());
let selectedInventoryRange = "today";
let selectedInventoryDate = getLocalDateInputValue(new Date());
let editingMenuKey = "";

function rebuildMenuIndexes(items) {
  MENU_ITEMS = Array.isArray(items) ? items : MENU_ITEMS;
  MENU_ITEM_INDEX = Object.fromEntries(MENU_ITEMS.map(item => [item.key, item]));
  SIGNATURE_DRINK_KEYS = MENU_ITEMS.filter(item => item.category === "signature").map(item => item.key);
  SPECIAL_KEYS = MENU_ITEMS.filter(item => item.category === "specials").map(item => item.key);
  FRIES_KEYS = MENU_ITEMS.filter(item => item.category === "fries").map(item => item.key);
  DRINK_KEYS = MENU_ITEMS.filter(item => item.category === "drinks").map(item => item.key);
  BURGER_KEYS = new Set(MENU_ITEMS
    .filter(item => item.category === "burgers" || Number(item.inventory?.patties) > 0)
    .map(item => item.key));
  COMBO_DRINK_KEYS = new Set(MENU_ITEMS
    .filter(item => item.comboDrink || item.category === "signature")
    .map(item => item.key));

  const burgerItems = MENU_ITEMS.filter(item => BURGER_KEYS.has(item.key));
  const familyMap = new Map();
  burgerItems.forEach(item => {
    const title = item.name
      .replace(/\s*\((single|double)\s*patty\)\s*/i, "")
      .replace(/\s*-\s*(single|double)\s*patty\s*/i, "")
      .trim();
    if (!familyMap.has(title)) familyMap.set(title, { title, items: [] });
    familyMap.get(title).items.push(item.key);
  });
  BURGER_FAMILIES = Array.from(familyMap.values());
}

// ── LOCAL STORAGE HELPERS ────────────────────────────────
const LS_ORDERS_KEY = "cartel_orderCache";
const LS_QUEUE_KEY = "cartel_offlineQueue";

function saveOrdersToLocal(orders) {
  try {
    localStorage.setItem(LS_ORDERS_KEY, JSON.stringify(orders));
  } catch { /* localStorage full or blocked — ignore */ }
}

function loadOrdersFromLocal() {
  try {
    const raw = localStorage.getItem(LS_ORDERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function getOfflineQueue() {
  try {
    const raw = localStorage.getItem(LS_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveOfflineQueue(queue) {
  try {
    localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(queue));
  } catch { /* ignore */ }
}

function addToOfflineQueue(orderPayload) {
  const queue = getOfflineQueue();
  const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const localOrder = {
    _id: tempId,
    orderId: "PENDING",
    customerName: orderPayload.customerName,
    phone: orderPayload.phone || "Walk-in",
    items: orderPayload.items.map(item => {
      const menuItem = MENU_ITEM_INDEX[item.name];
      return { name: item.name, qty: item.qty, price: menuItem ? menuItem.price : 0 };
    }),
    total: calculateVisiblePricing(orderPayload.items.map(item => {
      const menuItem = MENU_ITEM_INDEX[item.name];
      return { name: item.name, qty: item.qty, price: menuItem ? menuItem.price : 0 };
    })).total,
    paymentMethod: orderPayload.paymentMethod || "cash",
    status: "preparing",
    paymentStatus: "paid",
    createdAt: new Date().toISOString(),
    _offline: true,
    _payload: orderPayload
  };
  queue.push(localOrder);
  saveOfflineQueue(queue);
  return localOrder;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

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

  document.querySelectorAll(".pay-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pay-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      selectedPaymentMethod = btn.dataset.method;
    });
  });
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

  if (id === "menuManager") {
    loadMenu();
  }

  if (id === "revenue") {
    loadRevenue();
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

function getLocalDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getYesterdayDateInputValue() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return getLocalDateInputValue(date);
}

function getMenuItemLabel(name) {
  return MENU_ITEM_INDEX[name]?.name || String(name || "");
}

function calculateVisiblePricing(items) {
  const subtotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0);

  const burgerQty = items.reduce((sum, item) => {
    return sum + (BURGER_KEYS.has(item.name) ? item.qty : 0);
  }, 0);

  const comboDrinkQty = items.reduce((sum, item) => {
    return sum + (COMBO_DRINK_KEYS.has(item.name) ? item.qty : 0);
  }, 0);

  const burgerDealQty = Math.min(burgerQty, comboDrinkQty);
  const remainingComboDrinkQty = comboDrinkQty - burgerDealQty;
  const trioDealCount = Math.floor(remainingComboDrinkQty / 3);
  const discount = (burgerDealQty * 100) + (trioDealCount * 200);

  return {
    subtotal,
    discount,
    total: subtotal - discount
  };
}

function renderMenu() {
  const savoryMenu = document.getElementById("menuSavory");
  const drinksMenu = document.getElementById("menuDrinks");
  if (!savoryMenu || !drinksMenu) {
    return;
  }

  const renderControls = (item) => `
    <div class="controls">
      <button onclick="changeQty('${item.key}', ${item.price}, -1)">-</button>
      <span id="qty-${item.key}">0</span>
      <button onclick="changeQty('${item.key}', ${item.price}, 1)">+</button>
    </div>
  `;

  const renderMenuRow = (key, compactLabel) => {
    const item = MENU_ITEM_INDEX[key];
    if (!item) {
      return "";
    }

    return `
      <div class="menu-item">
        <span>${escapeHtml(compactLabel || item.name)} - ${formatMoney(item.price)}</span>
        ${renderControls(item)}
      </div>
    `;
  };

  const renderBurgerFamily = (family) => `
    <div class="menu-family">
      <div class="menu-family-title">${escapeHtml(family.title)}</div>
      ${family.items.map(key => {
        const item = MENU_ITEM_INDEX[key];
        if (!item) return "";
        const patties = Number(item.inventory?.patties) || 0;
        const variantLabel = item.name.includes("Double")
          ? "Double Patty"
          : item.name.includes("Single")
            ? "Single Patty"
            : (patties > 0 ? `${patties} patty${patties === 1 ? "" : "ies"}` : item.name);
        return `
          <div class="menu-variant">
            <div class="menu-line">
              <span>${escapeHtml(variantLabel)}</span>
              <strong>${formatMoney(item.price)}</strong>
            </div>
            ${renderControls(item)}
          </div>
        `;
      }).join("")}
    </div>
  `;

  const renderSection = (title, content, note = "") => `
    <section class="menu-section">
      <div class="menu-section-header">
        <h4>${title}</h4>
        ${note ? `<p class="menu-note">${note}</p>` : ""}
      </div>
      ${content}
    </section>
  `;

  savoryMenu.innerHTML = [
    renderSection(
      "Burgers",
      `<div class="menu-family-grid">${BURGER_FAMILIES.map(renderBurgerFamily).join("")}</div>`
    ),
    renderSection(
      "Curly Fries",
      FRIES_KEYS.map(key => renderMenuRow(key)).join("")
    )
  ].join("");

  drinksMenu.innerHTML = [
    renderSection(
      "Signature Drinks",
      SIGNATURE_DRINK_KEYS.map(key => renderMenuRow(key)).join(""),
      "Any 3 for Rs 1,000. Any signature drink with a burger for Rs 300."
    ),
    renderSection(
      "Specials",
      SPECIAL_KEYS.map(key => renderMenuRow(key)).join("")
    ),
    renderSection(
      "Drinks",
      DRINK_KEYS.map(key => renderMenuRow(key)).join("")
    )
  ].join("");
}

function renderMenuManager() {
  const list = document.getElementById("menuManagerList");
  if (!list) return;

  if (MENU_ITEMS.length === 0) {
    list.innerHTML = "<p class=\"helper-text\">No menu items yet.</p>";
    return;
  }

  list.innerHTML = MENU_ITEMS.map(item => `
    <div class="menu-manager-item ${editingMenuKey === item.key ? "editing" : ""}">
      <div class="menu-manager-info">
        <span class="menu-manager-category">${escapeHtml(item.category || "menu")}</span>
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.key)}</small>
      </div>
      <span class="menu-manager-price">${formatMoney(item.price)}</span>
      <div class="menu-manager-actions">
        <button type="button" class="mark-all-btn" onclick="editMenuItem('${encodeURIComponent(item.key)}')">Edit</button>
        <button type="button" class="delete-btn" onclick="deleteMenuItem('${encodeURIComponent(item.key)}')">Remove</button>
      </div>
    </div>
  `).join("");
}

function setMenuFormMode(item = null) {
  const title = document.getElementById("menuFormTitle");
  const saveButton = document.getElementById("menuSaveButton");
  const cancelButton = document.getElementById("menuCancelEditButton");
  const status = document.getElementById("menuManagerStatus");

  editingMenuKey = item?.key || "";

  if (title) title.textContent = item ? "Edit Menu Item" : "Add Menu Item";
  if (saveButton) saveButton.textContent = item ? "Update Item" : "Save Item";
  if (cancelButton) cancelButton.hidden = !item;
  if (status) status.textContent = item ? `Editing ${item.name}.` : "";
  renderMenuManager();
}

function resetMenuForm(message = "") {
  const nameInput = document.getElementById("menuItemName");
  const priceInput = document.getElementById("menuItemPrice");
  const categoryInput = document.getElementById("menuItemCategory");
  const pattiesInput = document.getElementById("menuItemPatties");
  const bunsInput = document.getElementById("menuItemBuns");
  const comboInput = document.getElementById("menuItemComboDrink");
  const status = document.getElementById("menuManagerStatus");

  if (nameInput) nameInput.value = "";
  if (priceInput) priceInput.value = "";
  if (categoryInput) categoryInput.value = "burgers";
  if (pattiesInput) pattiesInput.value = "0";
  if (bunsInput) bunsInput.value = "0";
  if (comboInput) comboInput.checked = false;
  setMenuFormMode(null);
  if (status) status.textContent = message;
}

function editMenuItem(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  const item = MENU_ITEM_INDEX[key];
  if (!item) return;

  const nameInput = document.getElementById("menuItemName");
  const priceInput = document.getElementById("menuItemPrice");
  const categoryInput = document.getElementById("menuItemCategory");
  const pattiesInput = document.getElementById("menuItemPatties");
  const bunsInput = document.getElementById("menuItemBuns");
  const comboInput = document.getElementById("menuItemComboDrink");

  if (nameInput) nameInput.value = item.name || "";
  if (priceInput) priceInput.value = String(item.price ?? "");
  if (categoryInput) categoryInput.value = item.category || "drinks";
  if (pattiesInput) pattiesInput.value = String(item.inventory?.patties || 0);
  if (bunsInput) bunsInput.value = String(item.inventory?.buns || 0);
  if (comboInput) comboInput.checked = Boolean(item.comboDrink);

  setMenuFormMode(item);
  if (nameInput) nameInput.focus();
}

function cancelMenuEdit() {
  resetMenuForm("");
}

function applyMenuItems(items) {
  rebuildMenuIndexes(items);
  cart = Object.fromEntries(Object.entries(cart).filter(([key]) => MENU_ITEM_INDEX[key]));
  renderMenu();
  renderMenuManager();
  renderOrderSummary();
}

async function loadMenu() {
  try {
    const res = await authFetch(MENU_API_URL);
    if (!res.ok) throw new Error(`Failed to load menu (${res.status})`);
    const data = await res.json();
    applyMenuItems(data.items || []);
    if (editingMenuKey === key) {
      resetMenuForm("");
    }
  } catch (err) {
    console.error("loadMenu failed", err);
    renderMenu();
    renderMenuManager();
  }
}

async function saveMenuItem() {
  const status = document.getElementById("menuManagerStatus");
  const nameInput = document.getElementById("menuItemName");
  const priceInput = document.getElementById("menuItemPrice");
  const categoryInput = document.getElementById("menuItemCategory");
  const pattiesInput = document.getElementById("menuItemPatties");
  const bunsInput = document.getElementById("menuItemBuns");
  const comboInput = document.getElementById("menuItemComboDrink");

  const payload = {
    key: editingMenuKey || undefined,
    name: nameInput?.value.trim(),
    price: Number(priceInput?.value),
    category: categoryInput?.value || "drinks",
    patties: Number(pattiesInput?.value) || 0,
    buns: Number(bunsInput?.value) || 0,
    comboDrink: Boolean(comboInput?.checked)
  };

  if (!payload.name || !Number.isFinite(payload.price) || payload.price < 0) {
    if (status) status.textContent = "Enter an item name and a valid price.";
    return;
  }

  try {
    const res = await authFetch(MENU_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Failed to save menu item.");
    }

    const data = await res.json();
    applyMenuItems(data.items || []);
    resetMenuForm(editingMenuKey ? "Menu item updated." : "Menu item saved.");
  } catch (err) {
    console.error("saveMenuItem failed", err);
    if (status) status.textContent = err.message || "Could not save menu item.";
  }
}

async function deleteMenuItem(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  const item = MENU_ITEM_INDEX[key];
  if (!item || !confirm(`Remove ${item.name} from the menu?`)) return;

  try {
    const res = await authFetch(`${MENU_API_URL}/${encodeURIComponent(key)}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Failed to remove menu item.");
    }

    const data = await res.json();
    applyMenuItems(data.items || []);
  } catch (err) {
    console.error("deleteMenuItem failed", err);
    alert(err.message || "Could not remove menu item.");
  }
}

function clearUI() {
  const preparing = document.getElementById("preparing");
  const ready = document.getElementById("ready");

  if (preparing) preparing.innerHTML = '<div class="column-header"><h2>Notify Customer <span class="col-count" id="countPreparing"></span></h2><button class="mark-all-btn" onclick="markAllReady()">Mark All Ready</button></div>';
  if (ready) ready.innerHTML = '<div class="column-header"><h2>Ready <span class="col-count" id="countReady"></span></h2><button class="mark-all-btn" onclick="markAllDelivered()">Mark All Delivered</button></div>';
}

function updateColumnCounts() {
  const active = orderCache.filter(o => o.status !== "completed");
  const preparingCount = active.filter(o => o.status === "confirmed" || o.status === "preparing").length;
  const readyCount = active.filter(o => o.status === "ready").length;

  const cp = document.getElementById("countPreparing");
  const cr = document.getElementById("countReady");
  if (cp) cp.textContent = preparingCount > 0 ? `(${preparingCount})` : "";
  if (cr) cr.textContent = readyCount > 0 ? `(${readyCount})` : "";
}

function refreshOrderTimers() {
  document.querySelectorAll(".order-timer[data-created-at]").forEach(el => {
    const created = el.dataset.createdAt;
    const mins = Math.floor((new Date() - new Date(created)) / 60000);
    el.textContent = timeAgo(created);
    const card = el.closest(".order-card");
    if (card) {
      card.classList.toggle("order-urgent", mins >= 15);
    }
  });
}

function matchesFollowUpSearch(order) {
  if (!followUpSearchTerm) {
    return true;
  }

  return String(order.orderId || "").includes(followUpSearchTerm);
}

function renderFollowUpOrders() {
  clearUI();
  orderCache
    .filter(order => order.status !== "completed")
    .filter(matchesOrderFilter)
    .filter(matchesFollowUpSearch)
    .sort(compareDashboardOrders)
    .forEach(addOrder);
  updateColumnCounts();
  updateSelectionUI();
}

function handleFollowUpSearch(value) {
  followUpSearchTerm = String(value || "").trim();
  renderFollowUpOrders();
}

function hasWhatsappNumber(order) {
  return Boolean(order.phone && order.phone !== "Walk-in");
}

function matchesOrderFilter(order) {
  if (selectedOrderFilter === "all") return true;
  if (selectedOrderFilter === "preparing") return order.status === "confirmed" || order.status === "preparing";
  if (selectedOrderFilter === "ready") return order.status === "ready";
  if (selectedOrderFilter === "whatsapp") return hasWhatsappNumber(order);
  if (selectedOrderFilter === "walkin") return !hasWhatsappNumber(order);
  if (selectedOrderFilter === "cash") return (order.paymentMethod || defaultPaymentMethod) === "cash";
  if (selectedOrderFilter === "jazzcash") return order.paymentMethod === "jazzcash";
  return true;
}

function setOrderFilter(filter) {
  selectedOrderFilter = filter;
  document.querySelectorAll(".filter-btn").forEach(button => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
  renderFollowUpOrders();
}

function getDashboardColumnId(order) {
  if (order.status === "confirmed" || order.status === "preparing") {
    return "preparing";
  }

  return order.status;
}

function compareDashboardOrders(a, b) {
  const stageRank = {
    preparing: 0,
    confirmed: 0,
    ready: 1,
    completed: 2
  };

  const rankDiff = (stageRank[a.status] ?? 99) - (stageRank[b.status] ?? 99);
  if (rankDiff !== 0) {
    return rankDiff;
  }

  if ((a.status === "confirmed" || a.status === "preparing") && hasWhatsappNumber(a) !== hasWhatsappNumber(b)) {
    return hasWhatsappNumber(b) ? 1 : -1;
  }

  return new Date(b.createdAt) - new Date(a.createdAt);
}

function getOrderById(id) {
  return orderCache.find(order => order._id === id);
}

function getVisibleActionableOrders() {
  return orderCache
    .filter(order => order.status !== "completed")
    .filter(order => !order._offline)
    .filter(matchesOrderFilter)
    .filter(matchesFollowUpSearch);
}

function updateSelectionUI() {
  const selectedCount = selectedOrderIds.size;
  const label = document.getElementById("selectedOrderCount");
  if (label) label.textContent = `${selectedCount} selected`;

  document.querySelectorAll(".order-select").forEach(input => {
    input.checked = selectedOrderIds.has(input.dataset.orderId);
  });

  document.querySelectorAll(".bulk-action").forEach(button => {
    button.disabled = bulkActionRunning || selectedCount === 0;
  });
}

function toggleOrderSelection(id, checked) {
  if (checked) {
    selectedOrderIds.add(String(id));
  } else {
    selectedOrderIds.delete(String(id));
  }
  updateSelectionUI();
}

function selectVisibleOrders() {
  getVisibleActionableOrders().forEach(order => selectedOrderIds.add(String(order._id)));
  updateSelectionUI();
}

function clearSelectedOrders() {
  selectedOrderIds.clear();
  updateSelectionUI();
}

function addOrder(order) {
  const columnId = getDashboardColumnId(order);
  const column = document.getElementById(columnId);
  if (!column) return;

  const isOffline = Boolean(order._offline);
  const div = document.createElement("div");
  div.className = `order-card ${order.status}${isOffline ? " offline-pending" : ""}`;
  div.id = `order-${order._id}`;
  div.dataset.createdAt = order.createdAt;

  const isPreparing = order.status === "confirmed" || order.status === "preparing";
  const isReady = order.status === "ready";
  const offlineTag = isOffline ? '<span class="offline-tag">PENDING SYNC</span>' : "";
  const selectable = !isOffline;
  const checked = selectedOrderIds.has(String(order._id)) ? "checked" : "";

  div.innerHTML = `
    <div class="order-header">
      <h3>${selectable ? `<input class="order-select" type="checkbox" data-order-id="${order._id}" onchange="toggleOrderSelection('${order._id}', this.checked)" ${checked}>` : ""} #${order.orderId}${offlineTag}</h3>
      <span class="order-timer" data-created-at="${order.createdAt}">${timeAgo(order.createdAt)}</span>
    </div>
    <div class="order-items">
      ${order.customerName ? `<p>Customer: ${escapeHtml(order.customerName)}</p>` : ""}
      ${order.phone && order.phone !== "Walk-in" ? `<p>WhatsApp: ${escapeHtml(order.phone)}</p>` : ""}
      ${order.items.map(item => `<p>${item.qty}x ${escapeHtml(getMenuItemLabel(item.name))}</p>`).join("")}
    </div>
    <div class="order-footer">
      <span class="total">${formatMoney(order.total)}</span>
      <span class="time">${escapeHtml((order.paymentMethod || defaultPaymentMethod).toUpperCase())}</span>
    </div>
    <div class="actions">
      ${isOffline ? '<p class="helper-text">Will sync when online</p>' : `
      ${isPreparing ? `<button onclick="markReady('${order._id}')">Mark Ready</button>` : ""}
      ${isReady ? `<button onclick="markDelivered('${order._id}')">Mark Delivered</button>` : ""}
      <button class="receipt-btn" onclick="printReceipt('${order._id}')">Print Receipt</button>
      <button class="receipt-btn" onclick="editOrder('${order._id}')">Edit Order</button>
      <button class="delete-btn" onclick="deleteOrder('${order._id}')">Delete Order</button>
      `}
    </div>
  `;

  column.append(div);
}

// Edit customer name and WhatsApp number (persisted to server)
async function editOrder(id) {
  const order = getOrderById(id);
  if (!order) {
    alert("Order not found");
    return;
  }
  const newName = prompt("Edit customer name:", order.customerName || "");
  if (newName === null) return;
  const newPhone = prompt("Edit WhatsApp number:", order.phone || "");
  if (newPhone === null) return;

  try {
    const res = await authFetch(`${API_URL}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerName: newName, phone: newPhone })
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Failed to edit order.");
    }

    await loadOrders();
  } catch (err) {
    console.error("editOrder failed", err);
    alert(err.message || "Could not edit order.");
  }
}

function renderCompleted() {
  const container = document.getElementById("completedList");
  if (!container) {
    return;
  }

  const completedOrders = orderCache
    .filter(order => order.status === "completed")
    .filter(order => selectedCompletedRange === "all" || getLocalDateInputValue(new Date(order.createdAt)) === selectedCompletedDate);

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
        ${order.customerName ? `<p>Customer: ${escapeHtml(order.customerName)}</p>` : ""}
        ${order.phone && order.phone !== "Walk-in" ? `<p>WhatsApp: ${escapeHtml(order.phone)}</p>` : ""}
        ${order.items.map(item => `<p>${item.qty}x ${escapeHtml(getMenuItemLabel(item.name))}</p>`).join("")}
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

function syncCompletedControls() {
  document.querySelectorAll(".completed-filter").forEach(button => {
    button.classList.toggle("active", button.dataset.range === selectedCompletedRange);
  });

  const input = document.getElementById("completedDateInput");
  if (input) input.value = selectedCompletedRange === "all" ? "" : selectedCompletedDate;
}

function setCompletedRange(range) {
  selectedCompletedRange = range;
  if (range === "today") {
    selectedCompletedDate = getLocalDateInputValue(new Date());
  } else if (range === "yesterday") {
    selectedCompletedDate = getYesterdayDateInputValue();
  }
  syncCompletedControls();
  renderCompleted();
}

function setCompletedDate(value) {
  if (!value) {
    setCompletedRange("all");
    return;
  }
  selectedCompletedRange = "custom";
  selectedCompletedDate = value;
  syncCompletedControls();
  renderCompleted();
}

function syncInventoryControls() {
  document.querySelectorAll(".inventory-filter").forEach(button => {
    button.classList.toggle("active", button.dataset.range === selectedInventoryRange);
  });

  const input = document.getElementById("inventoryDateInput");
  if (input) input.value = selectedInventoryRange === "all" ? "" : selectedInventoryDate;
}

function setInventoryRange(range) {
  selectedInventoryRange = range;
  if (range === "today") {
    selectedInventoryDate = getLocalDateInputValue(new Date());
  } else if (range === "yesterday") {
    selectedInventoryDate = getYesterdayDateInputValue();
  }
  syncInventoryControls();
  loadInventory();
}

function setInventoryDate(value) {
  if (!value) {
    setInventoryRange("all");
    return;
  }
  selectedInventoryRange = "custom";
  selectedInventoryDate = value;
  syncInventoryControls();
  loadInventory();
}

function renderRevenue(stats) {
  const totalValue = document.getElementById("revenueTotalValue");
  const cashValue = document.getElementById("revenueCashValue");
  const jazzValue = document.getElementById("revenueJazzValue");
  const pendingCount = document.getElementById("revenuePendingCount");
  const completedCount = document.getElementById("revenueCompletedCount");
  const orderCount = document.getElementById("revenueOrderCount");
  const pendingList = document.getElementById("pendingVerificationList");
  const revenueStatus = document.getElementById("revenueStatus");

  if (totalValue) totalValue.textContent = formatMoney(stats.totalRevenue);
  if (cashValue) cashValue.textContent = formatMoney(stats.cashRevenue);
  if (jazzValue) jazzValue.textContent = formatMoney(stats.jazzRevenue);
  if (pendingCount) pendingCount.textContent = String((stats.pendingVerification || []).length);
  if (completedCount) completedCount.textContent = String(stats.completedOrders || 0);
  if (orderCount) orderCount.textContent = String(stats.totalOrders || 0);

  if (!pendingList || !revenueStatus) {
    return;
  }

  const pendingVerification = stats.pendingVerification || [];

  if (pendingVerification.length === 0) {
    revenueStatus.textContent = "No pending payment verifications.";
    pendingList.innerHTML = "";
    return;
  }

  revenueStatus.textContent = "These orders still need screenshot verification.";
  pendingList.innerHTML = pendingVerification.map(order => `
    <div class="revenue-order">
      <h4>#${order.orderId}</h4>
      <p>Customer: ${escapeHtml(order.customerName || "Walk-in")}</p>
      <p>WhatsApp: ${escapeHtml(order.phone || "Not provided")}</p>
      <p>Total: ${formatMoney(order.total)}</p>
      <p>Received: ${formatDateTime(order.createdAt)}</p>
    </div>
  `).join("");
}

function renderReceiptSearch(value) {
  const container = document.getElementById("receiptSearchResults");
  if (!container) return;

  const term = String(value || "").trim();
  if (!term) {
    container.innerHTML = "";
    return;
  }

  const matches = orderCache
    .filter(order => String(order.orderId || "").includes(term))
    .slice(0, 8);

  if (matches.length === 0) {
    container.innerHTML = "<span class='helper-text'>No receipt found.</span>";
    return;
  }

  container.innerHTML = matches.map(order => `
    <button type="button" class="receipt-result" onclick="printReceipt('${order._id}')">
      #${order.orderId} ${escapeHtml(order.customerName || "Walk-in")} ${formatMoney(order.total)}
    </button>
  `).join("");
}

async function loadRevenue() {
  try {
    const query = selectedRevenueRange === "all" ? "" : `?date=${encodeURIComponent(selectedRevenueDate)}`;
    const res = await authFetch(`${API_URL}/stats/payments${query}`);
    if (!res.ok) {
      throw new Error(`Failed to load revenue stats (${res.status})`);
    }

    const stats = await res.json();
    renderRevenue(stats);
  } catch (err) {
    console.error("loadRevenue failed", err);

    const revenueStatus = document.getElementById("revenueStatus");
    const pendingList = document.getElementById("pendingVerificationList");

    if (revenueStatus) {
      revenueStatus.textContent = "Could not load revenue stats.";
    }

    if (pendingList) {
      pendingList.innerHTML = "";
    }
  }
}

function syncRevenueControls() {
  document.querySelectorAll(".revenue-filter").forEach(button => {
    button.classList.toggle("active", button.dataset.range === selectedRevenueRange);
  });

  const input = document.getElementById("revenueDateInput");
  if (input) {
    input.value = selectedRevenueRange === "all" ? "" : selectedRevenueDate;
  }
}

function setRevenueRange(range) {
  selectedRevenueRange = range;

  if (range === "today") {
    selectedRevenueDate = getLocalDateInputValue(new Date());
  } else if (range === "yesterday") {
    selectedRevenueDate = getYesterdayDateInputValue();
  }

  syncRevenueControls();
  loadRevenue();
}

function setRevenueDate(value) {
  if (!value) {
    setRevenueRange("all");
    return;
  }

  selectedRevenueRange = "custom";
  selectedRevenueDate = value;
  syncRevenueControls();
  loadRevenue();
}

async function loadOrders() {
  try {
    const res = await authFetch(API_URL);
    if (!res.ok) {
      throw new Error(`Failed to load orders (${res.status})`);
    }

    orderCache = await res.json();
    saveOrdersToLocal(orderCache);
    usingCachedData = false;

    // Merge any pending offline queue orders into the view
    const queue = getOfflineQueue();
    if (queue.length > 0) {
      orderCache = [...queue, ...orderCache];
    }

    renderFollowUpOrders();
    renderCompleted();
    updateOfflineBanner();
    loadRevenue();
  } catch (err) {
    console.error("loadOrders failed — falling back to local cache", err);
    const cached = loadOrdersFromLocal();
    const queue = getOfflineQueue();
    orderCache = [...queue, ...cached];
    usingCachedData = true;
    renderFollowUpOrders();
    renderCompleted();
    updateOfflineBanner();
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

function setBulkActionState(isRunning, message = "") {
  bulkActionRunning = isRunning;
  const status = document.getElementById("selectedOrderCount");
  if (status && message) status.textContent = message;

  document.querySelectorAll(".mark-all-btn, .bulk-action").forEach(button => {
    button.disabled = isRunning;
  });

  if (!isRunning) updateSelectionUI();
}

async function postBulkAction(path, ids, label) {
  setBulkActionState(true, `${label}...`);
  try {
    const res = await authFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids?.length ? { ids } : {})
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `${label} failed (${res.status})`);
    }
    const result = await res.json().catch(() => ({}));
    selectedOrderIds.clear();
    await Promise.all([loadOrders(), loadInventory(), loadSyncStatus()]);
    alert(`${result.updated || 0} order(s) updated.`);
  } catch (err) {
    console.error(`${label} failed`, err);
    alert(err.message || `${label} failed. Please try again.`);
  } finally {
    setBulkActionState(false);
  }
}

async function markAllReady() {
  const preparingOrders = orderCache.filter(o => (o.status === "confirmed" || o.status === "preparing") && !o._offline);
  if (preparingOrders.length === 0) {
    alert("No orders to mark as ready.");
    return;
  }
  if (!confirm(`Mark ${preparingOrders.length} order(s) as ready?`)) return;
  await postBulkAction(`${API_URL}/bulk/ready`, [], "Marking all ready");
}

async function markAllDelivered() {
  const readyOrders = orderCache.filter(o => o.status === "ready" && !o._offline);
  if (readyOrders.length === 0) {
    alert("No ready orders to mark as delivered.");
    return;
  }
  if (!confirm(`Mark ${readyOrders.length} ready order(s) as delivered?`)) return;
  await postBulkAction(`${API_URL}/bulk/delivered`, [], "Marking all delivered");
}

async function markSelectedReady() {
  const ids = Array.from(selectedOrderIds);
  if (ids.length === 0) return;
  if (!confirm(`Mark ${ids.length} selected order(s) ready?`)) return;
  await postBulkAction(`${API_URL}/bulk/ready`, ids, "Marking selected ready");
}

async function markSelectedDelivered() {
  const ids = Array.from(selectedOrderIds);
  if (ids.length === 0) return;
  if (!confirm(`Mark ${ids.length} selected order(s) delivered?`)) return;
  await postBulkAction(`${API_URL}/bulk/delivered`, ids, "Marking selected delivered");
}

async function deleteOrder(id) {
  const order = getOrderById(id);
  if (!order) { alert("Order not found"); return; }
  if (!confirm(`Delete order #${order.orderId}? This cannot be undone.`)) return;
  try {
    const res = await authFetch(`${API_URL}/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Failed to delete order.");
    }
    orderCache = orderCache.filter(o => o._id !== id);
    const el = document.getElementById(`order-${id}`);
    if (el) el.remove();
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
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

function changeQty(name, price, delta) {
  const nextQty = Math.max(0, (cart[name]?.qty || 0) + delta);

  if (nextQty === 0) {
    delete cart[name];
  } else {
    cart[name] = {
      name,
      price,
      qty: nextQty
    };
  }

  updateItemQtyLabel(name, nextQty);
  renderOrderSummary();
}

function renderOrderSummary() {
  const orderSummary = document.getElementById("orderSummary");
  const totalEl = document.getElementById("total");

  if (!orderSummary || !totalEl) {
    return;
  }

  const items = Object.values(cart).filter(item => item.qty > 0);
  const { subtotal, discount, total } = calculateVisiblePricing(items);

  if (items.length === 0) {
    orderSummary.innerHTML = "<p>No items selected</p>";
  } else {
    orderSummary.innerHTML = items.map(item => `
      <p>${item.qty}x ${escapeHtml(getMenuItemLabel(item.name))} - ${formatMoney(item.qty * item.price)}</p>
    `).join("") + (discount > 0
      ? `<p class="helper-text">Subtotal: ${formatMoney(subtotal)} | Savings: ${formatMoney(discount)}</p>`
      : "");
  }

  totalEl.textContent = total.toLocaleString("en-PK");
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
    frame.srcdoc = "<html><body style=\"font-family: sans-serif; padding: 12px;\">No receipt selected.</body></html>";
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
  const inventorySoldCounts = document.getElementById("inventorySoldCounts");
  const inventoryWarnings = document.getElementById("inventoryWarnings");

  if (inventoryPatties) inventoryPatties.textContent = String(inventory.patties);
  if (inventoryBuns) inventoryBuns.textContent = String(inventory.buns);
  if (inventoryPattiesInput) inventoryPattiesInput.value = String(inventory.patties);
  if (inventoryBunsInput) inventoryBunsInput.value = String(inventory.buns);
  if (posPatties) posPatties.textContent = String(inventory.patties);
  if (posBuns) posBuns.textContent = String(inventory.buns);
  if (updatedAt) updatedAt.textContent = `Last updated: ${formatDateTime(inventory.updatedAt || new Date())}`;

  if (inventoryWarnings) {
    const warnings = [];
    if (Number(inventory.patties) <= 20) {
      warnings.push({ text: `Critical patties stock: ${inventory.patties} left`, critical: true });
    } else if (Number(inventory.patties) <= 50) {
      warnings.push({ text: `Low patties stock: ${inventory.patties} left`, critical: false });
    }

    if (Number(inventory.buns) <= 20) {
      warnings.push({ text: `Critical buns stock: ${inventory.buns} left`, critical: true });
    } else if (Number(inventory.buns) <= 50) {
      warnings.push({ text: `Low buns stock: ${inventory.buns} left`, critical: false });
    }

    inventoryWarnings.innerHTML = warnings.map(warning => `
      <div class="stock-warning ${warning.critical ? "critical" : ""}">${warning.text}</div>
    `).join("");
  }

  if (inventorySoldCounts) {
    const soldCounts = Array.isArray(inventory.soldCounts) ? inventory.soldCounts : [];
    inventorySoldCounts.innerHTML = soldCounts.map(item => `
      <div class="inventory-sales-item">
        <span>${item.label}</span>
        <strong>${item.qty}</strong>
      </div>
    `).join("");
  }
}

async function loadInventory() {
  try {
    const query = selectedInventoryRange === "all" ? "" : `?date=${encodeURIComponent(selectedInventoryDate)}`;
    const res = await authFetch(`${API_URL}/inventory${query}`);
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

  if (!Number.isFinite(patties) || patties < 0 || !Number.isFinite(buns) || buns < 0) {
    const inventoryStatus = document.getElementById("inventoryStatus");
    if (inventoryStatus) {
      inventoryStatus.textContent = "Patties and buns must be valid non-negative numbers.";
    }
    return;
  }

  try {
    const query = selectedInventoryRange === "all" ? "" : `?date=${encodeURIComponent(selectedInventoryDate)}`;
    const res = await authFetch(`${API_URL}/inventory${query}`, {
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
    const res = await authFetch(`${window.location.origin}/qr`, {
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

const RECEIPT_PAPER_WIDTH_MM = 58;
const RECEIPT_LINE_WIDTH = 32;

function fitReceiptText(text, width = RECEIPT_LINE_WIDTH) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [""];
  }

  const words = normalized.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      if (word.length <= width) {
        current = word;
      } else {
        for (let index = 0; index < word.length; index += width) {
          lines.push(word.slice(index, index + width));
        }
      }
      continue;
    }

    if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
      continue;
    }

    lines.push(current);
    if (word.length <= width) {
      current = word;
    } else {
      current = "";
      for (let index = 0; index < word.length; index += width) {
        const chunk = word.slice(index, index + width);
        if (chunk.length === width) {
          lines.push(chunk);
        } else {
          current = chunk;
        }
      }
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function padReceiptLine(left, right = "", width = RECEIPT_LINE_WIDTH) {
  const safeRight = String(right || "").trim();
  const leftWidth = safeRight ? Math.max(1, width - safeRight.length - 1) : width;
  const wrappedLeft = fitReceiptText(left, leftWidth);

  return wrappedLeft.map((line, index) => {
    if (index !== wrappedLeft.length - 1 || !safeRight) {
      return line;
    }

    const spaces = Math.max(1, width - line.length - safeRight.length);
    return `${line}${" ".repeat(spaces)}${safeRight}`;
  });
}

function centerReceiptLine(text, width = RECEIPT_LINE_WIDTH) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length >= width) {
    return normalized;
  }

  const leftPadding = Math.floor((width - normalized.length) / 2);
  return `${" ".repeat(leftPadding)}${normalized}`;
}

function escapeReceiptHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildReceiptHtml(order) {
  const subtotal = order.items.reduce((sum, item) => sum + (item.qty * item.price), 0);
  const discount = Math.max(0, subtotal - Number(order.total || 0));
  const payment = (order.paymentMethod || defaultPaymentMethod).toUpperCase();
  const date = formatDateTime(order.createdAt);
  const customer = escapeReceiptHtml(order.customerName || "Walk-in");
  const phone = escapeReceiptHtml(order.phone || "N/A");

  const renderRow = (label, value, bold) => {
    const l = String(label);
    const r = String(value);
    const gap = Math.max(1, 32 - l.length - r.length);
    const line = escapeReceiptHtml(l + " ".repeat(gap) + r);
    return bold ? `<b>${line}</b>` : line;
  };

  const dashes = "-".repeat(32);

  const itemLines = order.items.map(item => {
    const label = `${item.qty}x ${getMenuItemLabel(item.name)}`;
    const val = formatMoney(item.qty * item.price);
    const lines = padReceiptLine(label, val);
    return lines.map(l => escapeReceiptHtml(l)).join("\n");
  }).join("\n");

  const totalLines = [
    ...(discount > 0 ? [
      renderRow("Subtotal", formatMoney(subtotal), false),
      renderRow("Combo Savings", `-${formatMoney(discount)}`, false)
    ] : []),
    renderRow("TOTAL", formatMoney(order.total), true)
  ].join("\n");

  const buildCopy = (copyLabel) => `
<pre class="receipt">
${centerReceiptLine("CARTEL BURGERS")}
${centerReceiptLine("POS Receipt")}
${dashes}
${escapeReceiptHtml(copyLabel)}
${dashes}
Receipt:    #${order.orderId}
Date:       ${escapeReceiptHtml(date)}
Customer:   ${customer}
WhatsApp:   ${phone}
Payment:    ${escapeReceiptHtml(payment)}
${dashes}
ITEMS
${dashes}
${itemLines}
${dashes}
${totalLines}
${dashes}
${centerReceiptLine("Fresh. Loud. Served at the window.")}
</pre>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Receipt #${order.orderId}</title>
  <style>
    @page {
      size: ${RECEIPT_PAPER_WIDTH_MM}mm auto;
      margin: 0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Courier New", Courier, monospace;
      font-size: 12px;
      line-height: 1.4;
      background: #fff;
      color: #000;
      padding: 8px;
    }
    .receipt {
      width: 32ch;
      margin: 0 auto 20px;
      white-space: pre;
      font-family: "Courier New", Courier, monospace;
      font-size: 12px;
      line-height: 1.4;
      overflow: hidden;
    }
    b { font-weight: bold; }
    @media print {
      body { padding: 0; }
      .receipt { margin-bottom: 0; page-break-after: always; }
      .receipt:last-child { page-break-after: auto; }
    }
  </style>
</head>
<body>
  ${buildCopy("COUNTER COPY")}
  ${buildCopy("CUSTOMER COPY")}
</body>
</html>`;
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
  showSection("dashboard");
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
  const nameInput = document.getElementById("customerName");
  if (nameInput) {
    nameInput.focus();
  }
}

async function submitOrder() {
  const items = Object.values(cart).filter(item => item.qty > 0);
  if (items.length === 0) {
    alert("Please add at least one item.");
    return;
  }

  const createBtn = document.getElementById("createOrderButton");
  const nameInput = document.getElementById("customerName");
  const phoneInput = document.getElementById("customerPhone");
  const customerName = nameInput ? nameInput.value.trim() : "";
  const phone = phoneInput ? phoneInput.value.trim() : "";

  if (!customerName) {
    alert("Customer name is required.");
    if (nameInput) {
      nameInput.focus();
    }
    return;
  }

  try {
    if (createBtn) {
      createBtn.disabled = true;
    }

    const orderPayload = {
      customerName,
      phone,
      items: items.map(item => ({ name: item.name, qty: item.qty })),
      paymentMethod: selectedPaymentMethod
    };

    let order;
    try {
      const res = await authFetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderPayload)
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to create order.");
      }

      order = await res.json();
    } catch (networkErr) {
      // Server unreachable — queue locally
      order = addToOfflineQueue(orderPayload);
      console.warn("Order queued offline:", order._id);
    }
    resetCartUI();

    if (nameInput) {
      nameInput.value = "";
    }

    if (phoneInput) {
      phoneInput.value = "";
    }

    selectedPaymentMethod = "cash";
    document.querySelectorAll(".pay-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.method === "cash");
    });

    await Promise.all([loadOrders(), loadInventory()]);
    renderReceiptPreview(order);
    showSection("dashboard");
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

socket.on("orders_bulk_updated", async () => {
  await Promise.all([loadOrders(), loadInventory(), loadSyncStatus()]);
});

socket.on("offline_orders_synced", async () => {
  await Promise.all([loadOrders(), loadInventory(), loadSyncStatus()]);
});

socket.on("menu_updated", (data) => {
  applyMenuItems(data.items || []);
});

socket.on("order_deleted", (data) => {
  orderCache = orderCache.filter(o => o._id !== data._id);
  const el = document.getElementById(`order-${data._id}`);
  if (el) el.remove();
});

async function checkDbStatus() {
  const badge = document.getElementById("dbStatus");
  if (!badge) return;
  let isOnline = false;
  try {
    const res = await fetch(`${window.location.origin}/health`);
    const data = await res.json();
    isOnline = data.db === "connected";
    if (isOnline) {
      badge.textContent = "DB: Online";
      badge.className = "db-badge online";
    } else {
      badge.textContent = "DB: Offline";
      badge.className = "db-badge offline";
    }
  } catch {
    badge.textContent = "DB: Offline";
    badge.className = "db-badge offline";
  }

  // If just came back online, sync queued orders
  if (isOnline && lastDbOnline === false) {
    await syncOfflineQueue();
  }
  lastDbOnline = isOnline;
  await loadSyncStatus();
}

async function loadSyncStatus() {
  const status = document.getElementById("offlineSyncStatus");
  const button = document.getElementById("syncOfflineButton");
  if (!status) return;

  try {
    const res = await authFetch(`${window.location.origin}/sync/offline/status`);
    if (!res.ok) throw new Error(`Sync status failed (${res.status})`);
    const data = await res.json();

    status.textContent = data.running
      ? `Sync running... ${data.pending} CSV order(s) pending`
      : `DB: ${data.db}. CSV pending sync: ${data.pending}`;

    if (button) button.disabled = data.running || data.db !== "connected" || Number(data.pending) === 0;
    updateOfflineBanner();
  } catch {
    status.textContent = "Sync status unavailable.";
    if (button) button.disabled = true;
    updateOfflineBanner();
  }
}

async function runOfflineSync() {
  const button = document.getElementById("syncOfflineButton");
  const status = document.getElementById("offlineSyncStatus");
  try {
    if (button) button.disabled = true;
    if (status) status.textContent = "Sync running...";

    const res = await authFetch(`${window.location.origin}/sync/offline/run`, { method: "POST" });
    if (!res.ok) throw new Error(`Sync failed (${res.status})`);
    const data = await res.json();

    if (status) status.textContent = `Synced ${data.synced || 0}. CSV pending sync: ${data.pending || 0}`;
    await Promise.all([loadOrders(), loadInventory(), loadSyncStatus()]);
  } catch (err) {
    console.error("runOfflineSync failed", err);
    alert(err.message || "Offline sync failed.");
    await loadSyncStatus();
  }
}

async function syncOfflineQueue() {
  const queue = getOfflineQueue();
  if (queue.length === 0) return;

  console.log(`Syncing ${queue.length} offline order(s)...`);
  const remaining = [];

  for (const localOrder of queue) {
    try {
      const res = await authFetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localOrder._payload)
      });

      if (!res.ok) {
        remaining.push(localOrder);
        continue;
      }

      console.log(`Synced offline order ${localOrder._id}`);
    } catch {
      remaining.push(localOrder);
    }
  }

  saveOfflineQueue(remaining);

  if (remaining.length < queue.length) {
    await loadOrders();
    await loadInventory();
  }

  updateOfflineBanner();

  if (remaining.length > 0) {
    console.warn(`${remaining.length} order(s) still pending sync.`);
  } else {
    console.log("All offline orders synced successfully.");
  }
}

function updateOfflineBanner() {
  let banner = document.getElementById("offlineBanner");
  const queue = getOfflineQueue();
  const csvPendingText = document.getElementById("offlineSyncStatus")?.textContent || "";
  const hasCsvPending = csvPendingText.includes("CSV pending sync:") && !csvPendingText.endsWith(": 0");
  const showBanner = usingCachedData || queue.length > 0 || hasCsvPending;

  if (!showBanner) {
    if (banner) banner.remove();
    return;
  }

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "offlineBanner";
    banner.className = "offline-banner";
    document.body.insertBefore(banner, document.body.firstChild.nextSibling);
  }

  const parts = [];
  if (usingCachedData) {
    parts.push("Showing cached data — server unreachable");
  }
  if (queue.length > 0) {
    parts.push(`${queue.length} order(s) pending sync`);
  }
  if (hasCsvPending) {
    parts.push(csvPendingText);
  }
  banner.textContent = parts.join(" · ");
}

bindNavigation();
loadMenu();
renderOrderSummary();
clearReceiptPreview();
syncRevenueControls();
syncCompletedControls();
syncInventoryControls();
checkDbStatus();
setInterval(checkDbStatus, 30000);
setInterval(refreshOrderTimers, 60000);
loadOrders();
loadInventory();
setActiveNav("dashboard");
