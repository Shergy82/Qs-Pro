const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const uploadsDir = path.join(__dirname, 'uploads');
const files = fs.readdirSync(uploadsDir);

files.forEach(file => {
  const filePath = path.join(uploadsDir, file);
  if (fs.statSync(filePath).isDirectory()) return;

  try {
    const workbook = XLSX.readFile(filePath);
    console.log(`===========================================`);
    console.log(`FILE: ${file} | SIZE: ${fs.statSync(filePath).size} bytes`);
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      console.log(`  Sheet: "${sheetName}" | Rows: ${rows.length}`);
      
      // Let's search for some keywords in this sheet's rows
      let textSnippet = '';
      for (let r = 0; r < Math.min(rows.length, 50); r++) {
        const row = rows[r];
        if (row && row.length > 0) {
          const rowStr = row.join(' | ');
          if (rowStr.toLowerCase().includes('cottage') || rowStr.toLowerCase().includes('specification') || rowStr.toLowerCase().includes('refurbishment')) {
            textSnippet += `    Row ${r}: ${rowStr.substring(0, 150)}\n`;
          }
        }
      }
      if (textSnippet) {
        console.log(`    Matching Keyword Rows:\n${textSnippet}`);
      }
      
      // Print first 5 rows regardless
      console.log(`    First 5 rows:`);
      for (let r = 0; r < Math.min(rows.length, 5); r++) {
        console.log(`      Row ${r}:`, rows[r]);
      }
    });
  } catch (e) {
    //
  }
});
