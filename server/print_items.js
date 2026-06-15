const { getDbConnection } = require('./database');

async function main() {
  const db = await getDbConnection();
  try {
    const items = await db.all(
      "SELECT section, description, quantity, unit FROM estimate_items WHERE project_id = 'dd07b8e7-1324-4d4a-a490-4479cd211488' ORDER BY id"
    );
    console.log(`Total items in project: ${items.length}`);
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
