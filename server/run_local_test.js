const { localHeuristicExcelParser } = require('./index.js');
const path = require('path');

const filePath = path.join(__dirname, 'uploads', '255ddfef0b0c5751993b911465ca42d1');
try {
  const items = localHeuristicExcelParser(filePath);
  console.log(`Extracted ${items.length} items locally.`);
  items.forEach((item, index) => {
    console.log(`${index + 1}. [${item.section}] Qty: ${item.quantity} | Unit: ${item.unit} | Desc: ${item.description.substring(0, 100)}`);
  });
} catch (e) {
  console.error("Error:", e.message);
}
