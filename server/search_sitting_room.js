const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const uploadsDir = path.join(__dirname, '../server/uploads');
const files = fs.readdirSync(uploadsDir);

console.log('Searching for "Sitting Room" or "Kitchen" in uploads...');

files.forEach(file => {
  const filePath = path.join(uploadsDir, file);
  if (fs.statSync(filePath).isDirectory()) return;

  try {
    const workbook = XLSX.readFile(filePath);
    let found = false;
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.toLowerCase().includes('sitting room') || csv.toLowerCase().includes('hooks')) {
        console.log(`FOUND IN FILE: ${file} (Sheet: ${sheetName})`);
        found = true;
      }
    });
  } catch (err) {
    // Check if it is PDF text (if we can read it)
    const content = fs.readFileSync(filePath);
    if (content.toString().toLowerCase().includes('sitting room') || content.toString().toLowerCase().includes('hooks')) {
      console.log(`FOUND IN PDF FILE: ${file}`);
    }
  }
});
