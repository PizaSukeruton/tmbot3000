const { Pool } = require("pg");
const TmAiEngine = require("./backend/services/tmAiEngine"); // This now receives the object

// IMPORTANT: Configure your database connection
// This script uses the same environment variables as your main code.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// A simple helper function to get the list of term_ids from the database
async function getTermIds() {
  const sql = `
    SELECT DISTINCT term_id
    FROM tm_answers
    WHERE is_current = true
    ORDER BY term_id;
  `;
  const db = { query: (text, params) => pool.query(text, params) };
  try {
    const res = await db.query(sql);
    // Return an array of term_ids
    return res.rows.map(row => row.term_id);
  } catch (error) {
    console.error("Error fetching term IDs:", error.message);
    return [];
  }
}

async function runTermTests() {
  console.log("--- Starting Industry Term Tests ---");
  
  // Use the pre-made instance directly, no 'new' keyword needed
  const engine = TmAiEngine;
  
  // Get all unique term IDs from the database
  const termIds = await getTermIds();

  if (termIds.length === 0) {
    console.log("No terms found to test. Please check your database connection or the 'tm_answers' table.");
    await pool.end();
    return;
  }

  console.log(`Found ${termIds.length} unique terms to test.`);
  
  // Loop through each term ID and run the test
  for (const termId of termIds) {
    console.log(`\n🧪 Testing term_id: "${termId}" 🧪`);
    
    // Call the chatbot engine with a 'term_lookup' intent
    const response = await engine.generateResponse({
      message: `check term ${termId}`, // A simulated message
      intent: {
        intent_type: "term_lookup",
        term_id: termId
      },
    });

    // Check if the response contains the expected answer
    if (response && response.text && response.text.startsWith("No answer found")) {
      console.log(`❌ FAILED: No answer found for term "${termId}"`);
    } else if (response && response.text) {
      console.log(`✅ PASSED: Found answer for term "${termId}"`);
      console.log(`  - Response: "${response.text.slice(0, 75)}..."`); // Show a snippet of the response
    } else {
      console.log(`❌ FAILED: Unexpected response for term "${termId}"`);
      console.log(`  - Response: ${JSON.stringify(response)}`);
    }
  }

  console.log("\n--- All Tests Complete ---");
  
  // Close the database connection
  await pool.end();
}

// Run the test suite
runTermTests().catch(err => {
  console.error("An unhandled error occurred:", err);
  pool.end();
});

