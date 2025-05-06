// test-message-agents.js
const numberPool = require('./numberPoolMessaging');
const readline = require('readline');

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Function to prompt user
const prompt = (question) => new Promise(resolve => rl.question(question, resolve));

async function runTest() {
  try {
    console.log('\n=== Message Agents Test ===');
    
    // Check if agents are running
    console.log('\nChecking agent status...');
    const agentStatus = await numberPool.checkAllAgents();
    
    // Display agent status
    for (const status of agentStatus) {
      console.log(`\nUser: ${status.username} (${status.phoneNumber})`);
      console.log(`- Agent Status: ${status.success ? '✅ Online' : '❌ Offline'}`);
      
      if (!status.success) {
        console.log(`- Error: ${status.error}`);
      } else {
        console.log(`- Agent Info: ${JSON.stringify(status.agentStatus)}`);
      }
    }
    
    // Only proceed if at least one agent is online
    const onlineAgents = agentStatus.filter(s => s.success);
    if (onlineAgents.length === 0) {
      console.log('\n❌ No agents are online. Please check the agent installations.');
      rl.close();
      return;
    }
    
    const runTests = await prompt('\nDo you want to run messaging tests? (y/n): ');
    if (runTests.toLowerCase() !== 'y') {
      console.log('Exiting without running tests.');
      rl.close();
      return;
    }
    
    // Get the test recipient
    const recipient = await prompt('\nEnter recipient phone number: ');
    
    // Test each online agent
    for (const agent of onlineAgents) {
      console.log(`\n=== Testing message from ${agent.username} (${agent.phoneNumber}) ===`);
      
      try {
        const result = await numberPool.sendMessageAsUser(
          agent.userId, 
          recipient, 
          `Test message from ${agent.username} at ${new Date().toLocaleTimeString()}`
        );
        
        console.log('✅ Success!');
        console.log('Result:', result);
      } catch (error) {
        console.error(`❌ Error with ${agent.username}:`, error.message);
      }
    }
    
    // Test rotation if multiple agents are online
    if (onlineAgents.length > 1) {
      console.log('\n=== Testing user rotation ===');
      
      for (let i = 0; i < 2; i++) {
        console.log(`\nSending message #${i+1} with rotation...`);
        
        try {
          const result = await numberPool.sendMessageAndRotate(
            recipient,
            `Rotation test message #${i+1} at ${new Date().toLocaleTimeString()}`
          );
          
          console.log('✅ Success!');
          console.log(`Message sent as ${result.username}`);
          console.log(`Next user will be ${result.nextUser.username}`);
        } catch (error) {
          console.error('❌ Error with rotation test:', error.message);
        }
      }
    }
    
    console.log('\n=== Test Complete ===');
    rl.close();
  } catch (error) {
    console.error('Error running test:', error);
    rl.close();
  }
}

// Run the test
runTest();