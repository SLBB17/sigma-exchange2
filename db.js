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
  const droppedPkTables = new Set();

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

      CREATE TABLE IF NOT EXISTS market_history (
        id BIGSERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        price NUMERIC(20,8) NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS market_history_symbol_time_idx
        ON market_history (symbol, recorded_at DESC);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(60) NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(60) PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      ["transactions", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],

      ["market_history", "symbol", "VARCHAR(20)"],
      ["market_history", "price", "NUMERIC(20,8)"],
      ["market_history", "recorded_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],

      ["chat_messages", "user_id", "INTEGER"],
      ["chat_messages", "body", "TEXT NOT NULL DEFAULT ''"],
      ["chat_messages", "deleted", "BOOLEAN NOT NULL DEFAULT FALSE"],
      ["chat_messages", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],

      ["admin_logs", "admin_id", "INTEGER"],
      ["admin_logs", "action", "VARCHAR(60)"],
      ["admin_logs", "details", "JSONB NOT NULL DEFAULT '{}'::jsonb"],
      ["admin_logs", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],

      ["app_settings", "key", "VARCHAR(60)"],
      ["app_settings", "value", "TEXT NOT NULL DEFAULT ''"],
      ["app_settings", "updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],

      ["users", "email", "VARCHAR(254)"],
      ["users", "banned", "BOOLEAN NOT NULL DEFAULT FALSE"],
      ["users", "muted_until", "TIMESTAMPTZ"],

      ["market_assets", "sector", "VARCHAR(40)"],
      ["market_assets", "description", "TEXT"],
      ["market_assets", "color", "VARCHAR(9)"],
      ["market_assets", "icon", "VARCHAR(16)"],
      ["market_assets", "volatility", "NUMERIC(6,4)"],
      ["market_assets", "base_price", "NUMERIC(20,8)"],
      ["market_assets", "active", "BOOLEAN NOT NULL DEFAULT TRUE"],

      ["cards", "emoji", "VARCHAR(16)"],
      ["cards", "series", "VARCHAR(40)"],

      ["shop_packs", "tier", "VARCHAR(20)"],
      ["shop_packs", "cards_per_pack", "INTEGER"],
      ["shop_packs", "emoji", "VARCHAR(16)"]
    ];

    for (const [table, column, definition] of migrations) {
      await client.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${definition}`
      );
    }

    // ------------------------------------------------------------------
    // Réparation des anciennes tables (versions précédentes du site).
    // Rien n'est supprimé : on assouplit seulement ce qui bloque.
    // ------------------------------------------------------------------

    // 1) Colonnes trop étroites ou de mauvais type pour les nouvelles
    //    valeurs (quantités décimales, montants à 2 décimales, etc.).
    const varcharMinimums = [
      ["users", "username", 50],
      ["users", "role", 20],
      ["cards", "rarity", 30],
      ["holdings", "symbol", 20],
      ["market_assets", "symbol", 20],
      ["transactions", "type", 30]
    ];

    for (const [table, column, minLength] of varcharMinimums) {
      const info = await client.query(
        `SELECT character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = $1 AND column_name = $2
           AND data_type = 'character varying'`,
        [table, column]
      );
      const length = info.rows[0]?.character_maximum_length;

      if (length && length < minLength) {
        await client.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE VARCHAR(${minLength})`
        );
        console.log(`Colonne élargie : ${table}.${column} -> VARCHAR(${minLength})`);
      }
    }

    const numericTargets = [
      ["users", "balance", 15, 2],
      ["shop_packs", "price", 15, 2],
      ["holdings", "quantity", 20, 8],
      ["holdings", "average_price", 20, 8],
      ["market_assets", "price", 20, 8]
    ];

    for (const [table, column, precision, scale] of numericTargets) {
      const info = await client.query(
        `SELECT data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      const col = info.rows[0];
      if (!col) continue;

      const isInteger = ["smallint", "integer", "bigint"].includes(col.data_type);
      const isNarrowNumeric =
        col.data_type === "numeric" &&
        col.numeric_scale !== null &&
        (col.numeric_scale < scale || col.numeric_precision < precision);

      if (isInteger || isNarrowNumeric) {
        const integerDigits = isInteger
          ? 19
          : Number(col.numeric_precision) - Number(col.numeric_scale);
        const newPrecision = Math.max(precision, integerDigits + scale);

        await client.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${column}"
           TYPE NUMERIC(${newPrecision},${scale}) USING "${column}"::numeric`
        );
        console.log(`Colonne élargie : ${table}.${column} -> NUMERIC(${newPrecision},${scale})`);
      }
    }

    // 2) Anciennes colonnes obligatoires sans valeur par défaut
    //    (ex. first_name, email, title_key...) : elles bloqueraient les
    //    nouvelles insertions. Si l'une d'elles fait partie d'une clé
    //    primaire, on retire cette clé primaire (les lignes restent), puis
    //    on rend la colonne facultative. Un index d'unicité équivalent est
    //    recréé plus bas pour les tables concernées.
    const knownColumns = new Map();
    for (const [table, column] of migrations) {
      if (!knownColumns.has(table)) knownColumns.set(table, new Set());
      knownColumns.get(table).add(column);
    }

    const blocking = await client.query(
      `SELECT c.relname AS table_name,
              a.attname AS column_name,
              (SELECT con.conname
               FROM pg_constraint con
               WHERE con.conrelid = a.attrelid
                 AND con.contype = 'p'
                 AND a.attnum = ANY(con.conkey)
               LIMIT 1) AS pk_name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND c.relname = ANY($1::text[])
         AND a.attnum > 0
         AND NOT a.attisdropped
         AND a.attnotnull
         AND NOT a.atthasdef
         AND a.attidentity = ''`,
      [Array.from(knownColumns.keys())]
    );

    for (const row of blocking.rows) {
      if (knownColumns.get(row.table_name)?.has(row.column_name)) continue;

      if (row.pk_name && !droppedPkTables.has(row.table_name)) {
        await client.query(
          `ALTER TABLE "${row.table_name}" DROP CONSTRAINT "${row.pk_name}"`
        );
        droppedPkTables.add(row.table_name);
        console.log(`Ancienne clé primaire retirée : ${row.table_name}.${row.pk_name}`);
      }

      await client.query(
        `ALTER TABLE "${row.table_name}" ALTER COLUMN "${row.column_name}" DROP NOT NULL`
      );
      console.log(`Ancienne colonne rendue facultative : ${row.table_name}.${row.column_name}`);
    }

    // 3) Récupère les anciens titres débloqués (title_key -> title_id)
    //    pour que les titres historiques restent visibles.
    const columnExists = async (table, column) => {
      const found = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      return found.rows.length > 0;
    };

    if (await columnExists("user_titles", "title_key")) {
      for (const keyColumn of ["key", "title_key"]) {
        if (await columnExists("titles", keyColumn)) {
          await client.query(
            `UPDATE user_titles ut
             SET title_id = t.id
             FROM titles t
             WHERE ut.title_id IS NULL
               AND ut.title_key::text = t."${keyColumn}"::text`
          );
          break;
        }
      }
    }

    // Données initiales : ajoutées seulement si elles n'existent pas.
    // Les casts explicites (::text, ::numeric, ::int) évitent l'erreur
    // PostgreSQL « inconsistent types deduced for parameter $1 » quand
    // un même paramètre est utilisé dans le SELECT et dans le WHERE.
    // Les lignes déjà présentes (même nom / même symbole) sont seulement
    // complétées quand leurs nouvelles colonnes sont encore vides.

    // symbole, nom, secteur, icône, couleur, prix, volatilité, description
    const companies = [
      ["SIG", "Sigma", "Finance", "💠", "#a78bfa", 100, 0.010, "Le groupe fondateur de l'univers Sigma, valeur refuge du marché."],
      ["NOVA", "Nova Systems", "Technologie", "⚡", "#38bdf8", 45, 0.016, "Logiciels et services cloud à croissance rapide."],
      ["ORX", "Orion Exchange", "Finance", "⭐", "#facc15", 75, 0.012, "Plateforme d'échange et de compensation interstellaire."],
      ["ECL", "Eclipse Labs", "Biotech", "🧬", "#f472b6", 125, 0.018, "Laboratoire de recherche en thérapies génétiques."],
      ["QNT", "Quantum Forge", "Technologie", "🧠", "#818cf8", 210, 0.020, "Ordinateurs quantiques et intelligence artificielle."],
      ["AER", "Aether Airlines", "Transport", "✈️", "#60a5fa", 62, 0.013, "Compagnie aérienne reliant les capitales de Sigma."],
      ["VRD", "Verdant Energy", "Énergie", "🌱", "#4ade80", 88, 0.012, "Énergies renouvelables et réseaux électriques verts."],
      ["HLX", "Helix Pharma", "Santé", "💊", "#fb7185", 140, 0.014, "Médicaments innovants et vaccins de nouvelle génération."],
      ["TIT", "Titan Motors", "Automobile", "🚗", "#f97316", 95, 0.015, "Véhicules électriques et utilitaires robustes."],
      ["LUM", "Lumen Media", "Médias", "🎬", "#c084fc", 54, 0.017, "Studios, streaming et production de contenus."],
      ["AQU", "Aqua Dynamics", "Industrie", "💧", "#22d3ee", 70, 0.010, "Traitement et distribution de l'eau."],
      ["CRB", "Carbon Capital", "Finance", "🏦", "#fbbf24", 160, 0.009, "Banque d'investissement orientée long terme."],
      ["FLX", "Flux Robotics", "Technologie", "🤖", "#2dd4bf", 180, 0.021, "Robots industriels et automatisation d'usines."],
      ["GLD", "Golden Harvest", "Agroalimentaire", "🌾", "#eab308", 38, 0.009, "Céréales, produits laitiers et distribution alimentaire."],
      ["STR", "Stellar Space", "Aérospatial", "🚀", "#a5b4fc", 300, 0.024, "Lanceurs réutilisables et tourisme orbital."],
      ["PXL", "Pixel Arena", "Jeux vidéo", "🎮", "#e879f9", 66, 0.022, "Éditeur de jeux compétitifs et plateforme d'e-sport."],
      ["MDX", "Medix Care", "Santé", "➕", "#34d399", 110, 0.011, "Cliniques, équipements et assurance santé."],
      ["OCN", "Ocean Logistics", "Transport", "🚢", "#3b82f6", 48, 0.010, "Transport maritime et ports automatisés."],
      ["SOL", "Solaris Power", "Énergie", "☀️", "#fde047", 82, 0.016, "Centrales solaires et stockage d'énergie."],
      ["CYB", "Cyber Shield", "Cybersécurité", "🛡️", "#94a3b8", 135, 0.019, "Protection des réseaux et détection des menaces."],
      ["URB", "Urban Estates", "Immobilier", "🏙️", "#fb923c", 120, 0.008, "Immobilier résidentiel et bureaux dans les grandes villes."],
      ["FSH", "Fashion Orbit", "Luxe", "👗", "#f9a8d4", 150, 0.014, "Maison de couture et accessoires de luxe."],
      ["BRW", "Brew & Co", "Consommation", "☕", "#d6a77a", 28, 0.010, "Cafés, boissons et chaîne de salons de thé."],
      ["MTL", "Metal Works", "Industrie", "⚙️", "#9ca3af", 58, 0.012, "Acier, alliages et pièces mécaniques."],
      ["NEO", "Neo Bank", "Finance", "💳", "#5eead4", 92, 0.017, "Banque en ligne et paiements instantanés."],
      ["WAV", "Wave Telecom", "Télécoms", "📡", "#7dd3fc", 72, 0.011, "Réseaux mobiles, fibre et satellites de communication."]
    ];

    for (const [symbol, name, sector, icon, color, price, volatility, description] of companies) {
      await client.query(
        `INSERT INTO market_assets
           (symbol, name, price, sector, description, color, icon, volatility, base_price)
         SELECT $1::text, $2::text, $6::numeric, $3::text, $8::text,
                $5::text, $4::text, $7::numeric, $6::numeric
         WHERE NOT EXISTS (
           SELECT 1 FROM market_assets WHERE symbol = $1::text
         )`,
        [symbol, name, sector, icon, color, price, volatility, description]
      );

      await client.query(
        `UPDATE market_assets
         SET sector = $2::text,
             icon = COALESCE(icon, $3::text),
             color = COALESCE(color, $4::text),
             volatility = COALESCE(volatility, $5::numeric),
             base_price = COALESCE(base_price, $6::numeric),
             description = CASE WHEN COALESCE(description, '') = ''
                                THEN $7::text ELSE description END
         WHERE symbol = $1::text AND sector IS NULL`,
        [symbol, sector, icon, color, volatility, price, description]
      );
    }

    // nom, rareté, emoji, série, description
    const cards = [
      ["Nova", "common", "🌟", "Cosmos", "Carte de départ de la collection."],
      ["Étoile Filante", "common", "🌠", "Cosmos", "Elle traverse le ciel de Sigma en une seconde."],
      ["Astéroïde", "common", "☄️", "Cosmos", "Un caillou qui a vu naître le marché."],
      ["Satellite", "common", "🛰️", "Cosmos", "Il observe les cours depuis l'orbite."],
      ["Lune Pâle", "common", "🌙", "Cosmos", "Elle veille sur les traders de nuit."],
      ["Orbite", "common", "🪐", "Cosmos", "Une planète aux anneaux d'argent."],
      ["Radar", "common", "📡", "Cosmos", "Il détecte les tendances avant tout le monde."],
      ["Pièce Sigma", "common", "🪙", "Marché", "La monnaie de base de l'univers Sigma."],
      ["Courbe Verte", "common", "📈", "Marché", "Tout monte, du moins pour aujourd'hui."],
      ["Courbe Rouge", "common", "📉", "Marché", "Une correction, rien de grave."],
      ["Taureau", "common", "🐂", "Marché", "Il croit en la hausse, toujours."],
      ["Ours", "common", "🐻", "Marché", "Il se méfie de tout et vend en premier."],
      ["Calculatrice", "common", "🧮", "Marché", "Chaque centime compte."],
      ["Mallette", "common", "💼", "Marché", "Le sac d'un investisseur pressé."],
      ["Gazette Financière", "common", "📰", "Marché", "Les nouvelles du matin, déjà dépassées."],
      ["Orion", "rare", "🔭", "Cosmos", "Une carte rare de l'univers Sigma."],
      ["Trader Nocturne", "rare", "🦉", "Marché", "Il achète quand les autres dorment."],
      ["Faucon Boursier", "rare", "🦅", "Marché", "Il repère les bonnes affaires de très haut."],
      ["Lingot d'Or", "rare", "🥇", "Marché", "Une valeur sûre, lourde et brillante."],
      ["Coffre-fort", "rare", "🔐", "Marché", "Personne ne sait ce qu'il contient."],
      ["Boule de Cristal", "rare", "🔮", "Mythes", "Elle prédit les cours, parfois."],
      ["Clé Maîtresse", "rare", "🗝️", "Mythes", "Elle ouvre toutes les portes de la bourse."],
      ["Renard Malin", "rare", "🦊", "Mythes", "Toujours un coup d'avance."],
      ["Loup de la Bourse", "rare", "🐺", "Mythes", "Il chasse en meute sur les marchés."],
      ["Panthère Noire", "rare", "🐆", "Mythes", "Silencieuse, rapide, redoutable."],
      ["Navigateur", "rare", "🧭", "Cosmos", "Il trouve le nord dans la tempête."],
      ["Eclipse", "epic", "🌘", "Cosmos", "Une carte épique très recherchée."],
      ["Dragon d'Émeraude", "epic", "🐉", "Mythes", "Il couve un trésor de titres rares."],
      ["Phénix Doré", "epic", "🔥", "Mythes", "Il renaît plus riche après chaque krach."],
      ["Gardien de Pierre", "epic", "🗿", "Mythes", "Il protège les portefeuilles depuis mille ans."],
      ["Tempête Boursière", "epic", "⛈️", "Marché", "Elle secoue les cours et les nerfs."],
      ["Couronne du Marché", "epic", "👑", "Marché", "Elle revient au plus patient des investisseurs."],
      ["Trident des Marées", "epic", "🔱", "Mythes", "Il fait monter et descendre les océans de capitaux."],
      ["Kraken des Profondeurs", "epic", "🦑", "Mythes", "Il avale les spéculateurs imprudents."],
      ["Singularity", "legendary", "🌀", "Cosmos", "Une carte légendaire de collection."],
      ["Licorne d'Or", "legendary", "🦄", "Mythes", "La start-up que tout le monde rêve de posséder."],
      ["Galaxie Sigma", "legendary", "🌌", "Cosmos", "Des milliards d'étoiles dans une seule carte."],
      ["Trophée Éternel", "legendary", "🏆", "Marché", "Décerné au meilleur investisseur de tous les temps."],
      ["Soleil Éternel", "legendary", "🌞", "Cosmos", "Il ne se couche jamais sur le marché Sigma."],
      ["Horizon des Événements", "mythic", "🕳️", "Cosmos", "Rien ne s'en échappe, pas même les gains."],
      ["Oracle Infini", "mythic", "👁️", "Mythes", "Il voit chaque cours avant qu'il n'existe."],
      ["Big Bang", "mythic", "💥", "Cosmos", "Le moment où tout a commencé."]
    ];

    for (const [name, rarity, emoji, series, description] of cards) {
      await client.query(
        `INSERT INTO cards (name, rarity, emoji, series, description)
         SELECT $1::text, $2::text, $3::text, $4::text, $5::text
         WHERE NOT EXISTS (
           SELECT 1 FROM cards WHERE name = $1::text
         )`,
        [name, rarity, emoji, series, description]
      );

      await client.query(
        `UPDATE cards
         SET emoji = COALESCE(emoji, $2::text),
             series = COALESCE(series, $3::text)
         WHERE name = $1::text`,
        [name, emoji, series]
      );
    }

    // nom, description, prix, stock, niveau, cartes par pack, emoji
    const packs = [
      ["Découverte", "3 cartes pour commencer ta collection.", 100, 20, "basic", 3, "📦"],
      ["Éclat", "4 cartes avec de meilleures chances de raretés.", 220, 14, "silver", 4, "🎁"],
      ["Premium", "4 cartes dont une rare minimum garantie.", 350, 10, "premium", 4, "💫"],
      ["Légendaire", "5 cartes dont une épique minimum garantie.", 800, 3, "legendary", 5, "👑"],
      ["Mythique", "5 cartes dont une légendaire minimum garantie.", 2000, 2, "mythic", 5, "🌌"]
    ];

    for (const [name, description, price, stock, tier, perPack, emoji] of packs) {
      await client.query(
        `INSERT INTO shop_packs
           (name, description, price, stock, active, tier, cards_per_pack, emoji)
         SELECT $1::text, $2::text, $3::numeric, $4::int, TRUE,
                $5::text, $6::int, $7::text
         WHERE NOT EXISTS (
           SELECT 1 FROM shop_packs WHERE name = $1::text
         )`,
        [name, description, price, stock, tier, perPack, emoji]
      );

      await client.query(
        `UPDATE shop_packs
         SET tier = COALESCE(tier, $2::text),
             cards_per_pack = COALESCE(cards_per_pack, $3::int),
             emoji = COALESCE(emoji, $4::text)
         WHERE name = $1::text`,
        [name, tier, perPack, emoji]
      );
    }

    const titles = [
      ["Nouveau membre", "Bienvenue dans Sigma Exchange."],
      ["Collectionneur", "Tu as ouvert ton premier pack de cartes."],
      ["Investisseur", "Tu as passé ton premier ordre en bourse."],
      ["Chanceux", "Tu as obtenu une carte légendaire ou mythique."],
      ["Portefeuille diversifié", "Tu détiens au moins 5 entreprises différentes."],
      ["Bavard", "Tu as envoyé ton premier message dans le chat."],
      ["Millionnaire", "Ton solde dépasse 25 000 crédits."]
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

    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client);
    console.error("Échec de l'initialisation PostgreSQL :", err.message);
    throw err;
  } finally {
    client.release();
  }

  // Remplace les clés primaires retirées par des index d'unicité sur les
  // colonnes que le nouveau code utilise.
  const replacementKeys = {
    holdings: ["user_id", "symbol"],
    user_cards: ["user_id", "card_id"],
    user_titles: ["user_id", "title_id"]
  };

  for (const table of droppedPkTables) {
    const columns = replacementKeys[table];
    if (!columns) continue;

    try {
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_unique_idx"
         ON "${table}" (${columns.map(c => `"${c}"`).join(", ")})`
      );
    } catch (err) {
      console.warn(`Index d'unicité non créé sur ${table} :`, err.message);
    }
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

  // Une adresse e-mail ne peut servir qu'à un seul compte.
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
       ON users (LOWER(email)) WHERE email IS NOT NULL`
    );
  } catch (err) {
    console.warn(
      "Index d'unicité des e-mails non créé (doublons existants ?) :",
      err.message
    );
  }

  console.log("Base PostgreSQL vérifiée et migrations terminées.");
}

module.exports = { pool, initDb, safeRollback };
