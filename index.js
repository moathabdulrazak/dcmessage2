// index.js
const express = require('express');
const path = require('path');
const fs = require('fs').promises;

// Import the number pool controller
const numberPool = require('./numberPoolMessaging.js');

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create a simple logger
const logger = {
  info: (message) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`),
  error: (message, error) => console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error)
};

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

app.post('/api/pool/message', async (req, res) => {
  try {
    const { recipient, message } = req.body;
    
    if (!recipient || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: recipient and message'
      });
    }
    
    // Send the message using the number pool rotation
    const result = await numberPool.sendMessageAndRotate(recipient, message);
    
    // Log the success
    logger.info(`Message sent via number pool to ${recipient} using agent ${result.username}`);
    
    res.json({
      success: true,
      message: 'Message sent successfully',
      result
    });
  } catch (error) {
    logger.error('Error sending message through number pool:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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

app.post('/api/pool/messages/bulk', async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid messages array'
      });
    }
    
    // Send bulk messages using the number pool
    const result = await numberPool.sendBulkMessages(messages);
    
    // Log the success
    logger.info(`Bulk message job completed: ${result.summary.successful}/${result.summary.total} messages sent successfully`);
    
    res.json({
      success: true,
      message: 'Bulk messages processed',
      result
    });
  } catch (error) {
    logger.error('Error sending bulk messages through number pool:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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
        <h1>Message Agent System</h1>
        <div class="status">
          <p>Server is running on port ${PORT}</p>
          <p>Current time: ${new Date().toLocaleString()}</p>
          <p>Current agent: ${numberPool.getCurrentUser().username}</p>
        </div>
        <h2>Available Endpoints:</h2>
        <ul>
          <li><code>GET /api/pool/status</code> - Check status of all agents</li>
          <li><code>GET /api/pool/users</code> - Get all registered users</li>
          <li><code>POST /api/pool/message</code> - Send a message using rotation</li>
          <li><code>POST /api/pool/message/:userId</code> - Send message as specific user</li>
          <li><code>POST /api/pool/messages/bulk</code> - Send multiple messages</li>
        </ul>
      </body>
    </html>
  `);
});

// Start server
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

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection:', reason);
});