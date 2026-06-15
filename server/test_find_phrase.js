const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const uploadsDir = path.join(__dirname, 'uploads');
const files = fs.readdirSync(uploadsDir);

console.log("Searching files for 'Paint for internal decoration' or 'linseed oil putty'...");
files.forEach(file => {
  const filePath = path.join(uploadsDir, file);
  if (fs.statSync(filePath).isDirectory()) return;

  // Try parsing as Excel
  try {
    const workbook = XLSX.readFile(filePath);
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.toLowerCase().includes('paint for internal') || csv.toLowerCase().includes('linseed oil putty')) {
        console.log(`FOUND IN EXCEL: ${file} (Sheet: ${sheetName})`);
      }
    });
  } catch (err) {
    // Try reading as raw text
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.toLowerCase().includes('paint for internal') || content.toLowerCase().includes('linseed oil putty')) {
        console.log(`FOUND IN RAW TEXT: ${file}`);
      }
    } catch (e) {}
  }
});
