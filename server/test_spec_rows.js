const XLSX = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, 'uploads', '255ddfef0b0c5751993b911465ca42d1');
try {
  const workbook = XLSX.readFile(filePath);
  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    rows.forEach((row, i) => {
      if (row && row.length > 0) {
        const rowStr = row.join(' | ');
        if (rowStr.toLowerCase().includes('dulux') || rowStr.toLowerCase().includes('putty for woodwork') || rowStr.toLowerCase().includes('shall be')) {
          console.log(`[${sheetName}] Row ${i}:`, row);
        }
      }
    });
  });
} catch (e) {
  console.error(e.message);
}
