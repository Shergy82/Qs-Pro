const { getDbConnection } = require('./database');

async function main() {
  const db = await getDbConnection();
  try {
    const users = await db.all("SELECT id, email, margin, wasteAllowance FROM users");
    console.log("USERS:", users);
    
    const sessions = await db.all("SELECT token, user_id, expires_at FROM sessions");
    console.log("SESSIONS:", sessions);
    
    const projects = await db.all("SELECT * FROM projects");
    console.log("PROJECTS:", projects);

    const itemCounts = await db.all("SELECT project_id, COUNT(*) as count FROM estimate_items GROUP BY project_id");
    console.log("ESTIMATE ITEM COUNTS:", itemCounts);
    
    const hollybush = projects.find(p => p.name.includes('Hollybush'));
    if (hollybush) {
      const items = await db.all("SELECT * FROM estimate_items WHERE project_id = ? LIMIT 5", [hollybush.id]);
      console.log("HOLLYBUSH FIRST 5 ITEMS:", items);
    }

    const labourRates = await db.all("SELECT * FROM labour_rates");
    console.log("LABOUR RATES IN DB:", labourRates);
  } catch (e) {
    console.error(e);
  } finally {
    await db.close();
  }
}

main();

