"use strict";

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const express = require("express");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const bcrypt = require("bcryptjs");

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET doit contenir au moins 32 caractères.");
  process.exit(1);
}

const { pool, initDb, safeRollback } = require("./db");

const app = express();
const PgStore = connectPgSimple(session);
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";

// Adresse e-mail du compte administrateur (modifiable avec ADMIN_EMAIL).
const DEFAULT_ADMIN_EMAIL = "sammi.mahdeb@outlook.fr";

// Hash factice : permet de dépenser le même temps de calcul quand le
// compte n'existe pas, pour ne pas révéler quels pseudos existent.
const DUMMY_HASH = bcrypt.hashSync("sigma-dummy-password", 12);

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; " +
      "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; " +
      "base-uri 'self'; form-action 'self'"
  });
  next();
});

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax"
};

app.use(session({
  store: new PgStore({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  name: "sigma.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// Chemin absolu : le site fonctionne quel que soit le dossier
// depuis lequel on lance « node server.js ».
app.use(express.static(path.join(__dirname, "public")));

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

// Avec Express 5, req.body vaut undefined quand aucun corps n'est reçu.
function getBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id < 2147483647 ? id : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? clamp(number, min, max) : fallback;
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Limiteur de requêtes en mémoire (par adresse IP).
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.reset <= now) hits.delete(key);
    }
  }, windowMs);
  cleaner.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || "inconnu";
    let entry = hits.get(key);

    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.reset - now) / 1000)));
      return fail(res, 429, message);
    }

    next();
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Trop de tentatives. Réessaie dans quelques minutes."
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  message: "Trop de créations de compte. Réessaie plus tard."
});

/* ------------------------------------------------------------------ */
/* Adresses e-mail                                                     */
/* ------------------------------------------------------------------ */

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmailFormat(email) {
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return false;

  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;

  return /\.[a-z]{2,}$/.test(domain);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" }));
    }, ms);
    timer.unref();

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// Vérifie que le domaine existe et peut recevoir des e-mails.
// En cas de panne DNS temporaire, on ne bloque pas l'utilisateur.
async function domainCanReceiveMail(domain) {
  const missing = ["ENOTFOUND", "ENODATA"];

  try {
    const records = await withTimeout(dns.resolveMx(domain), 4000);
    if (records.length) return true;
  } catch (err) {
    if (!missing.includes(err.code)) return true;
  }

  try {
    const addresses = await withTimeout(dns.resolve4(domain), 4000);
    return addresses.length > 0;
  } catch (err) {
    return !missing.includes(err.code);
  }
}

async function checkEmail(raw) {
  const email = normalizeEmail(raw);

  if (!isValidEmailFormat(email)) {
    return { ok: false, error: "Saisis une adresse e-mail valide." };
  }

  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (!(await domainCanReceiveMail(domain))) {
    return { ok: false, error: "Ce nom de domaine ne peut pas recevoir d'e-mails." };
  }

  return { ok: true, email };
}

/* ------------------------------------------------------------------ */
/* Authentification                                                    */
/* ------------------------------------------------------------------ */

function publicUser(row) {
  const mutedUntil = row.muted_until && new Date(row.muted_until) > new Date()
    ? row.muted_until
    : null;

  return {
    id: row.id,
    username: row.username,
    email: row.email || null,
    role: row.role,
    balance: row.balance,
    created_at: row.created_at,
    muted_until: mutedUntil
  };
}

async function requireAuth(req, res, next) {
  try {
    if (!req.session.userId) {
      return fail(res, 401, "Connecte-toi pour continuer.");
    }

    const result = await pool.query(
      `SELECT id, username, email, role, banned, muted_until, last_seen
       FROM users WHERE id = $1`,
      [req.session.userId]
    );
    const user = result.rows[0];

    if (!user) {
      return req.session.destroy(() =>
        fail(res, 401, "Connecte-toi pour continuer.")
      );
    }

    if (user.banned) {
      return req.session.destroy(() =>
        fail(res, 403, "Ce compte est suspendu.")
      );
    }

    req.user = user;

    // Présence en ligne : mise à jour au plus une fois par minute.
    if (!user.last_seen || Date.now() - new Date(user.last_seen).getTime() > 60000) {
      pool.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [user.id])
        .catch(() => {});
    }

    next();
  } catch (err) {
    next(err);
  }
}

function requireEmail(req, res, next) {
  if (!req.user.email) {
    return fail(res, 403, "Ajoute une adresse e-mail valide à ton compte pour continuer.");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return fail(res, 403, "Accès réservé à l'administrateur.");
  }
  next();
}

async function logAdmin(db, adminId, action, details) {
  try {
    await db.query(
      "INSERT INTO admin_logs (admin_id, action, details) VALUES ($1, $2, $3::jsonb)",
      [adminId, action, JSON.stringify(details || {})]
    );
  } catch (err) {
    console.error("Journal admin non écrit :", err.message);
  }
}

async function killSessions(userId) {
  try {
    await pool.query(
      "DELETE FROM user_sessions WHERE (sess ->> 'userId') = $1",
      [String(userId)]
    );
  } catch (err) {
    console.error("Sessions non supprimées :", err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Cartes, packs et titres                                             */
/* ------------------------------------------------------------------ */

const RARITIES = ["common", "rare", "epic", "legendary", "mythic"];

const TIERS = {
  basic: {
    label: "Standard",
    weights: { common: 70, rare: 22, epic: 6.5, legendary: 1.4, mythic: 0.1 },
    guarantee: null
  },
  silver: {
    label: "Argent",
    weights: { common: 55, rare: 32, epic: 10, legendary: 2.7, mythic: 0.3 },
    guarantee: null
  },
  premium: {
    label: "Premium",
    weights: { common: 35, rare: 40, epic: 20, legendary: 4.5, mythic: 0.5 },
    guarantee: "rare"
  },
  legendary: {
    label: "Légendaire",
    weights: { common: 10, rare: 40, epic: 35, legendary: 13.5, mythic: 1.5 },
    guarantee: "epic"
  },
  mythic: {
    label: "Mythique",
    weights: { common: 0, rare: 30, epic: 45, legendary: 22, mythic: 3 },
    guarantee: "legendary"
  }
};

function normalizeRarity(value) {
  const key = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  const map = {
    common: "common", commune: "common",
    rare: "rare",
    epic: "epic", epique: "epic",
    legendary: "legendary", legendaire: "legendary",
    mythic: "mythic", mythique: "mythic"
  };

  return map[key] || "common";
}

function isTier(value) {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(TIERS, value);
}

function tierKey(pack) {
  return isTier(pack.tier) ? pack.tier : "basic";
}

function oddsPercent(key) {
  const weights = TIERS[key].weights;
  const total = RARITIES.reduce((sum, rarity) => sum + (weights[rarity] || 0), 0);

  return RARITIES.reduce((result, rarity) => {
    result[rarity] = Number((((weights[rarity] || 0) / total) * 100).toFixed(1));
    return result;
  }, {});
}

function weightedRarity(weights, minIndex) {
  let total = 0;
  let lastPositive = RARITIES[minIndex];
  const entries = RARITIES.map((rarity, index) => {
    const weight = index >= minIndex ? Number(weights[rarity]) || 0 : 0;
    total += weight;
    if (weight > 0) lastPositive = rarity;
    return [rarity, weight];
  });

  if (total <= 0) return RARITIES[minIndex];

  let roll = Math.random() * total;
  for (const [rarity, weight] of entries) {
    if (weight <= 0) continue;
    if (roll < weight) return rarity;
    roll -= weight;
  }

  return lastPositive;
}

function pickCards(cards, tier, count) {
  if (!cards.length) {
    throw new Error("Aucune carte disponible dans la base.");
  }

  const byRarity = {};
  for (const card of cards) {
    const key = normalizeRarity(card.rarity);
    (byRarity[key] ||= []).push(card);
  }

  const picked = [];

  for (let i = 0; i < count; i += 1) {
    const isLast = i === count - 1;
    const minIndex = isLast && tier.guarantee ? RARITIES.indexOf(tier.guarantee) : 0;
    const rarity = weightedRarity(tier.weights, minIndex);

    let pool = byRarity[rarity];
    if (!pool || !pool.length) {
      pool = RARITIES.slice(minIndex).flatMap((key) => byRarity[key] || []);
    }
    if (!pool.length) pool = cards;

    picked.push(pool[randomInt(0, pool.length - 1)]);
  }

  // Les meilleures cartes sont révélées en dernier.
  return picked.sort(
    (a, b) => RARITIES.indexOf(normalizeRarity(a.rarity)) - RARITIES.indexOf(normalizeRarity(b.rarity))
  );
}

// Attribue un titre une seule fois. Dans une transaction, un SAVEPOINT
// évite qu'un souci sur le titre annule l'opération principale.
async function awardTitle(db, userId, name, { savepoint = false } = {}) {
  try {
    if (savepoint) await db.query("SAVEPOINT award_title");

    const title = await db.query(
      "SELECT id FROM titles WHERE name = $1 ORDER BY id LIMIT 1",
      [name]
    );

    let inserted = false;
    if (title.rows.length) {
      const result = await db.query(
        `INSERT INTO user_titles (user_id, title_id)
         SELECT $1::int, $2::int
         WHERE NOT EXISTS (
           SELECT 1 FROM user_titles
           WHERE user_id = $1::int AND title_id = $2::int
         )
         RETURNING user_id`,
        [userId, title.rows[0].id]
      );
      inserted = result.rows.length > 0;
    }

    if (savepoint) await db.query("RELEASE SAVEPOINT award_title");
    return inserted;
  } catch (err) {
    if (savepoint) {
      try { await db.query("ROLLBACK TO SAVEPOINT award_title"); } catch (_) { /* ignoré */ }
    }
    console.error("Titre non attribué :", err.message);
    return false;
  }
}

async function recordTransaction(client, userId, type, details) {
  await client.query(
    `INSERT INTO transactions (user_id, type, details)
     VALUES ($1, $2, $3::jsonb)`,
    [userId, type, JSON.stringify(details)]
  );
}

/* ------------------------------------------------------------------ */
/* Simulation du marché                                                */
/* ------------------------------------------------------------------ */

const MEAN_REVERSION = 0.004;
const HISTORY_STEP_MINUTES = 5;
const HISTORY_POINTS = 864; // 3 jours

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Variation aléatoire avec retour progressif vers le prix de référence :
// les cours bougent, mais ne dérivent plus vers des valeurs absurdes.
function nextPrice(price, basePrice, volatility, steps = 1) {
  const vol = clamp(Number(volatility) || 0.012, 0.001, 0.05);
  const base = Number(basePrice) > 0 ? Number(basePrice) : price;
  const pull = MEAN_REVERSION * steps * Math.log(base / price);
  const shock = gaussian() * vol * Math.sqrt(steps);
  const change = clamp(pull + shock, -0.15, 0.15);

  return Math.max(0.01, Number((price * Math.exp(change)).toFixed(4)));
}

function generateHistory(asset, now = Date.now()) {
  const current = Number(asset.price);
  const base = Number(asset.base_price) > 0 ? Number(asset.base_price) : current;

  const raw = [base];
  for (let i = 1; i < HISTORY_POINTS; i += 1) {
    raw.push(nextPrice(raw[i - 1], base, asset.volatility, HISTORY_STEP_MINUTES));
  }

  // On recale la courbe pour qu'elle se termine exactement au prix actuel.
  const factor = current / raw[raw.length - 1];

  return raw.map((value, index) => ({
    price: Math.max(0.01, Number((value * factor).toFixed(4))),
    at: new Date(
      now - (HISTORY_POINTS - 1 - index) * HISTORY_STEP_MINUTES * 60000
    ).toISOString()
  }));
}

async function seedHistory() {
  const result = await pool.query(
    `SELECT a.symbol, a.price, a.base_price, a.volatility
     FROM market_assets a
     WHERE COALESCE(a.active, TRUE)
       AND NOT EXISTS (
         SELECT 1 FROM market_history h WHERE h.symbol = a.symbol
       )`
  );

  for (const asset of result.rows) {
    const points = generateHistory(asset);

    await pool.query(
      `INSERT INTO market_history (symbol, price, recorded_at)
       SELECT $1::text, v.price, v.ts
       FROM unnest($2::numeric[], $3::timestamptz[]) AS v(price, ts)`,
      [asset.symbol, points.map((p) => p.price), points.map((p) => p.at)]
    );
  }

  if (result.rows.length) {
    console.log(`Historique de cours généré pour ${result.rows.length} entreprise(s).`);
  }
}

let marketUpdating = false;
let marketTicks = 0;

async function pruneOldData() {
  await pool.query("DELETE FROM market_history WHERE recorded_at < NOW() - INTERVAL '4 days'");
  await pool.query("DELETE FROM chat_messages WHERE created_at < NOW() - INTERVAL '7 days'");
}

// Variation fictive des cours, sans argent réel.
async function updateMarket() {
  if (marketUpdating) return;
  marketUpdating = true;
  let client = null;

  try {
    const result = await pool.query(
      `SELECT symbol, price, base_price, volatility
       FROM market_assets WHERE COALESCE(active, TRUE)`
    );
    if (!result.rows.length) return;

    const symbols = [];
    const prices = [];

    for (const row of result.rows) {
      symbols.push(row.symbol);
      prices.push(nextPrice(Number(row.price), row.base_price, row.volatility));
    }

    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      `UPDATE market_assets m
       SET price = v.price, updated_at = NOW()
       FROM unnest($1::text[], $2::numeric[]) AS v(symbol, price)
       WHERE m.symbol = v.symbol`,
      [symbols, prices]
    );
    await client.query(
      `INSERT INTO market_history (symbol, price)
       SELECT v.symbol, v.price
       FROM unnest($1::text[], $2::numeric[]) AS v(symbol, price)`,
      [symbols, prices]
    );
    await client.query("COMMIT");

    marketTicks += 1;
    if (marketTicks % 60 === 0) await pruneOldData();
  } catch (err) {
    if (client) await safeRollback(client);
    console.error("Mise à jour du marché impossible :", err.message);
  } finally {
    if (client) client.release();
    marketUpdating = false;
  }
}

async function restockPacks() {
  try {
    const packs = await pool.query(
      "SELECT id FROM shop_packs WHERE COALESCE(active, TRUE)"
    );

    for (const pack of packs.rows) {
      // Les stocks ne sont pas remis à zéro : ils reçoivent
      // un nouvel approvisionnement aléatoire toutes les 5 minutes.
      await pool.query(
        "UPDATE shop_packs SET stock = stock + $1 WHERE id = $2",
        [randomInt(1, 8), pack.id]
      );
    }
  } catch (err) {
    console.error("Réapprovisionnement automatique impossible :", err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Compte administrateur                                               */
/* ------------------------------------------------------------------ */

// Crée ou met à jour l'administrateur uniquement si les variables
// secrètes d'administration sont configurées dans Render.
async function configureAdmin() {
  const username = (process.env.ADMIN_USERNAME || "").trim();
  const password = process.env.ADMIN_PASSWORD || "";
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL);

  if (!username && !password) {
    console.log("ADMIN_USERNAME/ADMIN_PASSWORD absents : aucun admin modifié.");
    return;
  }

  if (!username || !password || password.length < 12) {
    throw new Error(
      "Configure ADMIN_USERNAME et ADMIN_PASSWORD dans Render. " +
      "Le mot de passe admin doit contenir au moins 12 caractères."
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await pool.query(
    `SELECT id, email FROM users
     WHERE LOWER(username) = LOWER($1) ORDER BY id LIMIT 1`,
    [username]
  );

  // L'e-mail n'est attribué que s'il n'appartient pas déjà à un autre compte.
  const owner = isValidEmailFormat(adminEmail)
    ? await pool.query(
        "SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1",
        [adminEmail]
      )
    : { rows: [{ id: -1 }] };
  const ownerId = owner.rows[0]?.id ?? null;

  if (existing.rows.length) {
    const user = existing.rows[0];
    const emailFree = ownerId === null || ownerId === user.id;

    await pool.query(
      `UPDATE users
       SET role = 'admin', password_hash = $1, banned = FALSE,
           email = COALESCE(email, $3)
       WHERE id = $2`,
      [passwordHash, user.id, emailFree ? adminEmail : null]
    );
    console.log("Compte administrateur configuré.");
  } else {
    await pool.query(
      `INSERT INTO users (username, password_hash, role, balance, email)
       VALUES ($1, $2, 'admin', 10000, $3)`,
      [username, passwordHash, ownerId === null ? adminEmail : null]
    );
    console.log("Compte administrateur créé.");
  }
}

/* ------------------------------------------------------------------ */
/* Routes publiques et compte                                          */
/* ------------------------------------------------------------------ */

app.get("/api/health", asyncRoute(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, database: "connected" });
}));

app.get("/api/announcement", asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT value FROM app_settings WHERE key = 'announcement'"
  );
  res.json({ text: result.rows[0]?.value || "" });
}));

app.get("/api/me", asyncRoute(async (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }

  const result = await pool.query(
    `SELECT id, username, email, role, balance, banned, muted_until, created_at
     FROM users WHERE id = $1`,
    [req.session.userId]
  );
  const user = result.rows[0];

  if (!user) {
    return req.session.destroy(() => res.json({ user: null }));
  }

  if (user.banned) {
    return req.session.destroy(() => fail(res, 403, "Ce compte est suspendu."));
  }

  res.json({ user: publicUser(user) });
}));

app.post("/api/register", registerLimiter, asyncRoute(async (req, res) => {
  const body = getBody(req);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
    return fail(res, 400, "Le nom doit contenir de 3 à 30 lettres, chiffres, _ ou -.");
  }

  if (password.length < 8 || password.length > 128) {
    return fail(res, 400, "Le mot de passe doit contenir entre 8 et 128 caractères.");
  }

  const emailCheck = await checkEmail(body.email);
  if (!emailCheck.ok) {
    return fail(res, 400, emailCheck.error);
  }
  const email = emailCheck.email;

  const existing = await pool.query(
    `SELECT username, email FROM users
     WHERE LOWER(username) = LOWER($1) OR LOWER(email) = $2 LIMIT 1`,
    [username, email]
  );

  if (existing.rows.length) {
    const sameEmail = String(existing.rows[0].email || "").toLowerCase() === email;
    return fail(
      res,
      409,
      sameEmail
        ? "Cette adresse e-mail est déjà utilisée."
        : "Ce nom d'utilisateur existe déjà."
    );
  }

  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  let user;

  try {
    await client.query("BEGIN");

    const created = await client.query(
      `INSERT INTO users (username, email, password_hash, role, balance)
       VALUES ($1, $2, $3, 'user', 10000)
       RETURNING id, username, email, role, balance, muted_until, created_at`,
      [username, email, hash]
    );

    user = created.rows[0];
    await awardTitle(client, user.id, "Nouveau membre", { savepoint: true });

    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client);
    if (err.code === "23505") {
      return fail(
        res,
        409,
        String(err.constraint || "").includes("email")
          ? "Cette adresse e-mail est déjà utilisée."
          : "Ce nom d'utilisateur existe déjà."
      );
    }
    throw err;
  } finally {
    client.release();
  }

  req.session.regenerate((err) => {
    if (err) return fail(res, 500, "Impossible de créer la session.");

    req.session.userId = user.id;
    req.session.save((saveErr) => {
      if (saveErr) return fail(res, 500, "Impossible d'enregistrer la session.");
      res.status(201).json({ user: publicUser(user) });
    });
  });
}));

app.post("/api/login", loginLimiter, asyncRoute(async (req, res) => {
  const body = getBody(req);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  const result = await pool.query(
    `SELECT id, username, email, password_hash, role, balance, banned,
            muted_until, created_at
     FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
    [username]
  );

  const user = result.rows[0];
  const passwordOk = await bcrypt.compare(
    password,
    user && user.password_hash ? user.password_hash : DUMMY_HASH
  );

  if (!user || !user.password_hash || !passwordOk) {
    return fail(res, 401, "Identifiants incorrects.");
  }

  if (user.banned) {
    return fail(res, 403, "Ce compte est suspendu.");
  }

  req.session.regenerate((err) => {
    if (err) return fail(res, 500, "Impossible de créer la session.");

    req.session.userId = user.id;
    req.session.save((saveErr) => {
      if (saveErr) return fail(res, 500, "Impossible d'enregistrer la session.");
      res.json({ user: publicUser(user) });
    });
  });
}));

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return fail(res, 500, "Déconnexion impossible.");
    res.clearCookie("sigma.sid", cookieOptions);
    res.json({ ok: true });
  });
});

// Les anciens comptes sans e-mail doivent en renseigner un.
app.patch("/api/me/email", requireAuth, asyncRoute(async (req, res) => {
  if (req.user.email) {
    return fail(res, 400, "Ton adresse e-mail est déjà enregistrée.");
  }

  const check = await checkEmail(getBody(req).email);
  if (!check.ok) return fail(res, 400, check.error);

  const used = await pool.query(
    "SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1",
    [check.email, req.user.id]
  );
  if (used.rows.length) {
    return fail(res, 409, "Cette adresse e-mail est déjà utilisée.");
  }

  try {
    await pool.query(
      "UPDATE users SET email = $1 WHERE id = $2 AND email IS NULL",
      [check.email, req.user.id]
    );
  } catch (err) {
    if (err.code === "23505") {
      return fail(res, 409, "Cette adresse e-mail est déjà utilisée.");
    }
    throw err;
  }

  res.json({ email: check.email });
}));

/* ------------------------------------------------------------------ */
/* Marché et portefeuille                                              */
/* ------------------------------------------------------------------ */

app.get("/api/market", asyncRoute(async (req, res) => {
  const [assets, sparks] = await Promise.all([
    pool.query(
      `SELECT a.symbol, a.name, a.price, a.updated_at, a.sector, a.description,
              a.color, a.icon, ref.price AS ref_price
       FROM market_assets a
       LEFT JOIN LATERAL (
         SELECT h.price FROM market_history h
         WHERE h.symbol = a.symbol
           AND h.recorded_at >= NOW() - INTERVAL '24 hours'
         ORDER BY h.recorded_at ASC LIMIT 1
       ) ref ON TRUE
       WHERE COALESCE(a.active, TRUE)
       ORDER BY a.symbol`
    ),
    pool.query(
      `SELECT symbol, array_agg(price ORDER BY recorded_at) AS prices
       FROM (
         SELECT symbol, price, recorded_at,
                ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY recorded_at DESC) AS rn
         FROM market_history
         WHERE recorded_at > NOW() - INTERVAL '6 hours'
       ) t
       WHERE rn <= 60
       GROUP BY symbol`
    )
  ]);

  const sparkMap = new Map(
    sparks.rows.map((row) => [row.symbol, row.prices.map(Number)])
  );

  res.json({
    assets: assets.rows.map((row) => {
      const price = Number(row.price);
      const ref = Number(row.ref_price);
      const changePct = ref > 0 ? ((price - ref) / ref) * 100 : 0;

      return {
        symbol: row.symbol,
        name: row.name,
        price: row.price,
        updated_at: row.updated_at,
        sector: row.sector || "Divers",
        description: row.description || "",
        color: row.color || "#a78bfa",
        icon: row.icon || "📈",
        changePct: Number(changePct.toFixed(2)),
        spark: sparkMap.get(row.symbol) || []
      };
    })
  });
}));

const HISTORY_RANGES = {
  "1h": { seconds: 3600, bucket: 60 },
  "6h": { seconds: 21600, bucket: 120 },
  "24h": { seconds: 86400, bucket: 600 },
  "3d": { seconds: 259200, bucket: 1800 }
};

app.get("/api/market/:symbol/history", asyncRoute(async (req, res) => {
  const symbol = String(req.params.symbol || "").toUpperCase();
  const range = HISTORY_RANGES[String(req.query.range || "6h")];

  if (!/^[A-Z0-9._-]{1,20}$/.test(symbol) || !range) {
    return fail(res, 400, "Requête invalide.");
  }

  const result = await pool.query(
    `SELECT price, recorded_at FROM (
       SELECT DISTINCT ON (bucket) bucket, price, recorded_at FROM (
         SELECT FLOOR(EXTRACT(EPOCH FROM recorded_at) / $3::int)::bigint AS bucket,
                price, recorded_at
         FROM market_history
         WHERE symbol = $1
           AND recorded_at >= NOW() - make_interval(secs => $2::int)
       ) x
       ORDER BY bucket, recorded_at DESC
     ) y
     ORDER BY recorded_at ASC`,
    [symbol, range.seconds, range.bucket]
  );

  const points = result.rows.map((row) => ({
    t: new Date(row.recorded_at).getTime(),
    p: Number(row.price)
  }));

  res.json({ symbol, range: String(req.query.range || "6h"), points });
}));

app.get("/api/portfolio", requireAuth, asyncRoute(async (req, res) => {
  const [user, holdings] = await Promise.all([
    pool.query("SELECT balance FROM users WHERE id = $1", [req.user.id]),
    pool.query(
      `SELECT h.symbol, h.quantity, h.average_price, a.name, a.price,
              a.sector, a.color, a.icon
       FROM holdings h
       LEFT JOIN market_assets a ON a.symbol = h.symbol
       WHERE h.user_id = $1 AND h.symbol IS NOT NULL
       ORDER BY h.symbol`,
      [req.user.id]
    )
  ]);

  res.json({
    balance: user.rows[0]?.balance ?? 0,
    holdings: holdings.rows
  });
}));

app.post("/api/trade", requireAuth, requireEmail, asyncRoute(async (req, res) => {
  const body = getBody(req);
  const userId = req.user.id;
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const side = String(body.side || "").toLowerCase();

  const rawQuantity = typeof body.quantity === "number" || typeof body.quantity === "string"
    ? Number(body.quantity)
    : NaN;
  // La base stocke 8 décimales : on arrondit pareil côté serveur.
  const quantity = Number(rawQuantity.toFixed(8));

  if (!symbol || symbol.length > 20 || !["buy", "sell"].includes(side) ||
      !Number.isFinite(quantity) || quantity < 0.00000001 || quantity > 1000000) {
    return fail(res, 400, "Ordre invalide.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const assetResult = await client.query(
      `SELECT symbol, name, price FROM market_assets
       WHERE symbol = $1 AND COALESCE(active, TRUE) FOR UPDATE`,
      [symbol]
    );
    if (!assetResult.rows.length) {
      await client.query("ROLLBACK");
      return fail(res, 404, "Titre inconnu.");
    }

    const asset = assetResult.rows[0];
    const price = Number(asset.price);
    const total = Number((price * quantity).toFixed(2));

    const userResult = await client.query(
      "SELECT id, balance FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (!userResult.rows.length) throw new Error("Utilisateur introuvable.");

    const balance = Number(userResult.rows[0].balance);

    const holdingResult = await client.query(
      "SELECT quantity, average_price FROM holdings WHERE user_id = $1 AND symbol = $2 FOR UPDATE",
      [userId, symbol]
    );

    const holding = holdingResult.rows[0];
    const oldQuantity = Number(holding?.quantity || 0);
    const oldAverage = Number(holding?.average_price || 0);

    if (side === "buy") {
      // Empêche d'obtenir des titres gratuitement avec une quantité minuscule.
      if (total < 0.01) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Ordre trop petit.");
      }

      if (balance < total) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Solde insuffisant.");
      }

      const newQuantity = Number((oldQuantity + quantity).toFixed(8));
      const newAverage = newQuantity > 0
        ? Number(((oldQuantity * oldAverage + quantity * price) / newQuantity).toFixed(8))
        : price;

      await client.query(
        "UPDATE users SET balance = balance - $1 WHERE id = $2",
        [total, userId]
      );

      if (holding) {
        await client.query(
          `UPDATE holdings SET quantity = $1, average_price = $2
           WHERE user_id = $3 AND symbol = $4`,
          [newQuantity, newAverage, userId, symbol]
        );
      } else {
        await client.query(
          `INSERT INTO holdings (user_id, symbol, quantity, average_price)
           VALUES ($1, $2, $3, $4)`,
          [userId, symbol, quantity, price]
        );
      }
    } else {
      if (quantity - oldQuantity > 0.000000001) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Tu ne possèdes pas assez de titres.");
      }

      const remaining = Number((oldQuantity - quantity).toFixed(8));
      const closesPosition = remaining <= 0.000000001;

      // Une vente partielle trop petite rapporterait 0 : on la refuse,
      // mais on autorise toujours à solder entièrement une position.
      if (total < 0.01 && !closesPosition) {
        await client.query("ROLLBACK");
        return fail(res, 400, "Ordre trop petit.");
      }

      await client.query(
        "UPDATE users SET balance = balance + $1 WHERE id = $2",
        [total, userId]
      );

      if (closesPosition) {
        await client.query(
          "DELETE FROM holdings WHERE user_id = $1 AND symbol = $2",
          [userId, symbol]
        );
      } else {
        await client.query(
          "UPDATE holdings SET quantity = $1 WHERE user_id = $2 AND symbol = $3",
          [remaining, userId, symbol]
        );
      }
    }

    await recordTransaction(client, userId, side, {
      symbol, quantity, price, total
    });

    const updated = await client.query(
      "SELECT balance FROM users WHERE id = $1",
      [userId]
    );
    const newBalance = Number(updated.rows[0].balance);

    // Titres automatiques.
    const newTitles = [];
    if (await awardTitle(client, userId, "Investisseur", { savepoint: true })) {
      newTitles.push("Investisseur");
    }

    const distinct = await client.query(
      "SELECT COUNT(*)::int AS n FROM holdings WHERE user_id = $1 AND symbol IS NOT NULL",
      [userId]
    );
    if (distinct.rows[0].n >= 5 &&
        await awardTitle(client, userId, "Portefeuille diversifié", { savepoint: true })) {
      newTitles.push("Portefeuille diversifié");
    }

    if (newBalance >= 25000 &&
        await awardTitle(client, userId, "Millionnaire", { savepoint: true })) {
      newTitles.push("Millionnaire");
    }

    await client.query("COMMIT");
    res.json({
      balance: updated.rows[0].balance,
      symbol,
      quantity,
      price,
      total,
      newTitles
    });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

app.get("/api/transactions", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, type, details, created_at
     FROM transactions WHERE user_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ transactions: result.rows });
}));

/* ------------------------------------------------------------------ */
/* Cartes, boutique et titres                                          */
/* ------------------------------------------------------------------ */

function cardPayload(row, extra = {}) {
  return {
    id: row.id,
    name: row.name,
    rarity: row.rarity,
    rarityKey: normalizeRarity(row.rarity),
    emoji: row.emoji || "🃏",
    series: row.series || "",
    description: row.description || "",
    ...extra
  };
}

app.get("/api/cards", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.rarity, c.emoji, c.series, c.description,
            COALESCE(uc.quantity, 0)::int AS quantity
     FROM cards c
     LEFT JOIN user_cards uc
       ON uc.card_id = c.id AND uc.user_id = $1
     ORDER BY c.id`,
    [req.user.id]
  );

  res.json({
    cards: result.rows.map((row) => cardPayload(row, { quantity: row.quantity }))
  });
}));

function packPayload(row) {
  const key = tierKey(row);
  const tier = TIERS[key];

  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    price: row.price,
    stock: row.stock,
    emoji: row.emoji || "📦",
    tier: key,
    tierLabel: tier.label,
    guarantee: tier.guarantee,
    cardsPerPack: clampInt(row.cards_per_pack, 1, 10, 1),
    odds: oddsPercent(key)
  };
}

app.get("/api/shop", asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, description, price, stock, tier, cards_per_pack, emoji
     FROM shop_packs WHERE COALESCE(active, TRUE) ORDER BY price, id`
  );
  res.json({ packs: result.rows.map(packPayload) });
}));

app.post("/api/shop/buy", requireAuth, requireEmail, asyncRoute(async (req, res) => {
  const userId = req.user.id;
  const packId = Number(getBody(req).packId);
  if (!Number.isInteger(packId) || packId <= 0) {
    return fail(res, 400, "Pack invalide.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const packResult = await client.query(
      "SELECT * FROM shop_packs WHERE id = $1 AND COALESCE(active, TRUE) FOR UPDATE",
      [packId]
    );
    if (!packResult.rows.length) {
      await client.query("ROLLBACK");
      return fail(res, 404, "Pack introuvable.");
    }

    const pack = packResult.rows[0];
    if (Number(pack.stock) <= 0) {
      await client.query("ROLLBACK");
      return fail(res, 400, "Ce pack est en rupture de stock.");
    }

    const userResult = await client.query(
      "SELECT balance FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (!userResult.rows.length) throw new Error("Utilisateur introuvable.");

    const balance = Number(userResult.rows[0].balance);
    const price = Number(pack.price);

    if (balance < price) {
      await client.query("ROLLBACK");
      return fail(res, 400, "Solde insuffisant.");
    }

    const cardResult = await client.query(
      "SELECT id, name, rarity, emoji, series, description FROM cards"
    );
    if (!cardResult.rows.length) throw new Error("Aucune carte n'est configurée.");

    const key = tierKey(pack);
    const count = clampInt(pack.cards_per_pack, 1, 10, 1);
    const drawn = pickCards(cardResult.rows, TIERS[key], count);

    await client.query(
      "UPDATE users SET balance = balance - $1 WHERE id = $2",
      [price, userId]
    );
    await client.query(
      "UPDATE shop_packs SET stock = stock - 1 WHERE id = $1",
      [packId]
    );

    // Regroupe les doublons du tirage : une seule mise à jour par carte.
    const counts = new Map();
    for (const card of drawn) {
      counts.set(card.id, (counts.get(card.id) || 0) + 1);
    }

    const alreadyOwned = new Set();
    for (const [cardId, amount] of counts) {
      const owned = await client.query(
        "SELECT quantity FROM user_cards WHERE user_id = $1 AND card_id = $2 FOR UPDATE",
        [userId, cardId]
      );

      if (owned.rows.length) {
        alreadyOwned.add(cardId);
        await client.query(
          "UPDATE user_cards SET quantity = quantity + $3 WHERE user_id = $1 AND card_id = $2",
          [userId, cardId, amount]
        );
      } else {
        await client.query(
          "INSERT INTO user_cards (user_id, card_id, quantity) VALUES ($1, $2, $3)",
          [userId, cardId, amount]
        );
      }
    }

    await recordTransaction(client, userId, "pack_purchase", {
      packId,
      packName: pack.name,
      price,
      cards: drawn.map((card) => card.name),
      rarities: drawn.map((card) => normalizeRarity(card.rarity))
    });

    const updated = await client.query(
      "SELECT balance FROM users WHERE id = $1",
      [userId]
    );

    const newTitles = [];
    if (await awardTitle(client, userId, "Collectionneur", { savepoint: true })) {
      newTitles.push("Collectionneur");
    }

    const lucky = drawn.some((card) =>
      ["legendary", "mythic"].includes(normalizeRarity(card.rarity))
    );
    if (lucky && await awardTitle(client, userId, "Chanceux", { savepoint: true })) {
      newTitles.push("Chanceux");
    }

    await client.query("COMMIT");

    // « isNew » : première fois que le joueur obtient cette carte.
    const seen = new Set();
    res.json({
      balance: updated.rows[0].balance,
      cards: drawn.map((card) => {
        const isNew = !alreadyOwned.has(card.id) && !seen.has(card.id);
        seen.add(card.id);
        return cardPayload(card, { isNew });
      }),
      newTitles
    });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

app.get("/api/titles", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT t.id, t.name, t.description,
            (ut.title_id IS NOT NULL) AS unlocked
     FROM titles t
     LEFT JOIN user_titles ut
       ON ut.title_id = t.id AND ut.user_id = $1
     ORDER BY t.id`,
    [req.user.id]
  );
  res.json({ titles: result.rows });
}));

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

const lastChatMessage = new Map();

app.get("/api/chat", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM (
       SELECT m.id, m.body, m.created_at, u.username, u.role
       FROM chat_messages m
       JOIN users u ON u.id = m.user_id
       WHERE NOT m.deleted AND m.body <> ''
       ORDER BY m.id DESC
       LIMIT 60
     ) t
     ORDER BY id ASC`
  );
  res.json({ messages: result.rows });
}));

app.post("/api/chat", requireAuth, requireEmail, asyncRoute(async (req, res) => {
  const mutedUntil = req.user.muted_until ? new Date(req.user.muted_until) : null;
  if (mutedUntil && mutedUntil > new Date()) {
    return fail(
      res,
      403,
      `Tu es réduit au silence jusqu'à ${mutedUntil.toLocaleString("fr-FR", {
        timeZone: "Europe/Paris",
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit"
      })}.`
    );
  }

  const message = cleanText(getBody(req).message, 300);
  if (!message) {
    return fail(res, 400, "Écris un message avant de l'envoyer.");
  }

  const now = Date.now();
  if (now - (lastChatMessage.get(req.user.id) || 0) < 1500) {
    return fail(res, 429, "Doucement, attends une seconde entre deux messages.");
  }
  lastChatMessage.set(req.user.id, now);

  await pool.query(
    "INSERT INTO chat_messages (user_id, body) VALUES ($1, $2)",
    [req.user.id, message]
  );

  const newTitles = [];
  if (await awardTitle(pool, req.user.id, "Bavard")) {
    newTitles.push("Bavard");
  }

  res.status(201).json({ ok: true, newTitles });
}));

/* ------------------------------------------------------------------ */
/* Bazar : vente de cartes entre joueurs                               */
/* ------------------------------------------------------------------ */

const BAZAAR_FEE_RATE = 0.05;
const MAX_ACTIVE_LISTINGS = 50;
const MAX_FRIENDS = 100;
const ONLINE_WINDOW_MS = 3 * 60 * 1000;

function parsePrice(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const price = Number(Number(value).toFixed(2));
  return Number.isFinite(price) && price >= 1 && price <= 1000000 ? price : null;
}

// Ajoute des exemplaires d'une carte à un joueur ; renvoie true s'il la possédait déjà.
async function giveCard(client, userId, cardId, quantity = 1) {
  const owned = await client.query(
    "SELECT quantity FROM user_cards WHERE user_id = $1 AND card_id = $2 FOR UPDATE",
    [userId, cardId]
  );

  if (owned.rows.length) {
    await client.query(
      "UPDATE user_cards SET quantity = quantity + $3 WHERE user_id = $1 AND card_id = $2",
      [userId, cardId, quantity]
    );
    return Number(owned.rows[0].quantity) > 0;
  }

  await client.query(
    "INSERT INTO user_cards (user_id, card_id, quantity) VALUES ($1, $2, $3)",
    [userId, cardId, quantity]
  );
  return false;
}

// Retire des exemplaires ; renvoie false si le joueur n'en possède pas assez.
async function takeCard(client, userId, cardId, quantity = 1) {
  const owned = await client.query(
    "SELECT quantity FROM user_cards WHERE user_id = $1 AND card_id = $2 FOR UPDATE",
    [userId, cardId]
  );

  const current = owned.rows.length ? Number(owned.rows[0].quantity) : 0;
  if (current < quantity) return false;

  if (current === quantity) {
    await client.query(
      "DELETE FROM user_cards WHERE user_id = $1 AND card_id = $2",
      [userId, cardId]
    );
  } else {
    await client.query(
      "UPDATE user_cards SET quantity = quantity - $3 WHERE user_id = $1 AND card_id = $2",
      [userId, cardId, quantity]
    );
  }
  return true;
}

function listingPayload(row, userId) {
  return {
    id: row.id,
    price: row.price,
    status: row.status,
    created_at: row.created_at,
    sold_at: row.sold_at || null,
    seller: { id: row.seller_id, username: row.seller_name },
    isMine: row.seller_id === userId,
    isFriend: Boolean(row.is_friend),
    card: cardPayload({
      id: row.card_id,
      name: row.name,
      rarity: row.rarity,
      emoji: row.emoji,
      series: row.series,
      description: row.description
    })
  };
}

app.get("/api/bazaar", requireAuth, asyncRoute(async (req, res) => {
  const q = cleanText(req.query.q, 60);
  const rarity = RARITIES.includes(req.query.rarity) ? req.query.rarity : "";
  const seller = ["friends", "mine"].includes(req.query.seller) ? req.query.seller : "all";
  const sort = ["price-asc", "price-desc", "newest", "rarity-desc"].includes(req.query.sort)
    ? req.query.sort
    : "price-asc";

  const result = await pool.query(
    `SELECT l.id, l.price, l.status, l.created_at, l.sold_at, l.seller_id,
            u.username AS seller_name,
            c.id AS card_id, c.name, c.rarity, c.emoji, c.series, c.description,
            EXISTS (
              SELECT 1 FROM friendships f
              WHERE f.status = 'accepted'
                AND ((f.requester_id = $1 AND f.addressee_id = l.seller_id)
                  OR (f.addressee_id = $1 AND f.requester_id = l.seller_id))
            ) AS is_friend
     FROM card_listings l
     JOIN users u ON u.id = l.seller_id
     JOIN cards c ON c.id = l.card_id
     WHERE l.status = 'active'
       AND NOT u.banned
       AND ($2::text IS NULL OR c.name ILIKE $2::text)
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT 500`,
    [req.user.id, q ? `%${escapeLike(q)}%` : null]
  );

  let listings = result.rows.map((row) => listingPayload(row, req.user.id));

  if (rarity) listings = listings.filter((item) => item.card.rarityKey === rarity);
  if (seller === "friends") listings = listings.filter((item) => item.isFriend);
  if (seller === "mine") listings = listings.filter((item) => item.isMine);

  const rank = (item) => RARITIES.indexOf(item.card.rarityKey);
  const sorters = {
    "price-asc": (a, b) => Number(a.price) - Number(b.price),
    "price-desc": (a, b) => Number(b.price) - Number(a.price),
    newest: () => 0,
    "rarity-desc": (a, b) => rank(b) - rank(a) || Number(a.price) - Number(b.price)
  };
  listings.sort(sorters[sort]);

  res.json({ listings: listings.slice(0, 200), total: listings.length });
}));

app.get("/api/bazaar/mine", requireAuth, asyncRoute(async (req, res) => {
  const columns = `l.id, l.price, l.status, l.created_at, l.sold_at, l.seller_id, l.buyer_id,
            s.username AS seller_name, b.username AS buyer_name,
            c.id AS card_id, c.name, c.rarity, c.emoji, c.series, c.description,
            FALSE AS is_friend`;
  const joins = `FROM card_listings l
     JOIN users s ON s.id = l.seller_id
     LEFT JOIN users b ON b.id = l.buyer_id
     JOIN cards c ON c.id = l.card_id`;

  const [active, history] = await Promise.all([
    pool.query(
      `SELECT ${columns} ${joins}
       WHERE l.seller_id = $1 AND l.status = 'active'
       ORDER BY l.created_at DESC, l.id DESC`,
      [req.user.id]
    ),
    pool.query(
      `SELECT ${columns} ${joins}
       WHERE l.status = 'sold' AND (l.seller_id = $1 OR l.buyer_id = $1)
       ORDER BY l.sold_at DESC, l.id DESC LIMIT 30`,
      [req.user.id]
    )
  ]);

  res.json({
    feeRate: BAZAAR_FEE_RATE,
    active: active.rows.map((row) => listingPayload(row, req.user.id)),
    history: history.rows.map((row) => ({
      ...listingPayload(row, req.user.id),
      role: row.seller_id === req.user.id ? "sold" : "bought",
      buyer: row.buyer_name || null
    }))
  });
}));

app.get("/api/bazaar/price/:cardId", requireAuth, asyncRoute(async (req, res) => {
  const cardId = parseId(req.params.cardId);
  if (!cardId) return fail(res, 400, "Carte invalide.");

  const [floor, last] = await Promise.all([
    pool.query(
      `SELECT MIN(price) AS floor, COUNT(*)::int AS count
       FROM card_listings WHERE card_id = $1 AND status = 'active'`,
      [cardId]
    ),
    pool.query(
      `SELECT price FROM card_listings
       WHERE card_id = $1 AND status = 'sold'
       ORDER BY sold_at DESC, id DESC LIMIT 1`,
      [cardId]
    )
  ]);

  res.json({
    floor: floor.rows[0].floor,
    activeCount: floor.rows[0].count,
    lastSold: last.rows[0]?.price ?? null,
    feeRate: BAZAAR_FEE_RATE
  });
}));

app.post("/api/bazaar/list", requireAuth, requireEmail, asyncRoute(async (req, res) => {
  const body = getBody(req);
  const cardId = parseId(body.cardId);
  const price = parsePrice(body.price);
  const quantity = clampInt(body.quantity, 1, 10, 1);

  if (!cardId) return fail(res, 400, "Carte invalide.");
  if (price === null) {
    return fail(res, 400, "Le prix doit être compris entre 1 et 1 000 000 crédits.");
  }

  const userId = req.user.id;
  const client = await pool.connect();
  const abort = async (status, message) => {
    await client.query("ROLLBACK");
    return fail(res, status, message);
  };

  try {
    await client.query("BEGIN");

    const card = await client.query("SELECT id FROM cards WHERE id = $1", [cardId]);
    if (!card.rows.length) return abort(404, "Carte introuvable.");

    const active = await client.query(
      "SELECT COUNT(*)::int AS n FROM card_listings WHERE seller_id = $1 AND status = 'active'",
      [userId]
    );
    if (active.rows[0].n + quantity > MAX_ACTIVE_LISTINGS) {
      return abort(400, `Tu ne peux pas avoir plus de ${MAX_ACTIVE_LISTINGS} annonces en même temps.`);
    }

    // La carte est mise « sous séquestre » : elle quitte la collection du vendeur.
    if (!(await takeCard(client, userId, cardId, quantity))) {
      return abort(400, "Tu ne possèdes pas assez d'exemplaires de cette carte.");
    }

    await client.query(
      `INSERT INTO card_listings (seller_id, card_id, price)
       SELECT $1::int, $2::int, $3::numeric FROM generate_series(1, $4::int)`,
      [userId, cardId, price, quantity]
    );

    await client.query("COMMIT");
    res.status(201).json({ ok: true, listed: quantity });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

app.post("/api/bazaar/:id/buy", requireAuth, requireEmail, asyncRoute(async (req, res) => {
  const listingId = parseId(req.params.id);
  if (!listingId) return fail(res, 400, "Annonce invalide.");

  const userId = req.user.id;
  const client = await pool.connect();
  const abort = async (status, message) => {
    await client.query("ROLLBACK");
    return fail(res, status, message);
  };

  try {
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT l.id, l.seller_id, l.card_id, l.price, l.status,
              c.name, c.rarity, c.emoji, c.series, c.description
       FROM card_listings l
       JOIN cards c ON c.id = l.card_id
       WHERE l.id = $1
       FOR UPDATE OF l`,
      [listingId]
    );
    const listing = found.rows[0];

    if (!listing || listing.status !== "active") {
      return abort(404, "Cette annonce n'est plus disponible.");
    }
    if (listing.seller_id === userId) {
      return abort(400, "Tu ne peux pas acheter ta propre annonce.");
    }

    const price = Number(listing.price);
    const fee = Number((price * BAZAAR_FEE_RATE).toFixed(2));
    const net = Number((price - fee).toFixed(2));

    // Les deux comptes sont verrouillés dans l'ordre des identifiants (pas de blocage mutuel).
    const accounts = await client.query(
      `SELECT id, username, balance FROM users
       WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [[userId, listing.seller_id]]
    );
    const buyer = accounts.rows.find((row) => row.id === userId);
    const seller = accounts.rows.find((row) => row.id === listing.seller_id);

    if (!buyer) throw new Error("Utilisateur introuvable.");
    if (!seller) return abort(404, "Le vendeur n'existe plus.");
    if (Number(buyer.balance) < price) return abort(400, "Solde insuffisant.");

    await client.query("UPDATE users SET balance = balance - $1 WHERE id = $2", [price, userId]);
    await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [net, seller.id]);

    const hadBefore = await giveCard(client, userId, listing.card_id, 1);

    await client.query(
      `UPDATE card_listings
       SET status = 'sold', buyer_id = $2, sold_at = NOW()
       WHERE id = $1`,
      [listingId, userId]
    );

    await recordTransaction(client, userId, "card_buy", {
      listingId, card: listing.name, price, seller: seller.username
    });
    await recordTransaction(client, seller.id, "card_sell", {
      listingId, card: listing.name, price, fee, net, buyer: buyer.username
    });

    const newTitles = [];
    if (await awardTitle(client, userId, "Commerçant", { savepoint: true })) {
      newTitles.push("Commerçant");
    }
    await awardTitle(client, seller.id, "Commerçant", { savepoint: true });

    const updated = await client.query("SELECT balance FROM users WHERE id = $1", [userId]);

    await client.query("COMMIT");
    res.json({
      balance: updated.rows[0].balance,
      price,
      card: cardPayload(listing, { isNew: !hadBefore }),
      newTitles
    });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

app.post("/api/bazaar/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
  const listingId = parseId(req.params.id);
  if (!listingId) return fail(res, 400, "Annonce invalide.");

  const client = await pool.connect();
  const abort = async (status, message) => {
    await client.query("ROLLBACK");
    return fail(res, status, message);
  };

  try {
    await client.query("BEGIN");

    const found = await client.query(
      "SELECT id, seller_id, card_id, status FROM card_listings WHERE id = $1 FOR UPDATE",
      [listingId]
    );
    const listing = found.rows[0];

    if (!listing || listing.status !== "active") {
      return abort(404, "Cette annonce n'est plus disponible.");
    }
    if (listing.seller_id !== req.user.id) {
      return abort(403, "Cette annonce ne t'appartient pas.");
    }

    await client.query("UPDATE card_listings SET status = 'cancelled' WHERE id = $1", [listingId]);
    await giveCard(client, req.user.id, listing.card_id, 1);

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

app.patch("/api/bazaar/:id", requireAuth, asyncRoute(async (req, res) => {
  const listingId = parseId(req.params.id);
  const price = parsePrice(getBody(req).price);

  if (!listingId) return fail(res, 400, "Annonce invalide.");
  if (price === null) {
    return fail(res, 400, "Le prix doit être compris entre 1 et 1 000 000 crédits.");
  }

  const result = await pool.query(
    `UPDATE card_listings SET price = $1
     WHERE id = $2 AND seller_id = $3 AND status = 'active'
     RETURNING id`,
    [price, listingId, req.user.id]
  );
  if (!result.rows.length) return fail(res, 404, "Cette annonce n'est plus disponible.");

  res.json({ ok: true, price });
}));

/* ------------------------------------------------------------------ */
/* Amis                                                                */
/* ------------------------------------------------------------------ */

function isOnline(lastSeen) {
  return Boolean(lastSeen) && Date.now() - new Date(lastSeen).getTime() < ONLINE_WINDOW_MS;
}

async function areFriends(db, a, b) {
  const result = await db.query(
    `SELECT 1 FROM friendships
     WHERE status = 'accepted'
       AND ((requester_id = $1 AND addressee_id = $2)
         OR (requester_id = $2 AND addressee_id = $1))
     LIMIT 1`,
    [a, b]
  );
  return result.rows.length > 0;
}

async function awardSociable(...userIds) {
  for (const id of userIds) {
    await awardTitle(pool, id, "Sociable");
  }
}

app.get("/api/friends", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT f.id AS request_id, f.requester_id, f.status, f.created_at, f.responded_at,
            u.id AS other_id, u.username, u.last_seen
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
     WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND NOT u.banned
     ORDER BY LOWER(u.username)`,
    [req.user.id]
  );

  const friends = [];
  const incoming = [];
  const outgoing = [];

  for (const row of result.rows) {
    const person = {
      requestId: row.request_id,
      id: row.other_id,
      username: row.username,
      online: isOnline(row.last_seen),
      lastSeen: row.last_seen
    };

    if (row.status === "accepted") {
      friends.push({ ...person, since: row.responded_at || row.created_at });
    } else if (row.requester_id === req.user.id) {
      outgoing.push({ ...person, sentAt: row.created_at });
    } else {
      incoming.push({ ...person, sentAt: row.created_at });
    }
  }

  res.json({ friends, incoming, outgoing });
}));

app.get("/api/users/search", requireAuth, asyncRoute(async (req, res) => {
  const q = cleanText(req.query.q, 30);
  if (q.length < 2) return res.json({ users: [] });

  const result = await pool.query(
    `SELECT username FROM users
     WHERE username ILIKE $1 AND id <> $2 AND NOT banned
     ORDER BY LOWER(username) LIMIT 8`,
    [`${escapeLike(q)}%`, req.user.id]
  );
  res.json({ users: result.rows.map((row) => row.username) });
}));

app.post("/api/friends/request", requireAuth, asyncRoute(async (req, res) => {
  const username = cleanText(getBody(req).username, 30);
  if (!username) return fail(res, 400, "Saisis le pseudo de ton ami.");

  const target = await pool.query(
    "SELECT id, username FROM users WHERE LOWER(username) = LOWER($1) AND NOT banned LIMIT 1",
    [username]
  );
  if (!target.rows.length) return fail(res, 404, "Aucun joueur ne porte ce pseudo.");

  const other = target.rows[0];
  if (other.id === req.user.id) return fail(res, 400, "Tu ne peux pas t'ajouter toi-même.");

  const existing = await pool.query(
    `SELECT id, requester_id, status FROM friendships
     WHERE (requester_id = $1 AND addressee_id = $2)
        OR (requester_id = $2 AND addressee_id = $1)
     LIMIT 1`,
    [req.user.id, other.id]
  );

  if (existing.rows.length) {
    const relation = existing.rows[0];

    if (relation.status === "accepted") return fail(res, 409, "Vous êtes déjà amis.");
    if (relation.requester_id === req.user.id) {
      return fail(res, 409, "Tu as déjà envoyé une demande à ce joueur.");
    }

    // Ce joueur t'avait déjà invité : la demande est acceptée directement.
    await pool.query(
      "UPDATE friendships SET status = 'accepted', responded_at = NOW() WHERE id = $1",
      [relation.id]
    );
    await awardSociable(req.user.id, other.id);
    return res.json({ status: "accepted", username: other.username });
  }

  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM friendships
     WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
    [req.user.id]
  );
  if (count.rows[0].n >= MAX_FRIENDS) {
    return fail(res, 400, `Tu ne peux pas avoir plus de ${MAX_FRIENDS} amis.`);
  }

  try {
    await pool.query(
      "INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)",
      [req.user.id, other.id]
    );
  } catch (err) {
    if (err.code === "23505") {
      return fail(res, 409, "Une demande existe déjà entre vous.");
    }
    throw err;
  }

  res.status(201).json({ status: "pending", username: other.username });
}));

app.post("/api/friends/requests/:id/accept", requireAuth, asyncRoute(async (req, res) => {
  const requestId = parseId(req.params.id);
  if (!requestId) return fail(res, 400, "Demande invalide.");

  const result = await pool.query(
    `UPDATE friendships SET status = 'accepted', responded_at = NOW()
     WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
     RETURNING requester_id`,
    [requestId, req.user.id]
  );
  if (!result.rows.length) return fail(res, 404, "Cette demande n'existe plus.");

  await awardSociable(req.user.id, result.rows[0].requester_id);
  res.json({ ok: true });
}));

// Refuser une demande reçue ou annuler une demande envoyée.
app.delete("/api/friends/requests/:id", requireAuth, asyncRoute(async (req, res) => {
  const requestId = parseId(req.params.id);
  if (!requestId) return fail(res, 400, "Demande invalide.");

  const result = await pool.query(
    `DELETE FROM friendships
     WHERE id = $1 AND status = 'pending' AND (requester_id = $2 OR addressee_id = $2)
     RETURNING id`,
    [requestId, req.user.id]
  );
  if (!result.rows.length) return fail(res, 404, "Cette demande n'existe plus.");

  res.json({ ok: true });
}));

app.delete("/api/friends/:userId", requireAuth, asyncRoute(async (req, res) => {
  const otherId = parseId(req.params.userId);
  if (!otherId) return fail(res, 400, "Joueur invalide.");

  const result = await pool.query(
    `DELETE FROM friendships
     WHERE status = 'accepted'
       AND ((requester_id = $1 AND addressee_id = $2)
         OR (requester_id = $2 AND addressee_id = $1))
     RETURNING id`,
    [req.user.id, otherId]
  );
  if (!result.rows.length) return fail(res, 404, "Ce joueur n'est pas dans ta liste d'amis.");

  res.json({ ok: true });
}));

app.get("/api/friends/:userId/profile", requireAuth, asyncRoute(async (req, res) => {
  const otherId = parseId(req.params.userId);
  if (!otherId) return fail(res, 400, "Joueur invalide.");

  if (otherId !== req.user.id && !(await areFriends(pool, req.user.id, otherId))) {
    return fail(res, 403, "Tu dois être ami avec ce joueur pour voir son profil.");
  }

  const [user, titles, cards, total] = await Promise.all([
    pool.query(
      "SELECT id, username, created_at, last_seen FROM users WHERE id = $1 AND NOT banned",
      [otherId]
    ),
    pool.query(
      `SELECT t.name, t.description FROM user_titles ut
       JOIN titles t ON t.id = ut.title_id
       WHERE ut.user_id = $1 ORDER BY t.id`,
      [otherId]
    ),
    pool.query(
      `SELECT c.id, c.name, c.rarity, c.emoji, c.series, c.description, uc.quantity
       FROM user_cards uc JOIN cards c ON c.id = uc.card_id
       WHERE uc.user_id = $1 AND uc.quantity > 0
       ORDER BY c.id`,
      [otherId]
    ),
    pool.query("SELECT COUNT(*)::int AS n FROM cards")
  ]);

  if (!user.rows.length) return fail(res, 404, "Joueur introuvable.");

  res.json({
    user: {
      id: user.rows[0].id,
      username: user.rows[0].username,
      created_at: user.rows[0].created_at,
      online: isOnline(user.rows[0].last_seen),
      lastSeen: user.rows[0].last_seen
    },
    titles: titles.rows,
    cards: cards.rows.map((row) => cardPayload(row, { quantity: Number(row.quantity) })),
    totalCards: total.rows[0].n
  });
}));

app.post("/api/friends/:userId/gift", requireAuth, requireEmail, asyncRoute(async (req, res) => {
  const friendId = parseId(req.params.userId);
  const cardId = parseId(getBody(req).cardId);
  if (!friendId || !cardId) return fail(res, 400, "Requête invalide.");

  if (!(await areFriends(pool, req.user.id, friendId))) {
    return fail(res, 403, "Tu ne peux offrir une carte qu'à un ami.");
  }

  const client = await pool.connect();
  const abort = async (status, message) => {
    await client.query("ROLLBACK");
    return fail(res, status, message);
  };

  try {
    await client.query("BEGIN");

    const friend = await client.query(
      "SELECT username FROM users WHERE id = $1 AND NOT banned",
      [friendId]
    );
    const card = await client.query("SELECT id, name FROM cards WHERE id = $1", [cardId]);
    if (!friend.rows.length) return abort(404, "Joueur introuvable.");
    if (!card.rows.length) return abort(404, "Carte introuvable.");

    if (!(await takeCard(client, req.user.id, cardId, 1))) {
      return abort(400, "Tu ne possèdes pas cette carte.");
    }
    await giveCard(client, friendId, cardId, 1);

    await recordTransaction(client, req.user.id, "card_gift_sent", {
      card: card.rows[0].name, to: friend.rows[0].username
    });
    await recordTransaction(client, friendId, "card_gift_received", {
      card: card.rows[0].name, from: req.user.username
    });

    await client.query("COMMIT");
    res.json({ ok: true, card: card.rows[0].name, to: friend.rows[0].username });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

/* ------------------------------------------------------------------ */
/* Administration                                                      */
/* ------------------------------------------------------------------ */

const admin = [requireAuth, requireAdmin];

app.get("/api/admin/stats", admin, asyncRoute(async (req, res) => {
  const [users, holdings, activity, cards, messages, hourly, richest, recent] =
    await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS new24,
                COUNT(*) FILTER (WHERE banned)::int AS banned,
                COALESCE(SUM(balance), 0) AS credits
         FROM users`
      ),
      pool.query(
        `SELECT COALESCE(SUM(h.quantity * a.price), 0) AS value
         FROM holdings h JOIN market_assets a ON a.symbol = h.symbol`
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE type IN ('buy', 'sell'))::int AS trades,
                COUNT(*) FILTER (WHERE type = 'pack_purchase')::int AS packs
         FROM transactions WHERE created_at > NOW() - INTERVAL '24 hours'`
      ),
      pool.query("SELECT COALESCE(SUM(quantity), 0)::int AS total FROM user_cards"),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM chat_messages
         WHERE created_at > NOW() - INTERVAL '24 hours'`
      ),
      pool.query(
        `SELECT g AS hour, COALESCE(c.n, 0)::int AS n
         FROM generate_series(
                DATE_TRUNC('hour', NOW()) - INTERVAL '23 hours',
                DATE_TRUNC('hour', NOW()),
                INTERVAL '1 hour') g
         LEFT JOIN (
           SELECT DATE_TRUNC('hour', created_at) AS h, COUNT(*) AS n
           FROM transactions
           WHERE created_at > NOW() - INTERVAL '25 hours'
           GROUP BY 1
         ) c ON c.h = g
         ORDER BY g`
      ),
      pool.query(
        `SELECT u.id, u.username,
                u.balance + COALESCE((
                  SELECT SUM(h.quantity * a.price)
                  FROM holdings h JOIN market_assets a ON a.symbol = h.symbol
                  WHERE h.user_id = u.id), 0) AS net
         FROM users u
         ORDER BY net DESC LIMIT 5`
      ),
      pool.query(
        `SELECT t.id, t.type, t.details, t.created_at, u.username
         FROM transactions t JOIN users u ON u.id = t.user_id
         ORDER BY t.created_at DESC, t.id DESC LIMIT 15`
      )
    ]);

  res.json({
    users: users.rows[0],
    holdingsValue: holdings.rows[0].value,
    trades24: activity.rows[0].trades,
    packs24: activity.rows[0].packs,
    cardsOwned: cards.rows[0].total,
    messages24: messages.rows[0].total,
    hourly: hourly.rows.map((row) => ({ hour: row.hour, n: row.n })),
    richest: richest.rows,
    recent: recent.rows
  });
}));

app.get("/api/admin/users", admin, asyncRoute(async (req, res) => {
  const search = cleanText(req.query.search, 60);
  const pattern = search ? `%${escapeLike(search)}%` : null;

  const result = await pool.query(
    `SELECT id, username, email, role, balance, banned, muted_until, created_at
     FROM users
     WHERE $1::text IS NULL OR username ILIKE $1::text OR email ILIKE $1::text
     ORDER BY id DESC LIMIT 500`,
    [pattern]
  );
  res.json({ users: result.rows });
}));

app.patch("/api/admin/users/:id", admin, asyncRoute(async (req, res) => {
  const targetId = parseId(req.params.id);
  if (!targetId) return fail(res, 400, "Identifiant invalide.");

  const body = getBody(req);
  const client = await pool.connect();

  const abort = async (status, message) => {
    await client.query("ROLLBACK");
    return fail(res, status, message);
  };

  try {
    await client.query("BEGIN");

    const found = await client.query(
      "SELECT id, username, role, balance FROM users WHERE id = $1 FOR UPDATE",
      [targetId]
    );
    if (!found.rows.length) return abort(404, "Utilisateur introuvable.");

    const target = found.rows[0];
    const sets = [];
    const params = [];
    const changes = {};
    const add = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (body.role !== undefined) {
      if (!["user", "admin"].includes(body.role)) {
        return abort(400, "Rôle invalide.");
      }

      if (body.role !== target.role) {
        if (targetId === req.user.id) {
          return abort(400, "Tu ne peux pas modifier ton propre rôle.");
        }

        if (target.role === "admin") {
          const others = await client.query(
            "SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND id <> $1 AND NOT banned",
            [targetId]
          );
          if (others.rows[0].n < 1) {
            return abort(400, "Il doit rester au moins un administrateur.");
          }
        }

        add("role", body.role);
        changes.role = body.role;
      }
    }

    if (body.banned !== undefined) {
      const banned = Boolean(body.banned);
      if (banned && targetId === req.user.id) {
        return abort(400, "Tu ne peux pas te suspendre toi-même.");
      }
      if (banned && target.role === "admin") {
        return abort(400, "Retire d'abord le rôle administrateur à ce compte.");
      }
      add("banned", banned);
      changes.banned = banned;
    }

    if (body.muteMinutes !== undefined) {
      const minutes = Number(body.muteMinutes);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 43200) {
        return abort(400, "Durée invalide.");
      }

      if (minutes === 0) {
        sets.push("muted_until = NULL");
      } else {
        params.push(Math.round(minutes));
        sets.push(`muted_until = NOW() + make_interval(mins => $${params.length}::int)`);
      }
      changes.muteMinutes = Math.round(minutes);
    }

    if (body.balance && typeof body.balance === "object") {
      const amount = Number(body.balance.amount);
      const mode = body.balance.mode;
      const current = Number(target.balance);

      if (!Number.isFinite(amount) || Math.abs(amount) > 1e12 || !["add", "set"].includes(mode)) {
        return abort(400, "Montant invalide.");
      }

      const next = mode === "set" ? amount : current + amount;
      if (!Number.isFinite(next) || next < 0 || next > 9999999999999) {
        return abort(400, "Le solde doit rester entre 0 et 9 999 999 999 999.");
      }

      add("balance", Number(next.toFixed(2)));
      changes.balance = { mode, amount };
    }

    if (body.email !== undefined) {
      const email = normalizeEmail(body.email);

      if (email === "") {
        add("email", null);
      } else {
        if (!isValidEmailFormat(email)) {
          return abort(400, "Adresse e-mail invalide.");
        }

        const used = await client.query(
          "SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1",
          [email, targetId]
        );
        if (used.rows.length) {
          return abort(409, "Cette adresse e-mail est déjà utilisée.");
        }
        add("email", email);
      }
      changes.email = email || null;
    }

    if (!sets.length) return abort(400, "Aucune modification demandée.");

    params.push(targetId);
    await client.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params
    );

    await logAdmin(client, req.user.id, "user.update", {
      target: target.username, targetId, ...changes
    });

    await client.query("COMMIT");

    if (changes.banned === true) killSessions(targetId);
    res.json({ ok: true });
  } catch (err) {
    await safeRollback(client);
    if (err.code === "23505") {
      return fail(res, 409, "Cette adresse e-mail est déjà utilisée.");
    }
    throw err;
  } finally {
    client.release();
  }
}));

app.delete("/api/admin/users/:id", admin, asyncRoute(async (req, res) => {
  const targetId = parseId(req.params.id);
  if (!targetId) return fail(res, 400, "Identifiant invalide.");

  if (targetId === req.user.id) {
    return fail(res, 400, "Tu ne peux pas supprimer ton propre compte.");
  }

  const found = await pool.query(
    "SELECT id, username, role FROM users WHERE id = $1",
    [targetId]
  );
  if (!found.rows.length) return fail(res, 404, "Utilisateur introuvable.");
  if (found.rows[0].role === "admin") {
    return fail(res, 400, "Retire d'abord le rôle administrateur à ce compte.");
  }

  try {
    await pool.query("DELETE FROM users WHERE id = $1", [targetId]);
  } catch (err) {
    if (err.code === "23503") {
      return fail(res, 409, "Suppression impossible : des données sont encore liées à ce compte.");
    }
    throw err;
  }

  killSessions(targetId);
  await logAdmin(pool, req.user.id, "user.delete", {
    target: found.rows[0].username, targetId
  });
  res.json({ ok: true });
}));

app.post("/api/admin/users/:id/grant", admin, asyncRoute(async (req, res) => {
  const targetId = parseId(req.params.id);
  if (!targetId) return fail(res, 400, "Identifiant invalide.");

  const body = getBody(req);
  const client = await pool.connect();

  const abort = async (status, message) => {
    await client.query("ROLLBACK");
    return fail(res, status, message);
  };

  try {
    await client.query("BEGIN");

    const found = await client.query(
      "SELECT id, username FROM users WHERE id = $1 FOR UPDATE",
      [targetId]
    );
    if (!found.rows.length) return abort(404, "Utilisateur introuvable.");

    if (body.type === "card") {
      const cardId = parseId(body.cardId);
      const quantity = clampInt(body.quantity, 1, 100, 1);
      if (!cardId) return abort(400, "Carte invalide.");

      const card = await client.query("SELECT id, name FROM cards WHERE id = $1", [cardId]);
      if (!card.rows.length) return abort(404, "Carte introuvable.");

      const owned = await client.query(
        "SELECT quantity FROM user_cards WHERE user_id = $1 AND card_id = $2 FOR UPDATE",
        [targetId, cardId]
      );

      if (owned.rows.length) {
        await client.query(
          "UPDATE user_cards SET quantity = quantity + $3 WHERE user_id = $1 AND card_id = $2",
          [targetId, cardId, quantity]
        );
      } else {
        await client.query(
          "INSERT INTO user_cards (user_id, card_id, quantity) VALUES ($1, $2, $3)",
          [targetId, cardId, quantity]
        );
      }

      await logAdmin(client, req.user.id, "user.grant_card", {
        target: found.rows[0].username, card: card.rows[0].name, quantity
      });
    } else if (body.type === "title") {
      const titleId = parseId(body.titleId);
      if (!titleId) return abort(400, "Titre invalide.");

      const title = await client.query("SELECT id, name FROM titles WHERE id = $1", [titleId]);
      if (!title.rows.length) return abort(404, "Titre introuvable.");

      await client.query(
        `INSERT INTO user_titles (user_id, title_id)
         SELECT $1::int, $2::int
         WHERE NOT EXISTS (
           SELECT 1 FROM user_titles
           WHERE user_id = $1::int AND title_id = $2::int
         )`,
        [targetId, titleId]
      );

      await logAdmin(client, req.user.id, "user.grant_title", {
        target: found.rows[0].username, title: title.rows[0].name
      });
    } else {
      return abort(400, "Type de cadeau invalide.");
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

/* ----- Boutique ----- */

function packFields(body, { requireAll }) {
  const fields = {};
  const errors = [];

  const take = (key, column, parse) => {
    if (body[key] === undefined) {
      if (requireAll) errors.push(`Champ manquant : ${key}`);
      return;
    }
    const value = parse(body[key]);
    if (value === null) errors.push(`Valeur invalide : ${key}`);
    else fields[column] = value;
  };

  take("name", "name", (v) => cleanText(v, 100) || null);
  take("description", "description", (v) => cleanText(v, 300));
  take("price", "price", (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1e9 ? Number(n.toFixed(2)) : null;
  });
  take("stock", "stock", (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 1000000 ? n : null;
  });
  take("cardsPerPack", "cards_per_pack", (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
  });
  take("tier", "tier", (v) => (isTier(v) ? v : null));
  take("emoji", "emoji", (v) => cleanText(v, 8) || null);
  take("active", "active", (v) => (typeof v === "boolean" ? v : null));

  return { fields, errors };
}

app.get("/api/admin/packs", admin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, description, price, stock, tier, cards_per_pack, emoji,
            COALESCE(active, TRUE) AS active
     FROM shop_packs ORDER BY price, id`
  );

  res.json({
    packs: result.rows.map((row) => ({ ...packPayload(row), active: row.active }))
  });
}));

app.post("/api/admin/packs", admin, asyncRoute(async (req, res) => {
  const body = getBody(req);
  const { fields, errors } = packFields(
    { description: "", emoji: "📦", active: true, ...body },
    { requireAll: true }
  );
  if (errors.length) return fail(res, 400, "Pack invalide : vérifie les champs.");

  const result = await pool.query(
    `INSERT INTO shop_packs
       (name, description, price, stock, tier, cards_per_pack, emoji, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [fields.name, fields.description, fields.price, fields.stock, fields.tier,
     fields.cards_per_pack, fields.emoji, fields.active]
  );

  await logAdmin(pool, req.user.id, "pack.create", { name: fields.name });
  res.status(201).json({ id: result.rows[0].id });
}));

app.patch("/api/admin/packs/:id", admin, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, "Identifiant invalide.");

  const { fields, errors } = packFields(getBody(req), { requireAll: false });
  if (errors.length) return fail(res, 400, "Pack invalide : vérifie les champs.");

  const columns = Object.keys(fields);
  if (!columns.length) return fail(res, 400, "Aucune modification demandée.");

  const params = columns.map((column) => fields[column]);
  params.push(id);

  const result = await pool.query(
    `UPDATE shop_packs
     SET ${columns.map((column, i) => `${column} = $${i + 1}`).join(", ")}
     WHERE id = $${params.length}
     RETURNING id`,
    params
  );
  if (!result.rows.length) return fail(res, 404, "Pack introuvable.");

  await logAdmin(pool, req.user.id, "pack.update", { id, ...fields });
  res.json({ ok: true });
}));

app.post("/api/admin/shop/restock", admin, asyncRoute(async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const packs = await client.query(
      "SELECT id FROM shop_packs WHERE COALESCE(active, TRUE) FOR UPDATE"
    );

    for (const pack of packs.rows) {
      await client.query(
        "UPDATE shop_packs SET stock = $1 WHERE id = $2",
        [randomInt(3, 25), pack.id]
      );
    }

    await logAdmin(client, req.user.id, "shop.restock", { packs: packs.rows.length });
    await client.query("COMMIT");
    res.json({ ok: true, message: "Stocks réapprovisionnés." });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

/* ----- Marché ----- */

function assetFields(body, { requireAll }) {
  const fields = {};
  const errors = [];

  const take = (key, column, parse) => {
    if (body[key] === undefined) {
      if (requireAll) errors.push(`Champ manquant : ${key}`);
      return;
    }
    const value = parse(body[key]);
    if (value === null) errors.push(`Valeur invalide : ${key}`);
    else fields[column] = value;
  };

  take("name", "name", (v) => cleanText(v, 100) || null);
  take("sector", "sector", (v) => cleanText(v, 40) || null);
  take("description", "description", (v) => cleanText(v, 300));
  take("icon", "icon", (v) => cleanText(v, 8) || null);
  take("color", "color", (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v).toLowerCase() : null));
  take("volatility", "volatility", (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0.001 && n <= 0.05 ? Number(n.toFixed(4)) : null;
  });
  take("active", "active", (v) => (typeof v === "boolean" ? v : null));

  return { fields, errors };
}

function validPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0.01 && n <= 1e9 ? Number(n.toFixed(4)) : null;
}

app.get("/api/admin/assets", admin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT symbol, name, price, sector, description, color, icon, volatility,
            base_price, COALESCE(active, TRUE) AS active
     FROM market_assets ORDER BY symbol`
  );
  res.json({ assets: result.rows });
}));

app.post("/api/admin/assets", admin, asyncRoute(async (req, res) => {
  const body = getBody(req);
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const price = validPrice(body.price);

  if (!/^[A-Z0-9]{2,8}$/.test(symbol)) {
    return fail(res, 400, "Le symbole doit contenir de 2 à 8 lettres ou chiffres.");
  }
  if (price === null) return fail(res, 400, "Prix invalide.");

  const { fields, errors } = assetFields(
    { description: "", icon: "📈", color: "#a78bfa", volatility: 0.012, ...body },
    { requireAll: true }
  );
  if (errors.length) return fail(res, 400, "Entreprise invalide : vérifie les champs.");

  const exists = await pool.query("SELECT 1 FROM market_assets WHERE symbol = $1", [symbol]);
  if (exists.rows.length) return fail(res, 409, "Ce symbole existe déjà.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO market_assets
         (symbol, name, price, sector, description, color, icon, volatility, base_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $3)`,
      [symbol, fields.name, price, fields.sector, fields.description,
       fields.color, fields.icon, fields.volatility]
    );
    await client.query(
      "INSERT INTO market_history (symbol, price) VALUES ($1, $2)",
      [symbol, price]
    );
    await logAdmin(client, req.user.id, "asset.create", { symbol, name: fields.name, price });
    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }

  // Donne tout de suite un passé à la nouvelle courbe.
  seedHistoryFor(symbol).catch((err) =>
    console.error("Historique non généré :", err.message)
  );

  res.status(201).json({ symbol });
}));

async function seedHistoryFor(symbol) {
  const result = await pool.query(
    "SELECT symbol, price, base_price, volatility FROM market_assets WHERE symbol = $1",
    [symbol]
  );
  if (!result.rows.length) return;

  const points = generateHistory(result.rows[0]);

  // On retire le point de création et on garde les points générés.
  await pool.query("DELETE FROM market_history WHERE symbol = $1", [symbol]);
  await pool.query(
    `INSERT INTO market_history (symbol, price, recorded_at)
     SELECT $1::text, v.price, v.ts
     FROM unnest($2::numeric[], $3::timestamptz[]) AS v(price, ts)`,
    [symbol, points.map((p) => p.price), points.map((p) => p.at)]
  );
}

app.patch("/api/admin/assets/:symbol", admin, asyncRoute(async (req, res) => {
  const symbol = String(req.params.symbol || "").toUpperCase();
  if (!/^[A-Z0-9._-]{1,20}$/.test(symbol)) return fail(res, 400, "Symbole invalide.");

  const body = getBody(req);
  const { fields, errors } = assetFields(body, { requireAll: false });
  if (errors.length) return fail(res, 400, "Entreprise invalide : vérifie les champs.");

  let newPrice = null;
  if (body.price !== undefined) {
    newPrice = validPrice(body.price);
    if (newPrice === null) return fail(res, 400, "Prix invalide.");
    fields.price = newPrice;
  }

  const columns = Object.keys(fields);
  if (!columns.length) return fail(res, 400, "Aucune modification demandée.");

  const params = columns.map((column) => fields[column]);
  params.push(symbol);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE market_assets
       SET ${columns.map((column, i) => `${column} = $${i + 1}`).join(", ")}
       WHERE symbol = $${params.length}
       RETURNING symbol`,
      params
    );
    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return fail(res, 404, "Entreprise introuvable.");
    }

    if (newPrice !== null) {
      await client.query(
        "INSERT INTO market_history (symbol, price) VALUES ($1, $2)",
        [symbol, newPrice]
      );
    }

    await logAdmin(client, req.user.id, "asset.update", { symbol, ...fields });
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

// Événement de marché : krach ou boom sur une entreprise ou sur tout le marché.
app.post("/api/admin/market/event", admin, asyncRoute(async (req, res) => {
  const body = getBody(req);
  const percent = Number(body.percent);
  const target = String(body.symbol || "").trim().toUpperCase();

  if (!Number.isFinite(percent) || percent < -90 || percent > 500 || percent === 0) {
    return fail(res, 400, "La variation doit être comprise entre -90 % et +500 %.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const assets = target && target !== "ALL"
      ? await client.query(
          "SELECT symbol, price FROM market_assets WHERE symbol = $1 FOR UPDATE",
          [target]
        )
      : await client.query(
          "SELECT symbol, price FROM market_assets WHERE COALESCE(active, TRUE) FOR UPDATE"
        );

    if (!assets.rows.length) {
      await client.query("ROLLBACK");
      return fail(res, 404, "Entreprise introuvable.");
    }

    const symbols = [];
    const prices = [];
    for (const row of assets.rows) {
      symbols.push(row.symbol);
      prices.push(Math.max(0.01, Number((Number(row.price) * (1 + percent / 100)).toFixed(4))));
    }

    await client.query(
      `UPDATE market_assets m
       SET price = v.price, updated_at = NOW()
       FROM unnest($1::text[], $2::numeric[]) AS v(symbol, price)
       WHERE m.symbol = v.symbol`,
      [symbols, prices]
    );
    await client.query(
      `INSERT INTO market_history (symbol, price)
       SELECT v.symbol, v.price
       FROM unnest($1::text[], $2::numeric[]) AS v(symbol, price)`,
      [symbols, prices]
    );

    await logAdmin(client, req.user.id, "market.event", {
      target: target && target !== "ALL" ? target : "ALL", percent, count: symbols.length
    });

    await client.query("COMMIT");
    res.json({ ok: true, updated: symbols.length });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

/* ----- Cartes ----- */

function cardFields(body, { requireAll }) {
  const fields = {};
  const errors = [];

  const take = (key, column, parse) => {
    if (body[key] === undefined) {
      if (requireAll) errors.push(`Champ manquant : ${key}`);
      return;
    }
    const value = parse(body[key]);
    if (value === null) errors.push(`Valeur invalide : ${key}`);
    else fields[column] = value;
  };

  take("name", "name", (v) => cleanText(v, 100) || null);
  take("rarity", "rarity", (v) => (RARITIES.includes(v) ? v : null));
  take("emoji", "emoji", (v) => cleanText(v, 8) || null);
  take("series", "series", (v) => cleanText(v, 40));
  take("description", "description", (v) => cleanText(v, 300));

  return { fields, errors };
}

app.get("/api/admin/cards", admin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.rarity, c.emoji, c.series, c.description,
            COALESCE((SELECT SUM(uc.quantity) FROM user_cards uc WHERE uc.card_id = c.id), 0)::int AS owned
     FROM cards c ORDER BY c.id`
  );

  res.json({
    cards: result.rows.map((row) => cardPayload(row, { owned: row.owned }))
  });
}));

app.post("/api/admin/cards", admin, asyncRoute(async (req, res) => {
  const { fields, errors } = cardFields(
    { emoji: "🃏", series: "", description: "", ...getBody(req) },
    { requireAll: true }
  );
  if (errors.length) return fail(res, 400, "Carte invalide : vérifie les champs.");

  const result = await pool.query(
    `INSERT INTO cards (name, rarity, emoji, series, description)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [fields.name, fields.rarity, fields.emoji, fields.series, fields.description]
  );

  await logAdmin(pool, req.user.id, "card.create", { name: fields.name, rarity: fields.rarity });
  res.status(201).json({ id: result.rows[0].id });
}));

app.patch("/api/admin/cards/:id", admin, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, "Identifiant invalide.");

  const { fields, errors } = cardFields(getBody(req), { requireAll: false });
  if (errors.length) return fail(res, 400, "Carte invalide : vérifie les champs.");

  const columns = Object.keys(fields);
  if (!columns.length) return fail(res, 400, "Aucune modification demandée.");

  const params = columns.map((column) => fields[column]);
  params.push(id);

  const result = await pool.query(
    `UPDATE cards
     SET ${columns.map((column, i) => `${column} = $${i + 1}`).join(", ")}
     WHERE id = $${params.length}
     RETURNING id`,
    params
  );
  if (!result.rows.length) return fail(res, 404, "Carte introuvable.");

  await logAdmin(pool, req.user.id, "card.update", { id, ...fields });
  res.json({ ok: true });
}));

/* ----- Bazar ----- */

app.get("/api/admin/listings", admin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT l.id, l.price, l.status, l.created_at, l.sold_at, l.seller_id,
            s.username AS seller_name, b.username AS buyer_name,
            c.id AS card_id, c.name, c.rarity, c.emoji, c.series, c.description,
            FALSE AS is_friend
     FROM card_listings l
     JOIN users s ON s.id = l.seller_id
     LEFT JOIN users b ON b.id = l.buyer_id
     JOIN cards c ON c.id = l.card_id
     ORDER BY l.id DESC LIMIT 150`
  );

  res.json({
    listings: result.rows.map((row) => ({
      ...listingPayload(row, req.user.id),
      buyer: row.buyer_name || null
    }))
  });
}));

// Retire une annonce abusive : la carte retourne chez son vendeur.
app.post("/api/admin/listings/:id/cancel", admin, asyncRoute(async (req, res) => {
  const listingId = parseId(req.params.id);
  if (!listingId) return fail(res, 400, "Annonce invalide.");

  const client = await pool.connect();
  const abort = async (status, message) => {
    await client.query("ROLLBACK");
    return fail(res, status, message);
  };

  try {
    await client.query("BEGIN");

    const found = await client.query(
      "SELECT id, seller_id, card_id, status FROM card_listings WHERE id = $1 FOR UPDATE",
      [listingId]
    );
    const listing = found.rows[0];
    if (!listing || listing.status !== "active") {
      return abort(404, "Cette annonce n'est plus active.");
    }

    await client.query("UPDATE card_listings SET status = 'cancelled' WHERE id = $1", [listingId]);
    await giveCard(client, listing.seller_id, listing.card_id, 1);
    await logAdmin(client, req.user.id, "listing.cancel", {
      id: listingId, sellerId: listing.seller_id
    });

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

/* ----- Titres, annonce, chat, journal ----- */

app.get("/api/admin/titles", admin, asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT id, name, description FROM titles ORDER BY id");
  res.json({ titles: result.rows });
}));

app.put("/api/admin/announcement", admin, asyncRoute(async (req, res) => {
  const text = cleanText(getBody(req).text, 300);

  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('announcement', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [text]
  );

  await logAdmin(pool, req.user.id, "announcement.set", { text });
  res.json({ ok: true, text });
}));

app.delete("/api/admin/chat/:id", admin, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, "Identifiant invalide.");

  const result = await pool.query(
    "UPDATE chat_messages SET deleted = TRUE WHERE id = $1 RETURNING id",
    [id]
  );
  if (!result.rows.length) return fail(res, 404, "Message introuvable.");

  await logAdmin(pool, req.user.id, "chat.delete", { id });
  res.json({ ok: true });
}));

app.post("/api/admin/chat/clear", admin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "UPDATE chat_messages SET deleted = TRUE WHERE NOT deleted"
  );

  await logAdmin(pool, req.user.id, "chat.clear", { count: result.rowCount });
  res.json({ ok: true, cleared: result.rowCount });
}));

app.get("/api/admin/logs", admin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT l.id, l.action, l.details, l.created_at, u.username
     FROM admin_logs l LEFT JOIN users u ON u.id = l.admin_id
     ORDER BY l.id DESC LIMIT 100`
  );
  res.json({ logs: result.rows });
}));

/* ------------------------------------------------------------------ */
/* Erreurs et démarrage                                                */
/* ------------------------------------------------------------------ */

// Les routes /api inconnues répondent en JSON (et non en page HTML).
app.use("/api", (req, res) => {
  fail(res, 404, "Route introuvable.");
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Erreurs du client (JSON mal formé, corps trop gros...) : 4xx, pas 500.
  const status = Number(err.status || err.statusCode);
  if (status >= 400 && status < 500) {
    return fail(
      res,
      status,
      err.type === "entity.too.large"
        ? "Requête trop volumineuse."
        : "Requête invalide."
    );
  }

  const requestId = crypto.randomUUID();
  console.error(`Erreur serveur [${requestId}] :`, err.stack || err.message);

  res.status(500).json({
    error: "Une erreur interne est survenue.",
    requestId
  });
});

let server = null;
let marketTimer = null;
let restockTimer = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} reçu : arrêt en cours...`);

  clearInterval(marketTimer);
  clearInterval(restockTimer);

  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await pool.end();
  } catch (err) {
    console.error("Erreur pendant l'arrêt :", err.message);
  }

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("Promesse rejetée non gérée :", reason);
});

async function start() {
  await initDb();
  await configureAdmin();

  try {
    await seedHistory();
  } catch (err) {
    console.error("Historique initial non généré :", err.message);
  }

  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sigma Exchange écoute sur le port ${PORT}.`);
  });

  server.on("error", (err) => {
    console.error("Erreur du serveur HTTP :", err.message);
    process.exit(1);
  });

  marketTimer = setInterval(updateMarket, 60 * 1000);
  restockTimer = setInterval(restockPacks, 5 * 60 * 1000);
}

start().catch((err) => {
  console.error("Impossible de démarrer Sigma Exchange :", err.message);
  process.exit(1);
});
