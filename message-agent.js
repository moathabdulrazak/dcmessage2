// Combined Message Agent with pageId system, reliable typing indicators, and robust message sending
// This service runs on a Mac, interacts with the Messages app via AppleScript/UI automation for sending,
// and queries the chat.db file to detect incoming messages.
// It fetches its assigned pageId from the main API server on startup,
// checks for existing conversations using that pageId, and forwards incoming messages to the API server.


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
const PORT = process.argv[2] || 3001;
const API_SERVER = process.argv[3] || 'http://localhost:3000';


// Parse JSON bodies
app.use(express.json());


// Get current username
const username = os.userInfo().username;
console.log(`Starting combined message agent for user: ${username}`);
console.log(`API Server: ${API_SERVER}`);


// Determine user ID and phone number based on the system username
let userId = '';
let phoneNumber = '';
let assignedPageId = null; // Variable to store the fetched pageId


switch(username) {
 case 'debtconnects':
   userId = 'user1';
   phoneNumber = '000000'; // Replace with actual number
   break;
 case 'georgedc':
   userId = 'user2';
   phoneNumber = '00000'; // Replace with actual number
   break;
 case 'johndc':
   userId = 'user3';
   phoneNumber = '2087614687';
   break;
 default:
   userId = 'unknown';
   phoneNumber = 'unknown';
   console.warn(`Unknown username "${username}". Agent will not be able to identify itself.`);
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


// Set to store IDs of messages already processed from chat.db
const processedMessageIds = new Set();
const PROCESSED_IDS_FILE = path.join(os.tmpdir(), `processed_message_ids_${username}.json`);


// --- Helper Functions for Processed IDs Persistence ---


/**
* Loads processed message IDs from a file.
*/
async function loadProcessedIds() {
 try {
   const data = await fs.readFile(PROCESSED_IDS_FILE, 'utf8');
   const ids = JSON.parse(data);
   processedMessageIds.clear();
   ids.forEach(id => processedMessageIds.add(id));
   console.log(`Loaded ${processedMessageIds.size} processed message IDs from ${PROCESSED_IDS_FILE}`);
 } catch (error) {
   // Ignore error if file doesn't exist (first run)
   if (error.code !== 'ENOENT') {
     console.error(`Error loading processed message IDs:`, error.message);
   } else {
     console.log(`Processed IDs file not found, starting fresh: ${PROCESSED_IDS_FILE}`);
   }
 }
}


/**
* Saves processed message IDs to a file.
*/
async function saveProcessedIds() {
 try {
   const idsArray = Array.from(processedMessageIds);
  
   // Limit size to prevent excessive growth
   const maxIdsToStore = 1000;
   const trimmedIds = idsArray.slice(-maxIdsToStore);
  
   await fs.writeFile(PROCESSED_IDS_FILE, JSON.stringify(trimmedIds), 'utf8');
   console.log(`Saved ${trimmedIds.length} processed message IDs to ${PROCESSED_IDS_FILE}`);
 } catch (error) {
   console.error(`Error saving processed message IDs:`, error.message);
 }
}


// Set up interval to save processed IDs periodically
setInterval(saveProcessedIds, 60000); // Save every 1 minute


// Simple health check endpoint
app.get('/health', (req, res) => {
 res.json({
   status: 'ok',
   user: username,
   userId: userId,
   phoneNumber: phoneNumber,
   assignedPageId: assignedPageId,
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
   greenMessageRecipients: Array.from(greenMessageRecipients),
   processedMessageIdsCount: processedMessageIds.size
 });
});


// Function to detect and cancel stuck messages
function checkStuckMessages() {
 const now = Date.now();
 const stuckMessages = [];
  // Find messages that have been active too long
 for (const [msgId, data] of activeMessages.entries()) {
   if (!msgId || !data) continue;
  
   const elapsed = now - data.startTime;
  
   if (elapsed > MESSAGE_TIMEOUT) {
     console.log(`Message ${msgId} to ${data.recipient} appears stuck (${Math.round(elapsed/1000)}s)`);
     stuckMessages.push({ msgId, data });
   }
 }
  // Process stuck messages
 for (const { msgId, data } of stuckMessages) {
   if (!msgId || !data) continue;
  
   // Remove from active tracking
   activeMessages.delete(msgId);
  
   // If we haven't exceeded max attempts, retry
   if (data.attempts < MAX_ATTEMPTS) {
     console.log(`Attempting to retry stuck message to ${data.recipient} (attempt ${data.attempts + 1}/${MAX_ATTEMPTS})`);
    
     // On retry, force re-initialization
     const cleanNumber = data.recipient.replace(/\D/g, '');
     if (cleanNumber) {
       initializedConversations.delete(cleanNumber);
      
       // Also clear message type tracking to force re-detection
       blueMessageRecipients.delete(cleanNumber);
       greenMessageRecipients.delete(cleanNumber);
     }
    
     // Send asynchronously to avoid blocking
     sendMessage(data.recipient, data.message, data.attempts + 1, msgId)
       .then(result => {
         console.log(`Successfully resent message to ${data.recipient}`);
       })
       .catch(error => {
         console.error(`Failed to retry message to ${data.recipient}:`, error.message);
       });
   } else {
     console.log(`Maximum attempts (${MAX_ATTEMPTS}) reached for message to ${data.recipient}, giving up`);
   }
 }
}


// Helper function to run a script for sending
async function runAppleScript(script, approachName = 'AppleScript') {
 // AGGRESSIVELY clean up the script by removing ALL extra whitespace
 const cleanedScript = script.trim().split('\n').map(line => line.trimStart()).join('\n');
  const scriptSafeName = (approachName || 'unknown').replace(/\s+/g, '_').toLowerCase();
 const tempPath = path.join(os.tmpdir(), `script_${scriptSafeName}_${Date.now()}.scpt`);
 await fs.writeFile(tempPath, cleanedScript);
  try {
   const { stdout, stderr } = await execPromise(`osascript ${tempPath}`);
  
   // Log stderr if present, but only throw if it's not empty
   if (stderr) {
     console.warn(`Script stderr (${approachName}):`, stderr.trim());
   }
  
   console.log(`Script stdout (${approachName}):`, stdout.trim());
  
   // Check for specific error patterns in stdout or stderr that indicate failure
   if (stdout.trim().toLowerCase().includes('error') || stderr.trim().toLowerCase().includes('error')) {
     throw new Error(`AppleScript Error (${approachName}): ${stderr.trim() || stdout.trim()}`);
   }
  
   return { stdout: stdout.trim(), stderr: stderr.trim() };
 } finally {
   // Clean up
   try { await fs.unlink(tempPath); } catch (e) {
     console.error(`Error cleaning up temp script file ${tempPath}:`, e.message);
   }
 }
}


// Initialize a conversation using UI automation - this is the key fix for first messages
async function initializeConversation(recipient) {
 if (!recipient) {
   throw new Error("No recipient provided for initialization");
 }
  const cleanNumber = recipient.replace(/\D/g, '');
  // Avoid re-initializing if already done recently
 if (initializedConversations.has(cleanNumber)) {
   console.log(`Conversation with ${recipient} already initialized recently, skipping UI init.`);
   return;
 }
  console.log(`Initializing conversation with ${recipient} using UI automation`);
  try {
   // First activate Messages app
   await runAppleScript('tell application "Messages" to activate', 'Activate Messages');
   // Wait for Messages to fully activate
   await new Promise(resolve => setTimeout(resolve, 1000));
  
   // First cancel any existing new message dialog that might be open
   const cancelScript = `
     tell application "System Events"
       tell process "Messages"
         try
           click button "Cancel" of sheet 1 of window 1
         end try
       end tell
     end tell
   `;
  
   await runAppleScript(cancelScript, 'Cancel Dialog');
  
   // Create new message using UI automation
   const startNewMessageScript = `
     tell application "System Events"
       tell process "Messages"
         -- Bring the process to the front
         set frontmost to true
         delay 0.5
        
         -- Try keyboard shortcut first (Command+N) to open new message window
         keystroke "n" using command down
         delay 1.0
        
         -- Enter recipient
         keystroke "${recipient}"
         delay 1.0
        
         -- Press Return to select recipient and move to the message field
         key code 36
         delay 1.0
        
         return "Conversation initialized with ${recipient} via UI automation"
       end tell
     end tell
   `;
  
   await runAppleScript(startNewMessageScript, 'UI Init Sequence');
  
   // Mark as initialized
   initializedConversations.add(cleanNumber);
   console.log(`UI initialization sequence completed for ${recipient}`);
  
   // Wait for the UI to settle
   await new Promise(resolve => setTimeout(resolve, 1500));
  
   // Attempt to detect if this is an Apple device
   const isAppleDevice = await detectAppleDevice(recipient);
   if (isAppleDevice) {
     blueMessageRecipients.add(cleanNumber);
   } else {
     greenMessageRecipients.add(cleanNumber);
   }
  
   return;
 } catch (uiError) {
   console.error(`UI automation initialization failed: ${uiError.message}`);
  
   // Fall back to traditional AppleScript approaches
   console.log("Falling back to traditional AppleScript initialization");
  
   try {
     // Try generic initialization
     const genericScript = `
       tell application "Messages"
         set targetBuddy to "${recipient}"
         set theChat to make new chat with buddy targetBuddy
         return "Conversation initialized with ${recipient} using generic approach"
       end tell
     `;
    
     await runAppleScript(genericScript, 'Generic Initialization');
     initializedConversations.add(cleanNumber);
     return;
   } catch (genericError) {
     console.error(`Generic initialization failed: ${genericError.message}`);
    
     try {
       // Try iMessage initialization
       const iMessageScript = `
         tell application "Messages"
           set targetBuddy to "${recipient}" of service "iMessage"
           set theChat to make new chat with buddy targetBuddy
           return "Conversation initialized with ${recipient} using iMessage"
         end tell
       `;
      
       await runAppleScript(iMessageScript, 'iMessage Initialization');
       initializedConversations.add(cleanNumber);
       blueMessageRecipients.add(cleanNumber);
       return;
     } catch (iMessageError) {
       console.error(`iMessage initialization failed: ${iMessageError.message}`);
      
       try {
         // Try SMS initialization as last resort
         const smsScript = `
           tell application "Messages"
             set targetBuddy to "${recipient}" of service "SMS"
             set theChat to make new chat with buddy targetBuddy
             return "Conversation initialized with ${recipient} using SMS"
           end tell
         `;
        
         await runAppleScript(smsScript, 'SMS Initialization');
         initializedConversations.add(cleanNumber);
         greenMessageRecipients.add(cleanNumber);
         return;
       } catch (smsError) {
         console.error(`SMS initialization failed: ${smsError.message}`);
         // Don't add to initializedConversations if all attempts fail
         throw new Error(`All initialization methods failed for ${recipient}`);
       }
     }
   }
 }
}


// Better detection of Apple devices
async function detectAppleDevice(recipient) {
 if (!recipient) {
   return false;
 }
  const cleanNumber = recipient.replace(/\D/g, '');
  // Use cached knowledge if available
 if (blueMessageRecipients.has(cleanNumber)) {
   return true;
 }
  if (greenMessageRecipients.has(cleanNumber)) {
   return false;
 }
  console.log(`Attempting to detect device type for ${recipient}...`);
  try {
   // AppleScript to check if the recipient is available on the iMessage service
   const checkScript = `
     tell application "Messages"
       try
         -- Attempt to get the buddy on the iMessage service
         set theBuddy to buddy "${recipient}" of service "iMessage"
         -- If successful, it's an iMessage buddy
         return "true"
       on error errMsg
         -- If an error occurs, it's likely not an iMessage buddy
         return "false"
       end try
     end tell
   `;
  
   const { stdout } = await runAppleScript(checkScript, 'Detect iMessage Service');
  
   const isApple = stdout.trim().toLowerCase() === 'true';
   console.log(`Device type detection result for ${recipient}: ${isApple ? 'Apple device' : 'Not an Apple device'}`);
  
   // Cache the result
   if (isApple) {
     blueMessageRecipients.add(cleanNumber);
   } else {
     greenMessageRecipients.add(cleanNumber);
   }
  
   return isApple;
 } catch (error) {
   console.error(`Error in Apple device detection script for ${recipient}:`, error.message);
   // Default to non-Apple device on script error
   return false;
 }
}


// Trigger typing indicator using UI automation
async function triggerTypingIndicator(recipient) {
 if (!recipient) {
   return false;
 }
  console.log(`Attempting to trigger typing indicator for ${recipient}...`);
  try {
   // Script to simulate typing by entering and deleting characters
   const typingScript = `
     tell application "Messages" to activate
     delay 0.5
    
     tell application "System Events"
       tell process "Messages"
         -- Ensure focus is in the message input field
         keystroke tab
         delay 0.3
        
         -- Type a few characters and delete them
         keystroke "abc"
         delay 0.5
         repeat 3 times
           key code 51 -- Backspace/Delete key
           delay 0.1
         end repeat
        
         -- Type a space to leave the field ready for the actual message
         keystroke " "
         delay 0.2
        
         return "Typing indicator sequence executed."
       end tell
     end tell
   `;
  
   await runAppleScript(typingScript, 'Typing Indicator UI Automation');
  
   console.log(`Typing indicator script executed for ${recipient}.`);
   // Wait a moment for the indicator to appear before sending the message
   await new Promise(resolve => setTimeout(resolve, 1000));
  
   return true;
 } catch (error) {
   console.error(`Failed to trigger typing indicator for ${recipient}:`, error.message);
   return false;
 }
}


// SIMPLE working solution that just adds a Command+N before sending
// This preserves the original functionality while ensuring new conversations
async function sendMessage(recipient, message, attempt = 1, messageId = null) {
 if (!recipient) {
   throw new Error("No recipient provided for message");
 }
  if (!message) {
   throw new Error("No message content provided");
 }
  // CRITICAL FIX: Ensure message has no leading/trailing spaces
 message = message.trim();
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
   attempts: attempt
 });
  console.log(`Preparing to send message to ${formattedRecipient} (attempt ${attempt}/${MAX_ATTEMPTS})`);
  try {
   // SIMPLE CRITICAL FIX: For the first attempt, always force a new conversation with Command+N
   // This is all we need to ensure messages go to the right recipient
   if (attempt === 1) {
     try {
       // Force a new message window with Command+N
       console.log("Opening a new conversation window with Command+N");
       const newConvoScript = `
         tell application "Messages" to activate
         delay 0.5
        
         tell application "System Events"
           tell process "Messages"
             -- Create a new message with Command+N
             keystroke "n" using command down
             delay 1.0
            
             -- Enter recipient
             keystroke "${formattedRecipient}"
             delay 1.0
            
             -- Press Return to select recipient and move to message field
             key code 36
             delay 1.0
            
             return "New conversation window opened"
           end tell
         end tell
       `;
      
       await runAppleScript(newConvoScript, 'New Conversation');
       initializedConversations.add(cleanNumber);
      
       // Wait a moment for Messages app to process
       await new Promise(resolve => setTimeout(resolve, 1000));
     } catch (newConvoError) {
       console.error(`Error creating new conversation: ${newConvoError.message}`);
       // Continue anyway, we'll try the regular initialization
     }
   }
  
   // Now do the regular initialization if needed (only if not already initialized)
   if (!initializedConversations.has(cleanNumber)) {
     try {
       await initializeConversation(formattedRecipient);
      
       // Wait a moment for Messages to process the initialization
       await new Promise(resolve => setTimeout(resolve, 1000));
     } catch (initError) {
       console.error(`Error initializing conversation: ${initError.message}`);
       // Continue anyway, but mark as not initialized for retry
       initializedConversations.delete(cleanNumber);
     }
   }
  
   // Detect if this is an Apple device for message type selection
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
  
   // For iMessage recipients, trigger typing indicator before sending
   let typingIndicatorShown = false;
   if (isAppleDevice) {
     console.log(`Will show typing indicator for iMessage to ${formattedRecipient}`);
     try {
       const success = await triggerTypingIndicator(formattedRecipient);
      
       if (success) {
         console.log(`Typing indicator shown for ${formattedRecipient}`);
         typingIndicatorShown = true;
       } else {
         console.log(`Failed to trigger typing indicator, continuing with send`);
       }
     } catch (typingError) {
       console.error(`Error with typing indicator: ${typingError.message}`);
     }
   }
  
   // Send the message - using the approach that was working in your original code
   let result;
   try {
     console.log("Attempting to send via direct UI automation");
    
     const directScript = `
tell application "Messages" to activate
delay 0.5


tell application "System Events"
 tell process "Messages"
   -- Make sure we're in the right field
   keystroke tab
   delay 0.3
  
   -- Clear any existing text
   keystroke "a" using {command down}
   delay 0.2
   key code 51
   delay 0.2
  
   -- Send exactly this message with no extra whitespace
   keystroke "${message.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
   delay 0.5
   keystroke return
 end tell
end tell
`;
    
     await runAppleScript(directScript, 'Direct UI Send');
    
     result = {
       approach: "Direct UI",
       output: "Message sent via direct UI automation",
       messageType: isAppleDevice ? "blue" : "green"
     };
   } catch (uiError) {
     console.error(`Direct UI send failed: ${uiError.message}`);
    
     // Fall back to the simplest possible AppleScript
     try {
       console.log("Falling back to simple AppleScript send...");
       const simpleScript = `tell application "Messages" to send "${message.replace(/"/g, '\\"')}" to buddy "${formattedRecipient}"`;
      
       await runAppleScript(simpleScript, 'Simple Script Send');
      
       result = {
         approach: "Simple Script",
         output: "Message sent via simple AppleScript",
         messageType: "unknown"
       };
     } catch (simpleError) {
       console.error(`Simple script failed: ${simpleError.message}`);
      
       // Try specific service approaches as last resort
       try {
         if (isAppleDevice) {
           // Try iMessage direct
           const iMessageScript = `tell application "Messages" to send "${message.replace(/"/g, '\\"')}" to buddy "${formattedRecipient}" of service "iMessage"`;
          
           await runAppleScript(iMessageScript, 'iMessage Direct');
          
           result = {
             approach: "iMessage direct",
             output: "Message sent via iMessage",
             messageType: "blue"
           };
         } else {
           // Try SMS direct
           const smsScript = `tell application "Messages" to send "${message.replace(/"/g, '\\"')}" to buddy "${formattedRecipient}" of service "SMS"`;
          
           await runAppleScript(smsScript, 'SMS Direct');
          
           result = {
             approach: "SMS direct",
             output: "Message sent via SMS",
             messageType: "green"
           };
         }
       } catch (specificError) {
         console.error(`Service-specific script failed: ${specificError.message}`);
         throw new Error(`All send methods failed for ${formattedRecipient}`);
       }
     }
   }
  
   // Update our knowledge based on successful send
   if (result && result.messageType === 'blue') {
     blueMessageRecipients.add(cleanNumber);
   } else if (result && result.messageType === 'green') {
     greenMessageRecipients.add(cleanNumber);
   }
  
   // Message sent successfully, remove from active tracking
   activeMessages.delete(msgId);
  
   return {
     success: true,
     messageId: msgId,
     result: result ? result.output : "Message sent",
     approach: result ? result.approach : "unknown",
     messageType: result ? result.messageType : "unknown",
     typingIndicatorShown: typingIndicatorShown
   };
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


// Simple update to send endpoint
app.post('/send', async (req, res) => {
 try {
   let { recipient, message, messageId } = req.body;
  
   if (!recipient || !message) {
     return res.status(400).json({
       success: false,
       error: 'Missing required parameters: recipient and message'
     });
   }
  
   // Always trim the message to prevent whitespace issues
   message = message.trim();
  
   console.log(`Received send request for recipient: ${recipient}`);
  
   // CRITICAL FIX: Force a new conversation by removing from initialized list
   const cleanNumber = recipient.replace(/\D/g, '');
   initializedConversations.delete(cleanNumber);
  
   // Try to send the message with retry logic
   const sendResult = await sendMessage(recipient, message, 1, messageId);
  
   // Return success response with pageId
   res.json({
     success: true,
     messageId: sendResult.messageId,
     sender: username,
     pageId: assignedPageId, // Include the pageId for the API server
     recipient: recipient,
     timestamp: new Date().toISOString(),
     result: sendResult.result,
     approach: sendResult.approach || "unknown",
     messageType: sendResult.messageType || "unknown",
     typingIndicatorShown: sendResult.typingIndicatorShown || false
   });
  
 } catch (error) {
   console.error('Error sending message:', error);
   res.status(500).json({
     success: false,
     error: error.message
   });
 }
});
// --- Incoming Message Detection and Handling (from chat.db) ---


// Function to check the chat.db for new incoming messages
async function checkForNewMessages() {
 // Ensure the agent has fetched its pageId before checking messages
 if (!assignedPageId) {
   console.log("Agent pageId not yet assigned, skipping chat.db check.");
   return; // Skip check if pageId is not known yet
 }
  try {
   console.log(`Checking for new messages in chat.db for pageId ${assignedPageId}...`);
  
   // Direct SQL command using bash to avoid AppleScript errors
   const dbPath = path.join(os.homedir(), '/Library/Messages/chat.db');
  
   // Ensure the database file exists before attempting to query
   try {
     await fs.access(dbPath);
   } catch (error) {
     console.error(`Messages database not found at ${dbPath}. Cannot check for incoming messages.`);
     return;
   }
  
   // Query for recent incoming messages that haven't been processed
   const command = `sqlite3 -separator "|" "${dbPath}" "
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
       AND message.is_from_me = 0 -- Only get incoming messages
     ORDER BY
       message.date DESC
     LIMIT 20;
   "`;
  
   // Execute the command directly
   const { stdout, stderr } = await execPromise(command);
  
   if (stderr) {
     console.error("Error executing database query:", stderr);
     return;
   }
  
   if (!stdout || !stdout.trim()) {
     console.log("No new incoming messages found in database");
     return;
   }
  
   // Process each message line - one per message
   const messageLines = stdout.trim().split('\n');
   console.log(`Found ${messageLines.length} recent incoming messages`);
  
   let newMessagesFound = false;
  
   for (const line of messageLines) {
     const parts = line.split('|');
     if (!parts || parts.length < 5) {
       console.log(`Invalid message format: ${line}`);
       continue;
     }
    
     const rowId = parts[0] ? parts[0].trim() : '';
     const dateStr = parts[1] ? parts[1].trim() : '';
     const sender = parts[2] ? parts[2].trim() : '';
     const content = parts[3] ? parts[3].trim() : '';
     const isFromMe = parts[4] ? parts[4].trim() === '1' : false;
     const service = parts.length > 5 ? parts[5].trim() : '';
    
     // Skip if we've already processed this message or missing critical info
     if (!rowId || processedMessageIds.has(rowId) || !sender || isFromMe) {
       continue;
     }
    
     console.log(`Processing new incoming message ${rowId} from ${sender}: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`);
    
     // Track if this is a blue or green message based on service
     const cleanSender = sender.replace(/\D/g, '');
     if (cleanSender && service === 'iMessage') {
       blueMessageRecipients.add(cleanSender);
     } else if (cleanSender && service) {
       greenMessageRecipients.add(cleanSender);
     }
    
     // Forward the incoming message to the main API server
     try {
       const msgDate = new Date(dateStr);
      
       // Forward to API server with pageId
       const apiResponse = await axios.post(`${API_SERVER}/api/receive-message`, {
         from: sender,
         to: phoneNumber,
         message: content,
         timestamp: msgDate.toISOString(),
         pageId: assignedPageId, // Include the agent's assigned pageId
         messageType: service === 'iMessage' ? 'blue' : 'green'
       });
      
       console.log(`Incoming message ${rowId} from ${sender} forwarded to main API server. Response:`, apiResponse.data);
       newMessagesFound = true;
      
       // Mark as processed ONLY AFTER successfully forwarding to the API server
       if (rowId) {
         processedMessageIds.add(rowId);
       }
      
       // Mark this conversation as initialized since we received a message from it
       if (cleanSender) {
         initializedConversations.add(cleanSender);
       }
     } catch (error) {
       console.error(`Error forwarding incoming message ${rowId} to main API server:`, error.message);
       // Do NOT add to processedMessageIds if forwarding failed, so it will be retried on the next check
     }
   }
  
   // Save processed IDs after processing a batch of messages
   await saveProcessedIds();
  
   if (newMessagesFound) {
     console.log("Finished processing new incoming messages.");
   } else {
     console.log("No new unprocessed incoming messages found.");
   }
  
 } catch (error) {
   console.error("Error checking for messages in chat.db:", error);
 }
}


// Function to check for failed messages in Messages.app
async function checkForFailedMessages() {
 try {
   console.log("Checking for failed messages...");
  
   // Direct SQL command using bash to avoid AppleScript errors
   const dbPath = path.join(os.homedir(), '/Library/Messages/chat.db');
  
   const command = `sqlite3 -separator "|" "${dbPath}" "
     SELECT
       handle.id,
       message.service
     FROM
       message
       LEFT JOIN handle ON message.handle_id = handle.ROWID
     WHERE
       message.date > (strftime('%s', 'now', '-1 hour') - strftime('%s', '2001-01-01')) * 1000000000
       AND message.is_from_me = 1
       AND (message.is_sent = 0 OR message.is_delivered = 0 OR message.is_finished = 0)
     GROUP BY
       handle.id, message.service
     LIMIT 20;
   "`;
  
   // Execute the command directly
   const { stdout, stderr } = await execPromise(command);
  
   if (stderr) {
     console.error("Error checking for failed messages:", stderr);
     return;
   }
  
   if (!stdout || !stdout.trim()) {
     // No failed messages
     return;
   }
  
   // Process each line
   const messageLines = stdout.trim().split('\n');
   console.log(`Found ${messageLines.length} conversations with failed messages`);
  
   for (const line of messageLines) {
     const parts = line.split('|');
     if (!parts || parts.length < 1) continue;
    
     const phoneId = parts[0] ? parts[0].trim() : '';
     if (!phoneId) continue;
    
     const cleanNumber = phoneId.replace(/\D/g, '');
     const service = parts.length > 1 ? parts[1].trim() : '';
    
     console.log(`Detected failed message to ${phoneId}, will re-initialize on next send`);
    
     // Remove from initialized to force re-init
     if (cleanNumber) {
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
   }
  
 } catch (error) {
   console.error("Error checking for failed messages:", error);
 }
}


/**
* Fetches the assigned pageId for this agent's phone number from the API server.
*/
async function fetchAgentPageId() {
 if (!phoneNumber || phoneNumber === 'unknown') {
   console.error("Agent phone number is not configured. Cannot fetch pageId.");
   return false;
 }
  console.log(`Attempting to fetch pageId for agent phone ${phoneNumber} from API server ${API_SERVER}...`);
  try {
   // Use the endpoint to look up by agentPhoneNumber query param
   const response = await axios.get(`${API_SERVER}/api/page-phone-mapping`, {
     params: { agentPhoneNumber: phoneNumber }
   });
  
   if (response.data && response.data.success && response.data.pageId) {
     assignedPageId = response.data.pageId;
     console.log(`Successfully fetched assigned pageId: ${assignedPageId}`);
     return true;
   } else {
     console.warn(`API server did not return a pageId for agent phone ${phoneNumber}. Response:`, response.data);
     assignedPageId = null; // Ensure it's null if fetch fails
     return false;
   }
 } catch (error) {
   console.error(`Error fetching pageId for agent phone ${phoneNumber}:`, error.message);
   assignedPageId = null; // Ensure it's null on error
   return false;
 }
}


// Set up intervals for various checks
const MESSAGE_CHECK_INTERVAL = 5000; // Check for new messages every 5 seconds
const FAILED_MESSAGE_CHECK_INTERVAL = 15000; // Check for failed messages every 15 seconds
const STUCK_MESSAGE_CHECK_INTERVAL = 5000; // Check for stuck messages every 5 seconds


let messageCheckIntervalId;
let failedMessageCheckIntervalId;
let stuckMessageCheckIntervalId;


// Function to start the message checking intervals
function startAllChecks() {
 // Only start checking for new messages if the agent's pageId has been assigned
 if (assignedPageId) {
   if (!messageCheckIntervalId) {
     console.log(`Starting chat.db message checking interval (${MESSAGE_CHECK_INTERVAL / 1000}s) for pageId ${assignedPageId}...`);
     checkForNewMessages(); // Run once immediately
     messageCheckIntervalId = setInterval(checkForNewMessages, MESSAGE_CHECK_INTERVAL);
   }
  
   if (!failedMessageCheckIntervalId) {
     console.log(`Starting failed message checking interval (${FAILED_MESSAGE_CHECK_INTERVAL / 1000}s)...`);
     checkForFailedMessages(); // Run once immediately
     failedMessageCheckIntervalId = setInterval(checkForFailedMessages, FAILED_MESSAGE_CHECK_INTERVAL);
   }
 } else {
   console.warn("Cannot start message checking: Agent pageId is not assigned.");
 }
  // Start checking for stuck messages regardless of pageId status
 if (!stuckMessageCheckIntervalId) {
   console.log(`Starting stuck message checking interval (${STUCK_MESSAGE_CHECK_INTERVAL / 1000}s)...`);
   checkStuckMessages(); // Run once immediately
   stuckMessageCheckIntervalId = setInterval(checkStuckMessages, STUCK_MESSAGE_CHECK_INTERVAL);
 }
}


// Function to stop all checking intervals
function stopAllChecks() {
 if (messageCheckIntervalId) {
   console.log("Stopping chat.db message checking interval...");
   clearInterval(messageCheckIntervalId);
   messageCheckIntervalId = null;
 }
  if (failedMessageCheckIntervalId) {
   console.log("Stopping failed message checking interval...");
   clearInterval(failedMessageCheckIntervalId);
   failedMessageCheckIntervalId = null;
 }
  if (stuckMessageCheckIntervalId) {
   console.log("Stopping stuck message checking interval...");
   clearInterval(stuckMessageCheckIntervalId);
   stuckMessageCheckIntervalId = null;
 }
}


// Endpoint to force refresh of pageId
app.get('/refresh-page-id', async (req, res) => {
 try {
   // Stop existing checks first
   stopAllChecks();
  
   // Fetch new pageId
   const success = await fetchAgentPageId();
  
   // Restart checks if successful
   if (success) {
     startAllChecks();
     res.json({
       success: true,
       message: `PageId refreshed: ${assignedPageId}`,
       pageId: assignedPageId
     });
   } else {
     res.status(400).json({
       success: false,
       message: "Failed to refresh pageId",
       pageId: assignedPageId
     });
   }
 } catch (error) {
   console.error("Error refreshing pageId:", error);
   res.status(500).json({
     success: false,
     error: error.message
   });
 }
});


// --- Start the Express Server and Message Checking ---
app.listen(PORT, async () => {
 console.log(`Combined message agent for user "${username}" listening on port ${PORT}`);
 console.log(`Configured phone number: ${phoneNumber}`);
  // Load processed IDs when the agent starts
 await loadProcessedIds();
  // Fetch the agent's pageId from the API server
 const pageIdFetched = await fetchAgentPageId();
  // Start all checking intervals if pageId was fetched successfully
 if (pageIdFetched) {
   startAllChecks();
 } else {
   console.warn("Agent pageId not fetched successfully. Incoming message forwarding is disabled.");
   console.warn("Please ensure this agent's phone number is mapped to a pageId on the API server.");
  
   // Even without pageId, we can still check for stuck messages
   if (!stuckMessageCheckIntervalId) {
     stuckMessageCheckIntervalId = setInterval(checkStuckMessages, STUCK_MESSAGE_CHECK_INTERVAL);
   }
 }
});


// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
 console.log('SIGINT signal received. Server shutting down...');
 stopAllChecks(); // Stop all checking intervals
 await saveProcessedIds(); // Save processed IDs before exiting
 console.log('Agent shut down gracefully.');
 process.exit(0);
});


// Handle unhandled promise rejections to prevent process crashes
process.on('unhandledRejection', (reason, promise) => {
 console.error('Unhandled Rejection at:', promise, 'reason:', reason);
 // Log the error but don't crash the process
});


// Handle uncaught exceptions to prevent process crashes
process.on('uncaughtException', (error) => {
 console.error('Uncaught Exception:', error);
 // Log the error but don't crash the process
});






// node /Users/johndc/message-agent.js 3003 http://localhost:3000


//  nohup /usr/local/bin/node /Users/johndc/message-agent.js 3003 http://localhost:3000 > /Users/johndc/Library/Logs/messageagent.log 2>&1 &


// sudo kill -9 $(sudo lsof -ti:3003)



