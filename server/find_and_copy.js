const fs = require('fs');
const path = require('path');

const userDir = 'C:\\Users\\phil';
const targetPath = path.join(__dirname, 'uploads', 'daisy_cottage.xlsx');

function search(dir) {
  // Skip system and hidden dirs
  const base = path.basename(dir);
  if (base.startsWith('.') || base === 'AppData' || base === 'node_modules' || base === 'Local Settings' || base === 'Application Data') {
    return null;
  }

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      let stats;
      try {
        stats = fs.statSync(fullPath);
      } catch (e) {
        continue;
      }
      
      if (stats.isDirectory()) {
        const found = search(fullPath);
        if (found) return found;
      } else if (file.toLowerCase().includes('daisy') && file.endsWith('.xlsx')) {
        return fullPath;
      }
    }
  } catch (e) {
    // Permission errors
  }
  return null;
}

console.log("Searching recursively for Daisy Cottage Excel file under C:\\Users\\phil...");
const foundFile = search(userDir);
if (foundFile) {
  console.log(`Found file: ${foundFile}`);
  try {
    fs.copyFileSync(foundFile, targetPath);
    console.log(`Successfully copied to ${targetPath}`);
  } catch (e) {
    console.error(`Error copying: ${e.message}`);
  }
} else {
  console.log("Daisy Cottage Excel file was not found under your user directory.");
}
