const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const uploadsDir = path.join(__dirname, 'uploads');
const files = fs.readdirSync(uploadsDir);

console.log(`Checking ${files.length} files in uploads...`);
files.forEach(file => {
  const filePath = path.join(uploadsDir, file);
  if (fs.statSync(filePath).isDirectory()) return;

  try {
    const workbook = XLSX.readFile(filePath);
    console.log(`File: ${file} (Size: ${fs.statSync(filePath).size} bytes)`);
    console.log(`  Sheets:`, workbook.SheetNames);
  } catch (e) {
    console.log(`File: ${file} is not a valid Excel file or error: ${e.message}`);
  }
});
