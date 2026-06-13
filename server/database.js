const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'qs.db');

// Ensure parent directory of database exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

async function getDbConnection() {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  await db.run("PRAGMA foreign_keys = ON");
  return db;
}

function hashPassword(password, salt) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

async function seedUserScope(db, userId) {
  // 1. Seed Labour Rates for this specific user
  const seedLabour = [
    ['General labourer', 15.00, 120.00, 1.0, 1.0],
    ['Skilled labourer', 20.00, 160.00, 1.0, 1.0],
    ['Carpenter', 28.00, 220.00, 1.5, 1.0],
    ['Bricklayer', 30.00, 240.00, 1.2, 1.0],
    ['Plasterer', 28.00, 220.00, 1.4, 1.0],
    ['Roofer', 32.00, 250.00, 1.0, 1.0],
    ['Plumber', 35.00, 280.00, 1.2, 1.0],
    ['Electrician', 35.00, 280.00, 1.2, 1.0],
    ['Gas engineer', 40.00, 320.00, 1.0, 1.0],
    ['Painter/decorator', 22.00, 180.00, 2.0, 1.0],
    ['Groundworker', 22.00, 180.00, 1.0, 1.0],
    ['Multi-trade operative', 25.00, 200.00, 1.2, 1.0],
    ['Site manager', 45.00, 350.00, 1.0, 1.0]
  ];

  const insertLabour = await db.prepare(
    'INSERT INTO labour_rates (trade, user_id, hourlyRate, dailyRate, productivityRate, difficultyFactor) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const lab of seedLabour) {
    await insertLabour.run(lab[0], userId, lab[1], lab[2], lab[3], lab[4]);
  }
  await insertLabour.finalize();

  // 2. Seed Rates (Materials and Plant Price Book) for this specific user
  const seedRates = [
    ['Plasterboard 12.5mm x 1200x2400', 'Plastering', 'Sheet', 8.50, 'Material', 'Travis Perkins', 'https://www.travisperkins.co.uk/plasterboard/knauf-wallboard-tapered-edge-12-5mm-x-1200mm-x-2400mm/p/852504', '2026-04-15'],
    ['Cement 25kg', 'Groundworks', 'Bag', 6.50, 'Material', 'Selco Builders Warehouse', 'https://www.selcobw.com/', '2026-05-10'],
    ['8 Yard Skip Hire', 'Waste', 'Item', 280.00, 'Plant', 'Waste Co', '', '2026-03-10'],
    ['1.5t Excavator Day Hire', 'Groundworks', 'Day', 120.00, 'Plant', 'HSS Hire', '', '2026-05-01'],
    ['CLS Timber 38x89 2.4m', 'Joinery', 'Length', 3.45, 'Material', 'Jewson', 'https://www.jewson.co.uk/', '2026-05-18'],
    ['Skirting Board MDF 120mm x 4.4m', 'Joinery', 'Length', 14.20, 'Material', 'MKM Building Supplies', 'https://www.mkmbs.co.uk/', '2026-05-01'],
    ['Multi-Finish Plaster 25kg', 'Plastering', 'Bag', 8.20, 'Material', 'Buildbase', 'https://www.buildbase.co.uk/', '2026-05-12'],
    ['Copper Tube 15mm x 3m', 'Plumbing', 'Length', 8.40, 'Material', 'City Plumbing', 'https://www.cityplumbing.co.uk/', '2026-05-19'],
    ['Screwfix Gold Screws 4x50 Box 200', 'Joinery', 'Box', 6.99, 'Material', 'Screwfix', 'https://www.screwfix.com/', '2026-05-20'],
    ['Wickes Trade Emulsion Paint White 10L', 'Painting', 'Tub', 22.00, 'Material', 'Wickes', 'https://www.wickes.co.uk/', '2026-05-15'],
    ['Standard Concrete Blocks 7N', 'Groundworks', 'Each', 1.85, 'Material', 'Travis Perkins', 'https://www.travisperkins.co.uk/', '2026-05-14']
  ];

  const insertRate = await db.prepare(
    'INSERT INTO rates (id, user_id, name, trade, unit, costRate, category, supplier, sourceUrl, lastUpdated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const rate of seedRates) {
    await insertRate.run(crypto.randomUUID(), userId, ...rate);
  }
  await insertRate.finalize();
}

async function initDb() {
  const db = await getDbConnection();

  // Check if users table exists. If not, we drop the old single-user tables and rebuild.
  const usersTableExists = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  );

  if (!usersTableExists) {
    console.log('Detected older schema. Upgrading database to multi-user authentication tables...');
    await db.exec(`
      DROP TABLE IF EXISTS estimate_items;
      DROP TABLE IF EXISTS projects;
      DROP TABLE IF EXISTS rates;
      DROP TABLE IF EXISTS labour_rates;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS room_measurements;
    `);
  }

  // Create multi-user tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      company_name TEXT,
      estimator_name TEXT,
      office_address TEXT,
      vat_number TEXT,
      margin REAL DEFAULT 20.0,
      wasteAllowance REAL DEFAULT 10.0,
      contingency REAL DEFAULT 5.0,
      labourUplift REAL DEFAULT 0.0,
      plantOverhead REAL DEFAULT 5.0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      client TEXT,
      address TEXT,
      dateCreated TEXT,
      status TEXT,
      totalCost REAL,
      sellPrice REAL,
      margin REAL,
      tenderRef TEXT,
      tradeCategory TEXT,
      startDate TEXT,
      duration TEXT,
      notes TEXT,
      wasteAllowance REAL,
      contingency REAL,
      labourUplift REAL,
      plantOverhead REAL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trade TEXT,
      unit TEXT,
      costRate REAL,
      category TEXT,
      supplier TEXT,
      sourceUrl TEXT,
      lastUpdated TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS estimate_items (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      section TEXT,
      description TEXT,
      quantity REAL,
      unit TEXT,
      labourRate REAL,
      materialRate REAL,
      plantRate REAL,
      subRate REAL,
      isAIIdentified INTEGER,
      confidence TEXT,
      warnings TEXT,
      merchant TEXT,
      productUrl TEXT,
      assumptions TEXT,
      notes TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS labour_rates (
      trade TEXT,
      user_id TEXT,
      hourlyRate REAL,
      dailyRate REAL,
      productivityRate REAL,
      difficultyFactor REAL,
      PRIMARY KEY (trade, user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS room_measurements (
      project_id TEXT,
      room TEXT,
      width REAL,
      length REAL,
      height REAL,
      PRIMARY KEY (project_id, room),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  // Check if we need to seed the default demo user and data
  const demoUser = await db.get("SELECT * FROM users WHERE email = 'demo@truecostqs.com'");
  if (!demoUser) {
    console.log('Seeding initial mock data for demo user...');
    
    // 1. Create Demo User
    const demoUserId = crypto.randomUUID();
    const { salt, hash } = hashPassword('password123');
    
    await db.run(
      `INSERT INTO users (
        id, email, password_hash, salt, company_name, estimator_name, office_address, vat_number,
        margin, wasteAllowance, contingency, labourUplift, plantOverhead
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        demoUserId,
        'demo@truecostqs.com',
        hash,
        salt,
        'BuildWise Contractors Ltd',
        'Senior Estimator',
        'Suite 4B, Canary Wharf, London',
        'GB 123 4567 89',
        20.0, 10.0, 5.0, 0.0, 5.0
      ]
    );

    // 2. Seed price books & labour rates for this demo user
    await seedUserScope(db, demoUserId);

    console.log('Database multi-user initialization completed with demo user seeded.');
  }

  await db.close();
}

module.exports = { getDbConnection, initDb, hashPassword, seedUserScope };

