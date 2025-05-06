#!/bin/bash
# update-message-agents-sqlite.sh - Updates message agents to use direct SQLite access

echo "Updating message agents with direct SQLite database access..."

# Define users and their respective ports
USERS=("debtconnects" "georgedc")
PORTS=(3001 3002)
API_SERVER="http://localhost:3000"

# Create temporary directory for the new agent code
mkdir -p /tmp/agent-update

# Write the new message agent code using your working SQLite approach
cat > /tmp/agent-update/message-agent.js << 'EOF'
// Enhanced message-agent.js with direct SQLite database access
const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const axios = require('axios');
const crypto = require('crypto');

const execPromise = promisify(exec);
const app = express();
const PORT = process.argv[2] || 3000;
const API_SERVER = process.argv[3] || 'http://localhost:3000';

// Parse JSON bodies
app.use(express.json());

// Get current username
const username = os.userInfo().username;
console.log(`Starting message agent for user: ${username}`);
console.log(`API Server: ${API_SERVER}`);

// Determine user ID and phone number in the number pool
let userId = '';
let phoneNumber = '';
switch(username) {
  case 'debtconnects':
    userId = 'user1';
    phoneNumber = '2087130507';
    break;
  case 'georgedc':
    userId = 'user2';
    phoneNumber = '3108710761';
    break;
  default:
    userId = 'unknown';
    phoneNumber = 'unknown';
}

// Store last processed message timestamp to avoid duplicates
let lastProcessedTime = new Date();

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    user: username,
    phoneNumber: phoneNumber,
    timestamp: new Date().toISOString()
  });
});

// Endpoint to send a message
app.post('/send', async (req, res) => {
  try {
    const { recipient, message, messageId, conversationId } = req.body;
    
    if (!recipient || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters: recipient and message'
      });
    }

    // Format the recipient phone number
    const cleanNumber = recipient.replace(/\D/g, '');
    const formattedRecipient = cleanNumber.startsWith('1') ? 
      `+${cleanNumber}` : 
      `+1${cleanNumber}`;
    
    // Create AppleScript to send the message
    const appleScript = `
      tell application "Messages"
        activate
        
        try
          set targetService to service "SMS"
          set targetBuddy to buddy "${formattedRecipient}" of targetService
          send "${message.replace(/"/g, '\\"')}" to targetBuddy
          return "SMS sent to ${formattedRecipient} from ${username}"
        on error
          set targetService to 1st service
          set targetBuddy to buddy "${formattedRecipient}" of targetService
          send "${message.replace(/"/g, '\\"')}" to targetBuddy
          return "Message sent to ${formattedRecipient} from ${username}"
        end try
      end tell
    `;
    
    // Write the script to a temporary file
    const tempPath = path.join(os.tmpdir(), `send_message_${Date.now()}.scpt`);
    await fs.writeFile(tempPath, appleScript);
    
    // Execute the AppleScript
    const { stdout, stderr } = await execPromise(`osascript ${tempPath}`);
    
    // Clean up
    await fs.unlink(tempPath);
    
    if (stderr) {
      throw new Error(stderr);
    }
    
    console.log(`Message sent to ${formattedRecipient}`);
    
    // Save to conversation file on the server
    try {
      console.log(`Storing outgoing message to ${formattedRecipient} in conversation...`);
      const messageData = {
        direction: 'outgoing',
        sender: {
          userId: userId,
          username: username,
          phoneNumber: phoneNumber
        },
        recipient: formattedRecipient,
        message: message,
        timestamp: new Date().toISOString(),
        conversationId: conversationId || crypto.randomBytes(8).toString('hex')
      };
      
      console.log(`Sending to API: ${API_SERVER}/api/store-message`);
      
      const response = await axios.post(`${API_SERVER}/api/store-message`, messageData);
      console.log(`Storage response:`, response.data);
    } catch (saveError) {
      console.error('Failed to save message to conversation:', saveError.message);
    }
    
    // Return success response
    res.json({
      success: true,
      messageId: messageId || crypto.randomBytes(8).toString('hex'),
      sender: username,
      recipient: formattedRecipient,
      timestamp: new Date().toISOString(),
      result: stdout.trim()
    });
    
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Function to check for new messages using direct SQLite approach that works
async function checkForNewMessages() {
  try {
    console.log("Checking for new messages via SQLite...");
    
    // Use the exact working SQLite command you provided
    const dbPath = `${os.homedir()}/Library/Messages/chat.db`;
    const sqlCommand = `sqlite3 "${dbPath}" "
      SELECT 
        datetime(message.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date_str,
        handle.id as sender,
        message.text as message_text
      FROM 
        message 
        LEFT JOIN handle ON message.handle_id = handle.ROWID
      ORDER BY 
        message.date DESC 
      LIMIT 20;
    "`;
    
    // Execute the SQLite command directly (no AppleScript)
    const { stdout, stderr } = await execPromise(sqlCommand);
    
    if (stderr) {
      console.error("Error executing SQLite command:", stderr);
      return;
    }
    
    console.log("Message data received from database");
    
    if (!stdout.trim()) {
      console.log("No messages found in database");
      return;
    }
    
    // Process each message line
    const messageLines = stdout.trim().split('\n');
    console.log(`Found ${messageLines.length} recent messages`);
    
    for (const line of messageLines) {
      // Format is date_str|sender|message_text
      const parts = line.split('|');
      if (parts.length >= 3) {
        const dateStr = parts[0].trim();
        const sender = parts[1].trim();
        // Join the rest in case message contains pipes
        const content = parts.slice(2).join('|').trim();
        const msgDate = new Date(dateStr);
        
        // Skip if it's an old message
        if (msgDate <= lastProcessedTime) {
          console.log(`Message from ${sender} at ${dateStr} already processed`);
          continue;
        }
        
        // Skip messages from ourself
        if (sender === phoneNumber || sender === `+1${phoneNumber}`) {
          console.log(`Skipping message from ourselves (${sender})`);
          continue;
        }
        
        console.log(`New message from ${sender}: ${content}`);
        
        // Forward to the server
        try {
          await axios.post(`${API_SERVER}/api/receive-message`, {
            from: sender,
            message: content,
            timestamp: msgDate.toISOString(),
            agentId: userId,
            agentPhone: phoneNumber
          });
          
          console.log(`Message from ${sender} saved to conversation`);
          
          // Update last processed time
          if (msgDate > lastProcessedTime) {
            lastProcessedTime = msgDate;
          }
        } catch (error) {
          console.error("Error saving message to conversation:", error.message);
        }
      }
    }
  } catch (error) {
    console.error("Error checking for messages:", error);
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Message agent for ${username} listening on port ${PORT}`);
  
  // Start the message checking loop
  console.log('Starting message listener...');
  
  // Initial check
  setTimeout(() => {
    checkForNewMessages();
    
    // Set up periodic checking
    setInterval(checkForNewMessages, 30000); // Check every 30 seconds
  }, 2000);
});
EOF

# Update each user's agent
for i in "${!USERS[@]}"; do
  USER=${USERS[$i]}
  PORT=${PORTS[$i]}
  
  echo "Updating agent for ${USER}..."
  
  # Stop the current agent if it's running (but this might not work due to auto-restart)
  echo "Stopping current agent for ${USER}..."
  sudo pkill -f "node /Users/${USER}/message-agent.js" || true
  sleep 2
  
  # Backup the existing agent
  if [ -f /Users/${USER}/message-agent.js ]; then
    sudo cp /Users/${USER}/message-agent.js /Users/${USER}/message-agent.js.bak.$(date +%s)
    echo "Created backup at /Users/${USER}/message-agent.js.bak.$(date +%s)"
  fi
  
  # Copy the new agent
  sudo cp /tmp/agent-update/message-agent.js /Users/${USER}/message-agent.js
  sudo chown ${USER}:staff /Users/${USER}/message-agent.js
  sudo chmod 755 /Users/${USER}/message-agent.js
  
  echo "Agent updated for ${USER}"
done

# Clean up
rm -rf /tmp/agent-update

echo "All agents updated successfully with direct SQLite approach!"
echo "Now restart the agents with:"
echo ""
echo "For debtconnects (user1):"
echo "sudo -u debtconnects nohup /usr/local/bin/node /Users/debtconnects/message-agent.js 3001 ${API_SERVER} > /Users/debtconnects/Library/Logs/messageagent.log 2>&1 &"
echo ""
echo "For georgedc (user2):"
echo "sudo -u georgedc nohup /usr/local/bin/node /Users/georgedc/message-agent.js 3002 ${API_SERVER} > /Users/georgedc/Library/Logs/messageagent.log 2>&1 &"