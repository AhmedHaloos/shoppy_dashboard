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
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const IS_PROD = Boolean(process.env.VERCEL);
let firestoreToken = null;
let firestoreTokenExpiresAt = 0;

// Real collection names used by the live shoppy app / Flutter admin dashboard
// (blog-56c04). "users" here maps to the app's "customers" collection —
// everything else matches 1:1. See _Col in the Flutter app's
// firebase_datasource.dart for the source of truth.
const FIRESTORE_COLLECTION_NAMES = {
  categories: "categories",
  subcategories: "subcategories",
  products: "products",
  users: "customers",
  orders: "orders",
  workers: "workers",
  admins: "admins"
};

const emptyDb = {
  categories: [],
  subcategories: [],
  products: [],
  users: [],
  orders: [],
  workers: []
};

const tabs = [
  { id: "products", label: "Products", icon: "box" },
  { id: "categories", label: "Categories", icon: "folder" },
  { id: "subcategories", label: "Subcategories", icon: "tag" },
  { id: "users", label: "Users", icon: "users" },
  { id: "orders", label: "Orders", icon: "receipt" },
  { id: "workers", label: "Workers", icon: "truck" }
];

const ICONS = {
  box: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 7l9-4 9 4"/><line x1="12" y1="7" x2="12" y2="20"/>',
  folder:
    '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l1.7 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  tag: '<path d="M20.5 12.5 12 21l-9-9V4h8z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  users:
    '<circle cx="9" cy="8" r="3.3"/><path d="M2.7 20c0-3.8 2.8-6.2 6.3-6.2s6.3 2.4 6.3 6.2"/><circle cx="17.2" cy="9" r="2.6"/><path d="M15.7 13.3c2.5.5 4.3 2.6 4.3 5.1"/>',
  receipt: '<path d="M6 3h12v18l-2.5-1.7L13 21l-2.5-1.7L8 21l-2-1.7z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/>',
  truck:
    '<rect x="1.5" y="8" width="12.5" height="9" rx="1.3"/><path d="M14 11h4l3.5 3.2V17H14z"/><circle cx="6" cy="18.5" r="1.7"/><circle cx="17" cy="18.5" r="1.7"/>',
  back: '<path d="M19 12H5"/><path d="M11 18l-6-6 6-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>'
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
}

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

function authConfigured() {
  return usesFirestore() && Boolean(FIREBASE_WEB_API_KEY) && Boolean(SESSION_SECRET);
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

// Local-JSON-mode persistence only. In Firestore mode, mutations write
// directly to individual documents (see addItem/updateItem/deleteItem
// below) instead of a bulk write — see the note on syncFirestoreCollection's
// removal further down for why.
async function writeDb(db) {
  const normalizedDb = normalizeDb(db);
  await fs.writeFile(DB_FILE, `${JSON.stringify(normalizedDb, null, 2)}\n`);
}

function firestoreCollectionName(collection) {
  return FIRESTORE_COLLECTION_NAMES[collection] || collection;
}

function firestoreDocsRootUrl() {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/databases/(default)/documents`;
}

function firestoreCollectionUrl(collection) {
  return `${firestoreDocsRootUrl()}/${encodeURIComponent(firestoreCollectionName(collection))}`;
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

async function firestoreGetCollection(collection) {
  const response = await firestoreRequest(firestoreCollectionUrl(collection));
  if (response.status === 404) return [];
  const data = await response.json();
  return (data.documents || []).map((document) => ({
    // Spread decoded fields first so the real Firestore document ID always
    // wins over a possibly-stale embedded "id" field, since the doc ID is
    // what every write/delete/query below actually addresses by.
    ...decodeFirestoreFields(document.fields || {}),
    id: document.name.split("/").pop()
  }));
}

async function readFirestoreDb() {
  const db = { ...emptyDb };
  await Promise.all(
    Object.keys(emptyDb).map(async (collection) => {
      db[collection] = await firestoreGetCollection(collection);
    })
  );
  return db;
}

// Order.createdAt is a real Firestore Timestamp in the live app (written by
// the shoppy customer app, read back via `(json['createdAt'] as Timestamp)`
// in OrderModel.fromJson — a hard cast that crashes on anything else), not
// a plain string. Every other date-ish field in this app (Worker.joinedAt)
// really is a plain ISO string in Firestore, so only orders need this.
function firestoreTimestamp(iso) {
  return { __ts: iso };
}

function prepareForFirestore(collection, fields) {
  if (collection === "orders" && fields.createdAt) {
    return { ...fields, createdAt: firestoreTimestamp(fields.createdAt) };
  }
  return fields;
}

async function firestoreCreateDoc(collection, id, fields) {
  await firestoreRequest(`${firestoreCollectionUrl(collection)}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: encodeFirestoreFields(prepareForFirestore(collection, fields)) })
  });
}

// Partial update via updateMask — touches ONLY the given fields on the ONE
// target document. Deliberately not a full-collection read-diff-replace:
// this app used to sync each whole collection on every save (fine for its
// old isolated dashboard_* collections, since nothing else wrote there) —
// but pointed at the real shared collections, that pattern would delete
// any document written by another app (e.g. a customer's order placed via
// the shoppy app) in the moment between this app's read and write. Every
// mutation below must stay scoped to exactly the document(s) it means to
// touch.
async function firestoreUpdateDoc(collection, id, patch) {
  const prepared = prepareForFirestore(collection, patch);
  const keys = Object.keys(prepared);
  const mask = keys.map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`).join("&");
  const url = `${firestoreCollectionUrl(collection)}/${encodeURIComponent(id)}${mask ? `?${mask}` : ""}`;
  await firestoreRequest(url, {
    method: "PATCH",
    body: JSON.stringify({ fields: encodeFirestoreFields(prepared) })
  });
}

async function firestoreDeleteDoc(collection, id) {
  await firestoreRequest(`${firestoreCollectionUrl(collection)}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function firestoreQueryByField(collection, field, value) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: firestoreCollectionName(collection) }],
      where: {
        fieldFilter: {
          field: { fieldPath: field },
          op: "EQUAL",
          value: encodeFirestoreValue(value)
        }
      }
    }
  };
  const response = await firestoreRequest(`${firestoreDocsRootUrl()}:runQuery`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  const rows = await response.json();
  return rows
    .filter((row) => row.document)
    .map((row) => ({ ...decodeFirestoreFields(row.document.fields || {}), id: row.document.name.split("/").pop() }));
}

function encodeFirestoreFields(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, encodeFirestoreValue(value)]));
}

function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value && typeof value === "object" && "__ts" in value) return { timestampValue: value.__ts };
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

// ── Auth ──────────────────────────────────────────────────────────

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signSession(uid, email) {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payloadB64 = base64UrlEncode(JSON.stringify({ uid, email, exp }));
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

function verifySession(token) {
  if (!token || !SESSION_SECRET) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!payload.uid || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    out[decodeURIComponent(trimmed.slice(0, idx))] = decodeURIComponent(trimmed.slice(idx + 1));
  }
  return out;
}

function setSessionCookie(res, token) {
  const maxAge = 7 * 24 * 60 * 60;
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; ${IS_PROD ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `session=; HttpOnly; ${IS_PROD ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=0`);
}

const FIREBASE_AUTH_ERRORS = {
  EMAIL_NOT_FOUND: "No account with that email.",
  INVALID_PASSWORD: "Incorrect password.",
  INVALID_LOGIN_CREDENTIALS: "Incorrect email or password.",
  USER_DISABLED: "This account has been disabled.",
  TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Try again later."
};

async function firebaseSignIn(email, password) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const data = await response.json();
  if (!response.ok) {
    const code = data?.error?.message || "";
    throw new Error(FIREBASE_AUTH_ERRORS[code] || "Sign-in failed.");
  }
  return { uid: data.localId, email: data.email };
}

async function isAdmin(uid) {
  const response = await firestoreRequest(`${firestoreCollectionUrl("admins")}/${encodeURIComponent(uid)}`);
  return response.status !== 404;
}

function loginPage(error = "") {
  const configWarning = !authConfigured()
    ? `<p class="message message-error">Login isn't fully configured yet — missing ${[
        !usesFirestore() && "Firebase service account",
        !FIREBASE_WEB_API_KEY && "FIREBASE_WEB_API_KEY",
        !SESSION_SECRET && "SESSION_SECRET"
      ]
        .filter(Boolean)
        .join(", ")}.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Shoppy Admin</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="login-body">
  <main class="login-card">
    <div class="brand login-brand">
      <span class="brand-mark">S</span>
      <span class="brand-text"><strong>Shoppy</strong><small>Admin Dashboard</small></span>
    </div>
    ${configWarning}
    ${error ? `<p class="message message-error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/login">
      ${field("Email", "email", "", 'type="email" required autofocus')}
      ${field("Password", "password", "", 'type="password" required')}
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

// ── Layout & shared form helpers ─────────────────────────────────

function layout({ activeTab, message = "", body, session = null }) {
  const nav = tabs
    .map((tab) => `<a class="${tab.id === activeTab ? "active" : ""}" href="/?tab=${tab.id}"><span>${icon(tab.icon)}</span>${escapeHtml(tab.label)}</a>`)
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
    ${
      session
        ? `<form class="logout-form" method="post" action="/logout">
      <span class="session-email">${escapeHtml(session.email || "")}</span>
      <button class="btn-outline btn-outline-dark" type="submit">${icon("logout")}<span>Sign out</span></button>
    </form>`
        : ""
    }
  </aside>
  <main class="workspace">
    <header class="topbar">
      <div>
        <p class="eyebrow">Shoppy Admin</p>
        <h1>${escapeHtml(activeLabel)}</h1>
      </div>
      <div class="status-pill">${usesFirestore() ? "Live backend connected" : "Local JSON mode"}</div>
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

function addPanel(title, formHtml) {
  return `<details class="panel compact add-panel">
    <summary><span>${icon("plus")}Add ${escapeHtml(title)}</span><span class="chevron">${icon("chevron")}</span></summary>
    ${formHtml}
  </details>`;
}

function statCards(db) {
  const stats = [
    ["box", "Products", db.products.length],
    ["folder", "Categories", db.categories.length],
    ["tag", "Subcategories", db.subcategories.length],
    ["users", "Users", db.users.length],
    ["receipt", "Open orders", db.orders.filter((order) => order.status !== "delivered" && order.status !== "cancelled").length],
    ["truck", "Workers", db.workers.length]
  ];

  return `<section class="stats">${stats
    .map(([statIcon, label, value]) => `<div><span class="stat-icon">${icon(statIcon)}</span><strong>${value}</strong><span>${label}</span></div>`)
    .join("")}</section>`;
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
    ${addPanel(
      "category",
      `<form class="form-grid" method="post" action="/categories/add">
        ${field("Name", "name", "", "required")}
        ${field("Image URL", "imageUrl", "", "required")}
        <button type="submit">Add category</button>
      </form>`
    )}
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
    ${addPanel(
      "subcategory",
      `<form class="form-grid" method="post" action="/subcategories/add">
        ${field("Name", "name", "", "required")}
        ${field("Image URL", "imageUrl", "", "required")}
        ${selectField("Parent category", "parentCategoryId", db.categories, "", "Choose category")}
        <button type="submit">Add subcategory</button>
      </form>`
    )}
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
    ${addPanel(
      "product",
      `<form class="form-grid" method="post" action="/products/add">
        ${field("Name", "name", "", "required")}
        ${field("Description", "description", "", "required")}
        ${field("Image URL", "imageUrl", "", "required")}
        ${field("Additional images", "additionalImages", "", 'placeholder="Comma separated URLs"')}
        ${selectField("Category", "categoryId", db.categories, "", "Choose category")}
        ${selectField("Subcategory", "subcategoryId", db.subcategories, "", "Choose subcategory")}
        ${field("Price", "price", "", 'type="number" min="0" step="0.01" required')}
        <label>Stock status<select name="stockStatus">${stockStatusOptions("inStock")}</select></label>
        ${field("Available pieces", "availablePieces", "", 'type="number" min="0" step="1"')}
        ${field("Rating", "rating", "", 'type="number" min="0" max="5" step="0.1"')}
        ${field("Review count", "reviewCount", "0", 'type="number" min="0" step="1"')}
        ${checkboxField("Popular", "isPopular")}
        <button type="submit">Add product</button>
      </form>`
    )}
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
    ${addPanel(
      "user",
      `<form class="form-grid" method="post" action="/users/add">
        ${field("Name", "name", "", "required")}
        ${field("Email", "email", "", 'type="email" required')}
        ${field("Phone", "phone", "", "required")}
        ${field("Avatar URL", "avatarUrl")}
        ${addressFields("address")}
        ${field("Wallet balance", "walletBalance", "0", 'type="number" min="0" step="0.01"')}
        <button type="submit">Add user</button>
      </form>`
    )}
    ${tablePanel("Users", ["User", "Email", "Phone", "Address", "Wallet", ""], rows)}`;
}

function userDetailPage(user, message = "") {
  return `<a class="back-link" href="/?tab=users">${icon("back")}Back to users</a>
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
        ${field("Email", "email", user.email, 'type="email" required')}
        ${field("Phone", "phone", user.phone)}
        ${field("Avatar URL", "avatarUrl", user.avatarUrl)}
        ${addressFields("address", user.address)}
        ${field("Wallet balance", "walletBalance", user.walletBalance, 'type="number" min="0" step="0.01"')}
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
    .map((order) => {
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
    })
    .join("");

  return `${statCards(db)}
    ${addPanel(
      "order",
      `<form class="form-grid" method="post" action="/orders/add">
        ${selectField("User", "userId", db.users, "", "Choose user")}
        ${field("User name", "userName")}
        ${field("User phone", "userPhone")}
        ${selectField("Product", "productId", db.products, "", "Choose product")}
        ${field("Quantity", "quantity", "1", 'type="number" min="1" step="1" required')}
        ${selectField("Assigned worker", "assignedWorkerId", db.workers, "", "Choose worker")}
        <label>Status<select name="status">${statusOptions("pending")}</select></label>
        <label>Payment method<select name="paymentMethod">${paymentMethodOptions("wallet")}</select></label>
        ${field("Total", "total", "", 'type="number" min="0" step="0.01" required')}
        ${field("Notes", "notes")}
        ${addressFields("delivery")}
        <button type="submit">Add order</button>
      </form>`
    )}
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
    ${addPanel(
      "worker",
      `<form class="form-grid" method="post" action="/workers/add">
        ${field("Name", "name", "", "required")}
        ${field("Email", "email", "", 'type="email" required')}
        ${field("Phone", "phone", "", "required")}
        ${field("Avatar URL", "avatarUrl")}
        <label>Status<select name="status">${workerStatusOptions("free")}</select></label>
        ${field("Current order ID", "currentOrderId")}
        ${field("Completed orders", "completedOrders", "0", 'type="number" min="0" step="1"')}
        ${field("Total earnings", "totalEarnings", "0", 'type="number" min="0" step="0.01"')}
        ${field("Rating", "rating", "0", 'type="number" min="0" max="5" step="0.1"')}
        ${field("Joined at", "joinedAt", "", 'type="date"')}
        ${field("Vehicle type", "vehicleType")}
        ${field("Vehicle plate", "vehiclePlate")}
        ${field("Address", "address")}
        ${field("National ID", "nationalId")}
        ${checkboxField("Active", "isActive", true)}
        <button type="submit">Add worker</button>
      </form>`
    )}
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

// Enum values below match the real Flutter app's domain/entities/entities.dart
// exactly (OrderStatus, WorkerStatus, PaymentMethod) — this dashboard now
// writes directly into the same Firestore documents that app reads via a
// hard `OrderStatus.values.firstWhere(...)` etc., so an unrecognized value
// here would either silently fall back to a default on their side or, for
// createdAt's Timestamp cast, crash outright. Don't add values that don't
// exist in that enum without updating both sides.
function statusOptions(selected) {
  return ["pending", "confirmed", "assigned", "inDelivery", "delivered", "cancelled"]
    .map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${status}</option>`)
    .join("");
}

function workerStatusOptions(selected) {
  return ["free", "inDelivery", "offline"]
    .map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${status}</option>`)
    .join("");
}

// "lowStock" is a valid value in the admin app's own StockStatus enum, but
// deliberately not offered here — the shoppy CUSTOMER app's enum doesn't
// have it (inStock/outOfStock/preOrder only), and the Flutter dashboard
// already made this same call for the same cross-app-compat reason.
function stockStatusOptions(selected) {
  return ["inStock", "outOfStock"]
    .map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${status}</option>`)
    .join("");
}

function paymentMethodOptions(selected) {
  return ["wallet", "cashOnDelivery", "creditCard"]
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

// Each of these writes exactly one document in Firestore mode (see the
// comment on firestoreUpdateDoc above for why that matters) and falls back
// to mutating the in-memory snapshot in local-JSON mode, persisted by the
// single writeDb(db) call at the end of mutate().
async function addItem(db, collection, values) {
  const id = crypto.randomUUID();
  const item = { id, ...values, createdAt: new Date().toISOString() };
  if (usesFirestore()) {
    await firestoreCreateDoc(collection, id, item);
  } else {
    db[collection].push(item);
  }
  return item;
}

async function updateItem(db, collection, id, values) {
  const patch = { ...values, updatedAt: new Date().toISOString() };
  if (usesFirestore()) {
    await firestoreUpdateDoc(collection, id, patch);
  } else {
    db[collection] = db[collection].map((item) => (item.id === id ? { ...item, ...patch } : item));
  }
}

async function deleteItem(db, collection, id) {
  if (usesFirestore()) {
    await firestoreDeleteDoc(collection, id);
  } else {
    db[collection] = db[collection].filter((item) => item.id !== id);
  }
}

async function mutate(req, res, collection, tab, handlers, buildRedirect) {
  const form = await parseBody(req);
  const db = await readDb();
  await handlers[collection](db, form);
  if (!usesFirestore()) {
    await writeDb(db);
  }
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

  if (url.pathname === "/login" && req.method === "GET") {
    return sendHtml(res, loginPage(url.searchParams.get("error") || ""));
  }

  if (url.pathname === "/login" && req.method === "POST") {
    if (!authConfigured()) {
      return sendHtml(res, loginPage(), 500);
    }
    const form = await parseBody(req);
    try {
      const { uid, email } = await firebaseSignIn(clean(form.email), String(form.password || ""));
      if (!(await isAdmin(uid))) {
        return sendHtml(res, loginPage("This account isn't registered as an admin."));
      }
      setSessionCookie(res, signSession(uid, email));
      return redirect(res, "/");
    } catch (error) {
      return sendHtml(res, loginPage(error.message || "Sign-in failed."));
    }
  }

  if (url.pathname === "/logout" && req.method === "POST") {
    clearSessionCookie(res);
    return redirect(res, "/login");
  }

  let session = null;
  if (authConfigured()) {
    session = verifySession(parseCookies(req).session);
    if (!session) return redirect(res, "/login");
  }

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

    return sendHtml(res, layout({ activeTab, message: url.searchParams.get("message") || "", body, session }));
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
            session,
            body: `<a class="back-link" href="/?tab=users">${icon("back")}Back to users</a><section class="panel"><h2>User not found</h2><p class="muted">It may have already been deleted.</p></section>`
          }),
          404
        );
      }
      return sendHtml(res, layout({ activeTab: "users", session, body: userDetailPage(user, url.searchParams.get("message") || "") }));
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
        categories: async (db, form) => {
          const id = clean(form.id);
          if (action === "add") await addItem(db, "categories", { name: clean(form.name), imageUrl: clean(form.imageUrl), subcategories: [] });
          if (action === "update") await updateItem(db, "categories", id, { name: clean(form.name), imageUrl: clean(form.imageUrl) });
          if (action === "delete") {
            await deleteItem(db, "categories", id);
            if (usesFirestore()) {
              const orphanSubcategories = await firestoreQueryByField("subcategories", "parentCategoryId", id);
              for (const subcategory of orphanSubcategories) await firestoreDeleteDoc("subcategories", subcategory.id);
              const affectedProducts = await firestoreQueryByField("products", "categoryId", id);
              for (const product of affectedProducts) await firestoreUpdateDoc("products", product.id, { categoryId: "", subcategoryId: "" });
            } else {
              db.subcategories = db.subcategories.filter((item) => item.parentCategoryId !== id);
              db.products = db.products.map((item) => (item.categoryId === id ? { ...item, categoryId: "", subcategoryId: "" } : item));
            }
          }
        },
        subcategories: async (db, form) => {
          const id = clean(form.id);
          if (action === "add")
            await addItem(db, "subcategories", { name: clean(form.name), imageUrl: clean(form.imageUrl), parentCategoryId: clean(form.parentCategoryId) });
          if (action === "update")
            await updateItem(db, "subcategories", id, { name: clean(form.name), imageUrl: clean(form.imageUrl), parentCategoryId: clean(form.parentCategoryId) });
          if (action === "delete") {
            await deleteItem(db, "subcategories", id);
            if (usesFirestore()) {
              const affectedProducts = await firestoreQueryByField("products", "subcategoryId", id);
              for (const product of affectedProducts) await firestoreUpdateDoc("products", product.id, { subcategoryId: "" });
            } else {
              db.products = db.products.map((item) => (item.subcategoryId === id ? { ...item, subcategoryId: "" } : item));
            }
          }
        },
        products: async (db, form) => {
          const values = productValues(form);
          const id = clean(form.id);
          if (action === "add") await addItem(db, "products", values);
          if (action === "update") await updateItem(db, "products", id, values);
          if (action === "delete") await deleteItem(db, "products", id);
        },
        users: async (db, form) => {
          const values = userValues(form);
          const id = clean(form.id);
          if (action === "add") await addItem(db, "users", values);
          if (action === "update") await updateItem(db, "users", id, values);
          if (action === "delete") await deleteItem(db, "users", id);
        },
        orders: async (db, form) => {
          const existingOrder = db.orders.find((item) => item.id === clean(form.id)) || {};
          const values = orderValues(db, form, existingOrder);
          const id = clean(form.id);
          if (action === "add") await addItem(db, "orders", values);
          if (action === "update") await updateItem(db, "orders", id, values);
          if (action === "delete") await deleteItem(db, "orders", id);
        },
        workers: async (db, form) => {
          const values = workerValues(form);
          const id = clean(form.id);
          if (action === "add") await addItem(db, "workers", values);
          if (action === "update") await updateItem(db, "workers", id, values);
          if (action === "delete") await deleteItem(db, "workers", id);
        }
      };

      const buildRedirect =
        resource === "users" && action === "update"
          ? (form) => `/users/${encodeURIComponent(clean(form.id))}?message=Saved`
          : undefined;

      return mutate(req, res, collection, tabByResource[resource], handlers, buildRedirect);
    }
  }

  sendHtml(res, layout({ activeTab: "products", session, body: `<section class="panel"><h2>Page not found</h2><p><a href="/">Return dashboard</a></p></section>` }), 404);
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
    console.log(`Database: ${usesFirestore() ? "Cloud Firestore (live backend)" : "local JSON file"}`);
    console.log(`Login: ${authConfigured() ? "enabled" : "disabled (not fully configured)"}`);
  });
});
