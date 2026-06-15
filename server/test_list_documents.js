const fs = require('fs');
const path = require('path');

const dirs = ['C:\\Users\\phil\\OneDrive\\Documents', 'C:\\Users\\phil\\OneDrive'];
dirs.forEach(dir => {
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      console.log(`Directory ${dir} has ${files.length} files:`);
      files.forEach(f => console.log(`  ${f}`));
    } else {
      console.log(`Directory ${dir} does not exist.`);
    }
  } catch (e) {
    console.error(e.message);
  }
});
