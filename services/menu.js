const fs = require("fs");
const runtimePaths = require("../runtimePaths");

const MENU_DATA_FILE = runtimePaths.menuDataFile;

const defaultMenu = {
  "don og (single)": { display: "Don OG (Single Patty)", category: "burgers", price: 849, selectable: true, inventory: { patties: 1, buns: 1 } },
  "don og (double)": { display: "Don OG (Double Patty)", category: "burgers", price: 1099, selectable: true, inventory: { patties: 2, buns: 1 } },
  "underboss (single)": { display: "Underboss (Single Patty)", category: "burgers", price: 849, selectable: true, inventory: { patties: 1, buns: 1 } },
  "underboss (double)": { display: "Underboss (Double Patty)", category: "burgers", price: 1099, selectable: true, inventory: { patties: 2, buns: 1 } },
  "the godfather (single)": { display: "The Godfather (Single Patty)", category: "burgers", price: 899, selectable: true, inventory: { patties: 1, buns: 1 } },
  "the godfather (double)": { display: "The Godfather (Double Patty)", category: "burgers", price: 1199, selectable: true, inventory: { patties: 2, buns: 1 } },
  "don og": { display: "Don OG (Single Patty)", category: "burgers", price: 849, selectable: false, inventory: { patties: 1, buns: 1 } },
  "underboss": { display: "Underboss (Single Patty)", category: "burgers", price: 849, selectable: false, inventory: { patties: 1, buns: 1 } },
  "the godfather": { display: "The Godfather (Single Patty)", category: "burgers", price: 899, selectable: false, inventory: { patties: 1, buns: 1 } },
  "godfather": { display: "The Godfather (Single Patty)", category: "burgers", price: 899, selectable: false, inventory: { patties: 1, buns: 1 } },
  "god father": { display: "The Godfather (Single Patty)", category: "burgers", price: 899, selectable: false, inventory: { patties: 1, buns: 1 } },
  "lychee": { display: "Lychee", category: "signature", price: 400, selectable: true, comboDrink: true },
  "blueberry": { display: "Blueberry", category: "signature", price: 400, selectable: true, comboDrink: true },
  "peach": { display: "Peach", category: "signature", price: 400, selectable: true, comboDrink: true },
  "mango": { display: "Mango", category: "signature", price: 400, selectable: true, comboDrink: true },
  "peach mango": { display: "Peach Mango", category: "specials", price: 500, selectable: true },
  "blueberry redbull": { display: "Blueberry Red Bull", category: "specials", price: 900, selectable: true },
  "blueberry red bull": { display: "Blueberry Red Bull", category: "specials", price: 900, selectable: false },
  "fries": { display: "Curly Fries", category: "fries", price: 349, selectable: true },
  "curly fries": { display: "Curly Fries", category: "fries", price: 349, selectable: false },
  "curly fries with sauce": { display: "Curly Fries with Sauce", category: "fries", price: 449, selectable: true },
  "fries with sauce": { display: "Fries with Sauce", category: "fries", price: 449, selectable: false },
  "pepsi": { display: "Pepsi", category: "drinks", price: 150, selectable: true },
  "7up": { display: "7Up", category: "drinks", price: 150, selectable: false },
  "7 up": { display: "7Up", category: "drinks", price: 150, selectable: true },
  "redbull": { display: "Red Bull", category: "drinks", price: 600, selectable: false },
  "red bull": { display: "Red Bull", category: "drinks", price: 600, selectable: true },
  "water": { display: "Water", category: "drinks", price: 100, selectable: true }
};

const menu = {};
const priceMap = {};

function normalizeItemName(itemName) {
  return String(itemName || "").trim().toLowerCase();
}

function toMenuKey(name) {
  return normalizeItemName(name)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function replaceObject(target, next) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

function normalizeMenuData(data) {
  const source = data && typeof data === "object" ? data : defaultMenu;
  const normalized = {};

  for (const [rawKey, rawItem] of Object.entries(source)) {
    if (!rawItem || typeof rawItem !== "object") continue;

    const key = toMenuKey(rawKey);
    const price = Number(rawItem.price);
    if (!key || !Number.isFinite(price) || price < 0) continue;

    normalized[key] = {
      display: String(rawItem.display || rawItem.name || rawKey).trim(),
      category: String(rawItem.category || "drinks").trim().toLowerCase(),
      price,
      selectable: rawItem.selectable !== false,
      comboDrink: Boolean(rawItem.comboDrink),
      inventory: {
        patties: Math.max(0, Number(rawItem.inventory?.patties) || 0),
        buns: Math.max(0, Number(rawItem.inventory?.buns) || 0)
      }
    };
  }

  return normalized;
}

function refreshDerivedMaps() {
  replaceObject(priceMap, Object.fromEntries(
    Object.entries(menu).map(([key, item]) => [key, item.price])
  ));
}

function readPersistedMenu() {
  try {
    if (!fs.existsSync(MENU_DATA_FILE)) return null;
    return JSON.parse(fs.readFileSync(MENU_DATA_FILE, "utf8"));
  } catch (err) {
    console.error("Failed to read menu-data.json:", err.message);
    return null;
  }
}

function saveMenuData() {
  fs.writeFileSync(MENU_DATA_FILE, `${JSON.stringify(menu, null, 2)}\n`);
}

function loadMenuData() {
  replaceObject(menu, normalizeMenuData(readPersistedMenu() || defaultMenu));
  refreshDerivedMaps();
}

function getPublicMenuItems() {
  return Object.entries(menu)
    .filter(([, item]) => item.selectable !== false)
    .map(([key, item]) => ({
      key,
      name: item.display,
      price: item.price,
      category: item.category,
      comboDrink: Boolean(item.comboDrink),
      inventory: item.inventory || { patties: 0, buns: 0 }
    }));
}

function upsertMenuItem(input) {
  const display = String(input?.name || input?.display || "").trim();
  const key = toMenuKey(input?.key || display);
  const price = Number(input?.price);
  const category = String(input?.category || "drinks").trim().toLowerCase();

  if (!display) throw new Error("Menu item name is required.");
  if (!key) throw new Error("Menu item key is required.");
  if (!Number.isFinite(price) || price < 0) throw new Error("Price must be a non-negative number.");

  menu[key] = {
    display,
    category,
    price,
    selectable: true,
    comboDrink: Boolean(input?.comboDrink),
    inventory: {
      patties: Math.max(0, Number(input?.patties ?? input?.inventory?.patties) || 0),
      buns: Math.max(0, Number(input?.buns ?? input?.inventory?.buns) || 0)
    }
  };

  refreshDerivedMaps();
  saveMenuData();
  return { key, ...menu[key] };
}

function removeMenuItem(key) {
  const normalizedKey = toMenuKey(key);
  if (!normalizedKey || !menu[normalizedKey]) return false;

  delete menu[normalizedKey];
  refreshDerivedMaps();
  saveMenuData();
  return true;
}

loadMenuData();

function createSoldCountSeed() {
  return Object.fromEntries(getPublicMenuItems().map(item => [item.key, 0]));
}

function normalizeSoldCountKey(itemName) {
  const normalizedName = toMenuKey(itemName);

  if (["blueberry red bull"].includes(normalizedName)) return "blueberry redbull";
  if (["redbull"].includes(normalizedName)) return "red bull";
  if (["7up"].includes(normalizedName)) return "7 up";
  if (["curly fries", "fries with sauce"].includes(normalizedName)) return "curly fries with sauce";

  if (["don og", "underboss", "the godfather", "godfather", "god father"].includes(normalizedName)) {
    const aliasMap = {
      "don og": "don og single",
      underboss: "underboss single",
      "the godfather": "the godfather single",
      godfather: "the godfather single",
      "god father": "the godfather single"
    };
    return aliasMap[normalizedName];
  }

  return normalizedName;
}

function buildSoldCountRows(soldCounts) {
  return getPublicMenuItems().map(item => ({
    key: item.key,
    label: item.name,
    qty: soldCounts[item.key] || 0
  }));
}

function getInventoryUsage(itemName) {
  const normalizedName = toMenuKey(itemName);
  return menu[normalizedName]?.inventory || { patties: 0, buns: 0 };
}

function isBurgerItem(itemName) {
  const usage = getInventoryUsage(itemName);
  return usage.patties > 0 && usage.buns > 0;
}

function calculateDealTotals(structuredItems) {
  const subtotal = structuredItems.reduce((sum, item) => sum + (item.price * item.qty), 0);

  const burgerQty = structuredItems.reduce((sum, item) => {
    return sum + (isBurgerItem(item.name) ? item.qty : 0);
  }, 0);

  const comboDrinkQty = structuredItems.reduce((sum, item) => {
    const normalizedName = toMenuKey(item.name);
    return sum + (menu[normalizedName]?.comboDrink ? item.qty : 0);
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

function calculateOrderPricing(items) {
  const structuredItems = [];

  for (const item of items) {
    if (typeof item === "string") {
      const name = toMenuKey(item);
      const price = priceMap[name] || 0;
      structuredItems.push({ name, qty: 1, price });
      continue;
    }

    if (!item || typeof item !== "object" || !item.name) {
      console.log("Invalid item skipped:", item);
      continue;
    }

    const name = toMenuKey(item.name);
    const qty = Number(item.qty) > 0 ? Number(item.qty) : 1;
    const price = priceMap[name] || 0;

    structuredItems.push({ name, qty, price });
  }

  const { subtotal, discount, total } = calculateDealTotals(structuredItems);

  return {
    structuredItems,
    subtotal,
    discount,
    total
  };
}

module.exports = {
  menu,
  priceMap,
  getPublicMenuItems,
  upsertMenuItem,
  removeMenuItem,
  getInventoryUsage,
  calculateOrderPricing,
  createSoldCountSeed,
  normalizeSoldCountKey,
  buildSoldCountRows
};
