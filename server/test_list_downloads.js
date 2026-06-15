const fs = require('fs');
const path = require('path');

const dir = 'C:\\Users\\phil\\Downloads';
try {
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    console.log(`Downloads has ${files.length} files:`);
    files.forEach(f => {
      console.log(`  ${f}`);
    });
  } else {
    console.log("Downloads directory does not exist.");
  }
} catch (e) {
  console.error(e.message);
}
