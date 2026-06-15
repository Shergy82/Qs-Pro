const { getDbConnection } = require('./database');

async function main() {
  const db = await getDbConnection();
  try {
    const items = await db.all("SELECT id, project_id, section, description, quantity, unit FROM estimate_items");
    console.log(`Total items in DB: ${items.length}`);
    
    // Group by project_id
    const projects = {};
    items.forEach(item => {
      if (!projects[item.project_id]) projects[item.project_id] = [];
      projects[item.project_id].push(item);
    });

    for (const pid in projects) {
      console.log(`\nProject ID: ${pid} (${projects[pid].length} items)`);
      const matches = projects[pid].filter(item => 
        item.description.toLowerCase().includes('sitting') || 
        item.description.toLowerCase().includes('kitchen') ||
        item.description.toLowerCase().includes('hook')
      );
      console.log(`  Found ${matches.length} matching items:`);
      matches.forEach((m, idx) => {
        console.log(`    ${idx + 1}. [${m.section}] Qty: ${m.quantity} | Unit: ${m.unit} | Desc: ${m.description.substring(0, 100)}`);
      });
    }
  } catch (e) {
    console.error(e);
  } finally {
    await db.close();
  }
}

main();
