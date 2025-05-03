// message-agent.js
const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const execPromise = promisify(exec);
const app = express();
const PORT = process.argv[2] || 3000;

// Parse JSON bodies
app.use(express.json());

// Get current username
const username = os.userInfo().username;
console.log(`Starting message agent for user: ${username}`);

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    user: username,
    timestamp: new Date().toISOString()
  });
});

// Endpoint to send a message
app.post('/send', async (req, res) => {
  try {
    const { recipient, message, messageId } = req.body;
    
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
    
    // Create AppleScript that simulates typing
    const appleScript = `
      tell application "Messages"
        -- First activate Messages to ensure it's in focus
        activate
        delay 0.5
        
        -- Try SMS first for Android compatibility
        try
          set targetService to service "SMS"
          set targetBuddy to buddy "${formattedRecipient}" of targetService
          
          -- Select the conversation first
          set targetChat to chat targetBuddy
          select targetChat
          delay 0.5
          
          -- Type the message character by character
          tell application "System Events"
            -- Clear any existing text first
            keystroke "a" using {command down}
            keystroke (ASCII character 8) -- backspace
            delay 0.3
            
            -- Type the message with random delays to simulate human typing
            set messageText to "${message.replace(/"/g, '\\"')}"
            repeat with i from 1 to length of messageText
              set currentChar to character i of messageText
              keystroke currentChar
              -- Random delay between keystrokes (between 0.01 and 0.1 seconds)
              delay (random number from 0.01 to 0.1)
            end repeat
            
            -- Send the message
            delay 0.3
            keystroke return
          end tell
          
          return "SMS sent to ${formattedRecipient} from ${username} with typing simulation"
        on error
          -- Fall back to iMessage
          set targetService to 1st service
          set targetBuddy to buddy "${formattedRecipient}" of targetService
          
          -- Select the conversation first
          set targetChat to chat targetBuddy
          select targetChat
          delay 0.5
          
          -- Type the message character by character
          tell application "System Events"
            -- Clear any existing text first
            keystroke "a" using {command down}
            keystroke (ASCII character 8) -- backspace
            delay 0.3
            
            -- Type the message with random delays to simulate human typing
            set messageText to "${message.replace(/"/g, '\\"')}"
            repeat with i from 1 to length of messageText
              set currentChar to character i of messageText
              keystroke currentChar
              -- Random delay between keystrokes (between 0.01 and 0.1 seconds)
              delay (random number from 0.01 to 0.1)
            end repeat
            
            -- Send the message
            delay 0.3
            keystroke return
          end tell
          
          return "Message sent to ${formattedRecipient} from ${username} with typing simulation"
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
    
    console.log(`Message sent to ${formattedRecipient} with typing simulation`);
    
    // Return success response
    res.json({
      success: true,
      messageId,
      sender: username,
      recipient: formattedRecipient,
      timestamp: new Date().toISOString(),
      result: stdout.trim()
    });
    
  } catch (error) {
    console.error('Error sending message:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Message agent for ${username} listening on port ${PORT}`);
});