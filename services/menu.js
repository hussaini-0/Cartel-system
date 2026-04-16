// Single source of truth for menu items and prices.
// Update prices here — both the API and WhatsApp bot will use them.

const menu = {
  // Burgers
  "don og":                  { display: "Don OG",                  price: 849 },
  "underboss":               { display: "Underboss",               price: 849 },
  "the godfather":           { display: "The Godfather",           price: 899 },
  "godfather":               { display: "The Godfather",           price: 899 },
  "god father":              { display: "The Godfather",           price: 899 },
  // Fries
  "fries":                   { display: "Fries",                   price: 349 },
  "curly fries":             { display: "Curly Fries",             price: 349 },
  "curly fries with sauce":  { display: "Curly Fries with Sauce",  price: 449 },
  "fries with sauce":        { display: "Fries with Sauce",        price: 449 },
  // Drinks
  "pepsi":                   { display: "Pepsi",                   price: 150 },
  "7up":                     { display: "7Up",                     price: 150 },
  "7 up":                    { display: "7Up",                     price: 150 },
  "redbull":                 { display: "Red Bull",                price: 600 },
  "red bull":                { display: "Red Bull",                price: 600 },
  "water":                   { display: "Water",                   price: 100 },
};

// Flat price map: { "don og": 849, ... } — for quick price lookups
const priceMap = Object.fromEntries(
  Object.entries(menu).map(([k, v]) => [k, v.price])
);

const inventoryUsageMap = {
  "don og": { patties: 1, buns: 1 },
  "underboss": { patties: 1, buns: 1 },
  "the godfather": { patties: 1, buns: 1 },
  "godfather": { patties: 1, buns: 1 },
  "god father": { patties: 1, buns: 1 }
};

function getInventoryUsage(itemName) {
  const normalizedName = String(itemName || "").trim().toLowerCase();
  return inventoryUsageMap[normalizedName] || { patties: 0, buns: 0 };
}

module.exports = { menu, priceMap, getInventoryUsage };
