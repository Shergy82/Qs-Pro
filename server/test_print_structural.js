const XLSX = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, 'uploads', '255ddfef0b0c5751993b911465ca42d1');
try {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets['BILL 3 Structural Works'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  console.log(`BILL 3 has ${rows.length} rows.`);
  rows.forEach((row, i) => {
    if (row && row.length > 0) {
      console.log(`Row ${i}:`, row);
    }
  });
} catch (e) {
  console.error(e.message);
}
