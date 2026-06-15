const { getDbConnection } = require('./database');

async function main() {
  const db = await getDbConnection();
  try {
    const items = await db.all(
      "SELECT section, description, quantity, unit FROM estimate_items WHERE project_id = 'ea0cfc2b-8b5b-48f9-955c-9d2ec2250e43' ORDER BY id"
    );
    console.log(`Total items in 54-item project: ${items.length}`);
    items.forEach((m, idx) => {
      console.log(`${idx + 1}. [${m.section}] Qty: ${m.quantity} | Unit: ${m.unit} | Desc: ${m.description.substring(0, 120)}`);
    });
  } catch (e) {
    console.error(e);
  } finally {
    await db.close();
  }
}

main();
