const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const uploadsDir = path.join(__dirname, 'uploads');
const files = fs.readdirSync(uploadsDir);

console.log("Searching uploads for 'Daisy' or 'Cottage'...");
files.forEach(file => {
  const filePath = path.join(uploadsDir, file);
  if (fs.statSync(filePath).isDirectory()) return;

  try {
    const workbook = XLSX.readFile(filePath);
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.toLowerCase().includes('daisy') || csv.toLowerCase().includes('cottage')) {
        console.log(`FOUND IN EXCEL: ${file} (Sheet: ${sheetName})`);
      }
    });
  } catch (err) {
    try {
      const content = fs.readFileSync(filePath);
      if (content.toString().toLowerCase().includes('daisy') || content.toString().toLowerCase().includes('cottage')) {
        console.log(`FOUND IN RAW: ${file}`);
      }
    } catch (e) {}
  }
});
