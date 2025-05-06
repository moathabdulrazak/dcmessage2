// test-listener.js - ES Module version
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a simple AppleScript to check for messages
const appleScript = `
tell application "Messages"
  if (count of chats) > 0 then
    set theChat to item 1 of chats
    if (count of messages in theChat) > 0 then
      set theMessage to last message in theChat
      
      if sender of theMessage is not null then
        set theSender to handle of (sender of theMessage)
        set theContent to content of theMessage
        set theDate to date received of theMessage
        
        return theSender & "|" & theContent & "|" & theDate
      else
        return "no-sender"
      end if
    else
      return "no-messages"
    end if
  else
    return "no-chats"
  end if
end tell
`;

// Run as a direct osascript command instead of writing to file
console.log('Checking Messages app for recent messages...');

// Execute the AppleScript directly with -e option
const command = `osascript -e '${appleScript.replace(/'/g, "\\'")}'`;

exec(command, (error, stdout, stderr) => {
  if (error) {
    console.error('Error executing AppleScript:', error);
    return;
  }
  
  if (stderr) {
    console.error('AppleScript error:', stderr);
    return;
  }
  
  const result = stdout.trim();
  console.log('Raw result:', result);
  
  if (result === 'no-chats') {
    console.log('No chats found in Messages app');
    return;
  }
  
  if (result === 'no-messages') {
    console.log('No messages found in the first chat');
    return;
  }
  
  if (result === 'no-sender') {
    console.log('Last message has no sender information');
    return;
  }
  
  // Parse the result
  const parts = result.split('|');
  if (parts.length === 3) {
    const sender = parts[0];
    const content = parts[1];
    const dateStr = parts[2];
    
    console.log('\nLatest message details:');
    console.log('Sender:', sender);
    console.log('Content:', content);
    console.log('Date:', dateStr);
    console.log('\nThis message was successfully detected!');
    console.log('If this works but your agent isn\'t detecting messages,');
    console.log('the issue is in how your agent processes or forwards messages.');
  } else {
    console.log('Unexpected format in the result:', result);
  }
});