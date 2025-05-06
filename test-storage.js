// test-storage.js
const axios = require('axios');

async function testStorageAPI() {
  try {
    console.log("Testing store-message API...");
    const response = await axios.post('http://localhost:3000/api/store-message', {
      direction: 'outgoing',
      sender: {
        userId: 'user1',
        username: 'debtconnects',
        phoneNumber: '2087130507'
      },
      recipient: '1234567890',
      message: 'Test storage message',
      timestamp: new Date().toISOString()
    });
    
    console.log("Response:", response.data);
    
    // Check if conversation exists
    console.log("\nVerifying conversation file...");
    const checkResponse = await axios.get('http://localhost:3000/api/conversations');
    console.log("Conversations:", checkResponse.data);
  } catch (error) {
    console.error("Test failed:", error.message);
  }
}

testStorageAPI();