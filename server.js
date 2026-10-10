"use strict";

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
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

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return fail(res, 401, "Connecte-toi pour continuer.");
  }
  next();
}

async function requireAdmin(req, res, next) {
  try {
    if (!req.session.userId) {
      return fail(res, 401, "Connexion requise.");
    }

    const result = await pool.query(
      "SELECT role FROM users WHERE id = $1",
      [req.session.userId]
    );

    if (!result.rows.length || result.rows[0].role !== "admin") {
      return fail(res, 403, "Accès réservé à l'administrateur.");
    }

    next();
  } catch (err) {
    next(err);
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomCard(cards) {
  if (!cards.length) {
    throw new Error("Aucune carte disponible dans la base.");
  }

  const roll = Math.random() * 100;
  const rarity = roll < 1 ? "legendary"
    : roll < 6 ? "epic"
    : roll < 25 ? "rare"
    : "common";

  let candidates = cards.filter(card => card.rarity === rarity);
  if (!candidates.length) candidates = cards;

  return candidates[randomInt(0, candidates.length - 1)];
}

async function recordTransaction(client, userId, type, details) {
  await client.query(
    `INSERT INTO transactions (user_id, type, details)
     VALUES ($1, $2, $3::jsonb)`,
    [userId, type, JSON.stringify(details)]
  );
}

// Crée ou met à jour l'administrateur uniquement si les variables
// secrètes d'administration sont configurées dans Render.
async function configureAdmin() {
  const username = (process.env.ADMIN_USERNAME || "").trim();
  const password = process.env.ADMIN_PASSWORD || "";

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
    "SELECT id FROM users WHERE LOWER(username) = LOWER($1) ORDER BY id LIMIT 1",
    [username]
  );

  if (existing.rows.length) {
    await pool.query(
      "UPDATE users SET role = 'admin', password_hash = $1 WHERE id = $2",
      [passwordHash, existing.rows[0].id]
    );
    console.log("Compte administrateur configuré.");
  } else {
    await pool.query(
      `INSERT INTO users (username, password_hash, role, balance)
       VALUES ($1, $2, 'admin', 10000)`,
      [username, passwordHash]
    );
    console.log("Compte administrateur créé.");
  }
}

app.get("/api/health", asyncRoute(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, database: "connected" });
}));

app.get("/api/me", asyncRoute(async (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }

  const result = await pool.query(
    `SELECT id, username, role, balance, created_at
     FROM users WHERE id = $1`,
    [req.session.userId]
  );

  if (!result.rows.length) {
    return req.session.destroy(() => res.json({ user: null }));
  }

  res.json({ user: result.rows[0] });
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

  const existing = await pool.query(
    "SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1",
    [username]
  );

  if (existing.rows.length) {
    return fail(res, 409, "Ce nom d'utilisateur existe déjà.");
  }

  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  let user;

  try {
    await client.query("BEGIN");

    const created = await client.query(
      `INSERT INTO users (username, password_hash, role, balance)
       VALUES ($1, $2, 'user', 10000)
       RETURNING id, username, role, balance, created_at`,
      [username, hash]
    );

    user = created.rows[0];

    const title = await client.query(
      "SELECT id FROM titles WHERE name = $1 LIMIT 1",
      ["Nouveau membre"]
    );

    if (title.rows.length) {
      await client.query(
        `INSERT INTO user_titles (user_id, title_id)
         SELECT $1::int, $2::int
         WHERE NOT EXISTS (
           SELECT 1 FROM user_titles
           WHERE user_id = $1::int AND title_id = $2::int
         )`,
        [user.id, title.rows[0].id]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client);
    if (err.code === "23505") {
      return fail(res, 409, "Ce nom d'utilisateur existe déjà.");
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
      res.status(201).json({ user });
    });
  });
}));

app.post("/api/login", loginLimiter, asyncRoute(async (req, res) => {
  const body = getBody(req);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  const result = await pool.query(
    `SELECT id, username, password_hash, role, balance, created_at
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

  req.session.regenerate((err) => {
    if (err) return fail(res, 500, "Impossible de créer la session.");

    req.session.userId = user.id;
    req.session.save((saveErr) => {
      if (saveErr) return fail(res, 500, "Impossible d'enregistrer la session.");

      delete user.password_hash;
      res.json({ user });
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

app.get("/api/market", asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT symbol, name, price, updated_at FROM market_assets ORDER BY symbol"
  );
  res.json({ assets: result.rows });
}));

app.get("/api/portfolio", requireAuth, asyncRoute(async (req, res) => {
  const [user, holdings] = await Promise.all([
    pool.query("SELECT balance FROM users WHERE id = $1", [req.session.userId]),
    pool.query(
      `SELECT h.symbol, h.quantity, h.average_price, a.name, a.price
       FROM holdings h
       LEFT JOIN market_assets a ON a.symbol = h.symbol
       WHERE h.user_id = $1 ORDER BY h.symbol`,
      [req.session.userId]
    )
  ]);

  res.json({
    balance: user.rows[0]?.balance ?? 0,
    holdings: holdings.rows
  });
}));

app.post("/api/trade", requireAuth, asyncRoute(async (req, res) => {
  const body = getBody(req);
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
      "SELECT symbol, name, price FROM market_assets WHERE symbol = $1 FOR UPDATE",
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
      [req.session.userId]
    );
    if (!userResult.rows.length) throw new Error("Utilisateur introuvable.");

    const balance = Number(userResult.rows[0].balance);

    const holdingResult = await client.query(
      "SELECT quantity, average_price FROM holdings WHERE user_id = $1 AND symbol = $2 FOR UPDATE",
      [req.session.userId, symbol]
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
        [total, req.session.userId]
      );

      if (holding) {
        await client.query(
          `UPDATE holdings SET quantity = $1, average_price = $2
           WHERE user_id = $3 AND symbol = $4`,
          [newQuantity, newAverage, req.session.userId, symbol]
        );
      } else {
        await client.query(
          `INSERT INTO holdings (user_id, symbol, quantity, average_price)
           VALUES ($1, $2, $3, $4)`,
          [req.session.userId, symbol, quantity, price]
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
        [total, req.session.userId]
      );

      if (closesPosition) {
        await client.query(
          "DELETE FROM holdings WHERE user_id = $1 AND symbol = $2",
          [req.session.userId, symbol]
        );
      } else {
        await client.query(
          "UPDATE holdings SET quantity = $1 WHERE user_id = $2 AND symbol = $3",
          [remaining, req.session.userId, symbol]
        );
      }
    }

    await recordTransaction(client, req.session.userId, side, {
      symbol, quantity, price, total
    });

    const updated = await client.query(
      "SELECT balance FROM users WHERE id = $1",
      [req.session.userId]
    );

    await client.query("COMMIT");
    res.json({ balance: updated.rows[0].balance, symbol, quantity, price, total });
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
    [req.session.userId]
  );
  res.json({ transactions: result.rows });
}));

app.get("/api/cards", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.rarity, c.image_url, c.description,
            COALESCE(uc.quantity, 0)::int AS quantity
     FROM cards c
     LEFT JOIN user_cards uc
       ON uc.card_id = c.id AND uc.user_id = $1
     ORDER BY c.id`,
    [req.session.userId]
  );
  res.json({ cards: result.rows });
}));

app.get("/api/shop", asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, description, price, stock, image_url
     FROM shop_packs WHERE active = TRUE ORDER BY price, id`
  );
  res.json({ packs: result.rows });
}));

app.post("/api/shop/buy", requireAuth, asyncRoute(async (req, res) => {
  const packId = Number(getBody(req).packId);
  if (!Number.isInteger(packId) || packId <= 0) {
    return fail(res, 400, "Pack invalide.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const packResult = await client.query(
      "SELECT * FROM shop_packs WHERE id = $1 AND active = TRUE FOR UPDATE",
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
      [req.session.userId]
    );
    if (!userResult.rows.length) throw new Error("Utilisateur introuvable.");

    const balance = Number(userResult.rows[0].balance);
    const price = Number(pack.price);

    if (balance < price) {
      await client.query("ROLLBACK");
      return fail(res, 400, "Solde insuffisant.");
    }

    const cardResult = await client.query(
      "SELECT id, name, rarity, image_url, description FROM cards"
    );
    if (!cardResult.rows.length) throw new Error("Aucune carte n'est configurée.");

    const card = randomCard(cardResult.rows);

    await client.query(
      "UPDATE users SET balance = balance - $1 WHERE id = $2",
      [price, req.session.userId]
    );
    await client.query(
      "UPDATE shop_packs SET stock = stock - 1 WHERE id = $1",
      [packId]
    );

    const owned = await client.query(
      "SELECT quantity FROM user_cards WHERE user_id = $1 AND card_id = $2 FOR UPDATE",
      [req.session.userId, card.id]
    );

    if (owned.rows.length) {
      await client.query(
        "UPDATE user_cards SET quantity = quantity + 1 WHERE user_id = $1 AND card_id = $2",
        [req.session.userId, card.id]
      );
    } else {
      await client.query(
        "INSERT INTO user_cards (user_id, card_id, quantity) VALUES ($1, $2, 1)",
        [req.session.userId, card.id]
      );
    }

    await recordTransaction(client, req.session.userId, "pack_purchase", {
      packId, packName: pack.name, price, card: card.name, rarity: card.rarity
    });

    const updated = await client.query(
      "SELECT balance FROM users WHERE id = $1",
      [req.session.userId]
    );

    await client.query("COMMIT");
    res.json({ balance: updated.rows[0].balance, cards: [card] });
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
    [req.session.userId]
  );
  res.json({ titles: result.rows });
}));

app.get("/api/admin/users", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, username, role, balance, created_at
     FROM users ORDER BY id DESC LIMIT 500`
  );
  res.json({ users: result.rows });
}));

app.post("/api/admin/shop/restock", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const packs = await client.query(
      "SELECT id FROM shop_packs WHERE active = TRUE FOR UPDATE"
    );

    for (const pack of packs.rows) {
      await client.query(
        "UPDATE shop_packs SET stock = $1 WHERE id = $2",
        [randomInt(3, 25), pack.id]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, message: "Stocks réapprovisionnés." });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}));

// Variation fictive des cours, sans argent réel.
let marketUpdating = false;

async function updateMarket() {
  if (marketUpdating) return;
  marketUpdating = true;

  try {
    const result = await pool.query(
      "SELECT symbol, price FROM market_assets"
    );

    for (const asset of result.rows) {
      const oldPrice = Number(asset.price);
      const variation = (Math.random() * 0.06) - 0.03;
      const newPrice = Math.max(0.01, Number((oldPrice * (1 + variation)).toFixed(4)));

      await pool.query(
        "UPDATE market_assets SET price = $1, updated_at = NOW() WHERE symbol = $2",
        [newPrice, asset.symbol]
      );
    }
  } catch (err) {
    console.error("Mise à jour du marché impossible :", err.message);
  } finally {
    marketUpdating = false;
  }
}

async function restockPacks() {
  try {
    const packs = await pool.query(
      "SELECT id FROM shop_packs WHERE active = TRUE"
    );

    for (const pack of packs.rows) {
      // Les stocks ne sont pas forcément remis à zéro : ils reçoivent
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

  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sigma Exchange écoute sur le port ${PORT}.`);
  });

  server.on("error", (err) => {
    console.error("Erreur du serveur HTTP :", err.message);
    process.exit(1);
  });

  marketTimer = setInterval(updateMarket, 60 * 1000);
  restockTimer = setInterval(restockPacks, 5 * 60 * 1000);

  // Initialise le marché sans attendre la première minute.
  updateMarket();
}

start().catch((err) => {
  console.error("Impossible de démarrer Sigma Exchange :", err.message);
  process.exit(1);
});
