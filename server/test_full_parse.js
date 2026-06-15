const XLSX = require('xlsx');
const path = require('path');

function isInformationalOnly(descLower) {
  const specIndicators = [
    'all materials shall be',
    'workmanship',
    'in compliance with',
    'found to be faulty',
    'replaced like for like',
    'shall be of approved',
    'shall be used for making good',
    'maker\'s instructions',
    'manufacturer\'s instructions',
    'manufacturers instructions',
    'general workmanship',
    'workmanship shall',
    'specification of materials',
    'for information only',
    'putty to bs',
    'bitumastic solution',
    'shall be in accordance',
    'to be in accordance with bs',
    'standard standards',
    'evidence of registration',
    'ce marked in accordance'
  ];

  for (const indicator of specIndicators) {
    if (descLower.includes(indicator)) {
      return true;
    }
  }

  if (descLower.includes('electrical works') && descLower.includes('in accordance')) {
    return true;
  }
  if (descLower.includes('paint for internal') && descLower.includes('dulux')) {
    return true;
  }

  return false;
}

function prototypeParser(filePath) {
  const workbook = XLSX.readFile(filePath);
  const items = [];
  
  workbook.SheetNames.forEach(sheetName => {
    const nameLower = sheetName.toLowerCase();
    if (nameLower.includes('collection') || 
        nameLower.includes('summary') || 
        nameLower.includes('total') || 
        nameLower.includes('index') || 
        nameLower.includes('instruction') || 
        nameLower.includes('prelim')) {
      return;
    }
    
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    
    let currentSection = sheetName || 'General';
    
    let itemIdx = 0;
    let descIdx = 1;
    let unitIdx = 2;
    let qtyIdx = 3;
    let rateIdx = 4;
    
    let headerRowIdx = -1;
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const row = rows[r];
      if (!row || !Array.isArray(row)) continue;
      
      let foundDesc = false;
      row.forEach((cell, idx) => {
        if (!cell) return;
        const str = String(cell).toLowerCase().trim();
        if (str === 'item' || str === 'ref' || str === 'code') itemIdx = idx;
        if (str.includes('description') || str.includes('work') || str === 'details') {
          descIdx = idx;
          foundDesc = true;
        }
        if (str === 'unit') unitIdx = idx;
        if (str === 'qty' || str.includes('quantity')) qtyIdx = idx;
        if (str === 'rate' || str.includes('unit cost')) rateIdx = idx;
      });
      if (foundDesc) {
        headerRowIdx = r;
        break;
      }
    }
    
    const startRowIdx = headerRowIdx !== -1 ? headerRowIdx + 1 : 0;
    for (let r = startRowIdx; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !Array.isArray(row) || row.length === 0) continue;
      
      const descCell = row[descIdx];
      if (!descCell) continue;
      const description = String(descCell).trim();
      if (description.length < 5) continue;
      
      const descLower = description.toLowerCase();
      if (descLower.includes('description of works') || descLower.includes('description of work') || descLower.includes('item description')) {
        continue;
      }
      if (descLower.includes('total') || descLower.includes('collection') || descLower === 'downtakings' || descLower === 'electrical;') {
        continue;
      }
      
      if (isInformationalOnly(descLower)) {
        console.log(`[Prototype] Skipping informational-only: "${description.substring(0, 80)}..."`);
        continue;
      }
      
      const hasQty = row[qtyIdx] !== undefined && row[qtyIdx] !== null && String(row[qtyIdx]).trim() !== '';
      const hasUnit = row[unitIdx] !== undefined && row[unitIdx] !== null && String(row[unitIdx]).trim() !== '';
      const hasRate = row[rateIdx] !== undefined && row[rateIdx] !== null && String(row[rateIdx]).trim() !== '';
      const hasItemCode = itemIdx !== undefined && row[itemIdx] !== undefined && row[itemIdx] !== null && String(row[itemIdx]).trim() !== '';
      const hasInlineQty = /(\d+)\s*(no\.?|m2|m3|m\b)/i.test(description);
      
      if (!hasQty && !hasUnit && !hasRate && !hasItemCode && !hasInlineQty) {
        // Check if it's a continuation of the previous item
        const looksLikeContinuation = 
          description.trim().startsWith('•') || 
          description.trim().startsWith('-') ||
          description.trim().startsWith('*') ||
          /^[a-z]/.test(description.trim()) ||
          (items.length > 0 && items[items.length - 1].description.trim().endsWith(':')) ||
          description.length > 40;

        if (looksLikeContinuation && items.length > 0 && items[items.length - 1].section === currentSection) {
          items[items.length - 1].description += '\n' + description;
          console.log(`[Prototype] Appended continuation to "${items[items.length - 1].description.substring(0, 50)}..."`);
        } else if (description.length < 50) {
          currentSection = description;
        }
        continue;
      }
      
      // Check if it's a sub-heading section
      const itemCell = row[itemIdx];
      const itemCode = itemCell ? String(itemCell).trim() : '';
      if (!itemCode && description.length < 50 && !row[qtyIdx] && !row[unitIdx]) {
        currentSection = description;
        continue;
      }
      
      let quantity = null;
      const qtyCell = row[qtyIdx];
      if (qtyCell !== undefined && qtyCell !== null && qtyCell !== '') {
        const num = Number(String(qtyCell).replace(/[^0-9.-]/g, ''));
        if (!isNaN(num) && num > 0) {
          quantity = num;
        }
      }
      
      let unit = 'Item';
      const unitCell = row[unitIdx];
      if (unitCell !== undefined && unitCell !== null && unitCell !== '') {
        unit = String(unitCell).trim();
      }
      
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
      
      let materialRate = 0;
      let labourRate = 0;
      let plantRate = 0;
      let subRate = 0;
      
      const rateCell = row[rateIdx];
      if (rateCell !== undefined && rateCell !== null && rateCell !== '') {
        const num = Number(String(rateCell).replace(/[^0-9.-]/g, ''));
        if (!isNaN(num) && num > 0) {
          materialRate = num;
        }
      }
      
      items.push({
        section: currentSection,
        description: description,
        quantity: quantity,
        unit: unit,
        labourRate,
        materialRate,
        plantRate,
        subRate
      });
    }
  });
  
  return items;
}

const filePath = path.join(__dirname, 'uploads', '255ddfef0b0c5751993b911465ca42d1');
const items = prototypeParser(filePath);
console.log(`\nTOTAL PROTOTYPED ITEMS EXTRACTED: ${items.length}`);
items.forEach((item, idx) => {
  console.log(`${idx + 1}. [${item.section}] Qty: ${item.quantity} | Unit: ${item.unit} | Desc: ${item.description.replace(/\n/g, '  ').substring(0, 120)}`);
});
