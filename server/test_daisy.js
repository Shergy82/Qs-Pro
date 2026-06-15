const XLSX = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, 'uploads', 'daisy_cottage.xlsx');
try {
  const workbook = XLSX.readFile(filePath);
  console.log("Sheet names:", workbook.SheetNames);
  
  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    console.log(`\nSheet "${sheetName}" has ${rows.length} rows.`);
    console.log("First 30 rows:");
    rows.slice(0, 30).forEach((row, i) => {
      console.log(`  Row ${i}:`, row);
    });
  });
} catch (e) {
  console.error("Error:", e.message);
}
