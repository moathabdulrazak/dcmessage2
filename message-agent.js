// Enhanced message-agent.js with improved blue vs green detection
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
    phoneNumber = '000000';
    break;
  case 'georgedc':
    userId = 'user2';
    phoneNumber = '00000';
    break;
  case 'johndc':
    userId = 'user3';
    phoneNumber = '2087614687';
    break;
  default:
    userId = 'unknown';
    phoneNumber = 'unknown';
}

// Track active message sends
const activeMessages = new Map();
const MAX_ATTEMPTS = 3;
const MESSAGE_TIMEOUT = 30000; // 30 seconds before we consider a message stuck

// Track conversations we've tried to initialize to avoid unnecessary retries
const initializedConversations = new Set();

// Track which recipients have been successfully sent to as iMessage
const blueMessageRecipients = new Set();

// Track which recipients have been successfully sent to as SMS
const greenMessageRecipients = new Set();

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    user: username,
    userId: userId,
    phoneNumber: phoneNumber,
    timestamp: new Date().toISOString(),
    pendingMessages: Array.from(activeMessages.entries()).map(([id, data]) => ({
      id,
      recipient: data.recipient,
      attempts: data.attempts,
      startTime: new Date(data.startTime).toISOString(),
      elapsed: Date.now() - data.startTime
    })),
    initializedConversations: Array.from(initializedConversations),
    blueMessageRecipients: Array.from(blueMessageRecipients),
    greenMessageRecipients: Array.from(greenMessageRecipients)
  });
});

// Function to detect and cancel stuck messages
function checkStuckMessages() {
  const now = Date.now();
  const stuckMessages = [];
  
  // Find messages that have been active too long
  for (const [msgId, data] of activeMessages.entries()) {
    const elapsed = now - data.startTime;
    
    if (elapsed > MESSAGE_TIMEOUT) {
      console.log(`Message ${msgId} to ${data.recipient} appears stuck (${Math.round(elapsed/1000)}s)`);
      stuckMessages.push({ msgId, data });
    }
  }
  
  // Process stuck messages
  for (const { msgId, data } of stuckMessages) {
    // Remove from active tracking
    activeMessages.delete(msgId);
    
    // If we haven't exceeded max attempts, retry
    if (data.attempts < MAX_ATTEMPTS) {
      console.log(`Attempting to retry stuck message to ${data.recipient} (attempt ${data.attempts + 1}/${MAX_ATTEMPTS})`);
      
      // On retry, force re-initialization
      const cleanNumber = data.recipient.replace(/\D/g, '');
      initializedConversations.delete(cleanNumber);
      
      // Also clear message type tracking to force re-detection
      blueMessageRecipients.delete(cleanNumber);
      greenMessageRecipients.delete(cleanNumber);
      
      // Send asynchronously to avoid blocking
      sendMessage(data.recipient, data.message, data.attempts + 1)
        .then(result => {
          console.log(`Successfully resent message to ${data.recipient}`);
          
          // Store in conversation
          storeMessageInConversation(data.recipient, data.message, data.conversationId)
            .catch(err => console.error('Error storing retried message:', err.message));
        })
        .catch(error => {
          console.error(`Failed to retry message to ${data.recipient}:`, error.message);
        });
    } else {
      console.log(`Maximum attempts (${MAX_ATTEMPTS}) reached for message to ${data.recipient}, giving up`);
    }
  }
}

// Initialize a conversation with empty message
async function initializeConversation(recipient) {
  console.log(`Initializing conversation with ${recipient} by sending empty string`);
  
  // Try to detect if it's an Apple device first
  let isAppleDevice = false;
  try {
    isAppleDevice = await detectAppleDevice(recipient);
    console.log(`Device detection for ${recipient}: ${isAppleDevice ? 'Apple device' : 'Non-Apple device'}`);
  } catch (error) {
    console.log(`Device detection failed: ${error.message}`);
  }
  
  // Approaches are ordered - we'll try Apple-specific approaches first for Apple devices
  let approaches = [];
  
  if (isAppleDevice) {
    approaches = [
      // Try iMessage first for Apple devices
      {
        name: "iMessage service",
        script: `
          tell application "Messages"
            send "" to buddy "${recipient}" of service "iMessage"
            return "Conversation initialized with ${recipient} using iMessage service"
          end tell
        `
      },
      // Then try generic approach
      {
        name: "No service",
        script: `
          tell application "Messages"
            send "" to buddy "${recipient}"
            return "Conversation initialized with ${recipient} using no service"
          end tell
        `
      },
      // Then try SMS approaches
      {
        name: "SMS service",
        script: `
          tell application "Messages"
            send "" to buddy "${recipient}" of service "SMS"
            return "Conversation initialized with ${recipient} using SMS service"
          end tell
        `
      }
    ];
  } else {
    approaches = [
      // First try with service "SMS" - most reliable for non-Apple devices
      {
        name: "SMS service",
        script: `
          tell application "Messages"
            send "" to buddy "${recipient}" of service "SMS"
            return "Conversation initialized with ${recipient} using SMS service"
          end tell
        `
      },
      // Try without specifying service (lets Messages decide)
      {
        name: "No service",
        script: `
          tell application "Messages"
            send "" to buddy "${recipient}"
            return "Conversation initialized with ${recipient} using no service"
          end tell
        `
      },
      // Try with service index 2 (usually SMS)
      {
        name: "Service index 2",
        script: `
          tell application "Messages"
            send "" to buddy "${recipient}" of service 2
            return "Conversation initialized with ${recipient} using service index 2"
          end tell
        `
      }
    ];
  }
  
  // Try each approach in sequence until one works
  for (const approach of approaches) {
    try {
      console.log(`Trying initialization approach: ${approach.name}`);
      
      const tempPath = path.join(os.tmpdir(), `init_${approach.name.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}.scpt`);
      await fs.writeFile(tempPath, approach.script);
      
      const { stdout, stderr } = await execPromise(`osascript ${tempPath}`);
      
      // Clean up
      try { await fs.unlink(tempPath); } catch (e) {}
      
      if (stderr) {
        throw new Error(stderr);
      }
      
      console.log(`Initialization result: ${stdout.trim()}`);
      return { success: true, result: stdout.trim(), approach: approach.name };
    } catch (err) {
      console.log(`Initialization approach ${approach.name} failed: ${err.message}`);
      // Will continue to the next approach
    }
  }
  
  // If we've tried all approaches and none worked
  throw new Error("Failed to initialize conversation with all approaches");
}

// Send a message, attempting to use the most appropriate method based on device type
async function sendMessage(recipient, message, attempt = 1, messageId = null) {
  // Generate message ID if not provided
  const msgId = messageId || crypto.randomBytes(8).toString('hex');

  // Format the recipient phone number
  const cleanNumber = recipient.replace(/\D/g, '');
  const formattedRecipient = cleanNumber.startsWith('1') ? 
    `+${cleanNumber}` : 
    `+1${cleanNumber}`;
  
  // Add to active messages for tracking
  activeMessages.set(msgId, {
    recipient: formattedRecipient,
    message: message,
    startTime: Date.now(),
    attempts: attempt,
    conversationId: null
  });
  
  console.log(`Preparing to send message to ${formattedRecipient} (attempt ${attempt}/${MAX_ATTEMPTS})`);
  
  try {
    // Initialize if not already done (or if this is a retry)
    if (!initializedConversations.has(cleanNumber) || attempt > 1) {
      try {
        await initializeConversation(formattedRecipient);
        initializedConversations.add(cleanNumber);
        // Wait a moment for Messages to process
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (initError) {
        // If initialization fails, continue anyway - it might work without it
        console.error(`Error initializing conversation: ${initError.message}`);
      }
    }
    
    // Detect if this is an Apple device
    let isAppleDevice = false;
    
    // If already known, use that information
    if (blueMessageRecipients.has(cleanNumber)) {
      isAppleDevice = true;
      console.log(`${formattedRecipient} is a known iMessage recipient`);
    } else if (greenMessageRecipients.has(cleanNumber)) {
      isAppleDevice = false;
      console.log(`${formattedRecipient} is a known SMS recipient`);
    } else {
      // Otherwise detect
      console.log(`Detecting if ${formattedRecipient} is an Apple device...`);
      try {
        isAppleDevice = await detectAppleDevice(formattedRecipient);
        console.log(`${formattedRecipient} is ${isAppleDevice ? 'an Apple device' : 'a non-Apple device'}`);
      } catch (detectError) {
        console.error(`Error detecting device type: ${detectError.message}`);
        // Default to false if detection fails
        isAppleDevice = false;
      }
    }
    
    // Determine which approach to use based on device type
    let approachesToTry = [];
    
    if (isAppleDevice) {
      // For Apple devices, try iMessage first
      approachesToTry = [
        // Try iMessage direct first
        {
          name: "iMessage direct",
          type: "blue",
          script: `
            tell application "Messages"
              send "${message.replace(/"/g, '\\"')}" to buddy "${formattedRecipient}" of service "iMessage"
              return "iMessage sent to ${formattedRecipient}"
            end tell
          `
        },
        // Try iMessage account 
        {
          name: "iMessage account",
          type: "blue",
          script: `
            tell application "Messages"
              set iMessageService to 1st service whose service type = iMessage
              set targetBuddy to buddy "${formattedRecipient}" of service iMessageService
              send "${message.replace(/"/g, '\\"')}" to targetBuddy
              return "iMessage sent to ${formattedRecipient} via account"
            end tell
          `
        },
        // Try iMessage index 1
        {
          name: "iMessage index",
          type: "blue",
          script: `
            tell application "Messages"
              send "${message.replace(/"/g, '\\"')}" to buddy "${formattedRecipient}" of service 1
              return "iMessage sent to ${formattedRecipient} via service index"
            end tell
          `
        },
        // Try generic approach as fallback
        {
          name: "Generic approach",
          type: "unknown",
          script: `
            tell application "Messages"
              send "${message.replace(/"/g, '\\"')}" to buddy "${formattedRecipient}"
              return "Message sent to ${formattedRecipient} via generic approach"
            end tell
          `
        },
        // As a last resort, try SMS
        {
          name: "SMS fallback",
          type: "green",
          script: `
            tell application "Messages"
              send "${message.replace(/"/g, '\\"')}" to buddy "${formattedRecipient}" of service "SMS"
              return "SMS sent to ${formattedRecipient} as fallback"
            end tell
          `
        }
      ];
    } else {
      // For non-Apple devices, try SMS approaches
      approachesToTry = [
        // Try SMS direct first
        {
          name: "SMS direct",
          type: "green",
          script: `
            tell application "Messages"
              send "${message.replace(/"/g, '\\"')}" to buddy "${formattedRecipient}" of service "SMS"
              return "SMS sent to ${formattedRecipient}"
            end tell
          `
        },
        // Try SMS account
        {
          name: "SMS account",
          type: "green",
          script: `
            tell application "Messages"
              set SMSService to 1st service whose service type = SMS
              set targetBuddy to buddy "${formattedRecipient}" of service SMSService
              send "${message.replace(/"/g, '\\"')}" to targetBuddy
              return "SMS sent to ${formattedRecipient} via account"
            end tell
          `
        },
        // Try SMS index 2
        {
          name: "SMS index",
          type: "green",
          script: `
            tell application "Messages"
              send "${message.replace(/"/g, '\\"')}" to buddy "${formattedRecipient}" of service 2
              return "SMS sent to ${formattedRecipient} via service index"
            end tell
          `
        },
        // Try generic approach as fallback
        {
          name: "Generic approach",
          type: "unknown",
          script: `
            tell application "Messages"
              send "${message.replace(/"/g, '\\"')}" to buddy "${formattedRecipient}"
              return "Message sent to ${formattedRecipient} via generic approach"
            end tell
          `
        }
      ];
    }
    
    // Try each approach in sequence
    for (const approach of approachesToTry) {
      try {
        console.log(`Trying to send message using approach: ${approach.name}`);
        
        const tempPath = path.join(os.tmpdir(), `send_${approach.name.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}.scpt`);
        await fs.writeFile(tempPath, approach.script);
        
        const { stdout, stderr } = await execPromise(`osascript ${tempPath}`);
        
        // Clean up the temp file
        try { await fs.unlink(tempPath); } catch (e) {}
        
        if (stderr) {
          throw new Error(stderr);
        }
        
        console.log(`Message sent to ${formattedRecipient} using ${approach.name}: ${stdout.trim()}`);
        
        // Note this successful approach for future sends
        if (approach.type === 'blue') {
          blueMessageRecipients.add(cleanNumber);
        } else if (approach.type === 'green') {
          greenMessageRecipients.add(cleanNumber);
        }
        
        // Message sent successfully, remove from active tracking
        activeMessages.delete(msgId);
        
        return {
          success: true,
          messageId: msgId,
          result: stdout.trim(),
          approach: approach.name,
          messageType: approach.type
        };
      } catch (err) {
        console.log(`${approach.name} approach failed: ${err.message}`);
        // Will continue to the next approach
      }
    }
    
    // If all approaches failed, throw an error
    throw new Error("All message sending approaches failed");
  } catch (error) {
    console.error(`Error sending message (attempt ${attempt}):`, error.message);
    
    // Clear initialization status to force a retry with initialization
    initializedConversations.delete(cleanNumber);
    
    // Also clear message type tracking to force re-detection
    blueMessageRecipients.delete(cleanNumber);
    greenMessageRecipients.delete(cleanNumber);
    
    // If we haven't reached max attempts, retry after delay
    if (attempt < MAX_ATTEMPTS) {
      console.log(`Will retry automatically in ${attempt * 2} seconds...`);
      
      // Remove from active messages while waiting, will be re-added on retry
      activeMessages.delete(msgId);
      
      // Wait with exponential backoff
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
      
      // Try again with incremented attempt count
      return sendMessage(recipient, message, attempt + 1, msgId);
    }
    
    // Maximum attempts reached, clean up and rethrow
    activeMessages.delete(msgId);
    throw error;
  }
}

// Better detection of Apple devices
async function detectAppleDevice(recipient) {
  // Some newer iOS devices may have a number without registering for iMessage
  // This function will check if the device is registered with iMessage
  
  try {
    // Query approach 1: Try to specifically check if this is a valid iMessage recipient
    const checkScript1 = `
      tell application "Messages"
        -- Try to check if this buddy exists in iMessage service
        set canUseIMessage to false
        try
          set iMessageService to service "iMessage"
          set theBuddy to buddy "${recipient}" of service "iMessage"
          set canUseIMessage to true
        on error
          set canUseIMessage to false
        end try
        return canUseIMessage
      end tell
    `;
    
    const tempPath1 = path.join(os.tmpdir(), `detect_apple_1_${Date.now()}.scpt`);
    await fs.writeFile(tempPath1, checkScript1);
    
    const { stdout, stderr } = await execPromise(`osascript ${tempPath1}`);
    
    // Clean up
    try { await fs.unlink(tempPath1); } catch (e) {}
    
    if (stderr) {
      throw new Error(stderr);
    }
    
    // If the first approach detects iMessage, return true
    if (stdout.trim().toLowerCase() === 'true') {
      console.log(`${recipient} is confirmed as an Apple device (iMessage available)`);
      return true;
    }
    
    // If the first approach didn't work, try another approach
    console.log(`First detection approach didn't confirm iMessage, trying alternative...`);
    
    // Query approach 2: Try to get service info differently
    const checkScript2 = `
      tell application "Messages"
        try
          set availableServices to {}
          set theHandle to "${recipient}"
          set allServices to every service
          repeat with currentService in allServices
            try
              set testBuddy to buddy theHandle of currentService
              set end of availableServices to (service type of currentService)
            on error
              -- This service doesn't have this buddy, skip
            end try
          end repeat
          
          -- Check if "iMessage" is in the list of services
          repeat with svcType in availableServices
            if svcType as string is "iMessage" then
              return "true"
            end if
          end repeat
          return "false"
        on error errMsg
          return "error: " & errMsg
        end try
      end tell
    `;
    
    const tempPath2 = path.join(os.tmpdir(), `detect_apple_2_${Date.now()}.scpt`);
    await fs.writeFile(tempPath2, checkScript2);
    
    const result2 = await execPromise(`osascript ${tempPath2}`);
    
    // Clean up
    try { await fs.unlink(tempPath2); } catch (e) {}
    
    if (result2.stderr) {
      throw new Error(result2.stderr);
    }
    
    // Check result - if it has "true" (text value) it's an Apple device
    const isApple = result2.stdout.trim().toLowerCase() === 'true';
    console.log(`Second detection approach result for ${recipient}: ${isApple ? 'Apple device' : 'Not an Apple device'}`);
    return isApple;
  } catch (error) {
    console.error(`Error in Apple device detection: ${error.message}`);
    // Default to non-Apple device on error
    return false;
  }
}

// Helper function to store message in conversation
async function storeMessageInConversation(recipient, message, conversationId = null) {
  // Standardize phone number for API
  const cleanNumber = recipient.replace(/\D/g, '');
  const standardPhone = cleanNumber.replace(/^1/, '');
  
  // First check if a conversation exists
  let convoId = conversationId;
  if (!convoId) {
    try {
      // Check if a conversation exists for this number
      const checkResponse = await axios.get(`${API_SERVER}/api/check-conversation`, {
        params: { phone: standardPhone }
      });
      
      if (checkResponse.data.success && checkResponse.data.exists) {
        convoId = checkResponse.data.conversationId;
        console.log(`Found existing conversation: ${convoId}`);
      }
    } catch (err) {
      console.error("Error checking for existing conversation:", err.message);
    }
  }
  
  console.log(`Storing outgoing message to ${standardPhone} in conversation...`);
  
  // Prepare the message data
  const messageData = {
    direction: 'outgoing',
    sender: {
      userId: userId,
      username: username,
      phoneNumber: phoneNumber
    },
    recipient: standardPhone,
    message: message,
    timestamp: new Date().toISOString(),
    conversationId: convoId
  };
  
  console.log(`Sending to API: ${API_SERVER}/api/store-message`);
  
  // Send to API
  const response = await axios.post(`${API_SERVER}/api/store-message`, messageData);
  console.log(`Storage response:`, response.data);
  
  return response.data;
}

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
    
    // Check for conversation ID first
    let convoId = conversationId;
    if (!convoId) {
      try {
        // Standardize phone for API
        const cleanNumber = recipient.replace(/\D/g, '');
        const standardPhone = cleanNumber.replace(/^1/, '');
        
        // Check if a conversation exists for this number
        const checkResponse = await axios.get(`${API_SERVER}/api/check-conversation`, {
          params: { phone: standardPhone }
        });
        
        if (checkResponse.data.success && checkResponse.data.exists) {
          convoId = checkResponse.data.conversationId;
          console.log(`Found existing conversation: ${convoId}`);
        }
      } catch (err) {
        console.error("Error checking for existing conversation:", err.message);
      }
    }

    // Try to send the message with retry logic
    const sendResult = await sendMessage(recipient, message, 1, messageId);
    
    // Save to conversation file on the server
    try {
      const storeResult = await storeMessageInConversation(recipient, message, convoId);
      convoId = storeResult.conversationId;
    } catch (saveError) {
      console.error('Failed to save message to conversation:', saveError.message);
    }
    
    // Return success response
    res.json({
      success: true,
      messageId: sendResult.messageId,
      sender: username,
      recipient: recipient,
      timestamp: new Date().toISOString(),
      conversationId: convoId,
      result: sendResult.result,
      approach: sendResult.approach || "unknown",
      messageType: sendResult.messageType || "unknown"
    });
    
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Add an endpoint to manually reset a conversation's initialization status
app.post('/reset-initialization', async (req, res) => {
  try {
    const { recipient } = req.body;
    
    if (!recipient) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameter: recipient'
      });
    }
    
    // Remove from initialized conversations
    const cleanNumber = recipient.replace(/\D/g, '');
    initializedConversations.delete(cleanNumber);
    
    // Also clear message type tracking
    blueMessageRecipients.delete(cleanNumber);
    greenMessageRecipients.delete(cleanNumber);
    
    // Return success response
    res.json({
      success: true,
      recipient: recipient,
      timestamp: new Date().toISOString(),
      message: `Removed ${cleanNumber} from initialized conversations`
    });
    
  } catch (error) {
    console.error('Error resetting initialization:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Keep track of processed message IDs to avoid duplicates
let processedMessageIds = new Set();

// Load processed message IDs from file
async function loadProcessedIds() {
  try {
    const idFilePath = path.join(os.homedir(), '.processed-message-ids.json');
    const content = await fs.readFile(idFilePath, 'utf8');
    const ids = JSON.parse(content);
    processedMessageIds = new Set(ids);
    console.log(`Loaded ${processedMessageIds.size} processed message IDs`);
  } catch (err) {
    console.log("Starting with empty processed message IDs");
    processedMessageIds = new Set();
  }
}

// Save processed message IDs to file
async function saveProcessedIds() {
  try {
    const idFilePath = path.join(os.homedir(), '.processed-message-ids.json');
    const idsArray = Array.from(processedMessageIds);
    
    // Limit size to prevent excessive growth
    const maxIdsToStore = 1000;
    const trimmedIds = idsArray.slice(-maxIdsToStore);
    
    await fs.writeFile(idFilePath, JSON.stringify(trimmedIds));
    console.log(`Saved ${trimmedIds.length} processed message IDs`);
  } catch (err) {
    console.error("Error saving processed message IDs:", err);
  }
}

// Function to check for new messages
async function checkForNewMessages() {
  try {
    console.log("Checking for new messages...");
    
    // Load processed IDs at the start
    await loadProcessedIds();
    
    // Direct sqlite3 shell command to get individual messages correctly
    const dbPath = path.join(os.homedir(), '/Library/Messages/chat.db');
    
    // Use a shell script to run the SQLite query with proper escaping
    // This retrieves ONE MESSAGE AT A TIME, separately, with its own fields
    const shellScript = `
      sqlite3 -separator '¶' "${dbPath}" "
        SELECT 
          message.ROWID,
          datetime(message.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime'),
          handle.id,
          message.text,
          message.is_from_me,
          message.service
        FROM 
          message 
          LEFT JOIN handle ON message.handle_id = handle.ROWID
        WHERE 
          message.date > (strftime('%s', 'now', '-2 hours') - strftime('%s', '2001-01-01')) * 1000000000
          AND message.text IS NOT NULL
        ORDER BY 
          message.date DESC 
        LIMIT 20;
      "
    `;
    
    // Execute the shell script directly
    const { stdout, stderr } = await execPromise(shellScript);
    
    if (stderr) {
      console.error("Error executing shell script:", stderr);
      return;
    }
    
    if (!stdout.trim()) {
      console.log("No messages found in database");
      return;
    }
    
    // Process each message line - one per message
    const messageLines = stdout.trim().split('\n');
    console.log(`Found ${messageLines.length} recent messages`);
    
    let newMessagesFound = false;
    
    for (const line of messageLines) {
      const parts = line.split('¶');
      if (parts.length < 5) {
        console.log(`Invalid message format: ${line}`);
        continue;
      }
      
      const messageId = parts[0].trim();
      const dateStr = parts[1].trim();
      const sender = parts[2].trim();
      const content = parts[3].trim();
      const isFromMe = parts[4].trim() === '1';
      const service = parts.length > 5 ? parts[5].trim() : '';
      
      // Skip if we've already processed this message
      if (processedMessageIds.has(messageId)) {
        continue;
      }
      
      console.log(`Processing message ${messageId} from ${sender}: ${content.substring(0, 30)}${content.length > 30 ? '...' : ''}`);
      
      // Track if this is a blue or green message based on service
      const cleanSender = sender.replace(/\D/g, '');
      if (service === 'iMessage') {
        blueMessageRecipients.add(cleanSender);
        console.log(`Marked ${sender} as an iMessage (blue) recipient based on received message`);
      } else if (service) {
        greenMessageRecipients.add(cleanSender);
        console.log(`Marked ${sender} as an SMS (green) recipient based on received message`);
      }
      
      // For incoming messages
      if (!isFromMe) {
        try {
          // Skip messages from our own number
          const senderClean = sender.replace(/\D/g, '').replace(/^1/, '');
          const ourNumberClean = phoneNumber.replace(/\D/g, '').replace(/^1/, '');
          
          if (senderClean === ourNumberClean) {
            console.log(`Skipping message from our own number`);
            processedMessageIds.add(messageId);
            continue;
          }
          
          console.log(`Processing incoming message from ${sender}`);
          
          const msgDate = new Date(dateStr);
          
          // First check if conversation exists
          let convoId = null;
          try {
            const standardSender = sender.replace(/\D/g, '').replace(/^1/, '');
            const checkResponse = await axios.get(`${API_SERVER}/api/check-conversation`, {
              params: { phone: standardSender }
            });
            
            if (checkResponse.data.success && checkResponse.data.exists) {
              convoId = checkResponse.data.conversationId;
              console.log(`Found existing conversation: ${convoId}`);
            }
          } catch (err) {
            console.error("Error checking for existing conversation:", err.message);
          }
          
          // Send to API
          const response = await axios.post(`${API_SERVER}/api/receive-message`, {
            from: sender,
            message: content,
            timestamp: msgDate.toISOString(),
            agentId: userId,
            agentPhone: phoneNumber,
            conversationId: convoId
          });
          
          console.log(`Incoming message saved to conversation ${response.data.conversationId}`);
          newMessagesFound = true;
          
          // Mark this conversation as initialized since we received a message from it
          initializedConversations.add(cleanSender);
        } catch (error) {
          console.error(`Error saving incoming message:`, error.message);
        }
      }
      
      // Mark as processed
      processedMessageIds.add(messageId);
    }
    
    // Save processed IDs
    await saveProcessedIds();
    
    if (newMessagesFound) {
      console.log("New messages processed successfully");
    } else {
      console.log("No new unprocessed messages found");
    }
    
  } catch (error) {
    console.error("Error checking for messages:", error);
  }
}

// Function to check for failed messages in Messages.app
async function checkForFailedMessages() {
  try {
    console.log("Checking for failed messages...");
    
    // Query the database directly for failed message status
    const dbPath = path.join(os.homedir(), '/Library/Messages/chat.db');
    
    const shellScript = `
      sqlite3 -separator '¶' "${dbPath}" "
        SELECT 
          handle.id,
          message.is_from_me,
          message.is_sent,
          message.is_delivered,
          message.is_finished,
          message.service
        FROM 
          message 
          LEFT JOIN handle ON message.handle_id = handle.ROWID
        WHERE 
          message.date > (strftime('%s', 'now', '-1 hour') - strftime('%s', '2001-01-01')) * 1000000000
          AND message.is_from_me = 1
          AND (message.is_sent = 0 OR message.is_delivered = 0 OR message.is_finished = 0)
        GROUP BY 
          handle.id
        LIMIT 20;
      "
    `;
    
    // Execute the query
    const { stdout, stderr } = await execPromise(shellScript);
    
    if (stderr) {
      console.error("Error executing shell script:", stderr);
      return;
    }
    
    if (!stdout.trim()) {
      // No failed messages
      return;
    }
    
    // Process each line
    const messageLines = stdout.trim().split('\n');
    console.log(`Found ${messageLines.length} conversations with failed messages`);
    
    for (const line of messageLines) {
      const parts = line.split('¶');
      if (parts.length < 5) {
        continue;
      }
      
      const phoneId = parts[0].trim();
      const cleanNumber = phoneId.replace(/\D/g, '');
      const service = parts.length > 5 ? parts[5].trim() : '';
      
      console.log(`Detected failed message to ${phoneId}, will re-initialize on next send`);
      
      // Remove from initialized to force re-init
      initializedConversations.delete(cleanNumber);
      
      // Also clear message type tracking to force re-detection
      if (service === 'iMessage') {
        // If iMessage failed, remove from blue recipients
        blueMessageRecipients.delete(cleanNumber);
      } else {
        // If SMS failed, remove from green recipients
        greenMessageRecipients.delete(cleanNumber);
      }
    }
    
  } catch (error) {
    console.error("Error checking for failed messages:", error);
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Message agent for ${username} listening on port ${PORT}`);
  
  // Start the message checking loop
  console.log('Starting message listener...');
  
  // Load initial processed IDs
  loadProcessedIds().then(() => {
    // Initial check
    setTimeout(() => {
      checkForNewMessages();
      
      // Set up periodic checking for new messages
      setInterval(checkForNewMessages, 10000); // Check every 10 seconds
      
      // Set up periodic checking for stuck messages
      setInterval(checkStuckMessages, 5000); // Check every 5 seconds
      
      // Set up periodic checking for failed messages
      setInterval(checkForFailedMessages, 15000); // Check every 15 seconds
    }, 2000);
  });
});

