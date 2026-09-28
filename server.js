const http = require("http");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const querystring = require("querystring");

loadEnv();

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "dashboard.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || "";
const FIREBASE_PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const FIRESTORE_COLLECTION_PREFIX = process.env.FIRESTORE_COLLECTION_PREFIX || "dashboard";
let firestoreToken = null;
let firestoreTokenExpiresAt = 0;

const emptyDb = {
  categories: [],
  subcategories: [],
  products: [],
  users: [],
  orders: [],
  workers: []
};

const tabs = [
  { id: "products", label: "Products", icon: "P" },
  { id: "categories", label: "Categories", icon: "C" },
  { id: "subcategories", label: "Subcategories", icon: "S" },
  { id: "users", label: "Users", icon: "U" },
  { id: "orders", label: "Orders", icon: "O" },
  { id: "workers", label: "Workers", icon: "W" }
];

const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const money = (value) => {
  const number = Number(value || 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(number);
};

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fsSync.existsSync(envPath)) return;

  const lines = fsSync.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;

    const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
    process.env[key.trim()] = value;
  }
}

function usesFirestore() {
  return Boolean(FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY);
}

async function ensureStore() {
  if (usesFirestore()) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await writeDb(emptyDb);
  }
}

async function readDb() {
  let db;
  if (usesFirestore()) {
    db = await readFirestoreDb();
    return normalizeDb(db);
  }

  await ensureStore();
  const raw = await fs.readFile(DB_FILE, "utf8");
  db = { ...emptyDb, ...JSON.parse(raw) };
  return normalizeDb(db);
}

async function writeDb(db) {
  const normalizedDb = normalizeDb(db);
  if (usesFirestore()) {
    await writeFirestoreDb(normalizedDb);
    return;
  }

  await fs.writeFile(DB_FILE, `${JSON.stringify(normalizedDb, null, 2)}\n`);
}

function firestoreCollectionName(collection) {
  return `${FIRESTORE_COLLECTION_PREFIX}_${collection}`;
}

function firestoreCollectionUrl(collection) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/databases/(default)/documents/${encodeURIComponent(firestoreCollectionName(collection))}`;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function getFirestoreAccessToken() {
  if (firestoreToken && Date.now() < firestoreTokenExpiresAt - 60_000) {
    return firestoreToken;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: FIREBASE_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600
    })
  );
  const unsignedJwt = `${header}.${claim}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsignedJwt).sign(FIREBASE_PRIVATE_KEY);
  const jwt = `${unsignedJwt}.${base64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  if (!response.ok) {
    throw new Error(`Firestore auth failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  firestoreToken = data.access_token;
  firestoreTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return firestoreToken;
}

async function firestoreRequest(url, options = {}) {
  const token = await getFirestoreAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok && response.status !== 404) {
    const detail = await response.text();
    throw new Error(`Firestore request failed: ${response.status} ${response.statusText} ${detail}`);
  }

  return response;
}

async function readFirestoreDb() {
  const db = { ...emptyDb };
  await Promise.all(
    Object.keys(emptyDb).map(async (collection) => {
      const response = await firestoreRequest(firestoreCollectionUrl(collection));
      if (response.status === 404) {
        db[collection] = [];
        return;
      }

      const data = await response.json();
      db[collection] = (data.documents || []).map((document) => decodeFirestoreFields(document.fields || {}));
    })
  );
  return db;
}

async function writeFirestoreDb(db) {
  await Promise.all(Object.keys(emptyDb).map((collection) => syncFirestoreCollection(collection, db[collection])));
}

async function syncFirestoreCollection(collection, items) {
  const existingResponse = await firestoreRequest(firestoreCollectionUrl(collection));
  const existingIds =
    existingResponse.status === 404
      ? []
      : ((await existingResponse.json()).documents || []).map((document) => document.name.split("/").pop());
  const itemIds = new Set(items.map((item) => item.id));

  await Promise.all(
    existingIds
      .filter((id) => !itemIds.has(id))
      .map((id) => firestoreRequest(`${firestoreCollectionUrl(collection)}/${encodeURIComponent(id)}`, { method: "DELETE" }))
  );

  await Promise.all(
    items.map((item) =>
      firestoreRequest(`${firestoreCollectionUrl(collection)}/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ fields: encodeFirestoreFields(item) })
      })
    )
  );
}

function encodeFirestoreFields(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, encodeFirestoreValue(value)]));
}

function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "object") return { mapValue: { fields: encodeFirestoreFields(value) } };
  return { stringValue: String(value) };
}

function decodeFirestoreFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

function decodeFirestoreValue(value) {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if ("mapValue" in value) return decodeFirestoreFields(value.mapValue.fields || {});
  if ("timestampValue" in value) return value.timestampValue;
  return "";
}

function normalizeDb(db) {
  const normalized = { ...emptyDb, ...db };
  normalized.categories = normalized.categories.map((category) => ({
    id: category.id,
    name: category.name || "",
    imageUrl: category.imageUrl || "",
    subcategories: []
  }));
  normalized.subcategories = normalized.subcategories.map((subcategory) => ({
    id: subcategory.id,
    name: subcategory.name || "",
    imageUrl: subcategory.imageUrl || "",
    parentCategoryId: subcategory.parentCategoryId || subcategory.categoryId || ""
  }));
  normalized.categories = normalized.categories.map((category) => ({
    ...category,
    subcategories: normalized.subcategories.filter((subcategory) => subcategory.parentCategoryId === category.id)
  }));
  normalized.products = normalized.products.map((product) => ({
    id: product.id,
    name: product.name || "",
    description: product.description || "",
    imageUrl: product.imageUrl || "",
    additionalImages: Array.isArray(product.additionalImages) ? product.additionalImages : splitList(product.additionalImages),
    price: Number(product.price || 0),
    categoryId: product.categoryId || "",
    subcategoryId: product.subcategoryId || "",
    stockStatus: product.stockStatus || (Number(product.stock || 0) > 0 ? "inStock" : "outOfStock"),
    availablePieces: product.availablePieces === undefined || product.availablePieces === "" ? null : Number(product.availablePieces),
    rating: product.rating === undefined || product.rating === "" ? null : Number(product.rating),
    reviewCount: Number(product.reviewCount || 0),
    isPopular: Boolean(product.isPopular)
  }));
  normalized.users = normalized.users.map((user) => ({
    id: user.id,
    name: user.name || "",
    email: user.email || "",
    phone: user.phone || "",
    avatarUrl: user.avatarUrl || "",
    address: normalizeAddress(user.address),
    walletBalance: Number(user.walletBalance || 0)
  }));
  normalized.orders = normalized.orders.map((order) => ({
    id: order.id || order.orderNumber || crypto.randomUUID(),
    items: Array.isArray(order.items) ? order.items : [],
    total: Number(order.total || 0),
    status: order.status || "pending",
    createdAt: order.createdAt || new Date().toISOString(),
    deliveryAddress: normalizeAddress(order.deliveryAddress),
    paymentMethod: order.paymentMethod || "wallet",
    notes: order.notes || "",
    assignedWorkerId: order.assignedWorkerId || order.workerId || "",
    userId: order.userId || "",
    userName: order.userName || "",
    userPhone: order.userPhone || ""
  }));
  normalized.workers = normalized.workers.map((worker) => ({
    id: worker.id,
    name: worker.name || "",
    email: worker.email || "",
    phone: worker.phone || "",
    avatarUrl: worker.avatarUrl || "",
    status: worker.status || "free",
    currentOrderId: worker.currentOrderId || "",
    completedOrders: Number(worker.completedOrders || 0),
    totalEarnings: Number(worker.totalEarnings || 0),
    rating: Number(worker.rating || 0),
    joinedAt: worker.joinedAt || "",
    vehicleType: worker.vehicleType || "",
    vehiclePlate: worker.vehiclePlate || "",
    address: worker.address || "",
    nationalId: worker.nationalId || "",
    isActive: worker.isActive !== false
  }));
  return normalized;
}

function normalizeAddress(address) {
  if (typeof address === "string") {
    return { street: address, city: "", state: "", country: "", postalCode: "" };
  }
  return {
    street: address?.street || "",
    city: address?.city || "",
    state: address?.state || "",
    country: address?.country || "",
    postalCode: address?.postalCode || ""
  };
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(querystring.parse(body)));
    req.on("error", reject);
  });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendHtml(res, html, statusCode = 200) {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function getName(items, id, fallback = "Unassigned") {
  return items.find((item) => item.id === id)?.name || fallback;
}

function fullAddress(address) {
  const item = normalizeAddress(address);
  return [item.street, item.city, item.state, item.country, item.postalCode].filter(Boolean).join(", ");
}

function splitList(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function options(items, selectedId, placeholder = "Choose one") {
  return `<option value="">${escapeHtml(placeholder)}</option>${items
    .map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(item.name)}</option>`)
    .join("")}`;
}

function rowActions(resource, item) {
  return `<form class="inline-actions" method="post" action="/${resource}/delete" onsubmit="return confirm('Delete this item? This cannot be undone.')">
    <input type="hidden" name="id" value="${escapeHtml(item.id)}">
    <button class="danger" type="submit" title="Delete">Delete</button>
  </form>`;
}

function badge(kind, status) {
  const key = String(status || "").toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return `<span class="badge badge-${escapeHtml(kind)}-${escapeHtml(key)}">${escapeHtml(status)}</span>`;
}

function avatar(url, name, large = false) {
  if (url) {
    return `<img class="avatar-img${large ? " avatar-lg" : ""}" src="${escapeHtml(url)}" alt="${escapeHtml(name)}">`;
  }
  const initials = clean(name).slice(0, 1).toUpperCase() || "?";
  return `<span class="avatar-fallback${large ? " avatar-lg" : ""}">${escapeHtml(initials)}</span>`;
}

function layout({ activeTab, message = "", body }) {
  const nav = tabs
    .map((tab) => `<a class="${tab.id === activeTab ? "active" : ""}" href="/?tab=${tab.id}"><span>${escapeHtml(tab.icon)}</span>${escapeHtml(tab.label)}</a>`)
    .join("");
  const activeLabel = tabs.find((tab) => tab.id === activeTab)?.label || "Dashboard";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shoppy Admin</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <aside class="sidebar">
    <a class="brand" href="/">
      <span class="brand-mark">S</span>
      <span class="brand-text"><strong>Shoppy</strong><small>Admin Dashboard</small></span>
    </a>
    <nav class="tabs">${nav}</nav>
  </aside>
  <main class="workspace">
    <header class="topbar">
      <div>
        <p class="eyebrow">Shoppy Admin</p>
        <h1>${escapeHtml(activeLabel)}</h1>
      </div>
      <div class="status-pill">${usesFirestore() ? "Firestore connected" : "Local JSON mode"}</div>
    </header>
    ${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}
    ${body}
  </main>
</body>
</html>`;
}

function field(label, name, value = "", attrs = "") {
  return `<label>${escapeHtml(label)}<input name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${attrs}></label>`;
}

function checkboxField(label, name, checked = false) {
  return `<label class="check"><input type="checkbox" name="${escapeHtml(name)}" value="true" ${checked ? "checked" : ""}>${escapeHtml(label)}</label>`;
}

function selectField(label, name, items, selectedId, placeholder) {
  return `<label>${escapeHtml(label)}<select name="${escapeHtml(name)}">${options(items, selectedId, placeholder)}</select></label>`;
}

function addressFields(prefix, address = {}) {
  const item = normalizeAddress(address);
  return `${field("Street", `${prefix}Street`, item.street)}
    ${field("City", `${prefix}City`, item.city)}
    ${field("State", `${prefix}State`, item.state)}
    ${field("Country", `${prefix}Country`, item.country)}
    ${field("Postal code", `${prefix}PostalCode`, item.postalCode)}`;
}

function addressFromForm(form, prefix) {
  return {
    street: clean(form[`${prefix}Street`]),
    city: clean(form[`${prefix}City`]),
    state: clean(form[`${prefix}State`]),
    country: clean(form[`${prefix}Country`]),
    postalCode: clean(form[`${prefix}PostalCode`])
  };
}

function statCards(db) {
  const stats = [
    ["Products", db.products.length],
    ["Categories", db.categories.length],
    ["Subcategories", db.subcategories.length],
    ["Users", db.users.length],
    ["Open orders", db.orders.filter((order) => order.status !== "delivered").length],
    ["Workers", db.workers.length]
  ];

  return `<section class="stats">${stats.map(([label, value]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("")}</section>`;
}

function categoriesTab(db) {
  const categoryRows = db.categories
    .map(
      (category) => `<tr>
        <td>${escapeHtml(category.name)}</td>
        <td>${category.imageUrl ? `<a href="${escapeHtml(category.imageUrl)}" target="_blank">Image</a>` : ""}</td>
        <td>${category.subcategories.length}</td>
        <td>
          <form class="row-form" method="post" action="/categories/update">
            <input type="hidden" name="id" value="${escapeHtml(category.id)}">
            <input name="name" value="${escapeHtml(category.name)}" required>
            <input name="imageUrl" value="${escapeHtml(category.imageUrl)}" placeholder="Image URL" required>
            <button type="submit">Update</button>
          </form>
        </td>
        <td>${rowActions("categories", category)}</td>
      </tr>`
    )
    .join("");

  return `${statCards(db)}
    <section class="panel compact">
      <h2>Add category</h2>
      <form class="form-grid" method="post" action="/categories/add">
        ${field("Name", "name", "", "required")}
        ${field("Image URL", "imageUrl", "", "required")}
        <button type="submit">Add category</button>
      </form>
    </section>
    ${tablePanel("Categories", ["Name", "Image", "Subcategories", "Edit", ""], categoryRows)}`;
}

function subcategoriesTab(db) {
  const subcategoryRows = db.subcategories
    .map(
      (subcategory) => `<tr>
        <td>${escapeHtml(subcategory.name)}</td>
        <td>${subcategory.imageUrl ? `<a href="${escapeHtml(subcategory.imageUrl)}" target="_blank">Image</a>` : ""}</td>
        <td>${escapeHtml(getName(db.categories, subcategory.parentCategoryId))}</td>
        <td>
          <form class="row-form" method="post" action="/subcategories/update">
            <input type="hidden" name="id" value="${escapeHtml(subcategory.id)}">
            <input name="name" value="${escapeHtml(subcategory.name)}" required>
            <input name="imageUrl" value="${escapeHtml(subcategory.imageUrl)}" placeholder="Image URL" required>
            <select name="parentCategoryId">${options(db.categories, subcategory.parentCategoryId, "Choose category")}</select>
            <button type="submit">Update</button>
          </form>
        </td>
        <td>${rowActions("subcategories", subcategory)}</td>
      </tr>`
    )
    .join("");

  return `${statCards(db)}
    <section class="panel compact">
      <h2>Add subcategory</h2>
      <form class="form-grid" method="post" action="/subcategories/add">
        ${field("Name", "name", "", "required")}
        ${field("Image URL", "imageUrl", "", "required")}
        ${selectField("Parent category", "parentCategoryId", db.categories, "", "Choose category")}
        <button type="submit">Add subcategory</button>
      </form>
    </section>
    ${tablePanel("Subcategories", ["Name", "Image", "Parent category", "Edit", ""], subcategoryRows)}`;
}

function productsTab(db) {
  const productRows = db.products
    .map(
      (product) => `<tr>
        <td>${escapeHtml(product.name)}</td>
        <td>${product.imageUrl ? `<a href="${escapeHtml(product.imageUrl)}" target="_blank">Image</a>` : ""}</td>
        <td>${escapeHtml(getName(db.categories, product.categoryId))}</td>
        <td>${escapeHtml(getName(db.subcategories, product.subcategoryId))}</td>
        <td>${money(product.price)}</td>
        <td>${badge("stock", product.stockStatus)}</td>
        <td>${product.availablePieces ?? ""}</td>
        <td>${product.rating ?? ""}</td>
        <td>${escapeHtml(product.reviewCount)}</td>
        <td>${product.isPopular ? "Yes" : "No"}</td>
        <td>
          <form class="row-form entity" method="post" action="/products/update">
            <input type="hidden" name="id" value="${escapeHtml(product.id)}">
            <input name="name" value="${escapeHtml(product.name)}" required>
            <input name="description" value="${escapeHtml(product.description)}" placeholder="Description" required>
            <input name="imageUrl" value="${escapeHtml(product.imageUrl)}" placeholder="Image URL" required>
            <input name="additionalImages" value="${escapeHtml(product.additionalImages.join(", "))}" placeholder="Extra image URLs">
            <select name="categoryId">${options(db.categories, product.categoryId, "Category")}</select>
            <select name="subcategoryId">${options(db.subcategories, product.subcategoryId, "Subcategory")}</select>
            <input name="price" type="number" min="0" step="0.01" value="${escapeHtml(product.price)}" required>
            <select name="stockStatus">${stockStatusOptions(product.stockStatus)}</select>
            <input name="availablePieces" type="number" min="0" step="1" value="${escapeHtml(product.availablePieces ?? "")}" placeholder="Pieces">
            <input name="rating" type="number" min="0" max="5" step="0.1" value="${escapeHtml(product.rating ?? "")}" placeholder="Rating">
            <input name="reviewCount" type="number" min="0" step="1" value="${escapeHtml(product.reviewCount)}" placeholder="Reviews">
            ${checkboxField("Popular", "isPopular", product.isPopular)}
            <button type="submit">Update</button>
          </form>
        </td>
        <td>${rowActions("products", product)}</td>
      </tr>`
    )
    .join("");

  return `${statCards(db)}
    <section class="panel compact">
      <h2>Add product</h2>
      <form class="form-grid" method="post" action="/products/add">
        ${field("Name", "name", "", "required")}
        ${field("Description", "description", "", "required")}
        ${field("Image URL", "imageUrl", "", "required")}
        ${field("Additional images", "additionalImages", "", "placeholder=\"Comma separated URLs\"")}
        ${selectField("Category", "categoryId", db.categories, "", "Choose category")}
        ${selectField("Subcategory", "subcategoryId", db.subcategories, "", "Choose subcategory")}
        ${field("Price", "price", "", "type=\"number\" min=\"0\" step=\"0.01\" required")}
        <label>Stock status<select name="stockStatus">${stockStatusOptions("inStock")}</select></label>
        ${field("Available pieces", "availablePieces", "", "type=\"number\" min=\"0\" step=\"1\"")}
        ${field("Rating", "rating", "", "type=\"number\" min=\"0\" max=\"5\" step=\"0.1\"")}
        ${field("Review count", "reviewCount", "0", "type=\"number\" min=\"0\" step=\"1\"")}
        ${checkboxField("Popular", "isPopular")}
        <button type="submit">Add product</button>
      </form>
    </section>
    ${tablePanel("Products", ["Name", "Image", "Category", "Subcategory", "Price", "Stock", "Pieces", "Rating", "Reviews", "Popular", "Edit", ""], productRows)}`;
}

function usersTab(db) {
  const rows = db.users
    .map(
      (user) => `<tr>
        <td>
          <a class="user-link" href="/users/${encodeURIComponent(user.id)}">
            ${avatar(user.avatarUrl, user.name)}
            <span>${escapeHtml(user.name) || "Unnamed"}</span>
          </a>
        </td>
        <td>${escapeHtml(user.email)}</td>
        <td>${escapeHtml(user.phone)}</td>
        <td>${escapeHtml(fullAddress(user.address)) || "—"}</td>
        <td>${money(user.walletBalance)}</td>
        <td><a class="btn-outline" href="/users/${encodeURIComponent(user.id)}">View</a></td>
      </tr>`
    )
    .join("");

  return `${statCards(db)}
    <section class="panel compact">
      <h2>Add user</h2>
      <form class="form-grid" method="post" action="/users/add">
        ${field("Name", "name", "", "required")}
        ${field("Email", "email", "", "type=\"email\" required")}
        ${field("Phone", "phone", "", "required")}
        ${field("Avatar URL", "avatarUrl")}
        ${addressFields("address")}
        ${field("Wallet balance", "walletBalance", "0", "type=\"number\" min=\"0\" step=\"0.01\"")}
        <button type="submit">Add user</button>
      </form>
    </section>
    ${tablePanel("Users", ["User", "Email", "Phone", "Address", "Wallet", ""], rows)}`;
}

function userDetailPage(user, message = "") {
  return `<a class="back-link" href="/?tab=users">&larr; Back to users</a>
    ${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}
    <section class="panel detail-panel">
      <div class="detail-header">
        ${avatar(user.avatarUrl, user.name, true)}
        <div>
          <h2>${escapeHtml(user.name) || "Unnamed user"}</h2>
          <p class="muted">${escapeHtml(user.email) || "No email on file"}</p>
        </div>
      </div>
      <form class="form-grid" method="post" action="/users/update">
        <input type="hidden" name="id" value="${escapeHtml(user.id)}">
        ${field("Name", "name", user.name, "required")}
        ${field("Email", "email", user.email, "type=\"email\" required")}
        ${field("Phone", "phone", user.phone)}
        ${field("Avatar URL", "avatarUrl", user.avatarUrl)}
        ${addressFields("address", user.address)}
        ${field("Wallet balance", "walletBalance", user.walletBalance, "type=\"number\" min=\"0\" step=\"0.01\"")}
        <button type="submit">Save changes</button>
      </form>
    </section>
    <section class="panel danger-zone">
      <h2>Danger zone</h2>
      <p class="muted">Deleting a user removes their record permanently. This cannot be undone.</p>
      <form method="post" action="/users/delete" onsubmit="return confirm('Delete this user? This cannot be undone.')">
        <input type="hidden" name="id" value="${escapeHtml(user.id)}">
        <button class="danger" type="submit">Delete user</button>
      </form>
    </section>`;
}

function ordersTab(db) {
  const rows = db.orders
    .map(
      (order) => {
        const firstItem = order.items[0] || {};
        const productId = firstItem.product?.id || "";
        const quantity = firstItem.quantity || 1;
        return `<tr>
        <td>${escapeHtml(order.id)}</td>
        <td>${escapeHtml(order.userName || getName(db.users, order.userId, "Guest"))}</td>
        <td>${escapeHtml(firstItem.product?.name || getName(db.products, productId, "No product"))} x ${escapeHtml(quantity)}</td>
        <td>${escapeHtml(getName(db.workers, order.assignedWorkerId, "Not assigned"))}</td>
        <td>${badge("order", order.status)}</td>
        <td>${escapeHtml(order.paymentMethod)}</td>
        <td>${money(order.total)}</td>
        <td>${escapeHtml(fullAddress(order.deliveryAddress))}</td>
        <td>
          <form class="row-form entity" method="post" action="/orders/update">
            <input type="hidden" name="id" value="${escapeHtml(order.id)}">
            <select name="userId">${options(db.users, order.userId, "User")}</select>
            <input name="userName" value="${escapeHtml(order.userName)}" placeholder="User name">
            <input name="userPhone" value="${escapeHtml(order.userPhone)}" placeholder="User phone">
            <select name="productId">${options(db.products, productId, "Product")}</select>
            <input name="quantity" type="number" min="1" step="1" value="${escapeHtml(quantity)}" required>
            <select name="assignedWorkerId">${options(db.workers, order.assignedWorkerId, "Worker")}</select>
            <select name="status">${statusOptions(order.status)}</select>
            <select name="paymentMethod">${paymentMethodOptions(order.paymentMethod)}</select>
            <input name="total" type="number" min="0" step="0.01" value="${escapeHtml(order.total)}" required>
            <input name="notes" value="${escapeHtml(order.notes)}" placeholder="Notes">
            ${addressFields("delivery", order.deliveryAddress)}
            <button type="submit">Update</button>
          </form>
        </td>
        <td>${rowActions("orders", order)}</td>
      </tr>`;
      }
    )
    .join("");

  return `${statCards(db)}
    <section class="panel compact">
      <h2>Add order</h2>
      <form class="form-grid" method="post" action="/orders/add">
        ${selectField("User", "userId", db.users, "", "Choose user")}
        ${field("User name", "userName")}
        ${field("User phone", "userPhone")}
        ${selectField("Product", "productId", db.products, "", "Choose product")}
        ${field("Quantity", "quantity", "1", "type=\"number\" min=\"1\" step=\"1\" required")}
        ${selectField("Assigned worker", "assignedWorkerId", db.workers, "", "Choose worker")}
        <label>Status<select name="status">${statusOptions("pending")}</select></label>
        <label>Payment method<select name="paymentMethod">${paymentMethodOptions("wallet")}</select></label>
        ${field("Total", "total", "", "type=\"number\" min=\"0\" step=\"0.01\" required")}
        ${field("Notes", "notes")}
        ${addressFields("delivery")}
        <button type="submit">Add order</button>
      </form>
    </section>
    ${tablePanel("Orders", ["ID", "User", "Items", "Worker", "Status", "Payment", "Total", "Address", "Edit", ""], rows)}`;
}

function workersTab(db) {
  const rows = db.workers
    .map(
      (worker) => `<tr>
        <td>${escapeHtml(worker.name)}</td>
        <td>${escapeHtml(worker.email)}</td>
        <td>${escapeHtml(worker.phone)}</td>
        <td>${badge("worker", worker.status)}</td>
        <td>${escapeHtml(worker.vehicleType)}</td>
        <td>${escapeHtml(worker.vehiclePlate)}</td>
        <td>${money(worker.totalEarnings)}</td>
        <td>${escapeHtml(worker.rating)}</td>
        <td>${worker.isActive ? "Yes" : "No"}</td>
        <td>
          <form class="row-form entity" method="post" action="/workers/update">
            <input type="hidden" name="id" value="${escapeHtml(worker.id)}">
            <input name="name" value="${escapeHtml(worker.name)}" required>
            <input name="email" type="email" value="${escapeHtml(worker.email)}" required>
            <input name="phone" value="${escapeHtml(worker.phone)}" required>
            <input name="avatarUrl" value="${escapeHtml(worker.avatarUrl)}" placeholder="Avatar URL">
            <select name="status">${workerStatusOptions(worker.status)}</select>
            <input name="currentOrderId" value="${escapeHtml(worker.currentOrderId)}" placeholder="Current order ID">
            <input name="completedOrders" type="number" min="0" step="1" value="${escapeHtml(worker.completedOrders)}" placeholder="Completed">
            <input name="totalEarnings" type="number" min="0" step="0.01" value="${escapeHtml(worker.totalEarnings)}" placeholder="Earnings">
            <input name="rating" type="number" min="0" max="5" step="0.1" value="${escapeHtml(worker.rating)}" placeholder="Rating">
            <input name="joinedAt" type="date" value="${escapeHtml(worker.joinedAt ? worker.joinedAt.slice(0, 10) : "")}">
            <input name="vehicleType" value="${escapeHtml(worker.vehicleType)}" placeholder="Vehicle type">
            <input name="vehiclePlate" value="${escapeHtml(worker.vehiclePlate)}" placeholder="Vehicle plate">
            <input name="address" value="${escapeHtml(worker.address)}" placeholder="Address">
            <input name="nationalId" value="${escapeHtml(worker.nationalId)}" placeholder="National ID">
            ${checkboxField("Active", "isActive", worker.isActive)}
            <button type="submit">Update</button>
          </form>
        </td>
        <td>${rowActions("workers", worker)}</td>
      </tr>`
    )
    .join("");

  return `${statCards(db)}
    <section class="panel compact">
      <h2>Add worker</h2>
      <form class="form-grid" method="post" action="/workers/add">
        ${field("Name", "name", "", "required")}
        ${field("Email", "email", "", "type=\"email\" required")}
        ${field("Phone", "phone", "", "required")}
        ${field("Avatar URL", "avatarUrl")}
        <label>Status<select name="status">${workerStatusOptions("free")}</select></label>
        ${field("Current order ID", "currentOrderId")}
        ${field("Completed orders", "completedOrders", "0", "type=\"number\" min=\"0\" step=\"1\"")}
        ${field("Total earnings", "totalEarnings", "0", "type=\"number\" min=\"0\" step=\"0.01\"")}
        ${field("Rating", "rating", "0", "type=\"number\" min=\"0\" max=\"5\" step=\"0.1\"")}
        ${field("Joined at", "joinedAt", "", "type=\"date\"")}
        ${field("Vehicle type", "vehicleType")}
        ${field("Vehicle plate", "vehiclePlate")}
        ${field("Address", "address")}
        ${field("National ID", "nationalId")}
        ${checkboxField("Active", "isActive", true)}
        <button type="submit">Add worker</button>
      </form>
    </section>
    ${tablePanel("Workers", ["Name", "Email", "Phone", "Status", "Vehicle", "Plate", "Earnings", "Rating", "Active", "Edit", ""], rows)}`;
}

function tablePanel(title, headers, rows) {
  return `<section class="panel table-panel">
    <h2>${escapeHtml(title)}</h2>
    ${
      rows
        ? `<div class="table-wrap"><table>
            <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`
        : `<p class="empty">No ${escapeHtml(title.toLowerCase())} yet.</p>`
    }
  </section>`;
}

function statusOptions(selected) {
  return ["pending", "processing", "outForDelivery", "delivered", "cancelled"]
    .map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${status}</option>`)
    .join("");
}

function workerStatusOptions(selected) {
  return ["free", "busy", "offline"]
    .map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${status}</option>`)
    .join("");
}

function stockStatusOptions(selected) {
  return ["inStock", "outOfStock", "lowStock"]
    .map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${status}</option>`)
    .join("");
}

function paymentMethodOptions(selected) {
  return ["wallet", "cash", "card"]
    .map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${status}</option>`)
    .join("");
}

function clean(value) {
  return String(value || "").trim();
}

function optionalNumber(value) {
  const cleaned = clean(value);
  return cleaned === "" ? null : Number(cleaned);
}

function productValues(form) {
  return {
    name: clean(form.name),
    description: clean(form.description),
    imageUrl: clean(form.imageUrl),
    additionalImages: splitList(form.additionalImages),
    price: Number(form.price || 0),
    categoryId: clean(form.categoryId),
    subcategoryId: clean(form.subcategoryId),
    stockStatus: clean(form.stockStatus) || "inStock",
    availablePieces: optionalNumber(form.availablePieces),
    rating: optionalNumber(form.rating),
    reviewCount: Number(form.reviewCount || 0),
    isPopular: form.isPopular === "true"
  };
}

function userValues(form) {
  return {
    name: clean(form.name),
    email: clean(form.email),
    phone: clean(form.phone),
    avatarUrl: clean(form.avatarUrl),
    address: addressFromForm(form, "address"),
    walletBalance: Number(form.walletBalance || 0)
  };
}

function orderValues(db, form, existingOrder = {}) {
  const product = db.products.find((item) => item.id === clean(form.productId));
  const quantity = Number(form.quantity || 1);
  const user = db.users.find((item) => item.id === clean(form.userId));

  return {
    items: product
      ? [
          {
            id: existingOrder.items?.[0]?.id || crypto.randomUUID(),
            product,
            quantity
          }
        ]
      : [],
    total: Number(form.total || 0),
    status: clean(form.status) || "pending",
    createdAt: existingOrder.createdAt || new Date().toISOString(),
    deliveryAddress: addressFromForm(form, "delivery"),
    paymentMethod: clean(form.paymentMethod) || "wallet",
    notes: clean(form.notes),
    assignedWorkerId: clean(form.assignedWorkerId),
    userId: clean(form.userId),
    userName: clean(form.userName) || user?.name || "",
    userPhone: clean(form.userPhone) || user?.phone || ""
  };
}

function workerValues(form) {
  return {
    name: clean(form.name),
    email: clean(form.email),
    phone: clean(form.phone),
    avatarUrl: clean(form.avatarUrl),
    status: clean(form.status) || "free",
    currentOrderId: clean(form.currentOrderId),
    completedOrders: Number(form.completedOrders || 0),
    totalEarnings: Number(form.totalEarnings || 0),
    rating: Number(form.rating || 0),
    joinedAt: clean(form.joinedAt),
    vehicleType: clean(form.vehicleType),
    vehiclePlate: clean(form.vehiclePlate),
    address: clean(form.address),
    nationalId: clean(form.nationalId),
    isActive: form.isActive === "true"
  };
}

function addItem(db, collection, values) {
  db[collection].push({ id: crypto.randomUUID(), ...values, createdAt: new Date().toISOString() });
}

function updateItem(db, collection, id, values) {
  db[collection] = db[collection].map((item) => (item.id === id ? { ...item, ...values, updatedAt: new Date().toISOString() } : item));
}

function deleteItem(db, collection, id) {
  db[collection] = db[collection].filter((item) => item.id !== id);
}

async function mutate(req, res, collection, tab, handlers, buildRedirect) {
  const form = await parseBody(req);
  const db = await readDb();
  handlers[collection](db, form);
  await writeDb(db);
  redirect(res, buildRedirect ? buildRedirect(form) : `/?tab=${tab}&message=Saved`);
}

async function serveStatic(req, res) {
  const requestedPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const filePath = path.join(PUBLIC_DIR, path.basename(requestedPath));
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    res.end(content);
  } catch {
    sendHtml(res, "Not found", 404);
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/styles.css") return serveStatic(req, res);

  if (req.method === "GET" && url.pathname === "/") {
    const db = await readDb();
    const activeTab = tabs.some((tab) => tab.id === url.searchParams.get("tab")) ? url.searchParams.get("tab") : "products";
    const body = {
      products: productsTab,
      categories: categoriesTab,
      subcategories: subcategoriesTab,
      users: usersTab,
      orders: ordersTab,
      workers: workersTab
    }[activeTab](db);

    return sendHtml(res, layout({ activeTab, message: url.searchParams.get("message") || "", body }));
  }

  if (req.method === "GET") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "users" && segments.length === 2) {
      const db = await readDb();
      const user = db.users.find((item) => item.id === segments[1]);
      if (!user) {
        return sendHtml(
          res,
          layout({
            activeTab: "users",
            body: `<a class="back-link" href="/?tab=users">&larr; Back to users</a><section class="panel"><h2>User not found</h2><p class="muted">It may have already been deleted.</p></section>`
          }),
          404
        );
      }
      return sendHtml(res, layout({ activeTab: "users", body: userDetailPage(user, url.searchParams.get("message") || "") }));
    }
  }

  if (req.method === "POST") {
    const [resource, action] = url.pathname.split("/").filter(Boolean);
    const tabByResource = {
      categories: "categories",
      subcategories: "subcategories",
      products: "products",
      users: "users",
      orders: "orders",
      workers: "workers"
    };
    const collection = tabByResource[resource] ? resource : null;

    if (collection && ["add", "update", "delete"].includes(action)) {
      const handlers = {
        categories: (db, form) => {
          if (action === "add") addItem(db, "categories", { name: clean(form.name), imageUrl: clean(form.imageUrl), subcategories: [] });
          if (action === "update") updateItem(db, "categories", clean(form.id), { name: clean(form.name), imageUrl: clean(form.imageUrl) });
          if (action === "delete") {
            deleteItem(db, "categories", clean(form.id));
            db.subcategories = db.subcategories.filter((item) => item.parentCategoryId !== clean(form.id));
            db.products = db.products.map((item) => (item.categoryId === clean(form.id) ? { ...item, categoryId: "", subcategoryId: "" } : item));
          }
        },
        subcategories: (db, form) => {
          if (action === "add") addItem(db, "subcategories", { name: clean(form.name), imageUrl: clean(form.imageUrl), parentCategoryId: clean(form.parentCategoryId) });
          if (action === "update") updateItem(db, "subcategories", clean(form.id), { name: clean(form.name), imageUrl: clean(form.imageUrl), parentCategoryId: clean(form.parentCategoryId) });
          if (action === "delete") {
            deleteItem(db, "subcategories", clean(form.id));
            db.products = db.products.map((item) => (item.subcategoryId === clean(form.id) ? { ...item, subcategoryId: "" } : item));
          }
        },
        products: (db, form) => {
          const values = productValues(form);
          if (action === "add") addItem(db, "products", values);
          if (action === "update") updateItem(db, "products", clean(form.id), values);
          if (action === "delete") deleteItem(db, "products", clean(form.id));
        },
        users: (db, form) => {
          const values = userValues(form);
          if (action === "add") addItem(db, "users", values);
          if (action === "update") updateItem(db, "users", clean(form.id), values);
          if (action === "delete") deleteItem(db, "users", clean(form.id));
        },
        orders: (db, form) => {
          const existingOrder = db.orders.find((item) => item.id === clean(form.id)) || {};
          const values = orderValues(db, form, existingOrder);
          if (action === "add") addItem(db, "orders", values);
          if (action === "update") updateItem(db, "orders", clean(form.id), values);
          if (action === "delete") deleteItem(db, "orders", clean(form.id));
        },
        workers: (db, form) => {
          const values = workerValues(form);
          if (action === "add") addItem(db, "workers", values);
          if (action === "update") updateItem(db, "workers", clean(form.id), values);
          if (action === "delete") deleteItem(db, "workers", clean(form.id));
        }
      };

      const buildRedirect =
        resource === "users" && action === "update"
          ? (form) => `/users/${encodeURIComponent(clean(form.id))}?message=Saved`
          : undefined;

      return mutate(req, res, collection, tabByResource[resource], handlers, buildRedirect);
    }
  }

  sendHtml(res, layout({ activeTab: "products", body: `<section class="panel"><h2>Page not found</h2><p><a href="/">Return dashboard</a></p></section>` }), 404);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    sendHtml(res, "Server error", 500);
  });
});

ensureStore().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Database: ${usesFirestore() ? "Cloud Firestore" : "local JSON file"}`);
  });
});
