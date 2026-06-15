const XLSX = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, 'uploads', '255ddfef0b0c5751993b911465ca42d1');
try {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets['BILL 2 Builder Works'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  console.log(`Sheet has ${rows.length} rows.`);
  rows.forEach((row, i) => {
    console.log(`Row ${i}:`, row);
  });
} catch (e) {
  console.error(e.message);
}
