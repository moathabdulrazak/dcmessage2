// index.js
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const numberPool = require('./numberPoolMessaging.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Create a simple logger
const logger = {
  info: (message) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`),
  error: (message, error) => console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error)
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create conversations directory if it doesn't exist
const CONVERSATIONS_DIR = path.join(__dirname, 'conversations');

// Ensure conversations directory exists
async function ensureConversationsDir() {
  try {
    await fs.access(CONVERSATIONS_DIR);
  } catch (error) {
    await fs.mkdir(CONVERSATIONS_DIR, { recursive: true });
    logger.info('Created conversations directory');
  }
}
// Add this to your index.js
app.get('/api/check-conversation', async (req, res) => {
  try {
    const { phone } = req.query;
    
    if (!phone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameter: phone' 
      });
    }
    
    // Clean the phone number
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Read the mapping file
    const mappingPath = path.join(CONVERSATIONS_DIR, 'phone_mappings.json');
    let mappings = {};
    
    try {
      const content = await fs.readFile(mappingPath, 'utf8');
      mappings = JSON.parse(content);
    } catch (error) {
      // File doesn't exist yet
      return res.json({ 
        success: true, 
        exists: false 
      });
    }
    
    // Check if this phone number has a conversation
    const conversationId = mappings[cleanPhone];
    
    if (!conversationId) {
      return res.json({ 
        success: true, 
        exists: false 
      });
    }
    
    // Get the conversation details
    const conversationPath = path.join(CONVERSATIONS_DIR, `${conversationId}.json`);
    
    try {
      const content = await fs.readFile(conversationPath, 'utf8');
      const conversation = JSON.parse(content);
      
      res.json({
        success: true,
        exists: true,
        conversationId,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentPhone: conversation.assignedAgentPhone
      });
    } catch (error) {
      res.json({ 
        success: true, 
        exists: false 
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// Number Pool Messaging routes
app.get('/api/pool/status', async (req, res) => {
  try {
    const agentStatus = await numberPool.checkAllAgents();
    res.json({
      success: true,
      agents: agentStatus,
      currentAgent: numberPool.getCurrentUser()
    });
  } catch (error) {
    logger.error('Error checking agent status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Send a message via the number pool
app.post('/api/pool/message', async (req, res) => {
  try {
    const { recipient, message } = req.body;
    
    if (!recipient || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: recipient and message'
      });
    }
    
    // Log current user before sending
    logger.info(`Current user before sending: ${JSON.stringify(numberPool.getCurrentUser())}`);
    
    // Find or create conversation for this recipient
    await ensureConversationsDir();
    const cleanPhone = recipient.replace(/\D/g, '');
    const mappingPath = path.join(CONVERSATIONS_DIR, 'phone_mappings.json');
    
    // Read or create mappings
    let mappings = {};
    try {
      const content = await fs.readFile(mappingPath, 'utf8');
      mappings = JSON.parse(content);
    } catch (error) {
      // File doesn't exist yet
    }
    
    // Get or create conversation ID
    let conversationId = mappings[cleanPhone];
    let conversation;
    let existingAgent = null;
    
    if (conversationId) {
      // Try to load existing conversation
      try {
        const conversationPath = path.join(CONVERSATIONS_DIR, `${conversationId}.json`);
        const content = await fs.readFile(conversationPath, 'utf8');
        conversation = JSON.parse(content);
        
        // Check if conversation has an assigned agent
        if (conversation.assignedAgentId) {
          existingAgent = conversation.assignedAgentId;
          logger.info(`Using existing agent ${existingAgent} for conversation ${conversationId}`);
        }
      } catch (error) {
        logger.error(`Error loading conversation ${conversationId}:`, error);
        // Fall back to creating a new conversation
        conversationId = null;
      }
    }
    
    // Send the message using the number pool
    let result;
    if (existingAgent) {
      // Use the previously assigned agent if one exists
      try {
        result = await numberPool.sendMessageAsUser(existingAgent, recipient, message);
      } catch (error) {
        logger.error(`Error sending with assigned agent ${existingAgent}:`, error);
        // If that failed, use rotation instead
        result = await numberPool.sendMessageAndRotate(recipient, message);
      }
    } else {
      // Otherwise use the rotation system
      result = await numberPool.sendMessageAndRotate(recipient, message);
    }
    
    // Create or update the conversation
    if (!conversationId) {
      conversationId = crypto.randomBytes(8).toString('hex');
      mappings[cleanPhone] = conversationId;
      await fs.writeFile(mappingPath, JSON.stringify(mappings, null, 2));
      
      conversation = {
        id: conversationId,
        participants: [cleanPhone],
        assignedAgentId: result.userId,
        assignedAgentPhone: result.phoneNumber,
        startedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        messages: []
      };
    }
    
    // Add the message to the conversation
    conversation.messages.push({
      id: crypto.randomBytes(8).toString('hex'),
      direction: 'outgoing',
      sender: {
        userId: result.userId,
        username: result.username,
        phoneNumber: result.phoneNumber
      },
      recipient: recipient,
      message: message,
      timestamp: new Date().toISOString()
    });
    
    // Update conversation metadata
    conversation.lastMessageAt = new Date().toISOString();
    conversation.assignedAgentId = result.userId;
    conversation.assignedAgentPhone = result.phoneNumber;
    
    // Save the conversation
    const conversationPath = path.join(CONVERSATIONS_DIR, `${conversationId}.json`);
    await fs.writeFile(conversationPath, JSON.stringify(conversation, null, 2));
    
    // Log the success
    logger.info(`Message sent via number pool to ${recipient} using agent ${result.username}`);
    
    res.json({
      success: true,
      message: 'Message sent successfully',
      result,
      conversationId
    });
  } catch (error) {
    logger.error('Error sending message through number pool:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});// Add to your server's index.js
app.get('/api/agent-conversations', async (req, res) => {
  try {
    const { agentId } = req.query;
    
    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: agentId'
      });
    }
    
    // Ensure conversations directory exists
    await ensureConversationsDir();
    
    // Get all conversation files
    const files = await fs.readdir(CONVERSATIONS_DIR);
    const conversationFiles = files.filter(file => 
      file.endsWith('.json') && file !== 'phone_mappings.json'
    );
    
    // Find conversations assigned to this agent
    const conversations = [];
    
    for (const file of conversationFiles) {
      const filePath = path.join(CONVERSATIONS_DIR, file);
      const content = await fs.readFile(filePath, 'utf8');
      const conversation = JSON.parse(content);
      
      if (conversation.assignedAgentId === agentId) {
        conversations.push({
          id: conversation.id,
          participants: conversation.participants,
          assignedAgentId: conversation.assignedAgentId,
          assignedAgentPhone: conversation.assignedAgentPhone,
          startedAt: conversation.startedAt,
          lastMessageAt: conversation.lastMessageAt
        });
      }
    }
    
    res.json({
      success: true,
      conversations
    });
  } catch (error) {
    console.error('Error fetching agent conversations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// Send message as specific user
app.post('/api/pool/message/:userId', async (req, res) => {
  try {
    const { recipient, message } = req.body;
    const userId = req.params.userId;
    
    if (!recipient || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: recipient and message'
      });
    }
    
    // Send the message using a specific user
    const result = await numberPool.sendMessageAsUser(userId, recipient, message);
    
    // Store the message (similar to above)
    await ensureConversationsDir();
    // ... [storage code similar to above]
    
    res.json({
      success: true,
      message: 'Message sent successfully',
      result
    });
  } catch (error) {
    logger.error(`Error sending message as user ${req.params.userId}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to store an outgoing message (called by message agents)
app.post('/api/store-message', async (req, res) => {
  try {
    const { direction, sender, recipient, message, timestamp, conversationId } = req.body;
    
    logger.info("Received store-message request:", req.body);
    
    if (!recipient || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }
    
    // Ensure directory exists
    await ensureConversationsDir();
    
    // Clean the recipient phone number
    const cleanPhone = recipient.replace(/\D/g, '');
    
    // Get or create mappings
    const mappingPath = path.join(CONVERSATIONS_DIR, 'phone_mappings.json');
    let mappings = {};
    
    try {
      const content = await fs.readFile(mappingPath, 'utf8');
      mappings = JSON.parse(content);
    } catch (error) {
      // File doesn't exist yet, we'll create it
    }
    
    // Get or create conversation ID
    let convoId = conversationId;
    if (!convoId) {
      // If no ID provided, check if we have a mapping
      convoId = mappings[cleanPhone];
      if (!convoId) {
        // If no mapping either, create a new ID
        convoId = crypto.randomBytes(8).toString('hex');
        mappings[cleanPhone] = convoId;
      }
    } else {
      // If ID provided, update mapping
      mappings[cleanPhone] = convoId;
    }
    
    // Save updated mappings
    await fs.writeFile(mappingPath, JSON.stringify(mappings, null, 2));
    
    // Get or create conversation file
    const conversationPath = path.join(CONVERSATIONS_DIR, `${convoId}.json`);
    let conversation;
    
    try {
      const content = await fs.readFile(conversationPath, 'utf8');
      conversation = JSON.parse(content);
    } catch (error) {
      // Create new conversation
      conversation = {
        id: convoId,
        participants: [cleanPhone],
        assignedAgentId: sender.userId,
        assignedAgentPhone: sender.phoneNumber,
        startedAt: timestamp || new Date().toISOString(),
        lastMessageAt: timestamp || new Date().toISOString(),
        messages: []
      };
    }
    
    // Add the message
    conversation.messages.push({
      id: crypto.randomBytes(8).toString('hex'),
      direction: direction || 'outgoing',
      sender: sender,
      recipient: recipient,
      message: message,
      timestamp: timestamp || new Date().toISOString()
    });
    
    // Update last message time
    conversation.lastMessageAt = timestamp || new Date().toISOString();
    
    // Save conversation
    await fs.writeFile(conversationPath, JSON.stringify(conversation, null, 2));
    
    logger.info(`Message stored in conversation ${convoId}`);
    
    res.json({
      success: true,
      message: 'Message stored successfully',
      conversationId: convoId
    });
  } catch (error) {
    logger.error('Error storing message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to receive and store an incoming message
app.post('/api/receive-message', async (req, res) => {
  try {
    const { from, message, timestamp, agentId, agentPhone } = req.body;
    
    logger.info("Received incoming message:", req.body);
    
    if (!from || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: from and message'
      });
    }
    
    // Ensure directory exists
    await ensureConversationsDir();
    
    // Clean the phone number
    const cleanPhone = from.replace(/\D/g, '').replace(/^1/, '');
    
    // Find or create conversation
    const mappingPath = path.join(CONVERSATIONS_DIR, 'phone_mappings.json');
    let mappings = {};
    let convoId;
    
    try {
      const content = await fs.readFile(mappingPath, 'utf8');
      mappings = JSON.parse(content);
      convoId = mappings[cleanPhone];
    } catch (error) {
      // If file doesn't exist, create an empty mapping object
      mappings = {};
    }
    
    // If no mapping exists, create a new conversation
    if (!convoId) {
      convoId = crypto.randomBytes(8).toString('hex');
      mappings[cleanPhone] = convoId;
      await fs.writeFile(mappingPath, JSON.stringify(mappings, null, 2));
    }
    
    // Get or create conversation file
    const conversationPath = path.join(CONVERSATIONS_DIR, `${convoId}.json`);
    let conversation;
    
    try {
      const content = await fs.readFile(conversationPath, 'utf8');
      conversation = JSON.parse(content);
    } catch (error) {
      // If file doesn't exist, create a new conversation
      conversation = {
        id: convoId,
        participants: [cleanPhone],
        assignedAgentId: agentId,
        assignedAgentPhone: agentPhone,
        startedAt: timestamp || new Date().toISOString(),
        lastMessageAt: timestamp || new Date().toISOString(),
        messages: []
      };
    }
    
    // Check for duplicate message (simple content-based check)
    const isDuplicate = conversation.messages.some(msg => 
      msg.direction === 'incoming' && 
      msg.message === message && 
      msg.sender.phoneNumber === from
    );
    
    if (!isDuplicate) {
      // Add the message
      conversation.messages.push({
        id: crypto.randomBytes(8).toString('hex'),
        direction: 'incoming',
        sender: {
          phoneNumber: from
        },
        recipient: agentPhone,
        message: message,
        timestamp: timestamp || new Date().toISOString()
      });
      
      // Update last message time
      conversation.lastMessageAt = timestamp || new Date().toISOString();
      
      // Save conversation
      await fs.writeFile(conversationPath, JSON.stringify(conversation, null, 2));
      
      logger.info(`Incoming message stored in conversation ${convoId}`);
    } else {
      logger.info(`Duplicate message detected, not adding to conversation ${convoId}`);
    }
    
    res.json({
      success: true,
      message: isDuplicate ? 'Duplicate message detected' : 'Incoming message stored successfully',
      conversationId: convoId
    });
  } catch (error) {
    logger.error('Error storing incoming message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all conversations
app.get('/api/conversations', async (req, res) => {
  try {
    // Ensure directory exists
    await ensureConversationsDir();
    
    // Get all conversation files
    const files = await fs.readdir(CONVERSATIONS_DIR);
    const conversationFiles = files.filter(file => 
      file.endsWith('.json') && file !== 'phone_mappings.json'
    );
    
    // Read each conversation file
    const conversations = [];
    for (const file of conversationFiles) {
      const filePath = path.join(CONVERSATIONS_DIR, file);
      const content = await fs.readFile(filePath, 'utf8');
      const conversation = JSON.parse(content);
      
      // Add a summary (last message and count)
      const messageCount = conversation.messages.length;
      const lastMessage = messageCount > 0 ? 
        conversation.messages[messageCount - 1] : null;
      
      conversations.push({
        id: conversation.id,
        participants: conversation.participants,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentPhone: conversation.assignedAgentPhone,
        startedAt: conversation.startedAt,
        lastMessageAt: conversation.lastMessageAt,
        messageCount,
        lastMessage: lastMessage ? {
          direction: lastMessage.direction,
          message: lastMessage.message,
          timestamp: lastMessage.timestamp
        } : null
      });
    }
    
    // Sort by last message time (newest first)
    conversations.sort((a, b) => {
      const dateA = new Date(a.lastMessageAt);
      const dateB = new Date(b.lastMessageAt);
      return dateB - dateA;
    });
    
    res.json({
      success: true,
      conversations
    });
  } catch (error) {
    logger.error('Error fetching conversations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get a specific conversation
app.get('/api/conversations/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversationPath = path.join(CONVERSATIONS_DIR, `${conversationId}.json`);
    
    const content = await fs.readFile(conversationPath, 'utf8');
    const conversation = JSON.parse(content);
    
    res.json({
      success: true,
      conversation
    });
  } catch (error) {
    logger.error(`Error fetching conversation ${req.params.conversationId}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get number pool users
app.get('/api/pool/users', (req, res) => {
  try {
    const users = numberPool.getNumberPool();
    const currentUser = numberPool.getCurrentUser();
    
    res.json({
      success: true,
      users,
      currentUser
    });
  } catch (error) {
    logger.error('Error getting number pool users:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Basic route for checking server status
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Message Agent System</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
          h1 { color: #333; }
          .status { padding: 20px; background: #f5f5f5; border-radius: 5px; }
          .success { color: green; }
          .error { color: red; }
        </style>
      </head>
      <body>
        <h1>IMessage Agent</h1>
        <div class="status">
          <p>Server is running on port ${PORT}</p>
          <p>Current time: ${new Date().toLocaleString()}</p>
          <p>Current agent: ${numberPool.getCurrentUser().username}</p>
        </div>
        <h2>Available Endpoints:</h2>
        <ul>
          <li><code>GET /api/pool/status</code> - Check status of all agents</li>
          <li><code>POST /api/pool/message</code> - Send a message using rotation</li>
          <li><code>POST /api/pool/message/:userId</code> - Send message as specific user</li>
          <li><code>GET /api/conversations</code> - Get all conversations</li>
          <li><code>GET /api/conversations/:conversationId</code> - Get a specific conversation</li>
          <li><code>GET /api/pool/users</code> - Get all users in the pool</li>
        </ul>
         <h6>made by moath</h6>
      </body>
    </html>
  `);
});

// Start the server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  
  // Check agent status on startup
  numberPool.checkAllAgents().then(agentStatus => {
    const onlineAgents = agentStatus.filter(a => a.success);
    logger.info(`Found ${onlineAgents.length} online message agent(s)`);
    
    if (onlineAgents.length > 0) {
      onlineAgents.forEach(agent => {
        logger.info(`- Agent: ${agent.username} (${agent.phoneNumber})`);
      });
    } else {
      logger.info('No active message agents. Please start them using the start-agents.sh script.');
    }
  }).catch(err => {
    logger.error('Error checking agent status on startup:', err);
  });
});

module.exports = app;