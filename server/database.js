const crypto = require('crypto');
const { firestore } = require('./firestore');

function hashPassword(password, salt) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function asParams(params) {
  if (Array.isArray(params)) return params;
  if (params === undefined) return [];
  return [params];
}

function cleanObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normaliseSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

function lowerName(value) {
  return String(value || '').toLowerCase().trim();
}

function roomDocId(projectId, room) {
  return crypto.createHash('sha1').update(`${projectId}|${lowerName(room)}`).digest('hex');
}

async function queryOne(collection, field, op, value) {
  const snap = await firestore.collection(collection).where(field, op, value).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function queryMany(collection, field, op, value) {
  const snap = await firestore.collection(collection).where(field, op, value).get();
  const rows = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  if (collection === 'estimate_items') {
    rows.sort((a, b) => Number(a.sortOrder ?? 999999) - Number(b.sortOrder ?? 999999));
  }
  return rows;
}

async function getUserById(userId) {
  const doc = await firestore.collection('users').doc(userId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function getProjectById(projectId) {
  const doc = await firestore.collection('projects').doc(projectId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function getRateById(rateId) {
  const doc = await firestore.collection('rates').doc(rateId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function getItemById(itemId) {
  const doc = await firestore.collection('estimate_items').doc(itemId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

class FirestoreStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  async run(...args) {
    const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return this.db.run(this.sql, params);
  }

  async finalize() {
    return undefined;
  }
}

class FirestoreCompatDb {
  async get(sql, params) {
    const q = normaliseSql(sql);
    const p = asParams(params);

    if (q.includes('FROM SESSIONS S') && q.includes('JOIN USERS U')) {
      const token = p[0];
      const sessionDoc = await firestore.collection('sessions').doc(token).get();
      if (!sessionDoc.exists) return null;

      const session = sessionDoc.data();
      const user = await getUserById(session.user_id);
      if (!user) return null;

      return {
        user_id: session.user_id,
        expires_at: session.expires_at,
        email: user.email,
        company_name: user.company_name,
        estimator_name: user.estimator_name,
        office_address: user.office_address,
        vat_number: user.vat_number,
        margin: user.margin,
        wasteAllowance: user.wasteAllowance,
        contingency: user.contingency,
        labourUplift: user.labourUplift,
        plantOverhead: user.plantOverhead
      };
    }

    if (q === 'SELECT ID FROM USERS WHERE EMAIL = ?') {
      const user = await queryOne('users', 'email', '==', p[0]);
      return user ? { id: user.id } : null;
    }

    if (q === 'SELECT * FROM USERS WHERE EMAIL = ?') {
      return queryOne('users', 'email', '==', p[0]);
    }

    if (q.includes('FROM USERS WHERE ID = ?')) {
      return getUserById(p[0]);
    }

    if (q === 'SELECT * FROM PROJECTS WHERE ID = ?') {
      return getProjectById(p[0]);
    }

    if (q.includes('FROM PROJECTS WHERE ID = ? AND USER_ID = ?')) {
      const project = await getProjectById(p[0]);
      if (!project || project.user_id !== p[1]) return null;
      return q.startsWith('SELECT ID') ? { id: project.id } : project;
    }

    if (q === 'SELECT * FROM RATES WHERE ID = ?') {
      return getRateById(p[0]);
    }

    if (q.includes('FROM RATES WHERE USER_ID = ? AND LOWER(NAME) = ?')) {
      const userId = p[0];
      const name = lowerName(p[1]);

      const snap = await firestore.collection('rates')
        .where('user_id', '==', userId)
        .where('nameLower', '==', name)
        .limit(1)
        .get();

      if (!snap.empty) {
        const doc = snap.docs[0];
        return { id: doc.id, ...doc.data() };
      }

      const allRates = await queryMany('rates', 'user_id', '==', userId);
      const found = allRates.find(rate => lowerName(rate.name) === name);
      return found ? { id: found.id } : null;
    }

    if (q.includes('FROM LABOUR_RATES WHERE TRADE = ? AND USER_ID = ?')) {
      const [trade, userId] = p;
      const allRates = await queryMany('labour_rates', 'user_id', '==', userId);
      return allRates.find(rate => rate.trade === trade) || null;
    }

    if (q.includes('FROM ESTIMATE_ITEMS E') && q.includes('JOIN PROJECTS P')) {
      const [itemId, userId] = p;
      const item = await getItemById(itemId);
      if (!item) return null;
      const project = await getProjectById(item.project_id);
      if (!project || project.user_id !== userId) return null;
      return { project_id: item.project_id };
    }

    if (q === 'SELECT * FROM ESTIMATE_ITEMS WHERE ID = ?') {
      return getItemById(p[0]);
    }

    throw new Error(`Firestore adapter missing get() SQL support: ${sql}`);
  }

  async all(sql, params) {
    const q = normaliseSql(sql);
    const p = asParams(params);

    if (q.includes('FROM RATES WHERE USER_ID = ?')) {
      return queryMany('rates', 'user_id', '==', p[0]);
    }

    if (q.includes('FROM LABOUR_RATES WHERE USER_ID = ?')) {
      return queryMany('labour_rates', 'user_id', '==', p[0]);
    }

    if (q.includes('FROM PROJECTS WHERE USER_ID = ?')) {
      return queryMany('projects', 'user_id', '==', p[0]);
    }

    if (q.includes('FROM ESTIMATE_ITEMS WHERE PROJECT_ID = ?')) {
      return queryMany('estimate_items', 'project_id', '==', p[0]);
    }

    if (q.includes('FROM ROOM_MEASUREMENTS WHERE PROJECT_ID = ?')) {
      return queryMany('room_measurements', 'project_id', '==', p[0]);
    }

    if (q.includes('FROM ROOM_MEASUREMENTS RM') && q.includes('JOIN PROJECTS P')) {
      const userId = p[0];
      const projects = await queryMany('projects', 'user_id', '==', userId);
      const rows = [];

      for (const project of projects) {
        const measurements = await queryMany('room_measurements', 'project_id', '==', project.id);
        rows.push(...measurements);
      }

      return rows;
    }

    throw new Error(`Firestore adapter missing all() SQL support: ${sql}`);
  }

  async run(sql, params) {
    const q = normaliseSql(sql);
    const p = asParams(params);

    if (
      q === 'PRAGMA FOREIGN_KEYS = ON' ||
      q === 'BEGIN TRANSACTION' ||
      q === 'COMMIT' ||
      q === 'ROLLBACK'
    ) {
      return { changes: 0 };
    }

    if (q.includes('DELETE FROM SESSIONS WHERE TOKEN = ?')) {
      await firestore.collection('sessions').doc(p[0]).delete();
      return { changes: 1 };
    }

    if (q.includes('INSERT INTO USERS')) {
      const [
        id, email, password_hash, salt, company_name, estimator_name, office_address, vat_number
      ] = p;

      await firestore.collection('users').doc(id).set(cleanObject({
        id,
        email,
        password_hash,
        salt,
        company_name,
        estimator_name,
        office_address,
        vat_number,
        margin: 20.0,
        wasteAllowance: 10.0,
        contingency: 5.0,
        labourUplift: 0.0,
        plantOverhead: 5.0
      }));

      return { changes: 1 };
    }

    if (q.includes('INSERT INTO SESSIONS')) {
      const [token, user_id, expires_at] = p;
      await firestore.collection('sessions').doc(token).set({ token, user_id, expires_at });
      return { changes: 1 };
    }

    if (q.includes('UPDATE USERS SET')) {
      const [
        company_name, estimator_name, office_address, vat_number,
        margin, wasteAllowance, contingency, labourUplift, plantOverhead, userId
      ] = p;

      await firestore.collection('users').doc(userId).set(cleanObject({
        company_name,
        estimator_name,
        office_address,
        vat_number,
        margin,
        wasteAllowance,
        contingency,
        labourUplift,
        plantOverhead
      }), { merge: true });

      return { changes: 1 };
    }

    if (q.includes('UPDATE PROJECTS SET TOTALCOST = ?, SELLPRICE = ? WHERE ID = ?')) {
      const [totalCost, sellPrice, projectId] = p;
      await firestore.collection('projects').doc(projectId).set({ totalCost, sellPrice }, { merge: true });
      return { changes: 1 };
    }

    if (q.includes('INSERT INTO RATES')) {
      const [
        id, user_id, name, trade, unit, costRate, materialRate, labourRate, plantRate, subRate,
        category, supplier, sourceUrl, lastUpdated
      ] = p;

      await firestore.collection('rates').doc(id).set(cleanObject({
        id,
        user_id,
        name,
        nameLower: lowerName(name),
        trade,
        unit,
        costRate: parseFloat(costRate) || 0,
        materialRate: parseFloat(materialRate) || 0,
        labourRate: parseFloat(labourRate) || 0,
        plantRate: parseFloat(plantRate) || 0,
        subRate: parseFloat(subRate) || 0,
        category,
        supplier,
        sourceUrl,
        lastUpdated
      }), { merge: true });

      return { changes: 1 };
    }

    if (q.includes('UPDATE RATES SET NAME=?')) {
      const [
        name, trade, unit, costRate, materialRate, labourRate, plantRate, subRate,
        category, supplier, sourceUrl, lastUpdated, id, user_id
      ] = p;

      const existing = await getRateById(id);
      if (!existing || existing.user_id !== user_id) return { changes: 0 };

      await firestore.collection('rates').doc(id).set(cleanObject({
        name,
        nameLower: lowerName(name),
        trade,
        unit,
        costRate: parseFloat(costRate) || 0,
        materialRate: parseFloat(materialRate) || 0,
        labourRate: parseFloat(labourRate) || 0,
        plantRate: parseFloat(plantRate) || 0,
        subRate: parseFloat(subRate) || 0,
        category,
        supplier,
        sourceUrl,
        lastUpdated
      }), { merge: true });

      return { changes: 1 };
    }

    if (q.includes('UPDATE RATES SET COSTRATE = ?')) {
      const [costRate, materialRate, labourRate, plantRate, subRate, unit, lastUpdated, id] = p;
      await firestore.collection('rates').doc(id).set(cleanObject({
        costRate,
        materialRate,
        labourRate,
        plantRate,
        subRate,
        unit,
        lastUpdated
      }), { merge: true });
      return { changes: 1 };
    }

    if (q.includes('DELETE FROM RATES WHERE ID=? AND USER_ID=?')) {
      const [id, user_id] = p;
      const existing = await getRateById(id);
      if (existing && existing.user_id === user_id) {
        await firestore.collection('rates').doc(id).delete();
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (q.includes('UPDATE LABOUR_RATES SET')) {
      const [hourlyRate, dailyRate, productivityRate, difficultyFactor, trade, user_id] = p;
      const id = crypto.createHash('sha1').update(`${user_id}|${trade}`).digest('hex');

      await firestore.collection('labour_rates').doc(id).set(cleanObject({
        id,
        user_id,
        trade,
        hourlyRate,
        dailyRate,
        productivityRate,
        difficultyFactor
      }), { merge: true });

      return { changes: 1 };
    }

    if (q.includes('INSERT INTO PROJECTS')) {
      const [
        id, user_id, name, client, address, dateCreated, status, totalCost, sellPrice, margin,
        tenderRef, tradeCategory, startDate, duration, notes,
        wasteAllowance, contingency, labourUplift, plantOverhead
      ] = p;

      await firestore.collection('projects').doc(id).set(cleanObject({
        id,
        user_id,
        name,
        client,
        address,
        dateCreated,
        status,
        totalCost,
        sellPrice,
        margin,
        tenderRef,
        tradeCategory,
        startDate,
        duration,
        notes,
        wasteAllowance,
        contingency,
        labourUplift,
        plantOverhead
      }), { merge: true });

      return { changes: 1 };
    }

    if (q.includes('DELETE FROM PROJECTS WHERE ID = ? AND USER_ID = ?') || q.includes('DELETE FROM PROJECTS WHERE ID=? AND USER_ID=?')) {
      const [id, user_id] = p;
      const existing = await getProjectById(id);
      if (existing && existing.user_id === user_id) {
        await firestore.collection('projects').doc(id).delete();
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (q.includes('DELETE FROM ESTIMATE_ITEMS WHERE PROJECT_ID')) {
      const projectId = p[0];
      const items = await queryMany('estimate_items', 'project_id', '==', projectId);
      const batch = firestore.batch();
      for (const item of items) {
        batch.delete(firestore.collection('estimate_items').doc(item.id));
      }
      await batch.commit();
      return { changes: items.length };
    }

    if (q.includes('DELETE FROM ROOM_MEASUREMENTS WHERE PROJECT_ID')) {
      const projectId = p[0];
      const rows = await queryMany('room_measurements', 'project_id', '==', projectId);
      const batch = firestore.batch();
      for (const row of rows) {
        batch.delete(firestore.collection('room_measurements').doc(row.id));
      }
      await batch.commit();
      return { changes: rows.length };
    }

    if (q.includes('UPDATE PROJECTS SET NAME=?')) {
      const [
        name, client, address, status, margin, tenderRef, tradeCategory,
        startDate, duration, notes, wasteAllowance, contingency,
        labourUplift, plantOverhead, id, user_id
      ] = p;

      const existing = await getProjectById(id);
      if (!existing || existing.user_id !== user_id) return { changes: 0 };

      await firestore.collection('projects').doc(id).set(cleanObject({
        name,
        client,
        address,
        status,
        margin,
        tenderRef,
        tradeCategory,
        startDate,
        duration,
        notes,
        wasteAllowance,
        contingency,
        labourUplift,
        plantOverhead
      }), { merge: true });

      return { changes: 1 };
    }

    if (q.includes('INSERT INTO ROOM_MEASUREMENTS') || q.includes('INSERT OR REPLACE INTO ROOM_MEASUREMENTS')) {
      const [project_id, room, width, length, height] = p;
      const cleanRoom = lowerName(room);
      const id = roomDocId(project_id, cleanRoom);

      await firestore.collection('room_measurements').doc(id).set(cleanObject({
        id,
        project_id,
        room: cleanRoom,
        width: parseFloat(width) || 0,
        length: parseFloat(length) || 0,
        height: parseFloat(height) || 0
      }), { merge: true });

      return { changes: 1 };
    }

    if (q.includes('INSERT INTO ESTIMATE_ITEMS')) {
      const [
        id, project_id, section, description, quantity, unit, labourRate, materialRate,
        plantRate, subRate, isAIIdentified, confidence, warnings, merchant, productUrl, assumptions, notes
      ] = p;

      const existingItemsForOrder = await queryMany('estimate_items', 'project_id', '==', project_id);
      const nextSortOrder = existingItemsForOrder.reduce((max, item) => Math.max(max, Number(item.sortOrder ?? -1)), -1) + 1;

      await firestore.collection('estimate_items').doc(id).set(cleanObject({
        id,
                sortOrder: nextSortOrder,
                project_id,
        section,
        description,
        quantity: parseFloat(quantity) || 0,
        unit,
        labourRate: parseFloat(labourRate) || 0,
        materialRate: parseFloat(materialRate) || 0,
        plantRate: parseFloat(plantRate) || 0,
        subRate: parseFloat(subRate) || 0,
        isAIIdentified,
        confidence,
        warnings,
        merchant,
        productUrl,
        assumptions,
        notes
      }), { merge: true });

      return { changes: 1 };
    }

    if (q.includes('UPDATE ESTIMATE_ITEMS SET SECTION=?')) {
      const [
        section, description, quantity, unit, labourRate, materialRate,
        plantRate, subRate, confidence, warnings, merchant, productUrl, assumptions, notes, id
      ] = p;


      await firestore.collection('estimate_items').doc(id).set(cleanObject({
        section,
        description,
        quantity: parseFloat(quantity) || 0,
        unit,
        labourRate: parseFloat(labourRate) || 0,
        materialRate: parseFloat(materialRate) || 0,
        plantRate: parseFloat(plantRate) || 0,
        subRate: parseFloat(subRate) || 0,
        confidence,
        warnings,
        merchant,
        productUrl,
        assumptions,
        notes
      }), { merge: true });

      return { changes: 1 };
    }

    if (q.includes('UPDATE ESTIMATE_ITEMS SET LABOURRATE = ?')) {
      const [
        labourRate, materialRate, plantRate, subRate, confidence,
        warnings, merchant, productUrl, assumptions, notes, id
      ] = p;


      await firestore.collection('estimate_items').doc(id).set(cleanObject({
        labourRate: parseFloat(labourRate) || 0,
        materialRate: parseFloat(materialRate) || 0,
        plantRate: parseFloat(plantRate) || 0,
        subRate: parseFloat(subRate) || 0,
        confidence,
        warnings,
        merchant,
        productUrl,
        assumptions,
        notes
      }), { merge: true });

      return { changes: 1 };
    }

    if (q.includes('DELETE FROM ESTIMATE_ITEMS WHERE ID=?')) {
      await firestore.collection('estimate_items').doc(p[0]).delete();
      return { changes: 1 };
    }

    throw new Error(`Firestore adapter missing run() SQL support: ${sql}`);
  }

  async prepare(sql) {
    return new FirestoreStatement(this, sql);
  }

  async exec() {
    return { changes: 0 };
  }

  async close() {
    return undefined;
  }
}

async function getDbConnection() {
  return new FirestoreCompatDb();
}

async function seedUserScope(_db, userId) {
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

  for (const [trade, hourlyRate, dailyRate, productivityRate, difficultyFactor] of seedLabour) {
    const id = crypto.createHash('sha1').update(`${userId}|${trade}`).digest('hex');
    await firestore.collection('labour_rates').doc(id).set({
      id,
      user_id: userId,
      trade,
      hourlyRate,
      dailyRate,
      productivityRate,
      difficultyFactor
    }, { merge: true });
  }

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

  for (const rate of seedRates) {
    const id = crypto.randomUUID();
    const [name, trade, unit, costRate, category, supplier, sourceUrl, lastUpdated] = rate;
    await firestore.collection('rates').doc(id).set({
      id,
      user_id: userId,
      name,
      nameLower: lowerName(name),
      trade,
      unit,
      costRate,
      materialRate: costRate,
      labourRate: 0,
      plantRate: 0,
      subRate: 0,
      category,
      supplier,
      sourceUrl,
      lastUpdated
    });
  }
}

async function initDb() {
  const existingDemo = await queryOne('users', 'email', '==', 'demo@truecostqs.com');
  if (existingDemo) {
    return;
  }

  const demoUserId = crypto.randomUUID();
  const { salt, hash } = hashPassword('password123');

  await firestore.collection('users').doc(demoUserId).set({
    id: demoUserId,
    email: 'demo@truecostqs.com',
    password_hash: hash,
    salt,
    company_name: 'BuildWise Contractors Ltd',
    estimator_name: 'Senior Estimator',
    office_address: 'Suite 4B, Canary Wharf, London',
    vat_number: 'GB 123 4567 89',
    margin: 20.0,
    wasteAllowance: 10.0,
    contingency: 5.0,
    labourUplift: 0.0,
    plantOverhead: 5.0
  });

  await seedUserScope(null, demoUserId);
  console.log('Firestore initialization completed with demo user seeded.');
}

module.exports = { getDbConnection, initDb, hashPassword, seedUserScope };

