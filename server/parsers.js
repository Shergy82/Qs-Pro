const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { extractRoomFromDescription } = require('./utils');

// Initialize Gemini if API key is present
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

// Registry of document parsing strategies
const parserRegistry = {};

/**
 * Registers a document parser strategy.
 */
function registerParser(id, strategy) {
  parserRegistry[id] = strategy;
  console.log(`[Parser Registry] Registered strategy: ${id} (${strategy.name})`);
}

// 1. Gentleshaw Lane Excel Strategy
registerParser('gentleshaw_excel', {
  name: 'Gentleshaw Lane Scope of Works Excel',
  description: 'Parses the Scope of Works sheet from the Capital Works Report.',
  detect: (file, workbook) => {
    if (!workbook) return false;
    const nameLower = file.originalname.toLowerCase();
    const hasScope = workbook.SheetNames.includes('Scope of Works');
    const hasOverview = workbook.SheetNames.includes('Overview');
    return (hasScope && hasOverview) || nameLower.includes('gentleshaw');
  },
  parse: async (filePath, mimetype, originalName) => {
    console.log(`[Gentleshaw Parser] Reading file ${originalName}...`);
    const workbook = XLSX.readFile(filePath, { sheets: ['Scope of Works'] });
    const sheet = workbook.Sheets['Scope of Works'];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    const complianceItems = [
      'joinery throughout',
      'cleaning',
      'eicr',
      'hardwired co & smoke detectors',
      'gas - lpg/mains boiler/ appliances',
      'legionella',
      'decent homes remedial',
      'ground source heating',
      'sceptic tank/ drainage',
      'contingencies'
    ];

    let currentSection = 'General';
    const items = [];

    // Header row is row 1 (0-indexed). Start parsing from row 2.
    for (let r = 2; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length === 0) continue;

      const col0 = row[0] ? String(row[0]).trim() : '';
      const col1 = row[1] ? String(row[1]).trim() : '';
      const col2 = row[2]; // Net Cost

      // Skip sub-totals and empty rows
      if (
        col1.toLowerCase().includes('sub total') ||
        col1.toLowerCase().includes('sub-total') ||
        col0.toLowerCase().includes('sub total')
      ) {
        continue;
      }

      let description = '';
      let rate = 0;

      if (col0 && !col1) {
        const isHeader =
          col0 === col0.toUpperCase() ||
          col0.endsWith(':') ||
          col0.toLowerCase().includes('room');

        const isComplianceItem = complianceItems.includes(col0.toLowerCase().trim());

        if (isHeader && !isComplianceItem) {
          currentSection = col0.replace(/:$/, '').trim();
          continue;
        } else {
          description = col0;
        }
      } else if (col1) {
        description = col1;
        if (col0) {
          description = `${col0}: ${description}`;
        }
      } else {
        continue;
      }

      if (col2 !== undefined && col2 !== null && col2 !== '') {
        const num = Number(String(col2).replace(/[^0-9.-]/g, ''));
        if (!isNaN(num) && num > 0) {
          rate = num;
        }
      }

      let quantity = 1;
      let unit = 'Item';

      const nrMatch = description.match(/(\d+)\s*no\.?/i);
      if (nrMatch) {
        quantity = parseInt(nrMatch[1]);
        unit = 'Nr';
      } else {
        const m2Match = description.match(/(\d+)\s*m2\b/i);
        if (m2Match) {
          quantity = parseInt(m2Match[1]);
          unit = 'm2';
        }
      }

      const roomResult = extractRoomFromDescription(description, currentSection);

      items.push({
        section: roomResult.room,
        category: '',
        description: roomResult.description,
        quantity: quantity,
        unit: unit,
        labourRate: 0,
        materialRate: rate,
        plantRate: 0,
        subRate: 0,
        status: 'Yes',
        selected: true
      });
    }

    console.log(`[Gentleshaw Parser] Extracted ${items.length} items from Scope of Works.`);
    return items;
  }
});

// 2. Rose Cottage PDF Strategy (via Gemini PDF parser)
registerParser('rose_cottage_pdf', {
  name: 'Rose Cottage Schedule of Works PDF',
  description: 'Rose Cottage PDF spec sheet parsing using Gemini.',
  detect: (file, workbook) => {
    const nameLower = file.originalname.toLowerCase();
    return nameLower.includes('rose cottage') && nameLower.endsWith('.pdf');
  },
  parse: async (filePath, mimetype, originalName) => {
    if (!ai) throw new Error('Gemini API is not configured.');

    console.log(`[Rose Cottage Parser] Uploading file ${originalName} to Gemini...`);
    const uploadResult = await ai.files.upload({
      file: filePath,
      config: {
        mimeType: mimetype,
        displayName: originalName
      }
    });

    try {
      console.log(`[Rose Cottage Parser] File uploaded. URI: ${uploadResult.uri}. Analyzing...`);
      const prompt = `You are an expert UK Quantity Surveyor. Analyze this construction document (schedule of works, specification, or priced Bill of Quantities).
Extract all distinct work items, preliminaries, general items, and priced tasks. Do not hallucinate prices.
Map each item into our exact JSON array structure.
You must return a valid JSON array of objects. Do not wrap it in markdown block quotes (no \`\`\`json). Just the raw JSON array.

Strict Extraction Rules:
1. Extract all items, including all "PRELIMINARIES - GENERAL ITEMS" (e.g. items 0.01 to 0.11) and all room-by-room physical work items.
2. For Preliminaries or General Items that represent a task, requirement, or allowance (e.g. disposing of debris, builders works, safety checks, or general obligations), extract them. Do not skip them just because their rate, price, quantity, or unit columns are blank in the document; use quantity 1 and unit "Item" (or Nr/Sum) if unspecified.
3. Only ignore purely descriptive text that contains no requirements, safety obligations, or priced work.
4. For each item, specify the section, description, quantity, and unit.

Structure for each object:
{
  "section": "String (e.g. Preliminaries, External - Roof, Substructure)",
  "description": "String (Clear description of work or requirement)",
  "quantity": Number,
  "unit": "String (m, m2, m3, Item, Nr)"
}`;

      const response = await generateContentWithRetry({
        model: 'gemini-3.5-flash',
        contents: [
          { fileData: { mimeType: uploadResult.mimeType, fileUri: uploadResult.uri } },
          prompt
        ],
        config: {
          responseMimeType: 'application/json',
        }
      });

      const rawItems = JSON.parse(response.text);

      // Clean up file on Gemini
      try { await ai.files.delete({ name: uploadResult.name }); } catch (e) {}

      // Normalize items
      return rawItems.map(item => {
        const roomResult = extractRoomFromDescription(item.description || '', item.section || 'General');
        return {
          section: roomResult.room,
          category: '',
          description: roomResult.description,
          quantity: item.quantity || 1,
          unit: item.unit || 'Item',
          labourRate: 0,
          materialRate: 0,
          plantRate: 0,
          subRate: 0,
          status: 'Yes',
          selected: true
        };
      });
    } catch (err) {
      try { await ai.files.delete({ name: uploadResult.name }); } catch (e) {}
      throw err;
    }
  }
});

module.exports = {
  parserRegistry,
  registerParser
};
