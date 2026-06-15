const { extractRoomFromDescription } = require('./index.js');

const testCases = [
  { desc: "Lounge - Sand and polish floor", expectedRoom: "Lounge", expectedDesc: "Sand and polish floor" },
  { desc: "lounge: Sand and polish floor", expectedRoom: "Lounge", expectedDesc: "Sand and polish floor" },
  { desc: "Lounge sand and polish floor", expectedRoom: "Lounge", expectedDesc: "Sand and polish floor" },
  { desc: "Stairs and Landing Boiler cupboard door repair holes", expectedRoom: "Stairs & Landing - Boiler Cupboard", expectedDesc: "Door repair holes" },
  { desc: "Stairs and landing boiler cup'd door handle", expectedRoom: "Stairs & Landing - Boiler Cupboard", expectedDesc: "Door handle" },
  { desc: "Stairs & Landing - Paint ceiling", expectedRoom: "Stairs and Landing", expectedDesc: "Paint ceiling" },
  { desc: "Kitchen/Diner: Paint walls", expectedRoom: "Kitchen/Diner", expectedDesc: "Paint walls" },
  { desc: "skirting in hallway", expectedRoom: "Entrance Hall", expectedDesc: "skirting in hallway" },
  { desc: "General garden clearance", expectedRoom: "Garden", expectedDesc: "General garden clearance" },
  { desc: "Ceiling: Remove two hooks on ceiling", expectedRoom: "Entrance Hall", expectedDesc: "Ceiling: Remove two hooks on ceiling", currentSection: "Entrance Hall" },
  { desc: "Walls: Fill holes and redecorate", expectedRoom: "Lounge", expectedDesc: "Walls: Fill holes and redecorate", currentSection: "Lounge" }
];

console.log("--- RUNNING ROOM EXTRACTION TESTS ---");
let passed = 0;
for (const tc of testCases) {
  const result = extractRoomFromDescription(tc.desc, tc.currentSection || "General");
  const roomMatch = result.room === tc.expectedRoom;
  
  // Clean desc check
  const descMatch = result.description.toLowerCase().trim() === tc.expectedDesc.toLowerCase().trim();
  
  if (roomMatch && descMatch) {
    console.log(`PASS: "${tc.desc}" -> Room: "${result.room}", Desc: "${result.description}"`);
    passed++;
  } else {
    console.log(`FAIL: "${tc.desc}"`);
    console.log(`  Expected Room: "${tc.expectedRoom}", Got: "${result.room}"`);
    console.log(`  Expected Desc: "${tc.expectedDesc}", Got: "${result.description}"`);
  }
}

console.log(`\nResult: ${passed}/${testCases.length} passed.`);
process.exit(passed === testCases.length ? 0 : 1);
