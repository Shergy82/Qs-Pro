const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const uploadsDir = path.join(__dirname, 'uploads');
const files = fs.readdirSync(uploadsDir);

console.log("Searching for sheet 'Refurbishment' in uploads...");
files.forEach(file => {
  const filePath = path.join(uploadsDir, file);
  try {
    const workbook = XLSX.readFile(filePath);
    if (workbook.SheetNames.some(name => name.toLowerCase().includes('refurb'))) {
      console.log(`FOUND 'Refurbishment' sheet in file: ${file} (Sheets: ${workbook.SheetNames})`);
    }
  } catch (e) {
    // Ignore non-spreadsheet errors
  }
});
