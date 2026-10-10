"use strict";

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("La variable DATABASE_URL est absente.");
}

const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
  max: 10
});

pool.on("error", (err) => {
  console.error("Erreur PostgreSQL inattendue :", err.message);
});

// ROLLBACK qui ne masque jamais l'erreur d'origine
// (par exemple si la connexion est déjà perdue).
async function safeRollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch (err) {
    console.error("ROLLBACK impossible :", err.message);
  }
}

async function initDb() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Verrou léger : évite les doublons de données initiales si deux
    // instances démarrent en même temps (déploiement, redémarrage).
    await client.query("SELECT pg_advisory_xact_lock(727001)");

    // Crée les tables qui n'existent pas encore.
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'user',
        balance NUMERIC(15,2) NOT NULL DEFAULT 10000,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS holdings (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol VARCHAR(20) NOT NULL,
        quantity NUMERIC(20,8) NOT NULL DEFAULT 0,
        average_price NUMERIC(20,8) NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, symbol)
      );

      CREATE TABLE IF NOT EXISTS cards (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        rarity VARCHAR(30) NOT NULL DEFAULT 'common',
        image_url TEXT,
        description TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS user_cards (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, card_id)
      );

      CREATE TABLE IF NOT EXISTS shop_packs (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        price NUMERIC(15,2) NOT NULL DEFAULT 100,
        stock INTEGER NOT NULL DEFAULT 0,
        image_url TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS titles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS user_titles (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, title_id)
      );

      CREATE TABLE IF NOT EXISTS market_assets (
        symbol VARCHAR(20) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price NUMERIC(20,8) NOT NULL DEFAULT 100,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(30) NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Migration additive : complète les anciennes tables sans
    // effacer leurs lignes ni recréer la base.
    // Les noms ci-dessous sont des constantes internes, jamais des
    // valeurs fournies par un utilisateur.
    const migrations = [
      ["users", "id", "SERIAL"],
      ["users", "username", "VARCHAR(50)"],
      ["users", "password_hash", "TEXT"],
      ["users", "role", "VARCHAR(20) NOT NULL DEFAULT 'user'"],
      ["users", "balance", "NUMERIC(15,2) NOT NULL DEFAULT 10000"],
      ["users", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],

      ["holdings", "user_id", "INTEGER"],
      ["holdings", "symbol", "VARCHAR(20)"],
      ["holdings", "quantity", "NUMERIC(20,8) NOT NULL DEFAULT 0"],
      ["holdings", "average_price", "NUMERIC(20,8) NOT NULL DEFAULT 0"],

      ["cards", "id", "SERIAL"],
      ["cards", "name", "VARCHAR(100)"],
      ["cards", "rarity", "VARCHAR(30) NOT NULL DEFAULT 'common'"],
      ["cards", "image_url", "TEXT"],
      ["cards", "description", "TEXT NOT NULL DEFAULT ''"],

      ["user_cards", "user_id", "INTEGER"],
      ["user_cards", "card_id", "INTEGER"],
      ["user_cards", "quantity", "INTEGER NOT NULL DEFAULT 0"],

      ["shop_packs", "id", "SERIAL"],
      ["shop_packs", "name", "VARCHAR(100)"],
      ["shop_packs", "description", "TEXT NOT NULL DEFAULT ''"],
      ["shop_packs", "price", "NUMERIC(15,2) NOT NULL DEFAULT 100"],
      ["shop_packs", "stock", "INTEGER NOT NULL DEFAULT 0"],
      ["shop_packs", "image_url", "TEXT"],
      ["shop_packs", "active", "BOOLEAN NOT NULL DEFAULT TRUE"],

      ["titles", "id", "SERIAL"],
      ["titles", "name", "VARCHAR(100)"],
      ["titles", "description", "TEXT NOT NULL DEFAULT ''"],

      ["user_titles", "user_id", "INTEGER"],
      ["user_titles", "title_id", "INTEGER"],

      ["market_assets", "symbol", "VARCHAR(20)"],
      ["market_assets", "name", "VARCHAR(100)"],
      ["market_assets", "price", "NUMERIC(20,8) NOT NULL DEFAULT 100"],
      ["market_assets", "updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],

      ["transactions", "id", "SERIAL"],
      ["transactions", "user_id", "INTEGER"],
      ["transactions", "type", "VARCHAR(30)"],
      ["transactions", "details", "JSONB NOT NULL DEFAULT '{}'::jsonb"],
      ["transactions", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"]
    ];

    for (const [table, column, definition] of migrations) {
      await client.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${definition}`
      );
    }

    // Données initiales : ajoutées seulement si elles n'existent pas.
    // Les casts explicites (::text, ::numeric, ::int) évitent l'erreur
    // PostgreSQL « inconsistent types deduced for parameter $1 » quand
    // un même paramètre est utilisé dans le SELECT et dans le WHERE.
    const cards = [
      ["Nova", "common", "Carte de départ de la collection."],
      ["Orion", "rare", "Une carte rare de l'univers Sigma."],
      ["Eclipse", "epic", "Une carte épique très recherchée."],
      ["Singularity", "legendary", "Une carte légendaire de collection."]
    ];

    for (const [name, rarity, description] of cards) {
      await client.query(
        `INSERT INTO cards (name, rarity, description)
         SELECT $1::text, $2::text, $3::text
         WHERE NOT EXISTS (
           SELECT 1 FROM cards WHERE name = $1::text
         )`,
        [name, rarity, description]
      );
    }

    const packs = [
      ["Découverte", "Un pack pour commencer ta collection.", 100, 20],
      ["Premium", "Un pack avec des cartes plus rares.", 350, 10],
      ["Légendaire", "Un pack de collection haut de gamme.", 800, 3]
    ];

    for (const [name, description, price, stock] of packs) {
      await client.query(
        `INSERT INTO shop_packs (name, description, price, stock, active)
         SELECT $1::text, $2::text, $3::numeric, $4::int, TRUE
         WHERE NOT EXISTS (
           SELECT 1 FROM shop_packs WHERE name = $1::text
         )`,
        [name, description, price, stock]
      );
    }

    const titles = [
      ["Nouveau membre", "Bienvenue dans Sigma Exchange."],
      ["Collectionneur", "Tu collectionnes les cartes Sigma."],
      ["Investisseur", "Tu as commencé à investir sur le marché."]
    ];

    for (const [name, description] of titles) {
      await client.query(
        `INSERT INTO titles (name, description)
         SELECT $1::text, $2::text
         WHERE NOT EXISTS (
           SELECT 1 FROM titles WHERE name = $1::text
         )`,
        [name, description]
      );
    }

    // WHERE NOT EXISTS plutôt que ON CONFLICT (symbol) : fonctionne même
    // si une ancienne table market_assets n'a pas de contrainte unique
    // sur « symbol ».
    const assets = [
      ["SIG", "Sigma", 100],
      ["NOVA", "Nova Systems", 45],
      ["ORX", "Orion Exchange", 75],
      ["ECL", "Eclipse Labs", 125]
    ];

    for (const [symbol, name, price] of assets) {
      await client.query(
        `INSERT INTO market_assets (symbol, name, price)
         SELECT $1::text, $2::text, $3::numeric
         WHERE NOT EXISTS (
           SELECT 1 FROM market_assets WHERE symbol = $1::text
         )`,
        [symbol, name, price]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client);
    console.error("Échec de l'initialisation PostgreSQL :", err.message);
    throw err;
  } finally {
    client.release();
  }

  // Empêche deux comptes « Bob » et « bob » créés au même instant.
  // Hors transaction : si d'anciens doublons existent déjà, on prévient
  // simplement au lieu d'empêcher le serveur de démarrer.
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx
       ON users (LOWER(username))`
    );
  } catch (err) {
    console.warn(
      "Index d'unicité insensible à la casse non créé " +
      "(doublons existants ?) :", err.message
    );
  }

  console.log("Base PostgreSQL vérifiée et migrations terminées.");
}

module.exports = { pool, initDb, safeRollback };
