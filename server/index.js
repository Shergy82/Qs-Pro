const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { GoogleGenAI } = require('@google/genai');
const { scrapePrice } = require('./scraper');
const { getDbConnection, initDb, hashPassword, seedUserScope } = require('./database');
const { firestore } = require('./firestore');
const XLSX = require('xlsx');
const { parserRegistry } = require('./parsers');
const { isInformationalOnly, normalizeDescription, extractRoomFromDescription } = require('./utils');
const { registerSurveyRoutes } = require('./survey-routes');

const app = express();
const PORT = process.env.PORT || 3001;
const upload = multer({ dest: 'uploads/' });

// Initialize Gemini
let ai;
if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'YOUR_API_KEY_HERE') {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

// Helper to parse exact retryDelay from Gemini API error details if available
function getRetryDelayMs(error) {
  try {
    const errorMsg = error.message || '';
    const startIdx = errorMsg.indexOf('{');
    const endIdx = errorMsg.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const jsonStr = errorMsg.substring(startIdx, endIdx + 1);
      const errObj = JSON.parse(jsonStr);
      if (errObj && errObj.error && Array.isArray(errObj.error.details)) {
        const retryInfo = errObj.error.details.find(d => d && (d.retryDelay || (d['@type'] && d['@type'].includes('RetryInfo'))));
        if (retryInfo && retryInfo.retryDelay) {
          const seconds = parseFloat(retryInfo.retryDelay);
          if (!isNaN(seconds)) {
            return Math.ceil(seconds * 1000) + 1500; // Add 1.5s safety buffer
          }
        }
      }
    }
  } catch (e) {
    // Fail silently, fallback to backoff
  }
  return null;
}

// Helper for resilient Gemini API calls with Exact Wait & Exponential Backoff
async function generateContentWithRetry(params, retries = 8, delayMs = 2000) {
  if (!ai) throw new Error('Gemini API key is not configured.');

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (error) {
      const errorMsg = error.message || '';
      const status = error.status || 0;

      const isTransientError = status === 429 ||
        status === 503 ||
        errorMsg.includes('429') ||
        errorMsg.includes('503') ||
        errorMsg.includes('Quota exceeded') ||
        errorMsg.includes('RESOURCE_EXHAUSTED') ||
        errorMsg.includes('UNAVAILABLE') ||
        errorMsg.includes('high demand') ||
        errorMsg.includes('limit exceeded') ||
        errorMsg.includes('spikes in demand');

      if (isTransientError && attempt < retries) {
        // First try to parse exact retryDelay from Google, else fall back to exponential backoff (capped at 30s)
        let sleepTime = getRetryDelayMs(error);
        if (!sleepTime) {
          sleepTime = Math.min(delayMs * Math.pow(2, attempt - 1), 30000);
        }

        console.warn(`[Gemini API] Quota limit hit (429/RESOURCE_EXHAUSTED). Retrying attempt ${attempt}/${retries} in ${sleepTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, sleepTime));
        continue;
      }
      throw error;
    }
  }
}

// Utility functions are imported from `./utils.js` above

function localHeuristicExcelParser(filePath) {
  console.log('[Local Parser] Running robust local heuristic fallback parser...');
  try {
    const workbook = XLSX.readFile(filePath);
    const items = [];

    workbook.SheetNames.forEach(sheetName => {
      // Skip collection, summary, totals, index, instructions, or preliminaries sheets
      const nameLower = sheetName.toLowerCase();
      if (nameLower.includes('collection') ||
        nameLower.includes('summary') ||
        nameLower.includes('total') ||
        nameLower.includes('index') ||
        nameLower.includes('instruction') ||
        (nameLower.includes('prelim') && !nameLower.includes('bill'))) {
        return;
      }

      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      let currentSection = sheetName || 'General';

      // Checklist / Scoping sheet detection
      let statusColIdx = -1;
      const colVotes = [];
      for (let c = 0; c < 25; c++) colVotes[c] = { yes: 0, no: 0, textVotes: 0 };

      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!row || !Array.isArray(row)) continue;
        row.forEach((cell, idx) => {
          if (cell === null || cell === undefined || idx >= 25) return;
          const str = String(cell).trim().toLowerCase();
          if (str === 'yes' || str === 'y' || str === 'true') {
            colVotes[idx].yes++;
            colVotes[idx].textVotes++;
          } else if (str === '1') {
            colVotes[idx].yes++;
          }
          if (str === 'no' || str === 'n' || str === 'false') {
            colVotes[idx].no++;
            colVotes[idx].textVotes++;
          } else if (str === '0') {
            colVotes[idx].no++;
          }
        });
      }

      for (let idx = 0; idx < colVotes.length; idx++) {
        if (colVotes[idx].yes + colVotes[idx].no >= 2 && colVotes[idx].textVotes >= 1) {
          statusColIdx = idx;
          break;
        }
      }

      if (statusColIdx !== -1) {
        let catColIdx = statusColIdx > 0 ? statusColIdx - 1 : -1;
        let descColIdx = -1;
        let maxLen = 0;
        for (let c = statusColIdx + 1; c < 25; c++) {
          let totalLen = 0;
          let count = 0;
          for (let r = 0; r < Math.min(rows.length, 100); r++) {
            const row = rows[r];
            if (row && row[c] !== undefined && row[c] !== null) {
              totalLen += String(row[c]).length;
              count++;
            }
          }
          const avgLen = count > 0 ? totalLen / count : 0;
          if (avgLen > maxLen) {
            maxLen = avgLen;
            descColIdx = c;
          }
        }
        if (descColIdx === -1) {
          descColIdx = statusColIdx + 1;
        }

        console.log(`[Local Parser] Checklist sheet detected: "${sheetName}". statusColIdx=${statusColIdx}, catColIdx=${catColIdx}, descColIdx=${descColIdx}`);

        for (let r = 0; r < rows.length; r++) {
          const row = rows[r];
          if (!row || !Array.isArray(row) || row.length === 0) continue;

          // In structured SOR sheets, keep the Room column as the source of truth.
          // One-cell headings such as Ground Floor or External Decoration are headings,
          // not the room/area for pricing rows.

          // Capture the left-column merged room/area and fill it down.
          if (largeLooksLikeRoomName(row[0])) {
            currentSection = largeCellText(row[0]);
          }

          const cat = catColIdx !== -1 && row[catColIdx] ? String(row[catColIdx]).trim() : '';
          const details = descColIdx !== -1 && row[descColIdx] ? String(row[descColIdx]).trim() : '';

          // Structured SOR/scope sheets are driven by the Further Information cell.
          // Blank Further Information rows are not importable work items, even where
          // the Required Yes/No column contains stale Yes/No values.
          if (!largeHasUsefulFurtherInformation(details)) continue;

          const combinedDesc = largeBuildStructuredDescription(cat, details);

          if (isInformationalOnly(combinedDesc.toLowerCase())) {
            continue;
          }

          items.push({
            section: currentSection || 'General',
            category: cat,
            description: combinedDesc,
            quantity: 1,
            unit: 'Item',
            labourRate: 0,
            materialRate: 0,
            plantRate: 0,
            subRate: 0,
            sourceOrder: items.length,
            sortOrder: items.length,
            originalIndex: items.length,
            status: 'Yes',
            selected: true
          });
        }
        return; // Proceed to next sheet
      }

      // Default column mapping indices
      let itemIdx = -1;
      let descIdx = -1;
      let unitIdx = -1;
      let qtyIdx = -1;
      let rateIdx = -1;

      // Dynamic header mapping
      let headerRowIdx = -1;
      for (let r = 0; r < Math.min(rows.length, 15); r++) {
        const row = rows[r];
        if (!row || !Array.isArray(row)) continue;

        let foundDesc = false;
        row.forEach((cell, idx) => {
          if (!cell) return;
          const str = String(cell).toLowerCase().trim();
          if (str === 'item' || str === 'ref' || str === 'code') itemIdx = idx;
          if (str.includes('description') || str === 'details') {
            descIdx = idx;
            foundDesc = true;
          } else if (str.includes('work') && !foundDesc && !str.includes('total') && !str.includes('element') && !str.includes('amount')) {
            descIdx = idx;
            foundDesc = true;
          }
          if (str === 'unit') unitIdx = idx;
          if (str === 'qty' || str.includes('quantity')) qtyIdx = idx;
          if (str.includes('rate') || str.includes('unit cost') || str.includes('price per unit') || str.includes('unit price')) rateIdx = idx;
        });
        if (foundDesc) {
          headerRowIdx = r;
          break;
        }
      }

      // Assign robust fallback defaults if not found
      if (descIdx === -1) descIdx = 1;
      if (unitIdx === -1) unitIdx = [2, 1, 3, 4].find(i => i !== descIdx && i !== itemIdx) || 2;
      if (qtyIdx === -1) qtyIdx = [3, 2, 4, 1].find(i => i !== descIdx && i !== itemIdx && i !== unitIdx) || 3;
      if (rateIdx === -1) rateIdx = [4, 3, 2, 1].find(i => i !== descIdx && i !== itemIdx && i !== unitIdx && i !== qtyIdx) || 4;

      const startRowIdx = headerRowIdx !== -1 ? headerRowIdx + 1 : 0;
      for (let r = startRowIdx; r < rows.length; r++) {
        const row = rows[r];
        if (!row || !Array.isArray(row) || row.length === 0) continue;

        // Clean and read description
        const descCell = row[descIdx];
        if (!descCell) continue;
        const description = String(descCell).trim();
        if (description.length < 5) continue;

        // Skip header lines
        const descLower = description.toLowerCase();
        if (descLower.includes('description of works') || descLower.includes('description of work') || descLower.includes('item description')) {
          continue;
        }

        // Skip purely informational specification clauses
        if (isInformationalOnly(descLower)) {
          continue;
        }

        const hasQty = row[qtyIdx] !== undefined && row[qtyIdx] !== null && String(row[qtyIdx]).trim() !== '';
        const hasUnit = row[unitIdx] !== undefined && row[unitIdx] !== null && String(row[unitIdx]).trim() !== '';
        const hasRate = row[rateIdx] !== undefined && row[rateIdx] !== null && String(row[rateIdx]).trim() !== '';
        const hasItemCode = itemIdx !== -1 && itemIdx !== undefined && row[itemIdx] !== undefined && row[itemIdx] !== null && String(row[itemIdx]).trim() !== '';
        const hasInlineQty = /(\d+)\s*(no\.?|m2|m3|m\b)/i.test(description);

        if (!hasQty && !hasUnit && !hasRate && !hasItemCode && !hasInlineQty) {
          // Check if it's a continuation of the previous item
          const looksLikeContinuation =
            description.trim().startsWith('\u2022') ||
            description.trim().startsWith('-') ||
            description.trim().startsWith('*') ||
            /^[a-z]/.test(description.trim()) ||
            (items.length > 0 && items[items.length - 1].description.trim().endsWith(':')) ||
            description.length > 40;

          if (looksLikeContinuation && items.length > 0 && items[items.length - 1].section === currentSection) {
            items[items.length - 1].description += '\n' + description;
          } else if (description.length < 50) {
            currentSection = description;
          }
          continue;
        }

        // Check if it's a sub-heading section
        const itemCell = itemIdx !== -1 ? row[itemIdx] : null;
        const itemCode = itemCell ? String(itemCell).trim() : '';
        if (!itemCode && description.length < 50 && !row[qtyIdx] && !row[unitIdx]) {
          currentSection = description;
          continue;
        }

        // Parse quantity
        let quantity = null;
        const qtyCell = row[qtyIdx];
        if (qtyCell !== undefined && qtyCell !== null && qtyCell !== '') {
          const num = Number(String(qtyCell).replace(/[^0-9.-]/g, ''));
          if (!isNaN(num) && num > 0) {
            quantity = num;
          }
        }

        // Parse unit
        let unit = 'Item';
        const unitCell = row[unitIdx];
        if (unitCell !== undefined && unitCell !== null && unitCell !== '') {
          unit = String(unitCell).trim();
        }

        // Heuristics for quantity/unit from text if empty
        if (quantity === null) {
          const noMatch = description.match(/(\d+)\s*no\.?/i);
          if (noMatch) {
            quantity = parseInt(noMatch[1]);
            unit = 'Nr';
          } else {
            const mMatch = description.match(/(\d+)\s*m\b/i);
            if (mMatch) {
              quantity = parseInt(mMatch[1]);
              unit = 'm';
            } else {
              const m2Match = description.match(/(\d+)\s*m2\b/i);
              if (m2Match) {
                quantity = parseInt(m2Match[1]);
                unit = 'm2';
              } else {
                quantity = 1;
                unit = 'Sum';
              }
            }
          }
        }

        // Parse rate column if available
        let materialRate = 0;
        let labourRate = 0;
        let plantRate = 0;
        let subRate = 0;

        const rateCell = row[rateIdx];
        if (rateCell !== undefined && rateCell !== null && rateCell !== '') {
          const num = Number(String(rateCell).replace(/[^0-9.-]/g, ''));
          if (!isNaN(num) && num > 0) {
            materialRate = num; // Start as material cost rate
          }
        }

        const roomResult = extractRoomFromDescription(description, currentSection);
        items.push({
          section: roomResult.room,
          description: roomResult.description,
          quantity: quantity,
          unit: unit,
          labourRate,
          materialRate,
          plantRate,
          subRate
        });
      }
    });

    console.log(`[Local Parser] Successfully parsed ${items.length} items locally using heuristic mapping.`);
    return items;
  } catch (err) {
    console.error('[Local Parser] Robust local Excel parsing failed:', err);
    return [];
  }
}

function localKeywordPricing(items, libraryRates, labourRates, projectTradeCategory) {
  console.log(`[Local Pricing] Running local keyword-matching pricing engine for ${items.length} items...`);
  const pricedItems = [];

  for (const item of items) {
    let materialRate = 0;
    let labourRate = 0;
    let plantRate = 0;
    let subRate = 0;
    let merchant = 'Local Builders Merchant';
    let productUrl = '';
    let confidence = 'Low';
    let warnings = [];
    let assumptions = 'Priced using local estimating factors';
    let notes = '';

    const desc = (item.description || '').toLowerCase();
    const section = (item.section || '').toLowerCase();

    // 1. Try to match exact/partial words against custom library rates
    let bestLibraryMatch = null;
    let bestScore = 0;

    for (const lib of libraryRates) {
      const libName = lib.name.toLowerCase();
      if (desc.includes(libName)) {
        const score = libName.length;
        if (score > bestScore) {
          bestScore = score;
          bestLibraryMatch = lib;
        }
      }
    }

    if (bestLibraryMatch) {
      materialRate = bestLibraryMatch.costRate;
      merchant = bestLibraryMatch.supplier || 'Travis Perkins';
      productUrl = bestLibraryMatch.sourceUrl || '';
      confidence = 'High';
      assumptions = `Matched with library rate: "${bestLibraryMatch.name}" (£${bestLibraryMatch.costRate}/${bestLibraryMatch.unit})`;
    } else {
      // 2. Hardcoded fallback dictionary matching standard UK merchants
      if (desc.includes('plaster') || desc.includes('skim') || desc.includes('board') || desc.includes('gyproc') || section.includes('plaster')) {
        materialRate = desc.includes('multi-finish') ? 8.20 : 8.50;
        merchant = desc.includes('multi-finish') ? 'Buildbase' : 'Travis Perkins';
        productUrl = 'https://www.travisperkins.co.uk/';
        confidence = 'Medium';
        assumptions = 'Standard 12.5mm wallboard / Thistle multi-finish plaster pricing';
      } else if (desc.includes('cement') || desc.includes('concrete') || desc.includes('ballast') || desc.includes('foundation') || section.includes('ground')) {
        materialRate = desc.includes('cement') ? 6.50 : 95.00;
        merchant = 'Selco Builders Warehouse';
        productUrl = 'https://www.selcobw.com/';
        confidence = 'Medium';
        assumptions = 'Rugby premium cement 25kg bag / C25 ready-mix concrete standard volumetric rate';
      } else if (desc.includes('timber') || desc.includes('skirting') || desc.includes('cls') || desc.includes('wood') || desc.includes('stud') || desc.includes('ogee') || section.includes('joiner')) {
        materialRate = desc.includes('skirting') ? 14.20 : 3.45;
        merchant = desc.includes('skirting') ? 'MKM Building Supplies' : 'Jewson';
        productUrl = desc.includes('skirting') ? 'https://www.mkmbs.co.uk/' : 'https://www.jewson.co.uk/';
        confidence = 'Medium';
        assumptions = 'Standard treated CLS stud timber 38x89mm / MDF Ogee skirting 120mm';
      } else if (desc.includes('screw') || desc.includes('fixing') || desc.includes('nail') || desc.includes('plug') || desc.includes('anchor')) {
        materialRate = 6.99;
        merchant = 'Screwfix';
        productUrl = 'https://www.screwfix.com/';
        confidence = 'Medium';
        assumptions = 'Box of 200 Goldstar multipurpose wood screws';
      } else if (desc.includes('paint') || desc.includes('emulsion') || desc.includes('painter') || desc.includes('decorator') || section.includes('paint')) {
        materialRate = 22.00;
        merchant = 'Wickes';
        productUrl = 'https://www.wickes.co.uk/';
        confidence = 'Medium';
        assumptions = 'Wickes Trade 10L brilliant white emulsion tub';
      } else if (desc.includes('copper') || desc.includes('pipe') || desc.includes('plumb') || desc.includes('fitting') || desc.includes('sink') || section.includes('plumb')) {
        materialRate = desc.includes('pipe') ? 8.40 : 15.00;
        merchant = 'City Plumbing';
        productUrl = 'https://www.cityplumbing.co.uk/';
        confidence = 'Medium';
        assumptions = '15mm x 3m copper tubing standard thickness';
      } else if (desc.includes('skip') || desc.includes('waste') || desc.includes('rubbish') || desc.includes('clear') || desc.includes('disposal') || section.includes('waste')) {
        plantRate = 280.00;
        merchant = 'Waste Co';
        confidence = 'Medium';
        assumptions = '8-yard skip hire standard trade rate';
      } else if (desc.includes('excavator') || desc.includes('digger') || desc.includes('plant') || desc.includes('hire') || desc.includes('mixer')) {
        plantRate = 120.00;
        merchant = 'HSS Hire';
        confidence = 'Medium';
        assumptions = '1.5t micro excavator standard daily hire rate';
      } else if (desc.includes('brick') || desc.includes('block') || desc.includes('mason') || desc.includes('mortar')) {
        materialRate = 1.85;
        merchant = 'Travis Perkins';
        productUrl = 'https://www.travisperkins.co.uk/';
        confidence = 'Medium';
        assumptions = 'Standard 7N dense aggregate block';
      } else if (desc.includes('subcontract') || desc.includes('specialist') || desc.includes('install') || desc.includes('fitted') || desc.includes('commission')) {
        subRate = 150.00;
        confidence = 'Medium';
        assumptions = 'Subcontract trade specialist rate build-up';
      }
    }

    // 3. Determine trade and estimate labour rate
    let trade = 'General labourer';
    if (desc.includes('plaster') || desc.includes('skim') || desc.includes('board') || section.includes('plaster')) {
      trade = 'Plasterer';
    } else if (desc.includes('joiner') || desc.includes('skirting') || desc.includes('door') || desc.includes('stud') || desc.includes('timber') || section.includes('joiner')) {
      trade = 'Carpenter';
    } else if (desc.includes('ground') || desc.includes('excavate') || desc.includes('pour') || desc.includes('concrete') || section.includes('ground')) {
      trade = 'Groundworker';
    } else if (desc.includes('plumb') || desc.includes('pipe') || desc.includes('sink') || desc.includes('boiler') || section.includes('plumb')) {
      trade = 'Plumber';
    } else if (desc.includes('electric') || desc.includes('wire') || desc.includes('cable') || desc.includes('light') || section.includes('electric')) {
      trade = 'Electrician';
    } else if (desc.includes('paint') || desc.includes('decorate') || desc.includes('paper') || section.includes('paint')) {
      trade = 'Painter/decorator';
    } else if (desc.includes('brick') || desc.includes('block') || desc.includes('mason') || section.includes('brick')) {
      trade = 'Bricklayer';
    } else if (desc.includes('roof') || desc.includes('tile') || desc.includes('slate') || section.includes('roof')) {
      trade = 'Roofer';
    } else if (desc.includes('demolition') || desc.includes('strip') || desc.includes('clearance') || section.includes('waste')) {
      trade = 'General labourer';
    }

    // Find matched labour day rate
    const matchedLabour = labourRates.find(l => l.trade === trade);
    const dailyRate = matchedLabour ? matchedLabour.dailyRate : 220;

    // Calculate labour unit cost based on unit and item quantity
    const unitStr = (item.unit || '').toLowerCase().trim();
    let daysPerUnit = 0.15; // default
    if (unitStr === 'item' || unitStr === 'nr' || unitStr === 'each') {
      daysPerUnit = 0.5; // half a day per item
    } else if (unitStr === 'm') {
      daysPerUnit = 0.05; // 20m per day
    } else if (unitStr === 'm2') {
      daysPerUnit = 0.1; // 10m2 per day
    } else if (unitStr === 'm3') {
      daysPerUnit = 0.5; // 2m3 per day
    }

    if (subRate > 0) {
      labourRate = 0;
    } else {
      labourRate = parseFloat((dailyRate * daysPerUnit).toFixed(2));
    }

    if (section.includes('prelim') || desc.includes('particular') || desc.includes('insurance')) {
      materialRate = 0;
      labourRate = 0;
      plantRate = 0;
      subRate = 120.00;
      merchant = 'Internal';
      confidence = 'Medium';
      assumptions = 'Preliminaries contract overhead allotment';
    }

    // Zero-rate prevention fallback based on unit type
    if (materialRate === 0 && labourRate === 0 && plantRate === 0 && subRate === 0) {
      const cleanUnit = (item.unit || '').toLowerCase().trim();
      confidence = 'Low';
      merchant = 'Local Builders Merchant';
      assumptions = 'Offline fallback average UK cost rate based on item unit type';

      if (cleanUnit === 'm2' || cleanUnit === 'sqm') {
        materialRate = 12.50;
        labourRate = 8.50;
        assumptions += ' (m² surface area rates)';
      } else if (cleanUnit === 'm3' || cleanUnit === 'cum') {
        materialRate = 45.00;
        labourRate = 35.00;
        assumptions += ' (m³ volume rates)';
      } else if (cleanUnit === 'm' || cleanUnit === 'lm' || cleanUnit === 'linear') {
        materialRate = 4.50;
        labourRate = 3.50;
        assumptions += ' (linear meter rates)';
      } else if (cleanUnit === 'hr' || cleanUnit === 'hour') {
        labourRate = 25.00;
        assumptions += ' (hourly trade rates)';
      } else if (cleanUnit === 'day') {
        labourRate = 200.00;
        assumptions += ' (daily trade rates)';
      } else {
        subRate = 250.00;
        assumptions += ' (lump-sum works allowance)';
      }
    }

    pricedItems.push({
      id: item.id,
      materialRate,
      labourRate,
      plantRate,
      subRate,
      merchant,
      productUrl,
      confidence,
      warnings,
      assumptions,
      notes
    });
  }

  return pricedItems;
}

app.use(cors());
app.use(express.json());

// Request logger middleware
app.use((req, res, next) => {
  console.log(`[API REQUEST] ${req.method} ${req.url}`);
  res.on('finish', () => {
    console.log(`[API RESPONSE] ${req.method} ${req.url} -> Status: ${res.statusCode}`);
  });
  next();
});

// Serve frontend assets from the root directory
app.use(express.static(path.join(__dirname, '../')));

// Initialize DB on startup
initDb().then(() => console.log('Database initialized.')).catch(console.error);

// --- Auth Middleware ---
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or malformed token' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const db = await getDbConnection();
    // Validate session
    const session = await db.get(
      `SELECT s.user_id, s.expires_at, 
              u.email, u.company_name, u.estimator_name, u.office_address, u.vat_number, 
              u.margin, u.wasteAllowance, u.contingency, u.labourUplift, u.plantOverhead 
       FROM sessions s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.token = ?`,
      token
    );

    if (!session) {
      await db.close();
      return res.status(401).json({ error: 'Unauthorized: Invalid session token' });
    }

    // Check expiration
    if (new Date(session.expires_at) < new Date()) {
      await db.run('DELETE FROM sessions WHERE token = ?', token);
      await db.close();
      return res.status(401).json({ error: 'Unauthorized: Session expired' });
    }

    await db.close();

    req.user = {
      id: session.user_id,
      email: session.email,
      companyName: session.company_name,
      estimatorName: session.estimator_name,
      officeAddress: session.office_address,
      vatNumber: session.vat_number,
      margin: session.margin,
      wasteAllowance: session.wasteAllowance,
      contingency: session.contingency,
      labourUplift: session.labourUplift,
      plantOverhead: session.plantOverhead
    };

    next();
  } catch (error) {
    res.status(500).json({ error: 'Internal Auth Error: ' + error.message });
  }
}

// --- Auth Endpoints ---

// 1. Register User
app.post('/api/auth/register', async (req, res) => {
  const { email, password, companyName, estimatorName, officeAddress, vatNumber } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const db = await getDbConnection();

    // Check if email already exists
    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', email);
    if (existingUser) {
      await db.close();
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const userId = crypto.randomUUID();
    const { salt, hash } = hashPassword(password);

    await db.run(
      `INSERT INTO users (
        id, email, password_hash, salt, company_name, estimator_name, office_address, vat_number,
        margin, wasteAllowance, contingency, labourUplift, plantOverhead
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 20.0, 10.0, 5.0, 0.0, 5.0)`,
      [userId, email, hash, salt, companyName || '', estimatorName || '', officeAddress || '', vatNumber || '']
    );

    // Seed default rates and labour rates for this user scope!
    await seedUserScope(db, userId);

    // Sign session token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days session

    await db.run(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
      [token, userId, expiresAt]
    );

    const user = await db.get(
      'SELECT id, email, company_name, estimator_name, office_address, vat_number, margin, wasteAllowance, contingency, labourUplift, plantOverhead FROM users WHERE id = ?',
      userId
    );
    await db.close();

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        companyName: user.company_name,
        estimatorName: user.estimator_name,
        officeAddress: user.office_address,
        vatNumber: user.vat_number,
        margin: user.margin,
        wasteAllowance: user.wasteAllowance,
        contingency: user.contingency,
        labourUplift: user.labourUplift,
        plantOverhead: user.plantOverhead
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Login User
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const db = await getDbConnection();
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user) {
      await db.close();
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const { hash } = hashPassword(password, user.salt);
    if (hash !== user.password_hash) {
      await db.close();
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    // Sign session token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    await db.run(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
      [token, user.id, expiresAt]
    );

    await db.close();

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        companyName: user.company_name,
        estimatorName: user.estimator_name,
        officeAddress: user.office_address,
        vatNumber: user.vat_number,
        margin: user.margin,
        wasteAllowance: user.wasteAllowance,
        contingency: user.contingency,
        labourUplift: user.labourUplift,
        plantOverhead: user.plantOverhead
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Current User Profile
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// 4. Update Profile Settings
app.put('/api/auth/settings', requireAuth, async (req, res) => {
  const { companyName, estimatorName, officeAddress, vatNumber, margin, wasteAllowance, contingency, labourUplift, plantOverhead } = req.body;
  try {
    const db = await getDbConnection();
    await db.run(
      `UPDATE users SET 
        company_name = ?, 
        estimator_name = ?, 
        office_address = ?, 
        vat_number = ?, 
        margin = ?, 
        wasteAllowance = ?, 
        contingency = ?, 
        labourUplift = ?, 
        plantOverhead = ?
      WHERE id = ?`,
      [
        companyName !== undefined ? companyName : req.user.companyName,
        estimatorName !== undefined ? estimatorName : req.user.estimatorName,
        officeAddress !== undefined ? officeAddress : req.user.officeAddress,
        vatNumber !== undefined ? vatNumber : req.user.vatNumber,
        margin !== undefined ? margin : req.user.margin,
        wasteAllowance !== undefined ? wasteAllowance : req.user.wasteAllowance,
        contingency !== undefined ? contingency : req.user.contingency,
        labourUplift !== undefined ? labourUplift : req.user.labourUplift,
        plantOverhead !== undefined ? plantOverhead : req.user.plantOverhead,
        req.user.id
      ]
    );

    const user = await db.get(
      'SELECT id, email, company_name, estimator_name, office_address, vat_number, margin, wasteAllowance, contingency, labourUplift, plantOverhead FROM users WHERE id = ?',
      req.user.id
    );
    await db.close();

    res.json({
      user: {
        id: user.id,
        email: user.email,
        companyName: user.company_name,
        estimatorName: user.estimator_name,
        officeAddress: user.office_address,
        vatNumber: user.vat_number,
        margin: user.margin,
        wasteAllowance: user.wasteAllowance,
        contingency: user.contingency,
        labourUplift: user.labourUplift,
        plantOverhead: user.plantOverhead
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Logout User
app.post('/api/auth/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const db = await getDbConnection();
      await db.run('DELETE FROM sessions WHERE token = ?', token);
      await db.close();
    } catch (e) { }
  }
  res.json({ success: true });
});

// --- Math Helper: Recalculate Project Costs ---
async function recalculateProjectCost(db, projectId) {
  const project = await db.get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) return;

  const items = await db.all('SELECT * FROM estimate_items WHERE project_id = ?', projectId);

  let totalMaterial = 0;
  let totalLabour = 0;
  let totalPlant = 0;
  let totalSub = 0;

  for (const item of items) {
    totalMaterial += (item.materialRate || 0) * (item.quantity || 0);
    totalLabour += (item.labourRate || 0) * (item.quantity || 0);
    totalPlant += (item.plantRate || 0) * (item.quantity || 0);
    totalSub += (item.subRate || 0) * (item.quantity || 0);
  }

  const wasteAllowance = project.wasteAllowance !== undefined ? project.wasteAllowance : 10.0;
  const contingency = project.contingency !== undefined ? project.contingency : 5.0;
  const labourUplift = project.labourUplift !== undefined ? project.labourUplift : 0.0;
  const plantOverhead = project.plantOverhead !== undefined ? project.plantOverhead : 5.0;
  const margin = project.margin !== undefined ? project.margin : 20.0;

  const materialCost = totalMaterial * (1 + wasteAllowance / 100);
  const labourCost = totalLabour * (1 + labourUplift / 100);
  const plantCost = totalPlant * (1 + plantOverhead / 100);
  const subCost = totalSub;

  const netCost = materialCost + labourCost + plantCost + subCost;
  const totalCost = netCost * (1 + contingency / 100);
  const sellPrice = totalCost * (1 + margin / 100);

  await db.run(
    'UPDATE projects SET totalCost = ?, sellPrice = ? WHERE id = ?',
    [parseFloat(totalCost.toFixed(2)), parseFloat(sellPrice.toFixed(2)), projectId]
  );
}

// --- Rates (Price Book) API ---
app.get('/api/rates', requireAuth, async (req, res) => {
  try {
    const db = await getDbConnection();
    const rates = await db.all('SELECT * FROM rates WHERE user_id = ?', req.user.id);
    await db.close();
    res.json(rates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rates', requireAuth, async (req, res) => {
  let { name, trade, unit, costRate, materialRate, labourRate, plantRate, subRate, category, supplier, sourceUrl, lastUpdated } = req.body;
  const id = crypto.randomUUID();

  const mRate = parseFloat(materialRate) || 0;
  const lRate = parseFloat(labourRate) || 0;
  const pRate = parseFloat(plantRate) || 0;
  const sRate = parseFloat(subRate) || 0;

  if (materialRate !== undefined || labourRate !== undefined || plantRate !== undefined || subRate !== undefined) {
    costRate = mRate + lRate + pRate + sRate;
  } else {
    materialRate = costRate || 0;
    labourRate = 0;
    plantRate = 0;
    subRate = 0;
  }

  try {
    const db = await getDbConnection();
    await db.run(
      `INSERT INTO rates (
        id, user_id, name, trade, unit, costRate, materialRate, labourRate, plantRate, subRate,
        category, supplier, sourceUrl, lastUpdated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, req.user.id, name, trade, unit, parseFloat(costRate) || 0,
        parseFloat(materialRate) || 0, parseFloat(labourRate) || 0,
        parseFloat(plantRate) || 0, parseFloat(subRate) || 0,
        category, supplier, sourceUrl, lastUpdated || new Date().toISOString().split('T')[0]
      ]
    );
    const newRate = await db.get('SELECT * FROM rates WHERE id = ?', id);
    await db.close();
    res.json(newRate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/rates/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  let { name, trade, unit, costRate, materialRate, labourRate, plantRate, subRate, category, supplier, sourceUrl, lastUpdated } = req.body;

  const mRate = parseFloat(materialRate) || 0;
  const lRate = parseFloat(labourRate) || 0;
  const pRate = parseFloat(plantRate) || 0;
  const sRate = parseFloat(subRate) || 0;

  if (materialRate !== undefined || labourRate !== undefined || plantRate !== undefined || subRate !== undefined) {
    costRate = mRate + lRate + pRate + sRate;
  } else {
    materialRate = costRate || 0;
    labourRate = 0;
    plantRate = 0;
    subRate = 0;
  }

  try {
    const db = await getDbConnection();
    await db.run(
      `UPDATE rates SET 
        name=?, trade=?, unit=?, costRate=?, materialRate=?, labourRate=?, plantRate=?, subRate=?,
        category=?, supplier=?, sourceUrl=?, lastUpdated=? 
       WHERE id=? AND user_id=?`,
      [
        name, trade, unit, parseFloat(costRate) || 0,
        parseFloat(materialRate) || 0, parseFloat(labourRate) || 0,
        parseFloat(plantRate) || 0, parseFloat(subRate) || 0,
        category, supplier, sourceUrl, lastUpdated || new Date().toISOString().split('T')[0],
        id, req.user.id
      ]
    );
    const updatedRate = await db.get('SELECT * FROM rates WHERE id = ?', id);
    await db.close();
    res.json(updatedRate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/rates/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const db = await getDbConnection();
    await db.run('DELETE FROM rates WHERE id=? AND user_id=?', [id, req.user.id]);
    await db.close();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Labour Rates API ---
app.get('/api/labour-rates', requireAuth, async (req, res) => {
  try {
    const db = await getDbConnection();
    const rates = await db.all('SELECT * FROM labour_rates WHERE user_id = ?', req.user.id);
    await db.close();
    res.json(rates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/labour-rates/:trade', requireAuth, async (req, res) => {
  const { trade } = req.params;
  const { hourlyRate, dailyRate, productivityRate, difficultyFactor } = req.body;
  try {
    const db = await getDbConnection();
    await db.run(
      'UPDATE labour_rates SET hourlyRate=?, dailyRate=?, productivityRate=?, difficultyFactor=? WHERE trade=? AND user_id=?',
      [hourlyRate, dailyRate, productivityRate, difficultyFactor, trade, req.user.id]
    );
    const updated = await db.get('SELECT * FROM labour_rates WHERE trade = ? AND user_id = ?', [trade, req.user.id]);
    await db.close();
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// --- Firestore Quote Helpers ---
const LEGACY_FIRESTORE_QUOTES_FALLBACK = process.env.LEGACY_FIRESTORE_QUOTES_FALLBACK !== 'false';

function fsNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fsCleanObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function fsParseWarnings(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function fsSerialiseWarnings(value) {
  return Array.isArray(value) ? JSON.stringify(value) : (value || '[]');
}

function fsProjectVisibleToUser(project, userId) {
  if (!project) return false;
  if (project.user_id === userId || project.userId === userId) return true;
  // Legacy one-off migration fallback for old SQLite quote history.
  // This can be disabled with LEGACY_FIRESTORE_QUOTES_FALLBACK=false once old quotes have been claimed.
  if (LEGACY_FIRESTORE_QUOTES_FALLBACK && String(project.legacySource || '').startsWith('sqlite:server/qs.db:projects')) return true;
  return false;
}

function fsProjectToApi(doc) {
  const data = typeof doc.data === 'function' ? doc.data() : doc;
  return {
    ...data,
    id: data.id || doc.id,
    user_id: data.user_id || data.userId || '',
    dateCreated: data.dateCreated || data.createdAt || '',
    status: data.status || 'Draft',
    totalCost: fsNum(data.totalCost ?? data.costToCompany),
    sellPrice: fsNum(data.sellPrice ?? data.totalProposedTenderValue),
    margin: fsNum(data.margin ?? data.markupPercent)
  };
}

function fsItemToApi(doc) {
  const data = typeof doc.data === 'function' ? doc.data() : doc;
  return {
    ...data,
    id: data.id || doc.id,
    project_id: data.project_id || data.projectId || data.legacyProjectId || '',
    section: data.section || 'General',
    description: data.description || 'Unknown Item',
    quantity: fsNum(data.quantity || 0),
    unit: data.unit || 'Item',
    labourRate: fsNum(data.labourRate || 0),
    materialRate: fsNum(data.materialRate || 0),
    plantRate: fsNum(data.plantRate || 0),
    subRate: fsNum(data.subRate || 0),
    isAIIdentified: data.isAIIdentified === true || data.isAIIdentified === 1,
    warnings: fsParseWarnings(data.warnings),
    sortOrder: fsNum(data.sortOrder ?? data.sourceOrder ?? data.originalIndex ?? data.legacyRowId ?? 0)
  };
}

function fsRoomToApi(doc) {
  const data = typeof doc.data === 'function' ? doc.data() : doc;
  return {
    ...data,
    room: String(data.room || '').toLowerCase().trim(),
    width: fsNum(data.width || 0),
    length: fsNum(data.length || 0),
    height: fsNum(data.height || 0)
  };
}

async function fsGetProjectDoc(projectId, userId) {
  const snap = await firestore.collection('projects').doc(projectId).get();
  if (!snap.exists) return null;
  const project = fsProjectToApi(snap);
  if (!fsProjectVisibleToUser(project, userId)) return null;
  return { ref: snap.ref, data: project };
}

async function fsGetProjectItems(projectId) {
  const snap = await firestore.collection('estimate_items').where('project_id', '==', projectId).get();
  const items = [];
  snap.forEach(doc => items.push(fsItemToApi(doc)));
  items.sort((a, b) => {
    const ao = fsNum(a.sortOrder ?? a.legacyRowId ?? 0);
    const bo = fsNum(b.sortOrder ?? b.legacyRowId ?? 0);
    if (ao !== bo) return ao - bo;
    return String(a.id).localeCompare(String(b.id));
  });
  return items;
}

async function fsRecalculateProjectCost(projectId) {
  const snap = await firestore.collection('projects').doc(projectId).get();
  if (!snap.exists) return null;
  const project = fsProjectToApi(snap);
  const items = await fsGetProjectItems(projectId);

  let totalMaterial = 0;
  let totalLabour = 0;
  let totalPlant = 0;
  let totalSub = 0;

  for (const item of items) {
    const qty = fsNum(item.quantity || 0);
    totalMaterial += fsNum(item.materialRate || 0) * qty;
    totalLabour += fsNum(item.labourRate || 0) * qty;
    totalPlant += fsNum(item.plantRate || 0) * qty;
    totalSub += fsNum(item.subRate || 0) * qty;
  }

  const wasteAllowance = fsNum(project.wasteAllowance ?? 10.0);
  const contingency = fsNum(project.contingency ?? 5.0);
  const labourUplift = fsNum(project.labourUplift ?? 0.0);
  const plantOverhead = fsNum(project.plantOverhead ?? 5.0);
  const margin = fsNum(project.margin ?? project.markupPercent ?? 20.0);

  const materialCost = totalMaterial * (1 + wasteAllowance / 100);
  const labourCost = totalLabour * (1 + labourUplift / 100);
  const plantCost = totalPlant * (1 + plantOverhead / 100);
  const subCost = totalSub;

  const netCost = materialCost + labourCost + plantCost + subCost;
  const totalCost = netCost * (1 + contingency / 100);
  const sellPrice = totalCost * (1 + margin / 100);
  const profit = sellPrice - totalCost;
  const marginPercent = sellPrice > 0 ? (profit / sellPrice) * 100 : 0;

  const update = {
    totalCost: parseFloat(totalCost.toFixed(2)),
    costToCompany: parseFloat(totalCost.toFixed(2)),
    sellPrice: parseFloat(sellPrice.toFixed(2)),
    totalProposedTenderValue: parseFloat(sellPrice.toFixed(2)),
    profit: parseFloat(profit.toFixed(2)),
    markupPercent: margin,
    marginPercent: parseFloat(marginPercent.toFixed(2)),
    updatedAt: new Date().toISOString()
  };

  await snap.ref.set(update, { merge: true });
  return { ...project, ...update };
}

function fsRoomDocId(projectId, room) {
  return crypto.createHash('sha1').update(`${projectId}|${String(room || '').toLowerCase().trim()}`).digest('hex');
}

async function fsDeleteQuery(querySnap) {
  let batch = firestore.batch();
  let count = 0;
  for (const doc of querySnap.docs) {
    batch.delete(doc.ref);
    count++;
    if (count >= 450) {
      await batch.commit();
      batch = firestore.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

// --- Projects API ---
app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const byUserSnap = await firestore.collection('projects').where('user_id', '==', req.user.id).get();
    const projectsById = new Map();
    byUserSnap.forEach(doc => {
      const project = fsProjectToApi(doc);
      if (fsProjectVisibleToUser(project, req.user.id)) projectsById.set(project.id, project);
    });

    // Include legacy imported quotes if they were migrated before the live app user id was known.
    if (LEGACY_FIRESTORE_QUOTES_FALLBACK) {
      const legacySnap = await firestore.collection('projects').where('legacySource', '==', 'sqlite:server/qs.db:projects').get();
      legacySnap.forEach(doc => {
        const project = fsProjectToApi(doc);
        if (fsProjectVisibleToUser(project, req.user.id)) projectsById.set(project.id, project);
      });
    }

    const projects = Array.from(projectsById.values()).sort((a, b) => {
      const ad = String(a.dateCreated || a.createdAt || '');
      const bd = String(b.dateCreated || b.createdAt || '');
      return bd.localeCompare(ad);
    });

    res.json(projects);
  } catch (error) {
    console.error('[Firestore Projects GET Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const found = await fsGetProjectDoc(id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Project not found' });
    res.json(found.data);
  } catch (error) {
    console.error('[Firestore Project GET Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects', requireAuth, async (req, res) => {
  const {
    name, client, address, tenderRef, tradeCategory, startDate, duration, notes,
    margin, wasteAllowance, contingency, labourUplift, plantOverhead
  } = req.body;
  const id = crypto.randomUUID();
  const dateCreated = new Date().toISOString().split('T')[0];
  try {
    const newProject = fsCleanObject({
      id,
      user_id: req.user.id,
      name,
      client: client || '',
      address: address || '',
      dateCreated,
      createdAt: dateCreated,
      status: 'Draft',
      totalCost: 0,
      costToCompany: 0,
      sellPrice: 0,
      totalProposedTenderValue: 0,
      margin: margin || 20,
      tenderRef: tenderRef || '',
      tradeCategory: tradeCategory || '',
      startDate: startDate || '',
      duration: duration || '',
      notes: notes || '',
      wasteAllowance: wasteAllowance || 10.0,
      contingency: contingency || 5.0,
      labourUplift: labourUplift || 0.0,
      plantOverhead: plantOverhead || 5.0,
      source: 'firestore-api',
      updatedAt: new Date().toISOString()
    });

    await firestore.collection('projects').doc(id).set(newProject, { merge: true });
    res.json(newProject);
  } catch (error) {
    console.error('[Firestore Project POST Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/sync', requireAuth, async (req, res) => {
  const {
    id, name, client, address, dateCreated, status, totalCost, sellPrice, margin,
    tenderRef, tradeCategory, startDate, duration, notes,
    wasteAllowance, contingency, labourUplift, plantOverhead, items, roomMeasurements
  } = req.body;

  if (!id || !name || !Array.isArray(items)) {
    return res.status(400).json({ error: 'id, name, and items array are required for sync.' });
  }

  try {
    const projectRef = firestore.collection('projects').doc(id);
    const existing = await projectRef.get();
    if (existing.exists && !fsProjectVisibleToUser(fsProjectToApi(existing), req.user.id)) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const oldItemsSnap = await firestore.collection('estimate_items').where('project_id', '==', id).get();
    const oldRoomsSnap = await firestore.collection('room_measurements').where('project_id', '==', id).get();

    let batch = firestore.batch();
    let count = 0;
    const commitMaybe = async () => {
      if (count >= 430) {
        await batch.commit();
        batch = firestore.batch();
        count = 0;
      }
    };

    for (const doc of oldItemsSnap.docs) { batch.delete(doc.ref); count++; await commitMaybe(); }
    for (const doc of oldRoomsSnap.docs) { batch.delete(doc.ref); count++; await commitMaybe(); }

    const projectData = fsCleanObject({
      id,
      user_id: req.user.id,
      name,
      client: client || '',
      address: address || '',
      dateCreated: dateCreated || new Date().toISOString().split('T')[0],
      createdAt: dateCreated || new Date().toISOString().split('T')[0],
      status: status || 'Draft',
      totalCost: fsNum(totalCost || 0),
      costToCompany: fsNum(totalCost || 0),
      sellPrice: fsNum(sellPrice || 0),
      totalProposedTenderValue: fsNum(sellPrice || 0),
      margin: margin || 20.0,
      tenderRef: tenderRef || '',
      tradeCategory: tradeCategory || '',
      startDate: startDate || '',
      duration: duration || '',
      notes: notes || '',
      wasteAllowance: wasteAllowance || 10.0,
      contingency: contingency || 5.0,
      labourUplift: labourUplift || 0.0,
      plantOverhead: plantOverhead || 5.0,
      source: 'firestore-api',
      updatedAt: new Date().toISOString()
    });
    batch.set(projectRef, projectData, { merge: true }); count++; await commitMaybe();

    const orderedImportItems = items
      .map((item, index) => ({ ...item, sortOrder: Number(item.sortOrder ?? item.sourceOrder ?? item.originalIndex ?? index) }))
      .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));

    orderedImportItems.forEach((item, index) => {
      const itemId = item.id || crypto.randomUUID();
      const materialRate = fsNum(item.materialRate || 0);
      const labourRate = fsNum(item.labourRate || 0);
      const plantRate = fsNum(item.plantRate || 0);
      const subRate = fsNum(item.subRate || 0);
      const quantity = fsNum(item.quantity || 0);
      batch.set(firestore.collection('estimate_items').doc(itemId), fsCleanObject({
        id: itemId,
        project_id: id,
        user_id: req.user.id,
        section: item.section || 'General',
        description: item.description || 'Unknown Item',
        quantity,
        unit: item.unit || 'Item',
        labourRate,
        materialRate,
        plantRate,
        subRate,
        isAIIdentified: item.isAIIdentified !== undefined ? !!item.isAIIdentified : true,
        confidence: item.confidence || 'Medium',
        warnings: fsSerialiseWarnings(item.warnings),
        merchant: item.merchant || '',
        productUrl: item.productUrl || '',
        assumptions: item.assumptions || '',
        notes: item.notes || '',
        sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : index,
        baseCostRate: materialRate + labourRate + plantRate + subRate,
        baseCostTotal: (materialRate + labourRate + plantRate + subRate) * quantity,
        updatedAt: new Date().toISOString()
      }), { merge: true });
      count++;
    });

    if (roomMeasurements && typeof roomMeasurements === 'object') {
      Object.entries(roomMeasurements).forEach(([roomName, dims], index) => {
        if (dims && typeof dims === 'object') {
          const room = String(roomName || '').toLowerCase().trim();
          const roomId = fsRoomDocId(id, room);
          batch.set(firestore.collection('room_measurements').doc(roomId), fsCleanObject({
            id: roomId,
            project_id: id,
            user_id: req.user.id,
            room,
            width: fsNum(dims.width || 0),
            length: fsNum(dims.length || 0),
            height: fsNum(dims.height || 0),
            sortOrder: index,
            updatedAt: new Date().toISOString()
          }), { merge: true });
          count++;
        }
      });
    }

    if (count > 0) await batch.commit();
    await fsRecalculateProjectCost(id);
    res.json({ success: true, projectId: id });
  } catch (error) {
    console.error('[Firestore Sync API Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/projects/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const {
    name, client, address, status, margin, tenderRef, tradeCategory, startDate,
    duration, notes, wasteAllowance, contingency, labourUplift, plantOverhead
  } = req.body;
  try {
    const found = await fsGetProjectDoc(id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Project not found' });

    const update = fsCleanObject({
      name, client, address, status, margin, tenderRef, tradeCategory,
      startDate, duration, notes, wasteAllowance, contingency,
      labourUplift, plantOverhead,
      user_id: req.user.id,
      updatedAt: new Date().toISOString()
    });

    await found.ref.set(update, { merge: true });
    const updatedProject = await fsRecalculateProjectCost(id) || { ...found.data, ...update };
    res.json(updatedProject);
  } catch (error) {
    console.error('[Firestore Project PUT Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const found = await fsGetProjectDoc(id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Project not found' });

    const itemSnap = await firestore.collection('estimate_items').where('project_id', '==', id).get();
    const roomSnap = await firestore.collection('room_measurements').where('project_id', '==', id).get();
    await fsDeleteQuery(itemSnap);
    await fsDeleteQuery(roomSnap);
    await found.ref.delete();
    res.json({ success: true });
  } catch (error) {
    console.error('[Firestore Project DELETE Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Room Measurements API ---
app.get('/api/projects/:id/room-measurements', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const found = await fsGetProjectDoc(id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Project not found' });

    const snap = await firestore.collection('room_measurements').where('project_id', '==', id).get();
    const measurements = [];
    snap.forEach(doc => measurements.push(fsRoomToApi(doc)));
    measurements.sort((a, b) => fsNum(a.sortOrder ?? a.legacyRowId ?? 0) - fsNum(b.sortOrder ?? b.legacyRowId ?? 0));
    res.json(measurements);
  } catch (error) {
    console.error('[Firestore Room GET Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/:id/room-measurements', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { room, width, length, height } = req.body;
  if (!room) return res.status(400).json({ error: 'Room name is required.' });

  try {
    const found = await fsGetProjectDoc(id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Project not found' });

    const roomClean = String(room).toLowerCase().trim();
    const roomId = fsRoomDocId(id, roomClean);
    await firestore.collection('room_measurements').doc(roomId).set(fsCleanObject({
      id: roomId,
      project_id: id,
      user_id: req.user.id,
      room: roomClean,
      width: fsNum(width || 0),
      length: fsNum(length || 0),
      height: fsNum(height || 0),
      updatedAt: new Date().toISOString()
    }), { merge: true });

    res.json({ success: true });
  } catch (error) {
    console.error('[Firestore Room POST Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/room-measurements/lookup', requireAuth, async (req, res) => {
  try {
    const projectsSnap = await firestore.collection('projects').where('user_id', '==', req.user.id).get();
    const projectIds = new Set();
    projectsSnap.forEach(doc => projectIds.add(doc.id));

    if (LEGACY_FIRESTORE_QUOTES_FALLBACK) {
      const legacySnap = await firestore.collection('projects').where('legacySource', '==', 'sqlite:server/qs.db:projects').get();
      legacySnap.forEach(doc => projectIds.add(doc.id));
    }

    const lookup = {};
    for (const projectId of projectIds) {
      const snap = await firestore.collection('room_measurements').where('project_id', '==', projectId).get();
      snap.forEach(doc => {
        const row = fsRoomToApi(doc);
        if (!row.room) return;
        lookup[row.room] = { width: row.width, length: row.length, height: row.height };
      });
    }
    res.json(lookup);
  } catch (error) {
    console.error('[Firestore Room Lookup Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Estimate Items API ---
app.get('/api/projects/:id/estimates', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const found = await fsGetProjectDoc(id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Project not found' });
    const items = await fsGetProjectItems(id);
    res.json(items);
  } catch (error) {
    console.error('[Firestore Estimates GET Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/estimate-items', requireAuth, async (req, res) => {
  const {
    project_id, section, description, quantity, unit, labourRate, materialRate,
    plantRate, subRate, isAIIdentified, confidence, warnings, merchant, productUrl, assumptions, notes
  } = req.body;
  const id = crypto.randomUUID();
  try {
    const found = await fsGetProjectDoc(project_id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Project not found' });

    const existingItems = await fsGetProjectItems(project_id);
    const sortOrder = existingItems.length;
    const m = fsNum(materialRate || 0), l = fsNum(labourRate || 0), p = fsNum(plantRate || 0), s = fsNum(subRate || 0), q = fsNum(quantity || 1);
    const newItem = fsCleanObject({
      id,
      project_id,
      user_id: req.user.id,
      section: section || 'General',
      description,
      quantity: q,
      unit: unit || 'Item',
      labourRate: l,
      materialRate: m,
      plantRate: p,
      subRate: s,
      isAIIdentified: !!isAIIdentified,
      confidence: confidence || 'High',
      warnings: fsSerialiseWarnings(warnings),
      merchant: merchant || '',
      productUrl: productUrl || '',
      assumptions: assumptions || '',
      notes: notes || '',
      sortOrder,
      baseCostRate: m + l + p + s,
      baseCostTotal: (m + l + p + s) * q,
      updatedAt: new Date().toISOString()
    });

    await firestore.collection('estimate_items').doc(id).set(newItem, { merge: true });
    await fsRecalculateProjectCost(project_id);
    res.json(fsItemToApi(newItem));
  } catch (error) {
    console.error('[Firestore Estimate POST Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/estimate-items/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const {
    section, description, quantity, unit, labourRate, materialRate, plantRate,
    subRate, confidence, warnings, merchant, productUrl, assumptions, notes
  } = req.body;
  try {
    const itemRef = firestore.collection('estimate_items').doc(id);
    const itemSnap = await itemRef.get();
    if (!itemSnap.exists) return res.status(404).json({ error: 'Estimate item not found' });

    const oldItem = fsItemToApi(itemSnap);
    const found = await fsGetProjectDoc(oldItem.project_id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Estimate item not found' });

    const m = fsNum(materialRate || 0), l = fsNum(labourRate || 0), p = fsNum(plantRate || 0), s = fsNum(subRate || 0), q = fsNum(quantity || 0);
    const update = fsCleanObject({
      section,
      description,
      quantity: q,
      unit,
      labourRate: l,
      materialRate: m,
      plantRate: p,
      subRate: s,
      confidence,
      warnings: fsSerialiseWarnings(warnings),
      merchant,
      productUrl,
      assumptions,
      notes,
      user_id: req.user.id,
      baseCostRate: m + l + p + s,
      baseCostTotal: (m + l + p + s) * q,
      updatedAt: new Date().toISOString()
    });

    await itemRef.set(update, { merge: true });

    // Keep the existing SQLite price library behaviour for manual price learning.
    try {
      const db = await getDbConnection();
      const normName = normalizeDescription(description, section);
      if (normName) {
        const totalCostRate = m + l + p + s;
        const existingRate = await db.get('SELECT id FROM rates WHERE user_id = ? AND LOWER(name) = ?', [req.user.id, normName.toLowerCase()]);
        const dateStr = new Date().toISOString().split('T')[0];
        if (existingRate) {
          await db.run(
            `UPDATE rates SET costRate = ?, materialRate = ?, labourRate = ?, plantRate = ?, subRate = ?, unit = ?, lastUpdated = ? WHERE id = ?`,
            [totalCostRate, m, l, p, s, unit || 'Item', dateStr, existingRate.id]
          );
        } else {
          await db.run(
            `INSERT INTO rates (id, user_id, name, trade, unit, costRate, materialRate, labourRate, plantRate, subRate, category, supplier, sourceUrl, lastUpdated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [crypto.randomUUID(), req.user.id, normName, 'General', unit || 'Item', totalCostRate, m, l, p, s, 'Material', merchant || 'Manual Adjustment', productUrl || '', dateStr]
          );
        }
      }
      await db.close();
    } catch (libraryError) {
      console.warn('[Firestore Estimate PUT] Price-library SQLite update skipped:', libraryError.message);
    }

    await fsRecalculateProjectCost(oldItem.project_id);
    const updatedSnap = await itemRef.get();
    res.json(fsItemToApi(updatedSnap));
  } catch (error) {
    console.error('[Firestore Estimate PUT Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/estimate-items/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const itemRef = firestore.collection('estimate_items').doc(id);
    const itemSnap = await itemRef.get();
    if (!itemSnap.exists) return res.status(404).json({ error: 'Estimate item not found' });

    const item = fsItemToApi(itemSnap);
    const found = await fsGetProjectDoc(item.project_id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Estimate item not found' });

    await itemRef.delete();
    await fsRecalculateProjectCost(item.project_id);
    res.json({ success: true });
  } catch (error) {
    console.error('[Firestore Estimate DELETE Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- AI SOR Repricing Engine API ---
app.post('/api/projects/:id/reprice', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { forceLocal } = req.body || {};

  try {
    const db = await getDbConnection();

    // Verify ownership
    const project = await db.get('SELECT * FROM projects WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!project) {
      await db.close();
      return res.status(404).json({ error: 'Project not found' });
    }

    const items = await db.all('SELECT * FROM estimate_items WHERE project_id = ?', id);
    if (items.length === 0) {
      await db.close();
      return res.json({ success: true, message: 'No items to reprice.' });
    }

    const libraryRates = await db.all(
      'SELECT id, name, trade, unit, costRate, materialRate, labourRate, plantRate, subRate, category, supplier, sourceUrl FROM rates WHERE user_id = ?',
      req.user.id
    );
    const labourRates = await db.all('SELECT * FROM labour_rates WHERE user_id = ?', req.user.id);

    console.log(`Repricing ${items.length} items for project "${project.name}" (User: ${req.user.id}) with database lookup & de-duplication...`);

    // Group items by normalized description to ensure 100% rate consistency
    const itemsGroupedByDesc = {};

    for (const item of items) {
      const normDesc = normalizeDescription(item.description, item.section);
      if (!itemsGroupedByDesc[normDesc]) {
        itemsGroupedByDesc[normDesc] = [];
      }
      itemsGroupedByDesc[normDesc].push(item);
    }

    const matchedPricedItems = [];
    const unmatchedRepresentativeItems = [];

    // Normalization matching against price book
    for (const [normDesc, groupItems] of Object.entries(itemsGroupedByDesc)) {
      // Find match in libraryRates
      let bestMatch = null;
      for (const rate of libraryRates) {
        const rateNorm = normalizeDescription(rate.name, '');
        if (rateNorm === normDesc && rateNorm !== '') {
          bestMatch = rate;
          break;
        }
      }

      if (bestMatch) {
        // Apply this exact price to all items in the group
        for (const item of groupItems) {
          matchedPricedItems.push({
            id: item.id,
            materialRate: bestMatch.materialRate || bestMatch.costRate || 0,
            labourRate: bestMatch.labourRate || 0,
            plantRate: bestMatch.plantRate || 0,
            subRate: bestMatch.subRate || 0,
            merchant: bestMatch.supplier || '',
            productUrl: bestMatch.sourceUrl || '',
            confidence: 'High',
            warnings: [],
            assumptions: 'Matched from global Price Book',
            notes: ''
          });
        }
      } else {
        // No match in Price Book: check if the representative item has existing rates
        const representative = groupItems[0];
        const hasExistingRates = (representative.materialRate || 0) > 0 ||
                                 (representative.labourRate || 0) > 0 ||
                                 (representative.plantRate || 0) > 0 ||
                                 (representative.subRate || 0) > 0;
        
        if (hasExistingRates) {
          for (const item of groupItems) {
            matchedPricedItems.push({
              id: item.id,
              materialRate: item.materialRate || 0,
              labourRate: item.labourRate || 0,
              plantRate: item.plantRate || 0,
              subRate: item.subRate || 0,
              merchant: item.merchant || '',
              productUrl: item.productUrl || '',
              confidence: item.confidence || 'Medium',
              warnings: typeof item.warnings === 'string' ? JSON.parse(item.warnings || '[]') : (item.warnings || []),
              assumptions: item.assumptions || 'Preserved existing rates',
              notes: item.notes || ''
            });
          }
        } else {
          // No match and no existing rates: select as representative to send to Gemini
          unmatchedRepresentativeItems.push(representative);
        }
      }
    }

    let pricedFromGemini = [];
    if (unmatchedRepresentativeItems.length > 0) {
      console.log(`Sending ${unmatchedRepresentativeItems.length} unmatched representative items to Gemini...`);

      const prompt = `You are a professional UK Senior Quantity Surveyor. Price the following list of construction work items:
${JSON.stringify(unmatchedRepresentativeItems.map(item => ({ id: item.id, description: item.description, quantity: item.quantity, unit: item.unit })))}

Current Project Trade Category: ${project.tradeCategory}

Use the saved price library and labour rates below as your preferred database. If a material or daily trade rate matches, use it. Otherwise, estimate realistic current UK market rates (materials from Screwfix, Travis Perkins, Selco, Jewson, etc. and labour).

---
SAVED PRICE LIBRARY:
${JSON.stringify(libraryRates.map(r => ({ name: r.name, trade: r.trade, unit: r.unit, costRate: r.costRate })))}

SAVED LABOUR DAY RATES:
${JSON.stringify(labourRates)}
---

Provide a rate build-up for EACH item. Return a valid JSON array of objects.
Do not wrap in markdown \`\`\`json blocks. Just output a raw JSON array.
The rate fields MUST be unit rates (per 1 unit of the item):
- "id": The EXACT id of the item being priced (MUST match one of the input ids).
- "materialRate": The material cost per 1 unit of this item.
- "labourRate": The labour cost per 1 unit of this item (calculated by taking the hours/days needed per unit, multiplied by the daily/hourly trade rate).
- "plantRate": The plant hire/allowance cost per 1 unit of this item (e.g. skip share, cement mixer share).
- "subRate": Subcontractor rate per 1 unit if fully subcontracted (set other rates to 0 if subbed).
- "merchant": The matched merchant/supplier name (e.g. "Travis Perkins", "Screwfix", "HSS Hire", "Jewson", "Selco").
- "productUrl": Sourcing URL or domain (e.g. https://www.travisperkins.co.uk/).
- "confidence": "High", "Medium", or "Low" (High if it matches a library price or standard trade, Low if vague).
- "warnings": Array of strings (e.g. ["Access restrictions might require hand-digging"]).
- "assumptions": Clear breakdown of why this rate is built this way.
- "notes": Any other cost commentary.

JSON format:
[
  {
    "id": "string",
    "materialRate": number,
    "labourRate": number,
    "plantRate": number,
    "subRate": number,
    "merchant": "string",
    "productUrl": "string",
    "confidence": "High" | "Medium" | "Low",
    "warnings": ["string"],
    "assumptions": "string",
    "notes": "string"
  },
  ...
]`;

      try {
        if (forceLocal || !ai) {
          if (!ai) {
            console.warn('[Reprice Engine] Gemini API key is not configured. Automatically falling back to local Price Book offline matching...');
          } else {
            console.log('[Reprice Engine] Force local flag requested. Bypassing Gemini...');
          }
          pricedFromGemini = localKeywordPricing(unmatchedRepresentativeItems, libraryRates, labourRates, project.tradeCategory);
        } else {
          const response = await generateContentWithRetry({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
            }
          }, 1, 250);
          pricedFromGemini = JSON.parse(response.text);
        }
      } catch (geminiError) {
        console.warn('[Reprice Engine] Gemini API repricing failed. Falling back to local...', geminiError);
        pricedFromGemini = localKeywordPricing(unmatchedRepresentativeItems, libraryRates, labourRates, project.tradeCategory);
      }
    }

    // Combine matched database rates and newly generated rates
    const finalPricedItems = [...matchedPricedItems];
    const dateStr = new Date().toISOString().split('T')[0];

    for (const priced of pricedFromGemini) {
      if (!priced.id) continue;

      const repItem = unmatchedRepresentativeItems.find(item => item.id === priced.id);
      if (!repItem) continue;

      const normDesc = normalizeDescription(repItem.description, repItem.section);
      const groupItems = itemsGroupedByDesc[normDesc] || [];

      // Apply to all items in the group
      for (const item of groupItems) {
        finalPricedItems.push({
          id: item.id,
          materialRate: priced.materialRate || 0,
          labourRate: priced.labourRate || 0,
          plantRate: priced.plantRate || 0,
          subRate: priced.subRate || 0,
          merchant: priced.merchant || '',
          productUrl: priced.productUrl || '',
          confidence: priced.confidence || 'Medium',
          warnings: priced.warnings || [],
          assumptions: priced.assumptions || '',
          notes: priced.notes || ''
        });
      }

      // Automatically save to the global Price Book
      if (normDesc) {
        const totalCostRate = (priced.materialRate || 0) + (priced.labourRate || 0) + (priced.plantRate || 0) + (priced.subRate || 0);
        const existingRate = await db.get(
          'SELECT id FROM rates WHERE user_id = ? AND LOWER(name) = ?',
          [req.user.id, normDesc.toLowerCase()]
        );
        if (existingRate) {
          await db.run(
            `UPDATE rates SET 
              costRate = ?,
              materialRate = ?,
              labourRate = ?,
              plantRate = ?,
              subRate = ?,
              unit = ?,
              lastUpdated = ?
             WHERE id = ?`,
            [totalCostRate, priced.materialRate || 0, priced.labourRate || 0, priced.plantRate || 0, priced.subRate || 0, repItem.unit || 'Item', dateStr, existingRate.id]
          );
        } else {
          await db.run(
            `INSERT INTO rates (
              id, user_id, name, trade, unit, costRate, materialRate,
              labourRate, plantRate, subRate, category, supplier, sourceUrl, lastUpdated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              crypto.randomUUID(), req.user.id, normDesc, 'General', repItem.unit || 'Item',
              totalCostRate, priced.materialRate || 0, priced.labourRate || 0, priced.plantRate || 0, priced.subRate || 0,
              'Material', priced.merchant || 'AI Suggest', priced.productUrl || '', dateStr
            ]
          );
        }
      }
    }

    // Update in a transaction
    await db.run('BEGIN TRANSACTION');
    try {
      const updateStmt = await db.prepare(
        `UPDATE estimate_items SET 
          labourRate = ?, 
          materialRate = ?, 
          plantRate = ?, 
          subRate = ?, 
          confidence = ?, 
          warnings = ?, 
          merchant = ?, 
          productUrl = ?, 
          assumptions = ?, 
          notes = ? 
         WHERE id = ?`
      );

      for (const priced of finalPricedItems) {
        if (!priced.id) continue;
        await updateStmt.run([
          priced.labourRate || 0,
          priced.materialRate || 0,
          priced.plantRate || 0,
          priced.subRate || 0,
          priced.confidence || 'Medium',
          JSON.stringify(priced.warnings || []),
          priced.merchant || '',
          priced.productUrl || '',
          priced.assumptions || '',
          priced.notes || '',
          priced.id
        ]);
      }
      await updateStmt.finalize();
      await db.run('COMMIT');
    } catch (txErr) {
      await db.run('ROLLBACK');
      throw txErr;
    }

    // Now, recalculate project-level costs
    await recalculateProjectCost(db, id);

    await db.close();
    res.json({ success: true, message: `All ${finalPricedItems.length} items priced successfully` });
  } catch (error) {
    console.error('Reprice engine error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Scraper API ---
app.post('/api/scrape', requireAuth, async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  try {
    const result = await scrapePrice(url);
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// --- AI Price Suggest API ---
app.post('/api/ai/price-suggest', requireAuth, async (req, res) => {
  const { description, unit, quantity, category, originalDescription } = req.body || {};

  if (!description || !unit) {
    return res.status(400).json({
      success: false,
      error: 'Description and Unit are required'
    });
  }

  const descText = String(description || '').trim();
  const originalDescText = String(originalDescription || description || '').trim();
  const unitText = String(unit || '').trim();
  const normDesc = normalizeDescription(originalDescText, '');
  const normUnit = unitText.toLowerCase().trim();
  const qty = Math.max(Number(quantity) || 1, 1);
  const categoryText = String(category || '').trim();

  function responseFromSavedRate(rate) {
    const materialRate = Number(rate.materialRate) || 0;
    const labourRate = Number(rate.labourRate) || 0;
    const plantRate = Number(rate.plantRate) || 0;
    const subRate = Number(rate.subRate) || 0;
    const total = Number(rate.costRate) || materialRate + labourRate + plantRate + subRate;

    return {
      success: true,
      minPrice: total,
      maxPrice: total,
      recommendedRate: total,
      explanation: 'Matched from your saved Price Book, so no AI lookup was required.',
      source: 'Saved Firestore Price Book',
      matchedRateId: rate.id || '',
      matchedRateName: rate.name || ''
    };
  }

  function detectQuantityFromDescription() {
    const text = originalDescText.toLowerCase();

    const areaMatch = text.match(/(?:allowance\s*for\s*)?(\d+(?:\.\d+)?)\s*(?:m2|mï¿½|sqm|sq\s*m)/i);
    if (areaMatch) {
      return {
        quantity: Number(areaMatch[1]),
        unit: 'm2',
        reason: 'Quantity extracted from description area allowance'
      };
    }

    const numberUnitMatch = text.match(/(\d+(?:\.\d+)?)\s*x\s*/i);
    if (numberUnitMatch) {
      return {
        quantity: Number(numberUnitMatch[1]),
        unit: unitText,
        reason: 'Quantity extracted from item count'
      };
    }

    return {
      quantity: qty,
      unit: unitText,
      reason: 'Quantity supplied by rate modal'
    };
  }

  function buildFastQSAssessment() {
    const descLower = originalDescText.toLowerCase();
    const unitLower = unitText.toLowerCase().trim();
    const detected = detectQuantityFromDescription();

    if (
      (unitLower === 'm2' || unitLower === 'mï¿½' || unitLower === 'sqm') &&
      (descLower.includes('render') || descLower.includes('masonry paint') || descLower.includes('repaint') || descLower.includes('decorate')) &&
      (descLower.includes('elevation') || descLower.includes('external') || descLower.includes('silicone') || descLower.includes('cracking') || descLower.includes('bubbling'))
    ) {
      let recommendedRate = 18.5;
      let minPrice = 14.5;
      let maxPrice = 24.5;

      if (descLower.includes('silicone')) {
        recommendedRate += 3.5;
        minPrice += 2.5;
        maxPrice += 4.5;
      }

      if (descLower.includes('cracking') || descLower.includes('bubbling')) {
        recommendedRate += 4;
        minPrice += 3;
        maxPrice += 5;
      }

      recommendedRate = Number(recommendedRate.toFixed(2));
      minPrice = Number(minPrice.toFixed(2));
      maxPrice = Number(maxPrice.toFixed(2));

      return {
        success: true,
        minPrice,
        maxPrice,
        recommendedRate,
        detectedQuantity: detected.quantity,
        detectedUnit: detected.unit,
        totalEstimate: Number((recommendedRate * detected.quantity).toFixed(2)),
        explanation:
          'Fast QS assessment: external render/masonry redecorating priced per m2. The description contains an allowance of ' +
          detected.quantity +
          'm2, so the suggested rate is a m2 unit rate and the total estimate is rate multiplied by that measured area. Includes preparation to cracked/bubbling render, silicone masonry paint system and normal external access/productivity allowance.',
        source: 'Fast UK QS External Decoration / Render Estimator'
      };
    }

    return null;
  }

  function buildOfflinePrice() {
    let minPrice = 15;
    let maxPrice = 35;
    let recommendedRate = 22;
    let explanation = 'Based on average UK subcontracting rates, this item is estimated at standard regional prices. Includes standard labour hours and minor consumables.';
    let source = 'Offline Heuristics Cost Index';

    const descLower = originalDescText.toLowerCase();
    const unitLower = unitText.toLowerCase().trim();
    const isHourly = unitLower === 'hr' || unitLower === 'hour' || unitLower === 'hours';
    const isDaily = unitLower === 'day' || unitLower === 'days' || unitLower === 'daily';

    // Specialist EPC / UPVC windows and doors package estimator.
    // This handles descriptions like:
    // "10 x double, 7 x single, 2 x triple windows, 3 x double, 2x single doors"
    // and prevents the generic Item fallback returning nonsense.
    const isWindowDoorPackage =
      (descLower.includes('window') || descLower.includes('door')) &&
      (descLower.includes('upvc') || descLower.includes('u-value') || descLower.includes('epc') || descLower.includes('thermal') || descLower.includes('glazing'));

    if (!isHourly && !isDaily && isWindowDoorPackage) {
      const extractCount = (patterns) => {
        for (const pattern of patterns) {
          const match = descLower.match(pattern);
          if (match && match[1]) return Number(match[1]) || 0;
        }
        return 0;
      };

      const doubleWindows = extractCount([
        /(\d+)\s*x?\s*double[^\n,.;]*window/i,
        /(\d+)\s*x?\s*double/i
      ]);

      const singleWindows = extractCount([
        /(\d+)\s*x?\s*single[^\n,.;]*window/i,
        /(\d+)\s*x?\s*single/i
      ]);

      const tripleWindows = extractCount([
        /(\d+)\s*x?\s*triple[^\n,.;]*window/i,
        /(\d+)\s*x?\s*triple/i
      ]);

      const doubleDoors = extractCount([
        /(\d+)\s*x?\s*double[^\n,.;]*door/i
      ]);

      const singleDoors = extractCount([
        /(\d+)\s*x?\s*single[^\n,.;]*door/i
      ]);

      const totalWindows = doubleWindows + singleWindows + tripleWindows;
      const totalDoors = doubleDoors + singleDoors;

      // Supply and fit benchmark allowances for EPC-compliant UPVC replacement units.
      // These are deliberately mid-high because the spec requires thermal performance / U-value compliance.
      const singleWindowRate = 575;
      const doubleWindowRate = 825;
      const tripleWindowRate = 1125;
      const singleDoorRate = 1250;
      const doubleDoorRate = 1850;

      const windowSubtotal =
        (singleWindows * singleWindowRate) +
        (doubleWindows * doubleWindowRate) +
        (tripleWindows * tripleWindowRate);

      const doorSubtotal =
        (singleDoors * singleDoorRate) +
        (doubleDoors * doubleDoorRate);

      const makingGoodAllowance = Math.max((windowSubtotal + doorSubtotal) * 0.08, 350);
      const wasteAccessAndFixings = Math.max((windowSubtotal + doorSubtotal) * 0.05, 250);

      const packageTotal = windowSubtotal + doorSubtotal + makingGoodAllowance + wasteAccessAndFixings;

      minPrice = Number((packageTotal * 0.9).toFixed(2));
      maxPrice = Number((packageTotal * 1.15).toFixed(2));
      recommendedRate = Number(packageTotal.toFixed(2));

      explanation =
        'Specialist EPC UPVC windows/doors package estimate based on the quantities found in the specification: ' +
        totalWindows + ' windows and ' + totalDoors + ' doors. Includes supply and fit of thermally compliant UPVC units, standard fixings, removal of existing units, making good allowance, access/waste allowance and normal installation labour.';

      source = 'QS EPC UPVC Windows & Doors Package Estimator';

      return {
        success: true,
        minPrice,
        maxPrice,
        recommendedRate,
        explanation,
        source
      };
    }

    if (isHourly) {
      if (descLower.includes('paint') || descLower.includes('decorat') || descLower.includes('emulsion')) {
        minPrice = 18;
        maxPrice = 28;
        recommendedRate = 22;
        explanation = 'Standard painter/decorator hourly trade rate in the UK, excluding paint materials.';
        source = 'Offline UK Decorating Labour Index';
      } else if (descLower.includes('concrete') || descLower.includes('slab') || descLower.includes('ground')) {
        minPrice = 20;
        maxPrice = 30;
        recommendedRate = 22;
        explanation = 'Groundworker / general concrete contractor hourly labour rate in the UK.';
        source = 'Offline Groundworks Labour Index';
      } else if (descLower.includes('carp') || descLower.includes('join') || descLower.includes('floor') || descLower.includes('sill') || descLower.includes('door')) {
        minPrice = 22;
        maxPrice = 35;
        recommendedRate = 28;
        explanation = 'Skilled carpenter / joiner hourly trade rate in the UK, excluding timber materials.';
        source = 'Offline Joinery Labour Index';
      } else {
        minPrice = 18;
        maxPrice = 30;
        recommendedRate = 22;
        explanation = 'Average trade hourly subcontractor labour rate in the UK construction market.';
        source = 'Offline Labour Cost Index';
      }
    } else if (isDaily) {
      if (descLower.includes('paint') || descLower.includes('decorat') || descLower.includes('emulsion')) {
        minPrice = 150;
        maxPrice = 220;
        recommendedRate = 180;
        explanation = 'Standard painter/decorator daily rate in the UK, excluding paint materials.';
        source = 'Offline UK Decorating Labour Index';
      } else if (descLower.includes('concrete') || descLower.includes('slab') || descLower.includes('ground')) {
        minPrice = 160;
        maxPrice = 240;
        recommendedRate = 200;
        explanation = 'Groundworker / general concrete contractor daily labour rate in the UK.';
        source = 'Offline Groundworks Labour Index';
      } else if (descLower.includes('carp') || descLower.includes('join') || descLower.includes('floor') || descLower.includes('sill') || descLower.includes('door')) {
        minPrice = 180;
        maxPrice = 280;
        recommendedRate = 220;
        explanation = 'Skilled carpenter / joiner daily rate in the UK, excluding timber materials.';
        source = 'Offline Joinery Labour Index';
      } else {
        minPrice = 150;
        maxPrice = 250;
        recommendedRate = 200;
        explanation = 'Average subcontractor daily labour rate in the UK construction market.';
        source = 'Offline Labour Cost Index';
      }
    } else if (descLower.includes('radiator') || descLower.includes('cover')) {
      minPrice = unitLower === 'm' || unitLower === 'lm' ? 70 : 80;
      maxPrice = unitLower === 'm' || unitLower === 'lm' ? 120 : 150;
      recommendedRate = unitLower === 'm' || unitLower === 'lm' ? 90 : 115;
      explanation = 'Supply and installation of MDF radiator casing / cover, priced against UK joinery benchmark rates.';
      source = 'Offline Joinery Benchmark';
    } else if (descLower.includes('floor') && (descLower.includes('sand') || descLower.includes('polish'))) {
      minPrice = unitLower === 'm2' || unitLower === 'sqm' ? 40 : 800;
      maxPrice = unitLower === 'm2' || unitLower === 'sqm' ? 75 : 1500;
      recommendedRate = unitLower === 'm2' || unitLower === 'sqm' ? 55 : 1100;
      explanation = 'Floor sanding and sealing / polishing including equipment hire, abrasives and finishing consumables.';
      source = 'Offline Flooring Benchmark';
    } else if (descLower.includes('paint') || descLower.includes('decorat') || descLower.includes('emulsion') || descLower.includes('ceiling')) {
      minPrice = unitLower === 'm2' || unitLower === 'sqm' ? 12 : 80;
      maxPrice = unitLower === 'm2' || unitLower === 'sqm' ? 18 : 120;
      recommendedRate = unitLower === 'm2' || unitLower === 'sqm' ? 14.5 : 90;
      explanation = 'Decoration allowance including standard preparation, labour and trade emulsion / finish coats.';
      source = 'Offline Decorating Benchmark';
    } else if (descLower.includes('concrete') || descLower.includes('slab')) {
      minPrice = unitLower === 'm3' || unitLower === 'cum' ? 90 : 30;
      maxPrice = unitLower === 'm3' || unitLower === 'cum' ? 130 : 50;
      recommendedRate = unitLower === 'm3' || unitLower === 'cum' ? 110 : 40;
      explanation = 'Concrete slab / C25 ready-mix allowance based on standard UK minor works pricing.';
      source = 'Offline Concrete Benchmark';
    }

    return {
      success: true,
      minPrice,
      maxPrice,
      recommendedRate,
      explanation,
      source
    };
  }

  function rateSplitForSavedBook(amount) {
    const descLower = originalDescText.toLowerCase();
    const unitLower = unitText.toLowerCase().trim();

    const labourLike =
      unitLower === 'hr' ||
      unitLower === 'hour' ||
      unitLower === 'hours' ||
      unitLower === 'day' ||
      unitLower === 'days' ||
      descLower.includes('labour') ||
      descLower.includes('labor') ||
      descLower.includes('install') ||
      descLower.includes('fit') ||
      descLower.includes('decorate') ||
      descLower.includes('paint') ||
      descLower.includes('skim') ||
      descLower.includes('plaster');

    if (labourLike) {
      return { materialRate: 0, labourRate: amount, plantRate: 0, subRate: 0 };
    }

    return { materialRate: amount, labourRate: 0, plantRate: 0, subRate: 0 };
  }

  let db;

  try {
    db = await getDbConnection();

    const savedRates = await db.all('SELECT * FROM rates WHERE user_id = ?', req.user.id);

    let savedMatch = savedRates.find(rate => {
      const rateNorm = normalizeDescription(rate.name || '', '');
      const rateUnit = String(rate.unit || '').toLowerCase().trim();
      return rateNorm && rateNorm === normDesc && (!rateUnit || !normUnit || rateUnit === normUnit);
    });

    if (!savedMatch) {
      savedMatch = savedRates.find(rate => {
        const rateNorm = normalizeDescription(rate.name || '', '');
        const rateUnit = String(rate.unit || '').toLowerCase().trim();

        if (!rateNorm || !normDesc) return false;
        if (rateUnit && normUnit && rateUnit !== normUnit) return false;

        return rateNorm.includes(normDesc) || normDesc.includes(rateNorm);
      });
    }

    const savedBenchmark = savedMatch ? responseFromSavedRate(savedMatch) : null;

    const aiPriceCache = global.aiPriceSuggestCache || (global.aiPriceSuggestCache = new Map());
    const aiPriceCacheKey = [normDesc, normUnit, qty, categoryText.toLowerCase()].join('|');
    const aiPriceCached = aiPriceCache.get(aiPriceCacheKey);
    if (aiPriceCached && Date.now() - aiPriceCached.savedAt < 30 * 24 * 60 * 60 * 1000) {
      await db.close();
      return res.json({
        ...aiPriceCached.data,
        cached: true,
        source: (aiPriceCached.data.source || 'QS AI Market Assessment') + ' - cached repeat result, held for 30 days unless description/unit/quantity/category changes'
      });
    }

    let data;

    const fastAssessment = buildFastQSAssessment();
    if (fastAssessment) {
      data = fastAssessment;
    } else {
      try {
      if (!ai) {
        throw new Error('Gemini API key is not configured.');
      }

      const prompt = [
        'You are a professional UK Senior Quantity Surveyor and construction pricing expert.',
        'Analyze this construction work item and estimate the current UK unit rate in GBP.',
        '',
        'Description: "' + descText + '"',
        'Unit of Measurement: "' + unitText + '"',
        'Quantity being priced: ' + qty,
        'Category: "' + categoryText + '"',
        '',
        'Ignore any saved or current user-entered price. Produce a fresh UK QS market assessment from the item description, unit and quantity only.',
        savedBenchmark ? 'Important: do not blindly reuse the saved price. Use it only as a benchmark. Check whether current UK market pricing and quantity change the correct unit rate.' : '',
        '',
        'Return a valid JSON object only with:',
        '{',
        '  "success": true,',
        '  "minPrice": number,',
        '  "maxPrice": number,',
        '  "recommendedRate": number,',
        '  "explanation": "short 2-3 sentence QS explanation",',
        '  "source": "pricing source description"',
        '}'
      ].join('\n');

      const response = await generateContentWithRetry({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      }, 1, 250);

      data = JSON.parse(response.text);

      if (!data || data.success !== true || !Number.isFinite(Number(data.recommendedRate))) {
        throw new Error('Invalid Gemini price response.');
      }

      data.minPrice = Number(data.minPrice) || Number(data.recommendedRate);
      data.maxPrice = Number(data.maxPrice) || Number(data.recommendedRate);
      data.recommendedRate = Number(data.recommendedRate);
      data.explanation = data.explanation || 'AI generated UK construction pricing estimate.';
      data.source = data.source || 'Gemini QS Pricing Estimate';

      if (savedBenchmark) {
        data.benchmarkRate = savedBenchmark.recommendedRate;
        data.benchmarkSource = savedBenchmark.source;
        data.source = data.source + '';
      }
    } catch (aiErr) {
      console.warn('[AI Price Suggest] Gemini failed or unavailable. Using local estimator...', aiErr.message);
      data = buildOfflinePrice();

      if (savedBenchmark && data.source !== 'QS EPC UPVC Windows & Doors Package Estimator') {
        const base = Number(savedBenchmark.recommendedRate) || Number(data.recommendedRate) || 0;
        let adjustmentFactor = 1;

        if (qty >= 10) adjustmentFactor = 0.9;
        else if (qty >= 5) adjustmentFactor = 0.95;
        else if (qty <= 1) adjustmentFactor = 1.05;

        const adjusted = Number((base * adjustmentFactor).toFixed(2));

        data.minPrice = Number((adjusted * 0.9).toFixed(2));
        data.maxPrice = Number((adjusted * 1.1).toFixed(2));
        data.recommendedRate = adjusted;
        data.benchmarkRate = base;
        data.benchmarkSource = savedBenchmark.source;
        data.explanation = 'Saved Price Book rate used as a benchmark, then adjusted for the current quantity of ' + qty + ' and current estimating context. ' + data.explanation;
        data.source = data.source + '';
      }
    }

    }

    const recommendedRate = Number(data.recommendedRate) || 0;
    data.recommendedRate = recommendedRate;
    data.minPrice = Number(data.minPrice) || recommendedRate;
    data.maxPrice = Number(data.maxPrice) || recommendedRate;

    if (savedBenchmark) {
      data.savedBenchmark = {
        rate: savedBenchmark.recommendedRate,
        source: savedBenchmark.source,
        name: savedBenchmark.matchedRateName || ''
      };
    }

    aiPriceCache.set(aiPriceCacheKey, { savedAt: Date.now(), data: { ...data } });

    await db.close();

    return res.json({
      ...data,
      source: (data.source || 'QS AI Market Assessment') + ' - not saved until you choose Save Changes'
    });
  } catch (err) {
    console.error('[AI Price Suggest] Route failed:', err);

    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch (_) {}
    }

    return res.status(500).json({
      success: false,
      error: err.message || 'AI price lookup failed'
    });
  }
});

function localQSChatFallback(message, contextPrompt) {
  const msg = (message || '').toLowerCase();
  let text = `### TrueCost QS - Offline Estimator Companion\n\n*Note: Your Gemini API Key is offline or has reached its quota limit. I am operating in high-fidelity offline mode to guide your project.* \n\n`;

  if (msg.includes('plaster') || msg.includes('skim') || msg.includes('board') || msg.includes('dryline')) {
    text += `#### Plastering & Finishes Guidance
- **Materials**: Standard 12.5mm plasterboard sheets are priced around **£8.50/sheet** (Travis Perkins/Selco). Thistle multi-finish plaster is **£8.20/25kg bag** (covers approx. 10m² at 2mm thickness).
- **Labour Daily Productivity**: 1 plasterer + 1 labourer can typically tackle **10m² to 15m² per day** of 2-coat skim, or **35m² to 50m² per day** of plasterboard boarding.
- **Estimated Rates**: Budget **£18.00 to £25.00 per m²** for supply, board, and skim works in standard rooms. Add **10% waste allowance** for cutting board partitions.`;
  } else if (msg.includes('timber') || msg.includes('joiner') || msg.includes('skirting') || msg.includes('door') || msg.includes('stud')) {
    text += `#### Joinery & Timber Works Guidance
- **Materials**: Standard treated CLS stud timber (38x89x2400mm) is approx. **£3.45/length** (Jewson/Travis). MDF Ogee skirting (120mm x 4.4m twice-primed) is **£14.20/length**. Standard trade internal pre-finished doors are **£45.00 to £90.00 each**.
- **Labour Daily Productivity**: A skilled carpenter can install **20m to 30m of skirting per day**, or hang **4 to 6 internal doors per day**.
- **Estimated Rates**: Timber stud partition walls: **£35.00 to £50.00 per m²** (including studs, rockwool insulation, and boarding). Architraves/skirtings: **£8.00 per linear meter**.`;
  } else if (msg.includes('concrete') || msg.includes('foundation') || msg.includes('ground') || msg.includes('excavate') || msg.includes('cement')) {
    text += `#### Groundworks & Foundations Guidance
- **Materials**: Volumetric ready-mix C25 concrete is approx. **£95.00 to £115.00 per m³** delivered. Rugby premium cement is **£6.50/25kg bag**.
- **Labour / Equipment**: Standard 1.5t mini excavator hire is **£120.00/day** (excluding operator). Groundworker daily rate is **£200.00/day**.
- **Estimated Rates**: Concrete strip foundation (excavate, backfill C25): **£180.00 to £240.00 per m³**. Skip hire (8-yard standard builder): **£280.00 to £350.00** per load.`;
  } else if (msg.includes('asbestos') || msg.includes('demolition') || msg.includes('downtaking')) {
    text += `#### Asbestos & Demolition safety regulations (UK CAR 2012)
- **Regulations**: Under **Control of Asbestos Regulations 2012**, all asbestos cement roofing, ridges, or tiling must be identified before demolition. 
- **Handling**: While chrysotile (white asbestos) cement sheets can be handled by trained, competent contractors under non-licensed work rules, it must be double-bagged, handled without breaking, and placed in a sealed hazardous-waste skip.
- **Costs**: Sealed hazardous skips range from **£280.00 to £450.00**. Expert non-licensed removal and disposal of roofing sheets budgets around **£45.00 to £65.00 per m²**.`;
  } else if (msg.includes('margin') || msg.includes('contingency') || msg.includes('markup') || msg.includes('uplift') || msg.includes('waste')) {
    text += `#### RICS-Compliant Markups & Cost Control
- **Residential Margin**: Standard contractor markups for residential extensions or refurbs range from **15% to 22.5%** depending on access and complexity.
- **Commercial Margin**: Larger commercial works usually target **5% to 10%** overhead and profit margins.
- **Waste Allowances**: Standard materials waste allowances are **10% for plasterboard/timber**, **5% for cement/aggregate bags**, and **2.5% for general items**.
- **Contingency**: Maintain a **5% to 7.5% contingency fund** for hidden refurbishment works (especially foundations and old brickwork strip-outs).`;
  } else if (msg.includes('rate') || msg.includes('cost') || msg.includes('price') || msg.includes('pay')) {
    text += `#### Standard Trade Rates & Labour Day Indexes
- **Plasterer / Carpenter / Bricklayer / Plumber**: Standard trade daily rates across the UK average **£200.00 to £250.00 per day** (£25.00 to £32.00/hr).
- **Electrician**: Averages **£250.00 to £300.00 per day** (£30.00 to £38.00/hr).
- **General Labourer**: Averages **£120.00 to £150.00 per day** (£15.00 to £18.50/hr).
- *Tip: You can manually override any specific labor days or trade daily rate directly inside the "Rate Build-up" tab in your Estimate Builder panel on the right side of the screen.*`;
  } else {
    text += `#### Quantity Surveying Cost Companion
How can I assist you with your estimating project today? Ask me about:
- **Materials Cost**: Plasterboard sheets, timber CLS studs, paint emulsions, copper pipes, concrete mixes.
- **Labour day rates & productivity indexes** for Plasterers, Carpenters, Groundworkers, and Electricians.
- **HSE Regulations & Demolition**: CAR 2012 asbestos rules, waste skip disposal guidelines.
- **RICS Overheads**: Margin, waste allowance percentage recommendations, contingency factors.

*Tip: Type key terms like "plaster", "timber", "margin", "asbestos", or "concrete" for targeted UK trade guidelines instantly!*`;
  }

  if (contextPrompt) {
    text += `\n\n---\n*Context from your active project:* I see you are currently reviewing an estimate. If you need standard cost guidelines, use the manual **Rate Build-up** override in your Estimate Builder on any selected works row.`;
  }

  return text;
}

// --- AI Chat Assistant API ---
app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, projectId } = req.body;
  let contextPrompt = '';

  try {
    if (projectId) {
      const db = await getDbConnection();

      // Verify project ownership
      const project = await db.get('SELECT * FROM projects WHERE id = ? AND user_id = ?', [projectId, req.user.id]);
      if (project) {
        const items = await db.all('SELECT * FROM estimate_items WHERE project_id = ?', projectId);
        contextPrompt = `
You are currently helping the user with an estimate for the project: "${project.name}" (Client: ${project.client}, Status: ${project.status}, Sell Price: £${project.sellPrice}, Margin: ${project.margin}%).
Project Details: Tender Ref: ${project.tenderRef}, Trade Category: ${project.tradeCategory}, Address: ${project.address}, Start Date: ${project.startDate}, Duration: ${project.duration}, Waste Factor: ${project.wasteAllowance}%, Contingency: ${project.contingency}%, Labour Uplift: ${project.labourUplift}%, Plant Overhead: ${project.plantOverhead}%.

Below is the list of work items in the Schedule of Rates for this project:
${items.map(item => `- [${item.section}] ${item.description}: Qty: ${item.quantity} ${item.unit}, Lab Rate: £${item.labourRate}, Mat Rate: £${item.materialRate}, Plant Rate: £${item.plantRate}, Sub Rate: £${item.subRate}, Sourced from: ${item.merchant || 'None'}, Confidence: ${item.confidence}, Notes: ${item.notes}`).join('\n')}
`;
      }
      await db.close();
    }
  } catch (dbErr) {
    console.warn('Failed to load chat project context:', dbErr);
  }

  try {
    if (!ai) {
      throw new Error('Gemini API key is not configured.');
    }

    const response = await generateContentWithRetry({
      model: 'gemini-2.5-flash',
      contents: message,
      config: {
        systemInstruction: `You are an expert UK Senior Quantity Surveyor and Cost Estimator assistant. Help the user with construction pricing, methodologies, risks, and regulations. Keep your answers very concise, professional, and actionable. ${contextPrompt}`
      }
    });
    res.json({ text: response.text });
  } catch (error) {
    console.warn('[Chat Engine] Gemini API chat failed. Falling back to local offline surveyor...', error.message);
    const fallbackText = localQSChatFallback(message, contextPrompt);
    res.json({ text: fallbackText });
  }
});

// --- Project Import API ---
app.post('/api/projects/import', requireAuth, async (req, res) => {
  const { projectName, items, roomMeasurements } = req.body;
  if (!projectName || !Array.isArray(items)) {
    return res.status(400).json({ error: 'projectName and items array are required.' });
  }

  try {
    const db = await getDbConnection();
    const projectId = crypto.randomUUID();
    const date = new Date().toISOString().split('T')[0];

    await db.run(
      `INSERT INTO projects (
        id, user_id, name, client, address, dateCreated, status, totalCost, sellPrice, margin,
        tenderRef, tradeCategory, startDate, duration, notes,
        wasteAllowance, contingency, labourUplift, plantOverhead
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId, req.user.id, projectName, 'AI Client', 'Unknown Site Address', date, 'Draft', 0, 0, req.user.margin || 20.0,
        'T-AI-TAKEOFF', 'General', date, '4 weeks', 'Extracted via automated AI take-off.',
        req.user.wasteAllowance || 10.0, req.user.contingency || 5.0, req.user.labourUplift || 0.0, req.user.plantOverhead || 5.0
      ]
    );

    // Save room measurements if provided
    if (roomMeasurements && typeof roomMeasurements === 'object') {
      const insertRoom = await db.prepare(
        `INSERT OR REPLACE INTO room_measurements (project_id, room, width, length, height)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const [room, dims] of Object.entries(roomMeasurements)) {
        await insertRoom.run(
          projectId,
          room.toLowerCase().trim(),
          parseFloat(dims.width) || 0,
          parseFloat(dims.length) || 0,
          parseFloat(dims.height) || 0
        );
      }
      await insertRoom.finalize();
    }

    const insertItem = await db.prepare(
      `INSERT INTO estimate_items (
        id, project_id, section, description, quantity, unit, labourRate, materialRate,
        plantRate, subRate, isAIIdentified, confidence, warnings, merchant, productUrl, assumptions, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const orderedImportItems = items.map((item, index) => ({ ...item, sortOrder: Number(item.sortOrder ?? item.sourceOrder ?? item.originalIndex ?? index) })).sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));

    for (const item of orderedImportItems) {
      const cat = item.category ? item.category.trim() : '';
      const desc = item.description ? item.description.trim() : '';
      let combined = desc;
      if (cat) {
        if (desc.startsWith(cat)) {
          combined = desc;
        } else {
          combined = `${cat}: ${desc}`;
        }
      }

      // Keep Room/Area separate from the Description.
      // The pricing table and PDF already display section/room separately, so
      // prefixing the description with the room makes imports harder to review
      // and can cause room names to be inferred from the work type.

      await insertItem.run(
        crypto.randomUUID(),
        projectId,
        item.section || 'General',
        combined || 'Unknown Item',
        item.quantity || 1,
        item.unit || 'Item',
        item.labourRate || 0,
        item.materialRate || 0,
        item.plantRate || 0,
        item.subRate || 0,
        1,
        item.confidence || 'Medium',
        item.warnings ? (typeof item.warnings === 'string' ? item.warnings : JSON.stringify(item.warnings)) : '[]',
        item.merchant || '',
        item.productUrl || '',
        item.assumptions || 'Identified from uploaded document',
        item.notes || ''
      );
    }
    await insertItem.finalize();

    // Dynamic recalculation
    await recalculateProjectCost(db, projectId);

    await db.close();

    res.json({ success: true, projectId, itemsCount: items.length });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});


// --- Large Document Chunk Upload + Safe Excel Analysis ---
const LARGE_UPLOAD_ROOT = path.join(__dirname, 'uploads-large');
const LARGE_UPLOAD_TMP = path.join(LARGE_UPLOAD_ROOT, 'tmp');
const LARGE_EXCEL_SHEET_ROW_LIMIT = 3000;
const LARGE_EXCEL_MAX_ITEMS = 10000;

try {
  fs.mkdirSync(LARGE_UPLOAD_ROOT, { recursive: true });
  fs.mkdirSync(LARGE_UPLOAD_TMP, { recursive: true });
} catch (e) {
  console.warn('[Large Upload] Failed to initialise upload folders:', e.message);
}

const largeChunkUpload = multer({ dest: LARGE_UPLOAD_TMP });

function safeUploadId(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);
}

function safeFileName(value) {
  const base = path.basename(String(value || 'uploaded-file.xlsx'));
  return base.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180);
}

function isExcelFileNameOrMime(fileName, mimeType) {
  const lowerName = String(fileName || '').toLowerCase();
  const lowerMime = String(mimeType || '').toLowerCase();

  return (
    lowerName.endsWith('.xlsx') ||
    lowerName.endsWith('.xls') ||
    lowerName.endsWith('.csv') ||
    lowerMime.includes('spreadsheet') ||
    lowerMime.includes('excel') ||
    lowerMime.includes('csv')
  );
}

function largeCellText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r?\n/g, ' ').trim();
}

function largeNormaliseHeader(value) {
  return largeCellText(value)
    .toLowerCase()
    .replace(/[\s\-_]+/g, ' ')
    .replace(/[^a-z0-9 /]/g, '')
    .trim();
}

function largeIsBlankOrHeaderText(value) {
  const text = largeCellText(value);
  const lower = largeNormaliseHeader(text);
  return !text ||
    lower === 'further information' ||
    lower === 'description' ||
    lower === 'details' ||
    lower === 'scope' ||
    lower === 'notes' ||
    lower === 'note' ||
    lower === 'requirement' ||
    lower === 'work description';
}

function largeLooksLikeRoomName(value) {
  const text = largeCellText(value);
  if (!text) return false;

  const lower = text.toLowerCase();

  if (text.length < 2 || text.length > 55) return false;
  if (lower === 'yes' || lower === 'no' || lower === 'required yes or no') return false;
  if (lower === 'room' || lower === 'type' || lower === 'further information') return false;

  const blocked = [
    'address', 'cost', 'duration', 'capital expenditure', 'compliance',
    'allow for', 'breakdown', 'break down', 'works shall', 'shall include',
    'description', 'further information', 'required', 'cost per', 'please select',
    'gbp ', '£'
  ];

  return !blocked.some(word => lower.includes(word));
}

function largeHasUsefulFurtherInformation(value) {
  const text = largeCellText(value);
  if (largeIsBlankOrHeaderText(text)) return false;
  if (text.length < 5) return false;

  const lower = text.toLowerCase();
  if (lower === 'yes' || lower === 'no' || lower === 'n/a' || lower === 'na') return false;
  if (lower.includes('please select')) return false;

  return true;
}

function largeBuildStructuredDescription(typeValue, furtherInfoValue) {
  const type = largeCellText(typeValue);
  const further = largeCellText(furtherInfoValue);
  if (!type) return further;
  if (!further) return '';

  const lowerFurther = further.toLowerCase();
  const lowerType = type.toLowerCase();
  if (lowerFurther.startsWith(lowerType)) return further;

  return `${type}: ${further}`;
}

function largeFindChecklistColumns(rows) {
  let headerRowIdx = -1;
  let roomColIdx = 0;
  let typeColIdx = 1;
  let statusColIdx = -1;
  let descColIdx = -1;

  for (let r = 0; r < Math.min(rows.length, 80); r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;

    const headers = row.map(largeNormaliseHeader);
    const roomIdx = headers.findIndex(h => h === 'room' || h === 'area' || h === 'location');
    const typeIdx = headers.findIndex(h => h === 'type' || h === 'trade' || h === 'item');
    const requiredIdx = headers.findIndex(h => h.includes('required') || h === 'yes or no' || h === 'required yes or no');
    const furtherInfoIdx = headers.findIndex(h => h.includes('further information'));
    const detailIdx = headers.findIndex(h => h === 'details' || h === 'scope' || h.includes('description'));
    const furtherIdx = furtherInfoIdx !== -1 ? furtherInfoIdx : (requiredIdx !== -1 ? detailIdx : -1);

    // Do not classify a normal BOQ/SOR table as a checklist just because it has
    // an Item + Description header. The structured scoping template must have
    // a Further Information header or a Required Yes/No column.
    if (furtherIdx !== -1 && (furtherInfoIdx !== -1 || requiredIdx !== -1) && (roomIdx !== -1 || typeIdx !== -1 || requiredIdx !== -1)) {
      headerRowIdx = r;
      if (roomIdx !== -1) roomColIdx = roomIdx;
      if (typeIdx !== -1) typeColIdx = typeIdx;
      if (requiredIdx !== -1) statusColIdx = requiredIdx;
      descColIdx = furtherIdx;
      break;
    }
  }

  if (descColIdx === -1) {
    const colVotes = Array.from({ length: 30 }, () => ({ yes: 0, no: 0, textVotes: 0 }));

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;

      for (let c = 0; c < Math.min(row.length, 30); c++) {
        const str = largeCellText(row[c]).toLowerCase();
        if (str === 'yes' || str === 'y' || str === 'true') {
          colVotes[c].yes++;
          colVotes[c].textVotes++;
        } else if (str === '1') {
          colVotes[c].yes++;
        }
        if (str === 'no' || str === 'n' || str === 'false') {
          colVotes[c].no++;
          colVotes[c].textVotes++;
        } else if (str === '0') {
          colVotes[c].no++;
        }
      }
    }

    for (let c = 0; c < colVotes.length; c++) {
      if (colVotes[c].yes + colVotes[c].no >= 2 && colVotes[c].textVotes >= 1) {
        statusColIdx = c;
        roomColIdx = 0;
        typeColIdx = Math.max(0, c - 1);
        descColIdx = c + 1;
        break;
      }
    }
  }

  if (descColIdx === -1) return null;

  return { headerRowIdx, roomColIdx, typeColIdx, statusColIdx, descColIdx };
}

function largeNumberFromCell(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const text = String(value)
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '')
    .trim();

  if (!text) return null;

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function largeGuessUnit(description, explicitUnit) {
  const unit = largeCellText(explicitUnit);
  if (unit) return unit;

  const desc = String(description || '').toLowerCase();

  if (/\bm2\b|\bm²\b|\bsqm\b|\bsq\.?\s*m\b/.test(desc)) return 'm2';
  if (/\bm3\b|\bm³\b|\bcu\.?\s*m\b/.test(desc)) return 'm3';
  if (/\blm\b|\bl\/m\b|\blinear\b|\bmetre\b|\bm\b/.test(desc)) return 'm';
  if (/\bno\b|\bnr\b|\beach\b/.test(desc)) return 'Nr';
  if (/\bsum\b|\bls\b|\blump\b/.test(desc)) return 'Item';

  return 'Item';
}

function largeLooksLikeSectionRow(row) {
  if (!Array.isArray(row)) return false;

  const cells = row
    .map(largeCellText)
    .filter(Boolean);

  if (cells.length !== 1) return false;

  const value = cells[0];
  const lower = value.toLowerCase();

  if (value.length < 3 || value.length > 60) return false;
  if (lower.includes('total')) return false;
  if (lower.includes('description')) return false;
  if (lower.includes('quantity')) return false;
  if (lower.includes('rate')) return false;
  if (lower.includes('amount')) return false;

  return true;
}

function largeSkipSheet(sheetName) {
  const lower = String(sheetName || '').toLowerCase().trim();

  return (
    lower.includes('collection') ||
    lower.includes('summary') ||
    lower.includes('total') ||
    lower.includes('index') ||
    lower.includes('instruction') ||
    lower.includes('prelim cover') ||
    lower.includes('contents') ||
    lower.includes('list look up') ||
    lower.includes('lookup') ||
    lower.includes('general specification') ||
    lower === 'specification' ||
    lower.includes('compliance') ||
    lower.includes('cost breakdown') ||
    lower === 'sheet1'
  );
}

function pushLargeParsedItem(items, rawSection, rawDescription, rawQuantity, rawUnit, selected = true, options = {}) {
  const description = largeCellText(rawDescription);
  if (description.length < 5) return;

  const descLower = description.toLowerCase();

  if (descLower.includes('description of works')) return;
  if (descLower.includes('description of work')) return;
  if (descLower === 'description') return;
  if (descLower === 'total') return;
  if (descLower.includes('grand total')) return;
  if (descLower.includes('subtotal')) return;

  if (!options.allowInformationalItems && typeof isInformationalOnly === 'function' && isInformationalOnly(descLower)) {
    return;
  }

  const rawRoom = largeCellText(rawSection) || 'General';
  const preserveRoom = !!options.preserveRoom;
  const roomResult = (!preserveRoom && typeof extractRoomFromDescription === 'function')
    ? extractRoomFromDescription(description, rawRoom)
    : { room: rawRoom, description };

  let quantity = largeNumberFromCell(rawQuantity);

  if (!quantity || quantity <= 0) {
    const inlineQty = description.match(/(\d+(?:\.\d+)?)\s*(m2|m²|m3|m³|lm|m|nr|no|item|sum)\b/i);
    quantity = inlineQty ? Number(inlineQty[1]) : 1;
  }

  const unit = largeGuessUnit(description, rawUnit);
  const sourceOrder = Number.isFinite(Number(options.sourceOrder)) ? Number(options.sourceOrder) : items.length;

  const key = `${roomResult.room}|${roomResult.description}|${quantity}|${unit}|${sourceOrder}`.toLowerCase();
  if (items.some(item => item._largeKey === key)) return;

  items.push({
    _largeKey: key,
    section: roomResult.room || rawRoom,
    category: largeCellText(options.category),
    description: roomResult.description || description,
    quantity,
    unit,
    labourRate: largeNumberFromCell(options.labourRate) || 0,
    materialRate: largeNumberFromCell(options.materialRate) || 0,
    plantRate: largeNumberFromCell(options.plantRate) || 0,
    subRate: largeNumberFromCell(options.subRate) || 0,
    status: selected ? 'Yes' : 'No',
    selected: !!selected,
    sourceOrder,
    sortOrder: sourceOrder,
    originalIndex: sourceOrder,
    sourceSheet: options.sourceSheet || '',
    sourceRow: options.sourceRow || null
  });
}

function parseLargeExcelWorkbook(filePath, originalName) {
  console.log(`[Large Excel Parser] Reading large workbook safely: ${originalName}`);

  const workbook = XLSX.readFile(filePath, {
    sheetRows: LARGE_EXCEL_SHEET_ROW_LIMIT,
    cellDates: false,
    cellNF: false,
    cellStyles: false
  });

  const items = [];

  workbook.SheetNames.forEach((sheetName) => {
    if (items.length >= LARGE_EXCEL_MAX_ITEMS) return;
    if (largeSkipSheet(sheetName)) {
      console.log(`[Large Excel Parser] Skipping sheet: ${sheetName}`);
      return;
    }

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;

    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: ''
    });

    if (!rows || rows.length === 0) return;

    console.log(`[Large Excel Parser] Sheet "${sheetName}" loaded with ${rows.length} sampled rows.`);

    const checklistColumns = largeFindChecklistColumns(rows);
    let currentSection = sheetName || 'General';

    if (checklistColumns) {
      const { roomColIdx, typeColIdx, descColIdx, headerRowIdx } = checklistColumns;

      console.log(`[Large Excel Parser] Structured checklist detected: "${sheetName}". roomColIdx=${roomColIdx}, typeColIdx=${typeColIdx}, descColIdx=${descColIdx}`);

      for (let r = 0; r < rows.length; r++) {
        if (items.length >= LARGE_EXCEL_MAX_ITEMS) break;

        const row = rows[r];
        if (!Array.isArray(row) || row.length === 0) continue;
        if (headerRowIdx !== -1 && r <= headerRowIdx) continue;

        // Do not update currentSection from one-cell headings in structured sheets.
        // The merged/fill-down Room column is the authoritative section/room.

        const possibleRoom = largeCellText(row[roomColIdx]);
        if (largeLooksLikeRoomName(possibleRoom)) {
          currentSection = possibleRoom;
        }

        const furtherInfo = largeCellText(row[descColIdx]);
        if (!largeHasUsefulFurtherInformation(furtherInfo)) {
          continue;
        }

        const category = largeCellText(row[typeColIdx]);
        const description = largeBuildStructuredDescription(category, furtherInfo);

        pushLargeParsedItem(items, currentSection, description, 1, 'Item', true, {
          preserveRoom: true,
          category,
          sourceOrder: r + (workbook.SheetNames.indexOf(sheetName) * 100000),
          sourceSheet: sheetName,
          sourceRow: r + 1
        });
      }

      return;
    }

    let itemIdx = -1;
    let descIdx = -1;
    let unitIdx = -1;
    let qtyIdx = -1;
    let rateIdx = -1;
    let amountIdx = -1;
    let headerRowIdx = -1;

    for (let r = 0; r < Math.min(rows.length, 40); r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;

      for (let c = 0; c < Math.min(row.length, 40); c++) {
        const str = largeCellText(row[c]).toLowerCase();

        if (str === 'item' || str === 'ref' || str === 'code') itemIdx = c;
        if (str.includes('description') || str === 'details') {
          descIdx = c;
          headerRowIdx = r;
        } else if (str.includes('work') && descIdx === -1 && !str.includes('total') && !str.includes('element') && !str.includes('amount')) {
          descIdx = c;
          headerRowIdx = r;
        }
        if (str === 'unit' || str === 'uom') unitIdx = c;
        if (str === 'qty' || str.includes('quantity')) qtyIdx = c;
        if (str.includes('rate') || str.includes('unit cost') || str.includes('price per unit') || str.includes('unit price')) rateIdx = c;
        if (str === 'amount' || str === 'total') amountIdx = c;
      }

      if (descIdx !== -1) break;
    }

    if (descIdx === -1) {
      for (let c = 0; c < 12; c++) {
        let score = 0;
        for (let r = 0; r < Math.min(rows.length, 80); r++) {
          const value = largeCellText(rows[r]?.[c]);
          if (value.length > 20) score++;
        }
        if (score >= 3) {
          descIdx = c;
          break;
        }
      }
    }

    if (descIdx === -1) descIdx = 1;

    const startRow = headerRowIdx !== -1 ? headerRowIdx + 1 : 0;

    for (let r = startRow; r < rows.length; r++) {
      if (items.length >= LARGE_EXCEL_MAX_ITEMS) break;

      const row = rows[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      if (largeLooksLikeSectionRow(row)) {
        currentSection = largeCellText(row.find(Boolean));
        continue;
      }

      const description = largeCellText(row[descIdx]);
      if (!description || description.length < 5) continue;

      const itemCode = itemIdx !== -1 ? largeCellText(row[itemIdx]) : '';
      const unit = unitIdx !== -1 ? largeCellText(row[unitIdx]) : '';
      const quantity = qtyIdx !== -1 ? row[qtyIdx] : '';
      const rate = rateIdx !== -1 ? row[rateIdx] : '';
      const amount = amountIdx !== -1 ? row[amountIdx] : '';

      const hasQty = largeNumberFromCell(quantity) !== null;
      const hasUnit = !!unit;
      const hasRate = largeNumberFromCell(rate) !== null;
      const hasAmount = largeNumberFromCell(amount) !== null;
      const hasItemCode = !!itemCode;
      const hasInlineQty = /(\d+(?:\.\d+)?)\s*(no\.?|nr|m2|m²|m3|m³|lm|m\b|item|sum)/i.test(description);

      if (!hasQty && !hasUnit && !hasRate && !hasAmount && !hasItemCode && !hasInlineQty && description.length < 40) {
        continue;
      }

      pushLargeParsedItem(items, currentSection, description, quantity, unit, true, {
        category: itemCode,
        materialRate: rate,
        sourceOrder: r + (workbook.SheetNames.indexOf(sheetName) * 100000),
        sourceSheet: sheetName,
        sourceRow: r + 1,
        allowInformationalItems: hasItemCode
      });
    }
  });

  const cleanedItems = items
    .map(({ _largeKey, ...item }, index) => ({
      ...item,
      sourceOrder: Number.isFinite(Number(item.sourceOrder ?? item.sortOrder ?? item.originalIndex)) ? Number(item.sourceOrder ?? item.sortOrder ?? item.originalIndex) : index,
      sortOrder: Number.isFinite(Number(item.sortOrder ?? item.sourceOrder ?? item.originalIndex)) ? Number(item.sortOrder ?? item.sourceOrder ?? item.originalIndex) : index,
      originalIndex: Number.isFinite(Number(item.originalIndex ?? item.sourceOrder ?? item.sortOrder)) ? Number(item.originalIndex ?? item.sourceOrder ?? item.sortOrder) : index
    }))
    .sort((a, b) => Number(a.sourceOrder) - Number(b.sourceOrder));

  console.log(`[Large Excel Parser] Extracted ${cleanedItems.length} items from ${originalName}.`);

  return cleanedItems;
}

app.post('/api/upload-document-chunk', requireAuth, largeChunkUpload.single('chunk'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No chunk uploaded.' });
    }

    const uploadId = safeUploadId(req.body.uploadId);
    const chunkIndex = Number(req.body.chunkIndex);
    const totalChunks = Number(req.body.totalChunks);

    if (!uploadId || !Number.isInteger(chunkIndex) || chunkIndex < 0 || !Number.isInteger(totalChunks) || totalChunks < 1) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: 'Invalid chunk metadata.' });
    }

    const uploadDir = path.join(LARGE_UPLOAD_ROOT, uploadId);
    fs.mkdirSync(uploadDir, { recursive: true });

    const targetPath = path.join(uploadDir, `${chunkIndex}.part`);
    fs.renameSync(req.file.path, targetPath);

    return res.json({
      success: true,
      uploadId,
      chunkIndex,
      totalChunks
    });
  } catch (error) {
    console.error('[Large Upload] Chunk upload failed:', error);
    try {
      if (req.file?.path) fs.unlinkSync(req.file.path);
    } catch (e) {}
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze-document-large', requireAuth, async (req, res) => {
  const uploadId = safeUploadId(req.body?.uploadId);
  const originalName = safeFileName(req.body?.fileName);
  const mimeType = req.body?.fileType || 'application/octet-stream';
  const totalChunks = Number(req.body?.totalChunks);

  let rebuiltPath = null;
  let uploadDir = null;

  try {
    if (!uploadId || !Number.isInteger(totalChunks) || totalChunks < 1) {
      return res.status(400).json({ error: 'Invalid large upload metadata.' });
    }

    if (!isExcelFileNameOrMime(originalName, mimeType)) {
      return res.status(400).json({
        error: 'Large-file route currently supports Excel/CSV files. Use the normal analyser for smaller PDFs.'
      });
    }

    uploadDir = path.join(LARGE_UPLOAD_ROOT, uploadId);

    if (!fs.existsSync(uploadDir)) {
      return res.status(400).json({ error: 'Large upload chunks not found.' });
    }

    rebuiltPath = path.join(LARGE_UPLOAD_ROOT, `${uploadId}-${originalName}`);

    if (fs.existsSync(rebuiltPath)) {
      fs.unlinkSync(rebuiltPath);
    }

    fs.writeFileSync(rebuiltPath, Buffer.alloc(0));

    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(uploadDir, `${i}.part`);

      if (!fs.existsSync(chunkPath)) {
        throw new Error(`Missing upload chunk ${i + 1} of ${totalChunks}.`);
      }

      fs.appendFileSync(rebuiltPath, fs.readFileSync(chunkPath));
    }

    console.log(`[Large Upload] Rebuilt file ${originalName} from ${totalChunks} chunks.`);

    const extractedItems = parseLargeExcelWorkbook(rebuiltPath, originalName);

    return res.json({
      success: true,
      filename: originalName,
      largeFile: true,
      items: extractedItems
    });
  } catch (error) {
    console.error('[Large Upload] Analysis failed:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    try {
      if (rebuiltPath && fs.existsSync(rebuiltPath)) fs.unlinkSync(rebuiltPath);
    } catch (e) {}

    try {
      if (uploadDir && fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
    } catch (e) {}
  }
});

function largeWorkbookHasStructuredFurtherInfoSheet(filePath) {
  try {
    const workbook = XLSX.readFile(filePath, {
      sheetRows: LARGE_EXCEL_SHEET_ROW_LIMIT,
      cellDates: false,
      cellNF: false,
      cellStyles: false
    });

    for (const sheetName of workbook.SheetNames) {
      if (largeSkipSheet(sheetName)) continue;
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: ''
      });

      const columns = largeFindChecklistColumns(rows);
      if (columns && columns.descColIdx !== -1) {
        return true;
      }
    }
  } catch (err) {
    console.warn('[Structured SOR Parser] Detection failed:', err.message);
  }

  return false;
}

function largeWorkbookLooksLikeBoq(filePath) {
  try {
    const workbook = XLSX.readFile(filePath, {
      sheetRows: 250,
      cellDates: false,
      cellNF: false,
      cellStyles: false
    });

    let billSheetCount = 0;
    let codedItemCount = 0;

    for (const sheetName of workbook.SheetNames) {
      const lowerSheet = String(sheetName || '').toLowerCase();
      if (lowerSheet.includes('collection') || lowerSheet.includes('summary') || lowerSheet.includes('total')) {
        continue;
      }

      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: ''
      });

      let headerRowIdx = -1;
      let itemIdx = -1;
      let descIdx = -1;
      let unitIdx = -1;
      let qtyIdx = -1;
      let rateIdx = -1;
      let amountIdx = -1;

      for (let r = 0; r < Math.min(rows.length, 60); r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;

        const headers = row.map(largeNormaliseHeader);
        const possibleItemIdx = headers.findIndex(h => h === 'item' || h === 'ref' || h === 'code');
        const possibleDescIdx = headers.findIndex(h => h.includes('description') || h.includes('work') || h === 'details');
        const possibleUnitIdx = headers.findIndex(h => h === 'unit' || h === 'uom');
        const possibleQtyIdx = headers.findIndex(h => h === 'qty' || h.includes('quantity'));
        const possibleRateIdx = headers.findIndex(h => h === 'rate' || h.includes('unit cost'));
        const possibleAmountIdx = headers.findIndex(h => h === 'amount' || h === 'total');

        if (possibleDescIdx !== -1 && (possibleItemIdx !== -1 || possibleUnitIdx !== -1 || possibleQtyIdx !== -1 || possibleRateIdx !== -1 || possibleAmountIdx !== -1)) {
          headerRowIdx = r;
          itemIdx = possibleItemIdx !== -1 ? possibleItemIdx : 0;
          descIdx = possibleDescIdx;
          unitIdx = possibleUnitIdx;
          qtyIdx = possibleQtyIdx;
          rateIdx = possibleRateIdx;
          amountIdx = possibleAmountIdx;
          break;
        }
      }

      if (headerRowIdx === -1 || descIdx === -1) continue;

      let sheetItemCount = 0;
      for (let r = headerRowIdx + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;

        const itemCode = itemIdx !== -1 ? largeCellText(row[itemIdx]) : '';
        const description = largeCellText(row[descIdx]);
        const unit = unitIdx !== -1 ? largeCellText(row[unitIdx]) : '';
        const qty = qtyIdx !== -1 ? row[qtyIdx] : '';
        const rate = rateIdx !== -1 ? row[rateIdx] : '';
        const amount = amountIdx !== -1 ? row[amountIdx] : '';

        const hasCodedItem = /^[A-Z]?\d+(?:\.\d+)*[A-Z]?$/i.test(itemCode);
        const hasCommercialColumns = !!unit || largeNumberFromCell(qty) !== null || largeNumberFromCell(rate) !== null || largeNumberFromCell(amount) !== null;

        if (description.length >= 12 && (hasCodedItem || hasCommercialColumns)) {
          sheetItemCount++;
        }
      }

      if (sheetItemCount >= 2 || (lowerSheet.includes('bill') && sheetItemCount >= 1)) {
        billSheetCount++;
        codedItemCount += sheetItemCount;
      }
    }

    return billSheetCount >= 1 && codedItemCount >= 2;
  } catch (err) {
    console.warn('[BOQ Parser] Detection failed:', err.message);
    return false;
  }
}

// --- Document Analysis API ---
app.post('/api/analyze-document', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  try {
    const parserVersion = req.body.parserVersion || 'legacy';
    console.log(`[Document Analyzer] Requested parser version: ${parserVersion}`);

    const isExcelUpload = req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      req.file.mimetype === 'application/vnd.ms-excel' ||
      req.file.mimetype === 'text/csv' ||
      req.file.originalname.toLowerCase().endsWith('.xlsx') ||
      req.file.originalname.toLowerCase().endsWith('.xls') ||
      req.file.originalname.toLowerCase().endsWith('.csv');

    // Structured SOR/specification/BOQ workbooks must be parsed deterministically.
    // Do this before the AI/strategy registry so Excel BOQs still import when Gemini
    // is unavailable, rate limited, or not suited to this workbook layout.
    if (isExcelUpload && (largeWorkbookHasStructuredFurtherInfoSheet(req.file.path) || largeWorkbookLooksLikeBoq(req.file.path))) {
      console.log('[Document Analyzer] Structured Excel workbook detected. Using deterministic SOR/BOQ parser.');
      const extractedItems = parseLargeExcelWorkbook(req.file.path, req.file.originalname)
        .map((item, index) => ({
          ...item,
          sourceOrder: Number.isFinite(Number(item.sourceOrder ?? item.sortOrder ?? item.originalIndex)) ? Number(item.sourceOrder ?? item.sortOrder ?? item.originalIndex) : index,
          sortOrder: Number.isFinite(Number(item.sortOrder ?? item.sourceOrder ?? item.originalIndex)) ? Number(item.sortOrder ?? item.sourceOrder ?? item.originalIndex) : index,
          originalIndex: Number.isFinite(Number(item.originalIndex ?? item.sourceOrder ?? item.sortOrder)) ? Number(item.originalIndex ?? item.sourceOrder ?? item.sortOrder) : index,
          status: 'Yes',
          selected: true
        }))
        .sort((a, b) => Number(a.sourceOrder) - Number(b.sourceOrder));

      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.json({ success: true, filename: req.file.originalname, items: extractedItems });
    }

    if (!isExcelUpload && !ai) {
      return res.status(500).json({ error: 'Gemini API key is not configured.' });
    }

    let selectedStrategy = null;
    if (parserVersion === 'auto') {
      const isExcel = isExcelUpload;

      let workbook = null;
      if (isExcel) {
        try { workbook = XLSX.readFile(req.file.path); } catch (e) {}
      }

      for (const [id, strategy] of Object.entries(parserRegistry)) {
        if (typeof strategy.detect === 'function') {
          try {
            if (strategy.detect(req.file, workbook)) {
              selectedStrategy = strategy;
              console.log(`[Document Analyzer] Auto-detected parser strategy: ${id} (${strategy.name})`);
              break;
            }
          } catch (e) {
            console.warn(`[Document Analyzer] Detection failed for strategy ${id}:`, e);
          }
        }
      }
    } else if (parserRegistry[parserVersion]) {
      selectedStrategy = parserRegistry[parserVersion];
    }

    if (selectedStrategy) {
      console.log(`[Document Analyzer] Running strategy parser: ${selectedStrategy.name}...`);
      const items = await selectedStrategy.parse(req.file.path, req.file.mimetype, req.file.originalname);
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.json({ success: true, filename: req.file.originalname, items });
    }

    const isExcel = req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      req.file.mimetype === 'application/vnd.ms-excel' ||
      req.file.mimetype === 'text/csv' ||
      req.file.originalname.toLowerCase().endsWith('.xlsx') ||
      req.file.originalname.toLowerCase().endsWith('.xls') ||
      req.file.originalname.toLowerCase().endsWith('.csv');

    let extractedItems = [];

    if (isExcel) {
      console.log(`Parsing Excel file ${req.file.originalname} locally...`);
      const workbook = XLSX.readFile(req.file.path);
      let excelText = '';
      let originalTotalRows = 0;
      let cleanedTotalRows = 0;

      workbook.SheetNames.forEach(name => {
        if (largeSkipSheet(name)) {
          console.log(`[Excel Analyzer] Skipping sheet: ${name}`);
          return;
        }

        const sheet = workbook.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        originalTotalRows += rows.length;

        let itemIdx = -1, descIdx = -1, unitIdx = -1, qtyIdx = -1, rateIdx = -1;
        let headerRowIdx = -1;

        const checklistColumns = largeFindChecklistColumns(rows);

        let cleanedLines = [];
        let currentSection = name || 'General';

        if (checklistColumns) {
          const { roomColIdx, typeColIdx, descColIdx, headerRowIdx } = checklistColumns;

          console.log(`[Excel Pre-filter] Structured SOR/scope sheet detected: "${name}". roomColIdx=${roomColIdx}, typeColIdx=${typeColIdx}, descColIdx=${descColIdx}`);

          for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            if (!row || !Array.isArray(row) || row.length === 0) continue;
            if (headerRowIdx !== -1 && r <= headerRowIdx) continue;

            // Do not update currentSection from one-cell headings in structured sheets.
            // The merged/fill-down Room column is the authoritative section/room.

            const possibleRoom = largeCellText(row[roomColIdx]);
            if (largeLooksLikeRoomName(possibleRoom)) {
              currentSection = possibleRoom;
            }

            const furtherInfo = largeCellText(row[descColIdx]);
            if (!largeHasUsefulFurtherInformation(furtherInfo)) {
              continue;
            }

            const workType = largeCellText(row[typeColIdx]);
            const fullDescription = largeBuildStructuredDescription(workType, furtherInfo);

            if (isInformationalOnly(fullDescription.toLowerCase())) {
              continue;
            }

            const sourceOrder = r + (workbook.SheetNames.indexOf(name) * 100000);
            extractedItems.push({
              section: currentSection || 'General',
              category: workType,
              description: fullDescription,
              status: 'Yes',
              selected: true,
              quantity: 1,
              unit: 'Item',
              sourceOrder,
              sortOrder: sourceOrder,
              originalIndex: sourceOrder,
              sourceSheet: name,
              sourceRow: r + 1
            });
          }
        } else {
          // Dynamic header search up to 15 rows
          for (let r = 0; r < Math.min(rows.length, 15); r++) {
            const row = rows[r];
            if (!row || !Array.isArray(row)) continue;
            let foundDesc = false;
            row.forEach((cell, idx) => {
              if (!cell) return;
              const str = String(cell).toLowerCase().trim();
              if (str === 'item' || str === 'ref' || str === 'code') itemIdx = idx;
              if (str.includes('description') || str === 'details') {
                descIdx = idx;
                foundDesc = true;
              } else if (str.includes('work') && !foundDesc && !str.includes('total') && !str.includes('element') && !str.includes('amount')) {
                descIdx = idx;
                foundDesc = true;
              }
              if (str === 'unit') unitIdx = idx;
              if (str === 'qty' || str.includes('quantity')) qtyIdx = idx;
              if (str.includes('rate') || str.includes('unit cost') || str.includes('price per unit') || str.includes('unit price')) rateIdx = idx;
            });
            if (foundDesc) {
              headerRowIdx = r;
              break;
            }
          }

          // Assign robust defaults if not found
          if (descIdx === -1) descIdx = 1;
          if (unitIdx === -1) unitIdx = [2, 1, 3, 4].find(i => i !== descIdx && i !== itemIdx) || 2;
          if (qtyIdx === -1) qtyIdx = [3, 2, 4, 1].find(i => i !== descIdx && i !== itemIdx && i !== unitIdx) || 3;
          if (rateIdx === -1) rateIdx = [4, 3, 2, 1].find(i => i !== descIdx && i !== itemIdx && i !== unitIdx && i !== qtyIdx) || 4;

          const startRowIdx = headerRowIdx !== -1 ? headerRowIdx + 1 : 0;
          if (headerRowIdx !== -1) {
            cleanedLines.push(rows[headerRowIdx].join(','));
          }

          for (let r = startRowIdx; r < rows.length; r++) {
            const row = rows[r];
            if (!row || !Array.isArray(row) || row.length === 0) continue;

            const descCell = row[descIdx];
            if (!descCell) continue;
            const description = String(descCell).trim();
            if (description.length < 5) continue;

            const descLower = description.toLowerCase();
            // Skip header and totals lines
            if (descLower.includes('description of works') || descLower.includes('description of work') || descLower.includes('item description')) {
              continue;
            }
            if (descLower.includes('total') || descLower.includes('collection') || descLower === 'downtakings' || descLower === 'electrical;') {
              continue;
            }

            // Row quality check
            const hasQty = row[qtyIdx] !== undefined && row[qtyIdx] !== null && String(row[qtyIdx]).trim() !== '';
            const hasUnit = row[unitIdx] !== undefined && row[unitIdx] !== null && String(row[unitIdx]).trim() !== '';
            const hasRate = row[rateIdx] !== undefined && row[rateIdx] !== null && String(row[rateIdx]).trim() !== '';
            const hasItemCode = itemIdx !== -1 && itemIdx !== undefined && row[itemIdx] !== undefined && row[itemIdx] !== null && String(row[itemIdx]).trim() !== '';
            const hasInlineQty = /(\d+)\s*(no\.?|m2|m3|m\b)/i.test(description);

            if (!hasQty && !hasUnit && !hasRate && !hasItemCode && !hasInlineQty) {
              continue;
            }

            const itemCell = itemIdx !== -1 ? row[itemIdx] : null;
            const itemCode = itemCell ? String(itemCell).trim() : '';
            if (!itemCode && description.length < 50 && !row[qtyIdx] && !row[unitIdx]) {
              continue;
            }

            cleanedLines.push(row.map(cell => cell === null || cell === undefined ? '' : String(cell).replace(/,/g, ' ').replace(/\r?\n/g, '; ')).join(','));
          }

          // Safety cap to prevent blowing up the free-tier token quota on massive sheets
          if (cleanedLines.length > 1000) {
            console.warn(`Sheet "${name}" contains ${cleanedLines.length} rows. Truncating to 1000 rows for token safety.`);
            cleanedLines = cleanedLines.slice(0, 1000);
          }

          cleanedTotalRows += cleanedLines.length;

          if (cleanedLines.length > 0) {
            excelText += `### Sheet: ${name}\n${cleanedLines.join('\n')}\n\n`;
          }
        }
      });

      console.log(`Excel pre-filtered. Original rows: ${originalTotalRows}, Cleaned rows (with data): ${cleanedTotalRows}, String size: ${excelText.length} characters.`);
      if (excelText.trim().length > 0) {
        if (!ai) {
          console.log('[Analyze Document] Gemini API key is not configured. Using local Excel parser fallback.');
          const fallbackItems = localHeuristicExcelParser(req.file.path);
          fallbackItems.forEach(item => {
            const roomResult = extractRoomFromDescription(item.description || '', item.section || 'General');
            const isAlreadyAdded = extractedItems.some(i => i.section === roomResult.room && i.description === roomResult.description);
            if (!isAlreadyAdded) {
              extractedItems.push({
                section: roomResult.room,
                category: item.category || '',
                description: roomResult.description,
                quantity: item.quantity || 1,
                unit: item.unit || 'Item',
                labourRate: item.labourRate || 0,
                materialRate: item.materialRate || 0,
                plantRate: item.plantRate || 0,
                subRate: item.subRate || 0,
                sourceOrder: item.sourceOrder,
                sortOrder: item.sortOrder,
                status: 'Yes',
                selected: true
              });
            }
          });
          try { fs.unlinkSync(req.file.path); } catch (e) { }
        } else {
          console.log('Sending pre-filtered Excel contents to Gemini...');
          try {
          const response = await generateContentWithRetry({
            model: 'gemini-2.5-flash',
            contents: [
              `You are an expert UK Quantity Surveyor. Analyze this uploaded construction spreadsheet data.
Extract all distinct priced work items, quantities, and units. Do not hallucinate prices.
Map each item into our exact JSON array structure.
You must return a valid JSON array of objects. Do not wrap it in markdown block quotes (no \`\`\`json). Just the raw JSON array.

Strict Rules:
1. Ignore any general project information, headers, site notes, drawing list tables, preliminaries, contract terms, or pages/tabs that do not contain actual priced work items.
2. Ignore rows that are section headers, summaries, or blank rows.
3. Only extract physical, distinct construction work items that a contractor would price (e.g. demolitions, walls, doors, painting, plumbing, structural framing).
4. For each item, ensure you extract a valid description, quantity, and unit. If unit is missing, deduce it (e.g. m, m2, m3, Nr, Item).

Structure for each object:
{
  "section": "String (e.g. Substructure, Joinery)",
  "description": "String (Clear description of work)",
  "quantity": Number,
  "unit": "String (m, m2, m3, Item, Nr)"
}

SPREADSHEET DATA:
${excelText}`
            ],
            config: {
              responseMimeType: 'application/json',
            }
          }, 2, 1000);
          const geminiItems = JSON.parse(response.text);
          const sourceLinesForOrder = excelText.split(/\r?\n/).map((line, index) => ({ index, text: String(line || '').toLowerCase() }));

          function findSpreadsheetSourceOrder(item, fallbackIndex) {
            const text = (String(item.section || '') + ' ' + String(item.description || '')).toLowerCase();
            const tokens = text.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(token => token.length >= 4 && !['item','work','works','description','allowance','general'].includes(token));
            let bestIndex = Number.MAX_SAFE_INTEGER;
            let bestScore = 0;

            for (const line of sourceLinesForOrder) {
              let score = 0;
              for (const token of tokens) {
                if (line.text.includes(token)) score++;
              }
              if (score > bestScore || (score === bestScore && score > 0 && line.index < bestIndex)) {
                bestScore = score;
                bestIndex = line.index;
              }
            }

            return bestScore > 0 ? bestIndex : 100000 + fallbackIndex;
          }

          geminiItems.map((item, index) => ({ ...item, sourceOrder: findSpreadsheetSourceOrder(item, index) })).sort((a, b) => Number(a.sourceOrder || 0) - Number(b.sourceOrder || 0)).forEach(item => {
            const roomResult = extractRoomFromDescription(item.description || '', item.section || 'General');
            extractedItems.push({
              section: roomResult.room,
              category: '',
              description: roomResult.description,
              quantity: item.quantity || 1,
              unit: item.unit || 'Item',
              sourceOrder: item.sourceOrder,
              sortOrder: item.sourceOrder,
              status: 'Yes',
              selected: true
            });
          });
          fs.unlinkSync(req.file.path);
        } catch (geminiError) {
          console.warn('[Analyze Document] Gemini API spreadsheet parsing failed. Falling back to local standard parser...', geminiError);
          const fallbackItems = localHeuristicExcelParser(req.file.path);
          fallbackItems.forEach(item => {
            // Only add if not already in extractedItems to avoid double parsing checklist sheets
            const roomResult = extractRoomFromDescription(item.description || '', item.section || 'General');
            const isAlreadyAdded = extractedItems.some(i => i.section === roomResult.room && i.description === roomResult.description);
            if (!isAlreadyAdded) {
              extractedItems.push({
                section: roomResult.room,
                category: '',
                description: roomResult.description,
                quantity: item.quantity || 1,
                unit: item.unit || 'Item',
              sourceOrder: item.sourceOrder,
              sortOrder: item.sourceOrder,
              status: 'Yes',
                selected: true
              });
            }
          });
          try { fs.unlinkSync(req.file.path); } catch (e) { }
          }
        }
      } else {
        // All sheets were checklists and parsed locally! Just delete the uploaded file
        try { fs.unlinkSync(req.file.path); } catch (e) { }
      }

    } else {
      console.log(`Uploading file ${req.file.originalname} to Gemini...`);
      try {
        const uploadResult = await ai.files.upload({
          file: req.file.path,
          config: {
            mimeType: req.file.mimetype,
            displayName: req.file.originalname
          }
        });

        console.log(`File uploaded. URI: ${uploadResult.uri}. Analyzing...`);

        const prompt = `You are an expert UK Quantity Surveyor. Analyze this construction document (schedule of works, specification, or priced Bill of Quantities).
Extract all distinct work items, preliminaries, general items, and priced tasks. Do not hallucinate prices.
Map each item into our exact JSON array structure.
You must return a valid JSON array of objects. Do not wrap it in markdown block quotes (no \`\`\`json). Just the raw JSON array.

Strict Extraction Rules:
1. You MUST extract all room-by-room items, including all items in the "General Items" or "Removal" area at the end of the rooms list. Do not truncate or stop early.
2. You MUST extract all physical work items from the Schedule of Rates (SOR) / priced Bill of Quantities (BOQ) section at the end of the document.
3. Extract all Preliminaries or General Items that represent a task, requirement, or allowance (e.g. disposing of debris, builders works, safety checks, scaffolding, or general obligations). Do not skip them just because their rate, price, quantity, or unit columns are blank in the document; use quantity 1 and unit "Item" (or Nr/Sum) if unspecified.
4. Only ignore purely descriptive text that contains no requirements, safety obligations, or priced work.
5. For each item, specify the section (use the room name, sheet name, or section title, e.g. "Entrance Hall", "Kitchen", "External Works", "Preliminaries"), the description, the quantity, and the unit.

Structure for each object:
{
  "section": "String (e.g. Preliminaries, External - Roof, Substructure)",
  "description": "String (Clear description of work or requirement)",
  "quantity": Number,
  "unit": "String (m, m2, m3, Item, Nr)"
}`;

        const response = await generateContentWithRetry({
          model: 'gemini-2.5-flash',
          contents: [
            { fileData: { mimeType: uploadResult.mimeType, fileUri: uploadResult.uri } },
            prompt
          ],
          config: {
            responseMimeType: 'application/json',
          }
        }, 2, 1000); // 2 attempts max, 1s delay -> fail fast instantly

        try { await ai.files.delete({ name: uploadResult.name }); } catch (e) { }
        const rawItems = JSON.parse(response.text);
        extractedItems = rawItems.map(item => {
          const roomResult = extractRoomFromDescription(item.description || '', item.section || 'General');
          return {
            section: roomResult.room,
            category: '',
            description: roomResult.description,
            quantity: item.quantity || 1,
            unit: item.unit || 'Item',
              sourceOrder: item.sourceOrder,
              sortOrder: item.sourceOrder,
              status: 'Yes',
            selected: true
          };
        });
        fs.unlinkSync(req.file.path);
      } catch (geminiError) {
        try { fs.unlinkSync(req.file.path); } catch (e) { }
        throw new Error('Gemini API file analysis failed: ' + geminiError.message);
      }
    }

    extractedItems = extractedItems
      .map((item, index) => ({
        ...item,
        sourceOrder: Number.isFinite(Number(item.sourceOrder ?? item.sortOrder ?? item.originalIndex)) ? Number(item.sourceOrder ?? item.sortOrder ?? item.originalIndex) : index,
        sortOrder: Number.isFinite(Number(item.sortOrder ?? item.sourceOrder ?? item.originalIndex)) ? Number(item.sortOrder ?? item.sourceOrder ?? item.originalIndex) : index,
        originalIndex: Number.isFinite(Number(item.originalIndex ?? item.sourceOrder ?? item.sortOrder)) ? Number(item.originalIndex ?? item.sourceOrder ?? item.sortOrder) : index,
        status: item.status || 'Yes',
        selected: item.selected !== false
      }))
      .sort((a, b) => Number(a.sourceOrder) - Number(b.sourceOrder));

    res.json({ success: true, filename: req.file.originalname, items: extractedItems });

  } catch (error) {
    console.error('Analyze error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Fallback SPA routing to serve frontend on unmatched client routes (non-API)
app.get(/^(?!\/api)/, (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

registerSurveyRoutes(app, requireAuth);

app.listen(PORT, () => {
  console.log(`Scraper backend running on http://localhost:${PORT}`);
});

module.exports = {
  localHeuristicExcelParser,
  parseLargeExcelWorkbook,
  largeWorkbookLooksLikeBoq,
  localKeywordPricing,
  localQSChatFallback,
  extractRoomFromDescription
};


