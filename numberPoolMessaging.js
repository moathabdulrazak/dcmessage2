// numberPoolMessaging.js
const axios = require('axios');
const crypto = require('crypto');

// Configuration for your number pool
// Only using johndc - other users are commented out
const numberPool = [
  // {
  //   id: "user1",  
  //   username: "debtconnects",
  //   phoneNumber: "2087130507",
  //   agentUrl: "http://localhost:3001",
  //   messageCount: 0
  // },
  // {
  //   id: "user2",  
  //   username: "georgedc",
  //   phoneNumber: "3108710761",
  //   agentUrl: "http://localhost:3003",
  //   messageCount: 0
  // },
  {
    id: "user3",
    username: "johndc",
    phoneNumber: "2087614687",
    agentUrl: "http://localhost:3003",
    messageCount: 0
  }
];

// Keep track of the current user index
let currentUserIndex = 0;

/**
 * Get all users in the number pool
 */
const getNumberPool = () => {
  return [...numberPool];
};

/**
 * Get the current active user
 */
const getCurrentUser = () => {
  return numberPool[currentUserIndex];
};

/**
 * Rotate to the next user in the pool
 */
const rotateToNextUser = () => {
  currentUserIndex = (currentUserIndex + 1) % numberPool.length;
  return getCurrentUser();
};

/**
 * Check if a messaging agent is online
 * @param {string} userId - The ID of the user to check
 */
const checkAgentStatus = async (userId) => {
  const user = numberPool.find(u => u.id === userId);
  if (!user) {
    throw new Error(`User with ID ${userId} not found in the number pool`);
  }
  
  try {
    const response = await axios.get(`${user.agentUrl}/health`, { timeout: 3000 });
    return {
      success: true,
      userId,
      username: user.username,
      phoneNumber: user.phoneNumber,
      agentStatus: response.data
    };
  } catch (error) {
    return {
      success: false,
      userId,
      username: user.username,
      phoneNumber: user.phoneNumber,
      error: error.message
    };
  }
};

/**
 * Check if all messaging agents are online
 */
const checkAllAgents = async () => {
  const results = [];
  for (const user of numberPool) {
    const status = await checkAgentStatus(user.id);
    results.push(status);
  }
  return results;
};

/**
 * Send a message using a specific user's agent
 * @param {string} userId - The ID of the user to send as
 * @param {string} recipient - The recipient's phone number
 * @param {string} message - The message to send
 */
const sendMessageAsUser = async (userId, recipient, message) => {
  // Find the user in the pool
  const user = numberPool.find(u => u.id === userId);
  if (!user) {
    throw new Error(`User with ID ${userId} not found in the number pool`);
  }
  
  console.log(`Sending message to ${recipient} as user ${user.username} (${user.phoneNumber})`);
  
  try {
    // Generate a message ID
    const messageId = crypto.randomBytes(8).toString('hex');
    
    // Send the message using the user's agent
    const response = await axios.post(`${user.agentUrl}/send`, {
      recipient,
      message,
      messageId
    });
    
    // Check if the request was successful
    if (!response.data.success) {
      throw new Error(`Failed to send message: ${response.data.error}`);
    }
    
    // Update the message count for this user
    user.messageCount++;
    
    return {
      success: true,
      userId,
      username: user.username,
      phoneNumber: user.phoneNumber,
      recipient,
      messageId,
      result: response.data.result
    };
  } catch (error) {
    console.error(`Error sending message as ${user.username}:`, error.message);
    throw error;
  }
};

/**
 * Send a message using the current user in rotation
 * @param {string} recipient - The recipient's phone number
 * @param {string} message - The message to send
 */
const sendMessageAndRotate = async (recipient, message) => {
  // Get the current user
  const currentUser = getCurrentUser();
  
  try {
    // Send the message as the current user
    const result = await sendMessageAsUser(currentUser.id, recipient, message);
    
    // Rotate to the next user for future messages
    const nextUser = rotateToNextUser();
    
    return {
      ...result,
      nextUser: {
        id: nextUser.id,
        username: nextUser.username,
        phoneNumber: nextUser.phoneNumber
      }
    };
  } catch (error) {
    console.error(`Error in sendMessageAndRotate:`, error.message);
    
    // If sending as the current user fails, try the next user
    console.log(`Trying next user...`);
    rotateToNextUser();
    
    // If we've tried all users and come back to the original one, throw an error
    if (getCurrentUser().id === currentUser.id) {
      throw new Error("Failed to send message with any user in the pool. Check if the messaging agents are running.");
    }
    
    return await sendMessageAndRotate(recipient, message);
  }
};

/**
 * Send bulk messages, rotating through users
 * @param {Array} messages - Array of message objects {recipient, content}
 */
const sendBulkMessages = async (messages) => {
  const results = [];
  const errors = [];
  
  for (const msg of messages) {
    try {
      const result = await sendMessageAndRotate(msg.recipient, msg.content);
      results.push(result);
      
      // Add a delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      errors.push({
        recipient: msg.recipient,
        content: msg.content,
        error: error.message
      });
    }
  }
  
  return {
    success: results.length > 0,
    results,
    errors,
    summary: {
      total: messages.length,
      successful: results.length,
      failed: errors.length
    }
  };
};

module.exports = {
  getNumberPool,
  getCurrentUser,
  rotateToNextUser,
  checkAgentStatus,
  checkAllAgents,
  sendMessageAsUser,
  sendMessageAndRotate,
  sendBulkMessages
};