// index.js - Main application file for the Message Agent System
// This file handles API routes, MongoDB interaction, and uses pageId to
// determine which phone number to use for sending and how to organize conversations
// within a single 'pageConvos' collection per pageId.
// FIX: Split GET /api/page-phone-mapping/:pageId? into two separate routes for better parsing.

const express = require('express');
const path = require('path');
const crypto = require('crypto'); // Used for generating message IDs (optional)
const { MongoClient, ObjectId } = require('mongodb'); // MongoDB driver
const numberPool = require('./numberPoolMessaging.js'); // Import the number pool logic

const app = express();
const PORT = process.env.PORT || 3000; // Server port

// MongoDB Connection URL and Database Name
const MONGO_URI = 'mongodb+srv://moathabdulrazak12:dc2025@cluster0.wyfk4lf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const DB_NAME = 'messageAgent';

// Simple logger for console output
const logger = {
  info: (message) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`),
  error: (message, error) => console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error),
  warn: (message) => console.warn(`[WARN] ${new Date().toISOString()} - ${message}`)
};

// MongoDB connection variables and collection references
let db; // MongoDB database instance
let pageConvos; // NEW: Reference to the 'pageConvos' collection (holds page data and embedded convos)
let agentPageMappings; // Reference to the 'agentPageMappings' collection (agentPhone -> pageId)
let client; // MongoClient instance

// Message retry queue system for failed outgoing messages
const messageRetryQueue = [];
const MAX_RETRIES = 3; // Maximum number of retry attempts for a message
const RETRY_INTERVAL = 60000; // Interval between retry attempts in milliseconds (1 minute)

/**
 * Processes messages in the retry queue. Attempts to resend failed messages.
 * Runs periodically via setInterval.
 * Note: Retry logic assumes the pageId document and potentially the embedded conversation
 * exist by the time of retry.
 */
async function processRetryQueue() {
  // Stop processing if the queue is empty
  if (messageRetryQueue.length === 0) {
    return;
  }

  logger.info(`Processing message retry queue - ${messageRetryQueue.length} messages pending`);

  // Get the first message from the front of the queue for processing
  const retryItem = messageRetryQueue.shift();

  // Validate the retry item data
  if (!retryItem || !retryItem.pageId || !retryItem.recipient || !retryItem.message) {
      logger.error("Invalid retry item found in queue, skipping:", retryItem);
      // Process the next item after a short delay to prevent a tight loop on bad data
      setTimeout(processRetryQueue, 1000);
      return;
  }

  try {
    logger.info(`Retrying message to ${retryItem.recipient} for pageId ${retryItem.pageId} (attempt ${retryItem.attempts + 1}/${MAX_RETRIES})`);

    // Find the pageConvos document to get the assigned agent phone
    const pageDoc = await pageConvos.findOne({ pageId: retryItem.pageId });
    if (!pageDoc || !pageDoc.assignedAgentPhone) {
      logger.error(`Page document or assigned agent phone not found for pageId ${retryItem.pageId} during retry. Giving up on this message.`);
      // This message cannot be sent without a valid pageId mapping. Do not re-queue.
      setTimeout(processRetryQueue, 1000);
      return;
    }
    const agentPhoneNumber = pageDoc.assignedAgentPhone;

    // Find the corresponding agent's information (especially userId) from the number pool
    const agentInfo = numberPool.getNumberPool().find(agent => standardizePhoneNumber(agent.phoneNumber) === standardizePhoneNumber(agentPhoneNumber));

    if (!agentInfo) {
        logger.error(`Agent info not found in number pool for phone number ${agentPhoneNumber} mapped to pageId ${retryItem.pageId} during retry. Giving up on this message.`);
        // Cannot retry without valid agent info in the pool. Do not re-queue.
        setTimeout(processRetryQueue, 1000);
        return;
    }

    // Attempt to send the message using the specific agent determined by pageId
    const result = await numberPool.sendMessageAsUser(agentInfo.id, retryItem.recipient, retryItem.message);

    logger.info(`Successfully resent message to ${retryItem.recipient} for pageId ${retryItem.pageId}`);

    // Message sent successfully. The message should already be stored in the embedded
    // conversation document from the initial attempt (even if it failed sending).
    // You might update a 'status' field on the embedded message document if your schema supports it.

  } catch (error) {
    // Handle errors during the retry attempt (e.g., agent still offline)
    logger.error(`Error during retry attempt for ${retryItem.recipient} (pageId ${retryItem.pageId}):`, error);

    // Increment the attempts counter
    retryItem.attempts++;

    // If we haven't reached the maximum number of retries, add it back to the queue
    if (retryItem.attempts < MAX_RETRIES) {
      messageRetryQueue.push(retryItem);
      logger.info(`Message to ${retryItem.recipient} (pageId ${retryItem.pageId}) requeued for later retry. Attempts: ${retryItem.attempts}`);
    } else {
      // If max retries are reached, give up on this message
      logger.error(`Failed to send message to ${retryItem.recipient} (pageId ${retryItem.pageId}) after ${MAX_RETRIES} attempts. Giving up on this message.`);
      // You might want to log this permanent failure to a separate log or collection.
    }
  } finally {
      // Schedule processing of the next item in the queue after a short delay
      // This prevents blocking if one retry attempt takes a long time.
      setTimeout(processRetryQueue, 100); // Small delay (e.g., 100ms)
  }
}

/**
 * Connects to the MongoDB database and initializes collection references.
 * Also creates necessary indexes for performance.
 * @returns {Promise<boolean>} True if connection was successful, false otherwise.
 */
async function connectToMongo() {
  try {
    // Create a new MongoClient instance
    client = new MongoClient(MONGO_URI);
    // Connect to the MongoDB server
    await client.connect();

    // Get the database instance
    db = client.db(DB_NAME);

    // Get references to the collections
    pageConvos = db.collection('pageConvos'); // NEW: Reference to the 'pageConvos' collection (holds page data and embedded convos)
    agentPageMappings = db.collection('agentPageMappings'); // Maps agentPhone -> pageId (still needed)

    // Create indexes for efficient querying
    // Index on pageId for quick lookup of a page's document
    await pageConvos.createIndex({ 'pageId': 1 }, { unique: true });
    // Index on assignedAgentId within conversations object values for agent dashboards (requires aggregation)
    // Note: Indexing within embedded objects requires dot notation on the field within the value,
    // like 'conversations.assignedAgentId'. This index helps aggregation pipelines.
    await pageConvos.createIndex({ 'conversations.assignedAgentId': 1 });
    // Index on lastMessageAt within conversations object values for sorting (requires aggregation)
    await pageConvos.createIndex({ 'conversations.lastMessageAt': 1 });
    // Index for unique agentPhoneNumber in the separate mapping collection
    await agentPageMappings.createIndex({ 'agentPhoneNumber': 1 }, { unique: true });
    // Index for pageId in agentPageMappings for reverse lookup
     await agentPageMappings.createIndex({ 'pageId': 1 });


    logger.info('Connected to MongoDB');
    return true;
  } catch (error) {
    logger.error('Error connecting to MongoDB:', error);
    return false;
  }
}

/**
 * Helper function to standardize phone numbers consistently.
 * Removes non-digit characters and handles optional leading '1' for 11-digit numbers.
 * @param {string} phoneNumber - The phone number string to standardize.
 * @returns {string} The standardized 10-digit phone number, or a warning if length is unexpected.
 */
function standardizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return '';

  // Convert to string and remove all non-digit characters
  let cleaned = phoneNumber.toString().replace(/\D/g, '');

  // Remove leading '1' if it's an 11-digit number (common for US/Canada with country code)
  if (cleaned.startsWith('1') && cleaned.length === 11) {
    cleaned = cleaned.substring(1);
  }

  // Basic validation: check if it's a 10-digit number after cleaning
  if (cleaned.length !== 10) {
    logger.warn(`Standardized phone number "${phoneNumber}" resulted in unexpected length ${cleaned.length}: "${cleaned}"`);
    // Depending on requirements, you might throw an error here or handle invalid numbers
    // For now, we'll log a warning and return the cleaned version, which might be incomplete.
  }

  return cleaned;
}

/**
 * Helper function to find an existing embedded conversation or create a new one
 * within the page's document in the pageConvos collection.
 * @param {string} pageId - The page identifier.
 * @param {string} participantPhone - The external participant's phone number (will be standardized).
 * @param {Object} [initialAgentInfo=null] - Optional agent info { id, phoneNumber } to assign if creating a new embedded conversation.
 * @returns {Promise<Object>} An object containing success status, conversationKey (the participant phone),
 * isNew (boolean), and the page document containing the conversation.
 */
async function findOrCreateEmbeddedConversation(pageId, participantPhone, initialAgentInfo = null) {
    const cleanParticipantPhone = standardizePhoneNumber(participantPhone);
    // Use the standardized phone number as the key for the embedded conversation object
    const conversationKey = cleanParticipantPhone;

    try {
        // Find the page document. If it doesn't exist, it will be created by the caller (e.g., /api/pool/message)
        // For this helper, we assume the page document already exists.
        let pageDoc = await pageConvos.findOne({ pageId: pageId });

        if (!pageDoc) {
            // This case should ideally be handled by the caller auto-creating the page doc.
            // Throwing here indicates a flow issue if the page doc isn't pre-created.
            throw new Error(`Page document not found for pageId "${pageId}". It must be created first.`);
        }

        // Check if the embedded conversation already exists using the participant phone as the key
        logger.info(`DEBUG: Checking if embedded conversation exists for key "${conversationKey}" in pageDoc ID: ${pageDoc._id}`);
        if (pageDoc.conversations && pageDoc.conversations[conversationKey]) {
            logger.info(`DEBUG: Found existing embedded conversation for pageId "${pageId}" and participant "${conversationKey}".`);
            // DEBUG: Log the existing conversation object
            // logger.info(`DEBUG: Existing embedded conversation object: ${JSON.stringify(pageDoc.conversations[conversationKey])}`); // Avoid logging large objects
            return {
                success: true,
                conversationKey: conversationKey,
                isNew: false,
                pageDoc // Return the page document which contains the conversation
            };
        }

        // If the embedded conversation doesn't exist, create it
        logger.info(`DEBUG: Embedded conversation NOT found for key "${conversationKey}". Proceeding to create new.`);

        const newConversationId = new ObjectId(); // Generate a unique ID for the conversation thread itself (optional, but good practice)
        const newEmbeddedConversation = {
             // Note: We are embedding the conversation data directly.
             // The key in the 'conversations' object is the participantPhone.
             // The value is the conversation details.
             // We can still include a unique ID within the embedded object if needed.
            conversationId: newConversationId, // Unique ID for this specific thread
            participants: [cleanParticipantPhone], // Store the participant phone within the embedded object
            assignedAgentId: initialAgentInfo ? initialAgentInfo.id : null,
            assignedAgentPhone: initialAgentInfo ? initialAgentInfo.phoneNumber : null,
            startedAt: new Date(),
            lastMessageAt: new Date(),
            messages: [] // Initialize with an empty messages array
        };

        // DEBUG: Log immediately AFTER declaring newEmbeddedConversation
        // logger.info(`DEBUG: newEmbeddedConversation declared. Value: ${JSON.stringify(newEmbeddedConversation)}`);


        // DEBUG: Log pageDoc ID and the newEmbeddedConversation object before update
        logger.info(`DEBUG: Attempting to add new embedded conversation for pageDoc ID: ${pageDoc._id}`);
        // logger.info(`DEBUG: New embedded conversation object (pre-update): ${JSON.stringify(newEmbeddedConversation)}`);
        logger.info(`DEBUG: conversationKey is: "${conversationKey}"`);


        // This update operation should only happen when creating a NEW embedded conversation.
         const updateResult = await pageConvos.updateOne(
            { _id: pageDoc._id },
            {
                $set: {
                    // Set the new embedded conversation using the participant phone as the key
                    [`conversations.${conversationKey}`]: newEmbeddedConversation,
                    // Update lastMessageAt on the page document to reflect the new conversation start
                    lastMessageAt: new Date()
                }
            }
        );
        logger.info(`DEBUG: Update result for adding new embedded conversation: ${JSON.stringify(updateResult)}`);


        // Re-fetch the updated page document to return it
        // FIX: Re-fetch the pageDoc *after* the update has completed successfully
        pageDoc = await pageConvos.findOne({ _id: pageDoc._id });
         if (!pageDoc) {
             throw new Error(`Failed to retrieve page document after adding new conversation for pageId "${pageId}".`);
        }
        // FIX: After re-fetching, update the embeddedConversation variable
        // embeddedConversation = pageDoc.conversations[conversationKey]; // Not needed here, caller gets it from returned pageDoc


        logger.info(`Created new embedded conversation for pageId "${pageId}" and participant "${conversationKey}"`);

        // The function returns here if a new conversation was created
        // The rest of the logic in /api/pool/message handles adding the first message
        // and sending it via the agent.
         return {
            success: true,
            conversationKey: conversationKey,
            isNew: true,
            pageDoc // Return the updated page document
        };


    } catch (error) {
        logger.error(`Error finding or creating embedded conversation for pageId "${pageId}" and participant "${cleanParticipantPhone}":`, error);
        return {
            success: false,
            error: error.message
        };
    }
}


// --- Express Middleware ---
// Middleware to parse incoming requests with JSON payloads.
app.use(express.json());
// Middleware to serve static files from the 'public' directory (e.g., HTML, CSS, JS).
app.use(express.static(path.join(__dirname, 'public')));

// --- Endpoints for PageId -> Phone Mapping Configuration ---

/**
 * Sets or updates the assigned agent phone number for a specific pageId.
 * This now updates the 'assignedAgentPhone' field directly in the page's document
 * within the 'pageConvos' collection.
 * Request Body: { pageId: string, agentPhoneNumber: string }
 */
app.post('/api/page-phone-mapping', async (req, res) => {
  try {
    const { pageId, agentPhoneNumber } = req.body;

    // Validate required parameters
    if (!pageId || !agentPhoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: pageId and agentPhoneNumber'
      });
    }

    // Standardize the provided agent phone number
    const cleanAgentPhone = standardizePhoneNumber(agentPhoneNumber);

    // Validate if the provided agentPhoneNumber exists in the number pool configuration
    const agentExists = numberPool.getNumberPool().some(agent => standardizePhoneNumber(agent.phoneNumber) === cleanAgentPhone);
    if (!agentExists) {
        logger.warn(`Attempted to map pageId ${pageId} to phone ${agentPhoneNumber}, but this number is not in the number pool.`);
        return res.status(400).json({
            success: false,
            error: `Agent phone number ${agentPhoneNumber} not found in the number pool configuration. Please use a number defined in numberPoolMessaging.js.`
        });
    }

    // Use updateOne with upsert: true to create or update the page document
    // and set the assignedAgentPhone field within it.
    await pageConvos.updateOne(
      { pageId: pageId }, // Filter by pageId
      {
          $set: {
              pageId: pageId, // Ensure pageId is set if creating
              assignedAgentPhone: cleanAgentPhone // Set the assigned agent phone number
          },
          $setOnInsert: { conversations: {} } // Initialize conversations as an empty object if creating
      },
      { upsert: true } // Create the document if it doesn't exist
    );

    // Also create or update the reverse mapping (agentPhone -> pageId) in the agentPageMappings collection.
    // This is crucial for routing incoming messages received on an agent phone back to the correct pageId.
    await agentPageMappings.updateOne(
      { agentPhoneNumber: cleanAgentPhone }, // Filter by agentPhoneNumber
      { $set: { pageId: pageId } }, // Set the associated pageId
      { upsert: true } // Create the document if it doesn't exist
    );

    logger.info(`PageId "${pageId}" successfully mapped to agent phone "${cleanAgentPhone}" in pageConvos. Reverse mapping also updated.`);

    // Send a success response
    res.json({
      success: true,
      message: 'PageId to agent phone mapping created/updated successfully',
      pageId: pageId,
      agentPhoneNumber: cleanAgentPhone
    });
  } catch (error) {
    // Log and return error if the operation fails
    logger.error('Error setting pageId to agent phone mapping:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Gets the assigned agent phone number for a specific pageId.
 * URL Parameter: :pageId (string)
 */
app.get('/api/page-phone-mapping/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params; // Get pageId from URL parameters

    // Lookup by pageId
    const pageDoc = await pageConvos.findOne(
        { pageId: pageId },
        { projection: { assignedAgentPhone: 1, pageId: 1 } } // Only project necessary fields
    );

    if (!pageDoc || !pageDoc.assignedAgentPhone) {
      logger.warn(`No page document or assigned phone found for pageId "${pageId}"`);
      return res.status(404).json({
        success: false,
        error: `No agent phone mapping found for pageId "${pageId}"`
      });
    }

    res.json({
      success: true,
      pageId: pageDoc.pageId,
      agentPhoneNumber: pageDoc.assignedAgentPhone
    });

  } catch (error) {
    // Log and return error if the operation fails
    logger.error(`Error getting agent phone for pageId ${req.params.pageId}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Gets the pageId for a specific agentPhoneNumber.
 * Query Parameter: agentPhoneNumber (string)
 */
app.get('/api/page-phone-mapping', async (req, res) => {
  try {
    const { agentPhoneNumber } = req.query; // Get agentPhoneNumber from query parameters

    // Validate required query parameter
    if (!agentPhoneNumber) {
         return res.status(400).json({
            success: false,
            error: 'Missing required query parameter: agentPhoneNumber'
        });
    }

    // Lookup by agentPhoneNumber
    const cleanAgentPhone = standardizePhoneNumber(agentPhoneNumber);
    const mapping = await agentPageMappings.findOne(
        { agentPhoneNumber: cleanAgentPhone },
        { projection: { pageId: 1, agentPhoneNumber: 1 } } // Only project necessary fields
    );

    if (!mapping || !mapping.pageId) {
        logger.warn(`No pageId mapping found for agent phone "${cleanAgentPhone}"`);
         return res.status(404).json({
            success: false,
            error: `No pageId mapping found for agent phone "${agentPhoneNumber}"`
        });
    }

    res.json({
        success: true,
        pageId: mapping.pageId,
        agentPhoneNumber: mapping.agentPhoneNumber
    });

  } catch (error) {
    // Log and return error if the operation fails
    logger.error(`Error getting pageId for agent phone ${req.query.agentPhoneNumber}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// --- Primary Endpoint for Sending Outgoing Messages using pageId ---

/**
 * Sends an outgoing message to a recipient.
 * The agent phone number used for sending is determined by the provided pageId,
 * looked up from the page's document in 'pageConvos'.
 * If a page document for the pageId does not exist, it will automatically create one
 * and assign the next available agent phone from the pool using rotation.
 * Requires: pageId (string), recipient (string), message (string) in request body.
 */
app.post('/api/pool/message', async (req, res) => {
  try {
    // Extract required parameters from the request body
    const { pageId, recipient, message } = req.body;

    // Validate required parameters
    if (!pageId || !recipient || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: pageId, recipient, and message'
      });
    }

    // Standardize the recipient's phone number
    const cleanRecipient = standardizePhoneNumber(recipient);
    logger.info(`Received send request for pageId: "${pageId}", recipient: "${cleanRecipient}"`);

    let agentPhoneNumber;
    let agentInfo;
    let pageDocExists = false;

    // 1. Find or auto-create the page document for this pageId
    let pageDoc = await pageConvos.findOne({ pageId: pageId });

    if (pageDoc) {
        pageDocExists = true;
        logger.info(`Found existing page document for pageId "${pageId}".`);

        // Use the assigned phone number from the existing document
        agentPhoneNumber = pageDoc.assignedAgentPhone;

        // If no phone number is assigned in the existing document, auto-assign one
        if (!agentPhoneNumber) {
            logger.warn(`Existing page document for pageId "${pageId}" has no assigned phone. Auto-assigning.`);
            // Use the rotation logic from numberPoolMessaging to pick an agent
            const assignedAgent = numberPool.getCurrentUser();
             if (!assignedAgent) {
                throw new Error("Number pool is empty. Cannot auto-assign an agent.");
            }
            // Rotate the pool so the next auto-assignment gets a different number
            numberPool.rotateToNextUser();

            agentInfo = assignedAgent;
            agentPhoneNumber = agentInfo.phoneNumber;

            // Update the page document with the newly assigned phone number
            await pageConvos.updateOne(
                { pageId: pageId },
                { $set: { assignedAgentPhone: agentPhoneNumber } }
            );
             logger.info(`Assigned agent "${agentInfo.username}" (${agentPhoneNumber}) to existing pageId "${pageId}".`);

             // Also create the reverse mapping for incoming messages
             await agentPageMappings.updateOne(
                { agentPhoneNumber: agentPhoneNumber },
                { $set: { pageId: pageId } },
                { upsert: true }
             );
             logger.info(`Created/updated reverse mapping for agent phone "${agentPhoneNumber}" -> pageId "${pageId}".`);


        } else {
             // Phone number was already assigned, find agent info from the pool
             agentInfo = numberPool.getNumberPool().find(agent => standardizePhoneNumber(agent.phoneNumber) === standardizePhoneNumber(agentPhoneNumber));

             // Check if the mapped agent phone number is still in the number pool
             if (!agentInfo) {
                 logger.error(`Configuration error: Mapped agent phone number "${agentPhoneNumber}" for pageId "${pageId}" not found in current number pool configuration. Cannot send message.`);
                 return res.status(500).json({
                    success: false,
                    error: `Configuration error: Mapped agent phone number not found in number pool for pageId "${pageId}".`
                 });
             }
             logger.info(`Using assigned agent phone "${agentPhoneNumber}" for pageId "${pageId}".`);
        }

    } else {
      // No page document found for this pageId. Auto-create one and assign a phone number.
      logger.warn(`No page document found for pageId "${pageId}". Auto-creating and assigning a number from the pool.`);

      // Use the rotation logic from numberPoolMessaging to pick an agent
      const assignedAgent = numberPool.getCurrentUser();
      if (!assignedAgent) {
          throw new Error("Number pool is empty. Cannot auto-assign an agent.");
      }
       // Rotate the pool so the next auto-assignment gets a different number
      numberPool.rotateToNextUser();

      agentInfo = assignedAgent;
      agentPhoneNumber = agentInfo.phoneNumber;

      // Create the new page document with the assigned phone number and empty conversations object
      try {
          await pageConvos.insertOne({
              pageId: pageId,
              assignedAgentPhone: agentPhoneNumber,
              conversations: {} // Initialize conversations as an empty object
          });
           logger.info(`Created new page document for pageId "${pageId}" and assigned phone "${agentPhoneNumber}".`);

           // Also create the reverse mapping for incoming messages
           await agentPageMappings.updateOne(
              { agentPhoneNumber: agentPhoneNumber },
              { $set: { pageId: pageId } },
              { upsert: true }
           );
           logger.info(`Created reverse mapping for agent phone "${agentPhoneNumber}" -> pageId "${pageId}".`);


      } catch (dbError) {
           logger.error(`Error creating new page document for "${pageId}" -> "${agentPhoneNumber}":`, dbError);
           // If creating the page document fails, we cannot proceed.
           return res.status(500).json({
              success: false,
              error: `Failed to create new page document for pageId "${pageId}". Error: ${dbError.message}`
           });
      }
       // Re-fetch the page document after creation to ensure we have the latest state
       pageDoc = await pageConvos.findOne({ pageId: pageId });
        if (!pageDoc) {
             // This should not happen if insertOne was successful, but as a safeguard
             throw new Error(`Failed to retrieve page document after creation for pageId "${pageId}".`);
        }
    }

    // --- Now we have the pageDoc, agentInfo, and agentPhoneNumber ---

    // 2. Find or create the embedded conversation within the page document
    // Use the standardized recipient phone as the key for the embedded conversation
    const conversationKey = cleanRecipient;
    let embeddedConversation = pageDoc.conversations ? pageDoc.conversations[conversationKey] : null;
    let isNewConversation = false;

    if (!embeddedConversation) {
        isNewConversation = true;
        const newConversationId = new ObjectId(); // Unique ID for this thread
        const newEmbeddedConversation = {
             // Note: We are embedding the conversation data directly.
             // The key in the 'conversations' object is the participantPhone.
             // The value is the conversation details.
             // We can still include a unique ID within the embedded object if needed.
            conversationId: newConversationId, // Unique ID for this specific thread
            participants: [cleanRecipient], // Store the participant phone within the embedded object
            assignedAgentId: agentInfo.id, // Assign the determined agent
            assignedAgentPhone: agentInfo.phoneNumber, // Assign the determined agent phone
            startedAt: new Date(),
            lastMessageAt: new Date(),
            messages: [] // Initialize with an empty messages array
        };

        // DEBUG: Log immediately AFTER declaring newEmbeddedConversation
        // logger.info(`DEBUG: newEmbeddedConversation declared. Value: ${JSON.stringify(newEmbeddedConversation)}`);


        // DEBUG: Log pageDoc ID and the newEmbeddedConversation object before update
        logger.info(`DEBUG: Attempting to add new embedded conversation for pageDoc ID: ${pageDoc._id}`);
        // logger.info(`DEBUG: New embedded conversation object (pre-update): ${JSON.stringify(newEmbeddedConversation)}`);
        logger.info(`DEBUG: conversationKey is: "${conversationKey}"`);


        // This update operation should only happen when creating a NEW embedded conversation.
         const updateResult = await pageConvos.updateOne(
            { _id: pageDoc._id },
            {
                $set: {
                    // Set the new embedded conversation using the participant phone as the key
                    [`conversations.${conversationKey}`]: newEmbeddedConversation,
                    // Update lastMessageAt on the page document to reflect the new conversation start
                    lastMessageAt: new Date()
                }
            }
        );
        logger.info(`DEBUG: Update result for adding new embedded conversation: ${JSON.stringify(updateResult)}`);


        // Re-fetch the updated page document to return it
        // FIX: Re-fetch the pageDoc *after* the update has completed successfully
        pageDoc = await pageConvos.findOne({ _id: pageDoc._id });
         if (!pageDoc) {
             throw new Error(`Failed to retrieve page document after adding new conversation for pageId "${pageId}".`);
        }
        // FIX: After re-fetching, update the embeddedConversation variable
        embeddedConversation = pageDoc.conversations[conversationKey];


        logger.info(`Created new embedded conversation for pageId "${pageId}" and participant "${conversationKey}"`);

        // The function returns here if a new conversation was created
        // The rest of the logic in /api/pool/message handles adding the first message
        // and sending it via the agent.

    } else {
         logger.info(`Found existing embedded conversation for pageId "${pageId}" and participant "${conversationKey}"`);
         // If the conversation already exists, we don't need to create or add the embedded object again.
         // The embeddedConversation variable already holds the correct object from the initial pageDoc fetch.
         // Ensure assigned agent info is up-to-date on the embedded conversation if needed
         // (Optional, depending on if assignment can change per conversation)
         // For now, we'll just ensure the page-level assignedAgentPhone is used for sending.
    }


    // --- At this point, embeddedConversation variable HOLDS the correct conversation object (either found or newly created) ---

    // 3. Check for duplicate outgoing messages within the embedded conversation
     if (embeddedConversation && embeddedConversation.messages && embeddedConversation.messages.length > 0) {
        const isDuplicate = embeddedConversation.messages.some(msg =>
            msg.direction === 'outgoing' &&
            msg.message === message &&
            // Check if a message with the same text was sent to the same recipient by the same agent
            // within a short time frame (e.g., 60 seconds).
            standardizePhoneNumber(msg.recipient) === cleanRecipient && // Standardize message recipient for comparison
            msg.sender && standardizePhoneNumber(msg.sender.phoneNumber) === standardizePhoneNumber(agentInfo.phoneNumber) && // Standardize message sender for comparison
            Math.abs(new Date(msg.timestamp) - new Date()) < 60000 // Within 1 minute
        );

        if (isDuplicate) {
            logger.warn(`Duplicate outgoing message detected for pageId "${pageId}", participant "${conversationKey}". Not adding or sending again.`);
            return res.json({
                success: true,
                message: 'Message already exists in conversation (likely a duplicate API call)',
                pageId: pageId,
                conversationKey: conversationKey, // Use the participant phone as the conversation key
                conversationId: embeddedConversation.conversationId, // Return the embedded conversation's unique ID
                isDuplicate: true
            });
        }
    }


    try {
      // 4. Send the message using the specific agent phone determined by pageId (either looked up or auto-assigned).
      // Call numberPool.sendMessageAsUser with the found agent's userId.
      const sendResult = await numberPool.sendMessageAsUser(agentInfo.id, recipient, message);

      // 5. Store the outgoing message details in the embedded conversation document.
      const newMessage = {
        _id: new ObjectId(), // Generate a unique ID for this message document
        direction: 'outgoing', // Mark as outgoing
        sender: { // Details of the sending agent
          userId: agentInfo.id,
          username: agentInfo.username,
          phoneNumber: agentInfo.phoneNumber // Store the actual sending number used
        },
        recipient: cleanRecipient, // Store the standardized recipient number
        message: message, // Store the message content
        timestamp: new Date() // Use the current time for the message timestamp
      };

      // Update the page document to push the new message into the correct embedded conversation's messages array
      // and update the lastMessageAt timestamp for both the embedded conversation and the page document.
      await pageConvos.updateOne(
        { _id: pageDoc._id }, // Filter by the page document ID
        {
          $set: {
            // Update lastMessageAt for the specific embedded conversation
            [`conversations.${conversationKey}.lastMessageAt`]: new Date(),
            // Update lastMessageAt for the overall page document (optional, for sorting pages by activity)
            lastMessageAt: new Date()
          },
          // Push the new message into the messages array of the specific embedded conversation
          $push: { [`conversations.${conversationKey}.messages`]: newMessage }
        }
      );

      logger.info(`Message sent successfully via agent ${agentInfo.username} (${agentInfo.phoneNumber}) for pageId "${pageId}" to "${recipient}". Stored in embedded conversation.`);

      // Send a success response including the pageId and conversation key/ID.
      res.json({
        success: true,
        message: 'Message sent successfully',
        result: sendResult.result, // Include any result data returned by the agent's send API
        pageId: pageId,
        conversationKey: conversationKey, // Return the participant phone as the conversation key
        conversationId: embeddedConversation.conversationId, // Return the embedded conversation's unique ID
        mappingAutoCreated: !pageDocExists, // Indicate if a page document was auto-created
        conversationAutoCreated: isNewConversation // Indicate if the embedded conversation was auto-created
      });
    } catch (error) {
      // If message sending fails (e.g., network error, agent API error), add to retry queue.
      logger.error(`Error sending message for pageId "${pageId}" to "${recipient}". Adding to retry queue:`, error);

      // Add the necessary details to the retry queue for later processing.
      messageRetryQueue.push({
        pageId: pageId, // Store pageId to determine the sending number on retry
        recipient: recipient, // Original recipient phone number
        message: message, // Message content
        // conversationId: conversationId, // We don't have a top-level conversationId anymore
        // We might need conversationKey (participant phone) for retry if we want to update embedded message status
        conversationKey: conversationKey,
        attempts: 0, // Initialize attempt count
        timestamp: new Date() // Timestamp when added to the queue
      });

      // Respond with an error but indicate that the message will be retried.
      // You might want to store the message in the embedded conversation with a 'failed' status
      // here before adding to the retry queue, depending on your message schema.
      res.status(500).json({
        success: false,
        error: `Message sending failed, but has been added to retry queue. Error: ${error.message}`,
        willRetry: true,
        pageId: pageId,
        conversationKey: conversationKey,
        conversationId: embeddedConversation ? embeddedConversation.conversationId : null, // Return ID if conversation object was created
        mappingAutoCreated: !pageDocExists,
        conversationAutoCreated: isNewConversation
      });
    }
  } catch (error) {
    // Handle errors that occur before the send attempt (e.g., validation, database lookup errors)
    logger.error('Error processing /api/pool/message request:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Receives and stores an incoming message from an external participant.
 * The 'to' field (the receiving agent phone number) is used to determine the pageId
 * via agentPageMappings, and route the message to the correct embedded conversation
 * within the page's document in 'pageConvos'.
 * Requires: from (string - sender phone), message (string - content),
 * to (string - receiving agent phone), timestamp (optional string/number) in body.
 * Optional: conversationId (string - if agent already knows the conversation ID)
 */
app.post('/api/receive-message', async (req, res) => {
  logger.info("Received incoming message request");
  // DEBUG: Log the full request body to see what the agent is sending
  logger.info(`DEBUG: Incoming message request body: ${JSON.stringify(req.body)}`);

  try {
    // Extract required parameters from the request body.
    // 'from' is the external sender's phone number.
    // 'to' is the agent phone number that received the message.
    const { from, message, timestamp, to, conversationId } = req.body; // Added conversationId

    // Validate required parameters.
    if (!from || !message || !to) {
      logger.warn("Missing required parameters in /api/receive-message request:", req.body);
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: from (sender phone), message, and to (receiving agent phone)'
      });
    }

    // Standardize the sender's phone number and the receiving agent's phone number.
    const cleanSenderPhone = standardizePhoneNumber(from);
    const cleanReceivingAgentPhone = standardizePhoneNumber(to);
    // Use the standardized sender phone as the key for the embedded conversation
    const conversationKey = cleanSenderPhone;


    // 1. Determine the pageId based on the receiving agent phone number.
    // Look up the receiving agent's phone in the agentPageMappings collection.
    const agentPageMapping = await agentPageMappings.findOne({ agentPhoneNumber: cleanReceivingAgentPhone });

    // If the receiving agent phone is not mapped to any pageId, we cannot route the message.
    if (!agentPageMapping) {
        logger.warn(`No pageId mapping found for receiving agent phone "${cleanReceivingAgentPhone}". Cannot process incoming message.`);
        // If an incoming message arrives on a number not mapped to any pageId,
        // you might want to log this unroutable message or send an alert.
        // For now, we return a 404 error.
        return res.status(404).json({
            success: false,
            error: `No pageId mapping found for receiving agent phone "${to}". Incoming message cannot be routed.`
        });
    }

    // Get the pageId from the mapping.
    const pageId = agentPageMapping.pageId;
    logger.info(`Incoming message received by agent "${cleanReceivingAgentPhone}" mapped to pageId "${pageId}"`);

    // Find the receiving agent's information from the number pool configuration.
    const receivingAgentInfo = numberPool.getNumberPool().find(agent => standardizePhoneNumber(agent.phoneNumber) === cleanReceivingAgentPhone);
    // Note: receivingAgentInfo might be null if the number is mapped but not in the current pool config.
    // The findOrCreateEmbeddedConversation helper can handle null initialAgentInfo.


    // 2. Find the page document for this pageId.
    // We assume the page document exists because the agentPhone -> pageId mapping exists.
    // If it somehow doesn't exist, findOrCreateEmbeddedConversation will throw.
    let pageDoc = await pageConvos.findOne({ pageId: pageId });
     if (!pageDoc) {
         logger.error(`Page document not found for pageId "${pageId}" despite agentPageMapping existing for "${cleanReceivingAgentPhone}". Data inconsistency.`);
          return res.status(500).json({
            success: false,
            error: `Internal error: Page document not found for pageId "${pageId}".`
        });
     }


    // 3. Find or create the embedded conversation within the page document using the sender phone as the key.
    // We pass the receiving agent info so it can be assigned if a new conversation is created.
    const conversationResult = await findOrCreateEmbeddedConversation(pageId, cleanSenderPhone, receivingAgentInfo);

    // Handle error if finding or creating the embedded conversation fails.
    if (!conversationResult.success) {
        logger.error(`Failed to find or create embedded conversation for incoming message (pageId "${pageId}", sender "${cleanSenderPhone}"): ${conversationResult.error}`);
        return res.status(500).json({
            success: false,
            error: `Failed to find or create conversation for incoming message: ${conversationResult.error}`
        });
    }

    // Get the updated page document and the embedded conversation details
    pageDoc = conversationResult.pageDoc; // Get the latest page document state
    const embeddedConversation = pageDoc.conversations[conversationKey]; // Get the embedded conversation object
    const isNewConversation = conversationResult.isNew;


    // 4. Check for duplicate incoming messages within the embedded conversation.
    // This helps prevent duplicate entries if the agent service retries sending the webhook.
    if (embeddedConversation && embeddedConversation.messages && embeddedConversation.messages.length > 0) {
      const isDuplicate = embeddedConversation.messages.some(msg =>
        msg.direction === 'incoming' &&
        msg.message === message &&
        // Check if a message with the same text was received from the same sender
        // on the same receiving number within a short time frame (e.g., 60 seconds).
        msg.sender && standardizePhoneNumber(msg.sender.phoneNumber) === cleanSenderPhone &&
        standardizePhoneNumber(msg.recipient) === cleanReceivingAgentPhone && // Recipient is the receiving agent phone for incoming
        Math.abs(new Date(msg.timestamp) - (timestamp ? new Date(timestamp) : new Date())) < 60000 // Within 1 minute
      );

      if (isDuplicate) {
        logger.warn(`Duplicate incoming message detected for pageId "${pageId}", participant "${conversationKey}". Not adding.`);
        return res.json({
          success: true,
          message: 'Incoming message already exists in conversation (likely a duplicate webhook)',
          pageId: pageId,
          conversationKey: conversationKey,
          conversationId: embeddedConversation.conversationId, // Return the embedded conversation's unique ID
          isDuplicate: true
        });
      }
    }


    // 5. Create the new message object for storage.
    const newMessage = {
      _id: new ObjectId(), // Generate a unique ID for this message document
      direction: 'incoming', // Mark as incoming
      sender: {
        phoneNumber: from // Store the original sender phone number
        // You might add sender name or other details here if available
      },
      recipient: to, // Store the original receiving agent phone number
      message: message, // Store the message content
      timestamp: timestamp ? new Date(timestamp) : new Date() // Use the provided timestamp or current time
    };

    // 6. Update the page document to push the new message into the correct embedded conversation's messages array
    // and update the lastMessageAt timestamp for both the embedded conversation and the page document.
    const updateFields = {
        // Update lastMessageAt for the specific embedded conversation
        [`conversations.${conversationKey}.lastMessageAt`]: timestamp ? new Date(timestamp) : new Date(),
        // Update lastMessageAt for the overall page document (optional, for sorting pages by activity)
        lastMessageAt: timestamp ? new Date(timestamp) : new Date()
    };

    // If the embedded conversation didn't have an assigned agent, assign the receiving agent
    // This logic is now handled in findOrCreateEmbeddedConversation, but we can double-check/update here if needed.
    // For simplicity, we rely on findOrCreateEmbeddedConversation to set the initial assignment.
    // If you wanted to re-assign on incoming reply, you'd modify updateFields here.


    await pageConvos.updateOne(
      { _id: pageDoc._id }, // Filter by the page document ID
      {
        $set: updateFields, // Apply the updates (lastMessageAt)
        // Push the new message into the messages array of the specific embedded conversation
        $push: { [`conversations.${conversationKey}.messages`]: newMessage }
      }
    );

    logger.info(`Incoming message stored in embedded conversation for pageId "${pageId}", participant "${conversationKey}"`);

    // Send a success response including the pageId and conversation key/ID.
    res.json({
      success: true,
      message: 'Incoming message stored successfully',
      pageId: pageId,
      conversationKey: conversationKey, // Return the participant phone as the conversation key
      conversationId: embeddedConversation.conversationId, // Return the embedded conversation's unique ID
      conversationAutoCreated: isNewConversation // Indicate if the embedded conversation was auto-created
    });
  } catch (error) {
    // Handle errors during the incoming message processing.
    logger.error('Error processing /api/receive-message request:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/**
 * Checks if a conversation exists for a given pageId and participant phone number.
 * Looks for the embedded conversation within the page's document in 'pageConvos'.
 * Query Parameters: pageId (string), phone (string)
 */
app.get('/api/check-conversation', async (req, res) => {
  logger.info("Received /api/check-conversation request");
  logger.info(`DEBUG: /api/check-conversation query params: ${JSON.stringify(req.query)}`);

  try {
    const { pageId, phone } = req.query;

    // Validate required query parameters
    if (!pageId || !phone) {
      logger.warn("Missing required query parameters in /api/check-conversation:", req.query);
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameters: pageId and phone'
      });
    }

    // Standardize the participant's phone number to use as the conversation key
    const cleanPhone = standardizePhoneNumber(phone);
    const conversationKey = cleanPhone;

    // Find the page document for the given pageId
    const pageDoc = await pageConvos.findOne(
        { pageId: pageId },
        // Project only the specific embedded conversation if it exists
        { projection: { [`conversations.${conversationKey}`]: 1, pageId: 1 } }
    );

    // If no page document is found, or the embedded conversation doesn't exist within it
    if (!pageDoc || !pageDoc.conversations || !pageDoc.conversations[conversationKey]) {
       logger.info(`Conversation not found for pageId "${pageId}" and phone "${cleanPhone}"`);
      return res.json({
        success: true,
        exists: false
      });
    }

    // If the embedded conversation is found, return its details
    const embeddedConversation = pageDoc.conversations[conversationKey];
    logger.info(`Conversation found for pageId "${pageId}" and phone "${cleanPhone}"`);
    res.json({
      success: true,
      exists: true,
      conversationId: embeddedConversation.conversationId, // Return the embedded conversation's unique ID
      assignedAgentId: embeddedConversation.assignedAgentId,
      assignedAgentPhone: embeddedConversation.assignedAgentPhone,
      pageId: pageDoc.pageId,
      conversationKey: conversationKey // Return the participant phone key
    });
  } catch (error) {
    // Log and return error if the operation fails
    logger.error('Error checking conversation by pageId and phone:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/**
 * Gets all conversations, optionally filtered by pageId.
 * This requires querying the 'pageConvos' collection and extracting embedded conversations.
 * Query Parameter: pageId (optional string)
 */
app.get('/api/conversations', async (req, res) => {
  try {
    const { pageId } = req.query; // Get optional pageId filter from query parameters

    let matchQuery = {};
    // If pageId is provided, add it to the match stage
    if (pageId) {
        matchQuery.pageId = pageId;
    }

    // Use aggregation pipeline to extract and format embedded conversations
    const pipeline = [];

    // Stage 1: Filter page documents by pageId if provided
    if (Object.keys(matchQuery).length > 0) {
        pipeline.push({ $match: matchQuery });
    }

     // Stage 2: Unwind the 'conversations' object into key-value pairs
     pipeline.push({
         $project: {
             pageId: 1,
             assignedAgentPhone: 1, // Include the page-level assigned phone
             conversationsArray: { $objectToArray: "$conversations" } // Convert conversations object to array
         }
     });

     // Stage 3: Unwind the conversations array to process each conversation separately
     pipeline.push({ $unwind: "$conversationsArray" });

     // Stage 4: Project and format the output for each conversation
     pipeline.push({
         $project: {
             _id: "$conversationsArray.v.conversationId", // Use the embedded conversationId as the main ID
             pageId: "$pageId",
             conversationKey: "$conversationsArray.k", // The participant phone is the key
             participants: "$conversationsArray.v.participants",
             assignedAgentId: "$conversationsArray.v.assignedAgentId",
             assignedAgentPhone: "$conversationsArray.v.assignedAgentPhone", // Use embedded assigned phone
             startedAt: "$conversationsArray.v.startedAt",
             lastMessageAt: "$conversationsArray.v.lastMessageAt",
             // Get the last message (requires another unwind or $slice in a sub-pipeline, which is complex)
             // For simplicity in this list view, we'll just indicate if messages exist and show a preview if possible
             hasMessages: { $gt: [{ $size: "$conversationsArray.v.messages" }, 0] },
             lastMessageTimestamp: "$conversationsArray.v.lastMessageAt" // Use for sorting
             // To include the last message content, you'd need a more complex $project with $slice
             // or a separate lookup for the full conversation details.
         }
     });

    // Stage 5: Sort the results by last message timestamp (newest first)
    pipeline.push({ $sort: { lastMessageTimestamp: -1 } });

    // Execute the aggregation pipeline
    const allConversations = await pageConvos.aggregate(pipeline).toArray();

    // Format the response (already mostly formatted by the pipeline)
    const formattedConversations = allConversations.map(convo => ({
        id: convo._id,
        pageId: convo.pageId,
        conversationKey: convo.conversationKey,
        participants: convo.participants,
        assignedAgentId: convo.assignedAgentId,
        assignedAgentPhone: convo.assignedAgentPhone,
        startedAt: convo.startedAt,
        lastMessageAt: convo.lastMessageAt,
        hasLastMessage: convo.hasMessages, // Use hasMessages from aggregation
        // Last message content is not included in this list view for performance
        lastMessage: null // Set to null as content is not projected
      }));


    // Send the formatted list of conversations
    res.json({
      success: true,
      conversations: formattedConversations
    });
  } catch (error) {
    // Log and return error if the operation fails
    logger.error('Error fetching conversations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Gets a specific conversation by its embedded conversationId.
 * This requires finding the correct page document and then the embedded conversation.
 * URL Parameter: :conversationId (string - the embedded conversation's unique ID)
 */
app.get('/api/conversations/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params; // Get conversationId from URL parameters

    // Convert the string ID from the URL to a MongoDB ObjectId
    let id;
    try {
      id = new ObjectId(conversationId);
    } catch (error) {
      // If the provided ID string is not a valid ObjectId format
      return res.status(400).json({
          success: false,
          error: 'Invalid Conversation ID format'
      });
    }

    // Use aggregation to find the page document containing the embedded conversation
    // and extract that specific conversation.
    const pipeline = [
        // Stage 1: Find page documents that contain *any* embedded conversation
         {
             $match: {
                 'conversations': { $exists: true, $ne: {} } // Ensure conversations object exists and is not empty
             }
         },
        // Stage 2: Convert conversations object to an array of key-value pairs
        {
             $project: {
                 pageId: 1,
                 assignedAgentPhone: 1,
                 conversationsArray: { $objectToArray: "$conversations" }
             }
        },
        // Stage 3: Unwind the array to process each embedded conversation
        { $unwind: "$conversationsArray" },
        // Stage 4: Match the specific embedded conversation by its conversationId
        {
            $match: {
                'conversationsArray.v.conversationId': id // Match the embedded conversationId
            }
        },
        // Stage 5: Project the required fields from the matched embedded conversation
        {
            $project: {
                _id: "$conversationsArray.v.conversationId", // Use the embedded conversationId as the main ID
                pageId: "$pageId",
                conversationKey: "$conversationsArray.k", // The participant phone is the key
                participants: "$conversationsArray.v.participants",
                assignedAgentId: "$conversationsArray.v.assignedAgentId",
                assignedAgentPhone: "$conversationsArray.v.assignedAgentPhone",
                startedAt: "$conversationsArray.v.startedAt",
                lastMessageAt: "$conversationsArray.v.lastMessageAt",
                messages: "$conversationsArray.v.messages" // Include all messages
            }
        }
    ];

    // Execute the aggregation pipeline
    const conversation = await pageConvos.aggregate(pipeline).toArray();

    // The result is an array (should contain 0 or 1 document)
    if (!conversation || conversation.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Conversation not found'
      });
    }

    // Return the found conversation document (the first element of the result array)
    res.json({
      success: true,
      conversation: conversation[0]
    });
  } catch (error) {
    // Log and return error if the operation fails
    logger.error(`Error fetching conversation ${req.params.conversationId}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Gets all conversations assigned to a specific agent.
 * This requires querying the 'pageConvos' collection and filtering/extracting
 * embedded conversations where the assignedAgentId matches. This is complex
 * with the embedded structure and requires aggregation.
 * Query Parameter: agentId (string)
 */
app.get('/api/agent-conversations', async (req, res) => {
  try {
    const { agentId } = req.query; // Get agentId from query parameters

    // Validate required query parameter
    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: agentId'
      });
    }

    // Use aggregation pipeline to find and extract conversations assigned to the agent
    const pipeline = [
         // Stage 1: Find page documents that contain *any* embedded conversation
         {
             $match: {
                 'conversations': { $exists: true, $ne: {} } // Ensure conversations object exists and is not empty
             }
         },
         // Stage 2: Convert conversations object to an array of key-value pairs
         {
              $project: {
                  pageId: 1,
                  assignedAgentPhone: 1, // Page-level assigned phone
                  conversationsArray: { $objectToArray: "$conversations" }
              }
         },
         // Stage 3: Unwind the array to process each embedded conversation
         { $unwind: "$conversationsArray" },
         // Stage 4: Match the embedded conversations where the assignedAgentId matches
         {
             $match: {
                 'conversationsArray.v.assignedAgentId': agentId // Match the embedded conversation's assignedAgentId
             }
         },
         // Stage 5: Project and format the output for each matched conversation
         {
             $project: {
                 _id: "$conversationsArray.v.conversationId", // Use the embedded conversationId as the main ID
                 pageId: "$pageId",
                 conversationKey: "$conversationsArray.k", // The participant phone is the key
                 participants: "$conversationsArray.v.participants",
                 assignedAgentId: "$conversationsArray.v.assignedAgentId",
                 assignedAgentPhone: "$conversationsArray.v.assignedAgentPhone",
                 startedAt: "$conversationsArray.v.startedAt",
                 lastMessageAt: "$conversationsArray.v.lastMessageAt",
                 // Get the last message (requires another unwind or $slice in a sub-pipeline, complex)
                 hasMessages: { $gt: [{ $size: "$conversationsArray.v.messages" }, 0] },
                 lastMessageTimestamp: "$conversationsArray.v.lastMessageAt" // Use for sorting
             }
         },
         // Stage 6: Sort the results by last message timestamp (newest first)
         { $sort: { lastMessageTimestamp: -1 } }
    ];


    // Execute the aggregation pipeline
    const agentConversations = await pageConvos.aggregate(pipeline).toArray();

     // Format the response similarly to /api/conversations
    const formattedConversations = agentConversations.map(convo => {
      // Note: Last message content is not included in this list view due to projection
      return {
        id: convo._id, // Conversation's unique ID
        pageId: convo.pageId,
        conversationKey: convo.conversationKey,
        participants: convo.participants,
        assignedAgentId: convo.assignedAgentId,
        assignedAgentPhone: convo.assignedAgentPhone,
        startedAt: convo.startedAt,
        lastMessageAt: convo.lastMessageAt,
        hasLastMessage: convo.hasMessages,
        lastMessage: null // Content not projected
      };
    });

    // Send the formatted list of conversations assigned to the agent
    res.json({
      success: true,
      conversations: formattedConversations
    });
  } catch (error) {
    // Log and return error if the operation fails
    logger.error(`Error fetching conversations for agent ${req.query.agentId}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/**
 * Gets the current status of all agents in the number pool by hitting their health endpoints.
 */
app.get('/api/pool/status', async (req, res) => {
  try {
    // Call the checkAllAgents function from the numberPoolMessaging module
    const agentStatus = await numberPool.checkAllAgents();
    // Get the current user in the rotation (if rotation is used elsewhere)
    const currentUser = numberPool.getCurrentUser();

    // Send the status results
    res.json({
      success: true,
      agents: agentStatus, // Array of status objects for each agent
      currentUser: currentUser ? { id: currentUser.id, username: currentUser.username, phoneNumber: currentUser.phoneNumber } : null // Current user in rotation
    });
  } catch (error) {
    // Log and return error if checking status fails
    logger.error('Error checking agent status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Gets the list of all users/agents configured in the number pool.
 */
app.get('/api/pool/users', (req, res) => {
  try {
    // Get the list of users from the numberPoolMessaging module
    const users = numberPool.getNumberPool();
    // Get the current user in the rotation (if rotation is used elsewhere)
    const currentUser = numberPool.getCurrentUser();

    // Send the list of users
    res.json({
      success: true,
      users: users.map(user => ({ id: user.id, username: user.username, phoneNumber: user.phoneNumber })), // Return simplified user objects
      currentUser: currentUser ? { id: currentUser.id, username: currentUser.username, phoneNumber: currentUser.phoneNumber } : null // Current user in rotation
    });
  } catch (error) {
    // Log and return error if getting users fails
    logger.error('Error getting number pool users:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/**
 * Views the current messages in the retry queue.
 * Provides a snapshot of messages waiting to be resent.
 */
app.get('/api/retry-queue', (req, res) => {
  // Return the current state of the message retry queue
  res.json({
    success: true,
    queueLength: messageRetryQueue.length, // Number of messages in the queue
    queue: messageRetryQueue.map(item => ({ // Map queue items to a simplified format for the response
      pageId: item.pageId, // Include pageId
      recipient: item.recipient, // Recipient phone number
      messagePreview: item.message ? item.message.substring(0, 50) + (item.message.length > 50 ? '...' : '') : '', // Truncated message preview
      attempts: item.attempts, // Number of retry attempts made so far
      timestamp: item.timestamp, // Timestamp when the message was added to the queue
      // conversationId: item.conversationId // No longer a top-level conversationId in retry queue
      conversationKey: item.conversationKey // Include the participant phone key
    }))
  });
});

/**
 * Manually triggers processing of the first message in the retry queue.
 * Useful for debugging or forcing retries.
 */
app.post('/api/process-retry-queue', async (req, res) => {
  try {
    const queueLength = messageRetryQueue.length;

    // If the queue is empty, return a message indicating so
    if (queueLength === 0) {
      return res.json({
        success: true,
        message: 'No messages in retry queue'
      });
    }

    // Initiate processing for the first message in the queue.
    // The processRetryQueue function uses shift() internally to remove the item
    // and uses setTimeout to schedule the next item processing.
    await processRetryQueue();

    // Respond indicating that processing was initiated for the first item.
    // The queueLength here reflects the state *after* shift().
    res.json({
      success: true,
      message: `Initiated processing for the first message in the retry queue. ${messageRetryQueue.length} messages remaining in queue.`
    });
  } catch (error) {
    // Log and return error if manual processing fails
    logger.error('Error processing retry queue manually:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// Basic route for checking server status and providing API info
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
          code { background: #eee; padding: 2px 4px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <h1>IMessage Agent</h1>
        <div class="status">
          <p>Server is running on port ${PORT}</p>
          <p>Current time: ${new Date().toLocaleString()}</p>
          <p>Current agent (rotation): ${numberPool.getCurrentUser() ? numberPool.getCurrentUser().username : 'N/A'}</p>
          <p>Database: ${db ? 'Connected' : 'Disconnected'}</p>
          <p>Message Retry Queue: ${messageRetryQueue.length} pending</p>
        </div>
        <h2>Available Endpoints:</h2>
        <ul>
          <li><code>POST /api/page-phone-mapping</code> - Set/Update agent phone for a pageId</li>
          <li><code>GET /api/page-phone-mapping/:pageId</code> - Get agent phone for a pageId</li>
          <li><code>GET /api/page-phone-mapping?agentPhoneNumber=...</code> - Get pageId for agent phone</li>
          <li><code>POST /api/pool/message</code> - Send an outgoing message using pageId (Auto-creates mapping & convo if needed)</li>
          <li><code>POST /api/receive-message</code> - Receive and store incoming message (requires 'to' agent phone)</li>
          <li><code>GET /api/check-conversation?pageId=...&phone=...</code> - Check if conversation exists for pageId and phone</li>
          <li><code>GET /api/conversations?pageId=...</code> - Get all conversations (optionally filter by pageId)</li>
          <li><code>GET /api/conversations/:conversationId</code> - Get a specific conversation by its embedded ID</li>
          <li><code>GET /api/agent-conversations?agentId=...</code> - Get conversations assigned to an agent (requires aggregation)</li>
          <li><code>GET /api/pool/status</code> - Check status of all agents</li>
          <li><code>GET /api/pool/users</code> - Get all users in the pool</li>
          <li><code>GET /api/retry-queue</code> - View messages in retry queue</li>
          <li><code>POST /api/process-retry-queue</code> - Manually process retry queue</li>
        </ul>
         <h6>made by moath</h6>
      </body>
    </html>
  `);
});

/**
 * Setup function to start the retry queue processing interval.
 * Uses setTimeout to wait for the first interval before the first execution.
 */
function setupRetryQueue() {
  logger.info(`Message retry queue processing scheduled to start after ${RETRY_INTERVAL/1000} seconds.`);
  // Schedule the first execution of processRetryQueue
  setTimeout(processRetryQueue, RETRY_INTERVAL);
  // Note: processRetryQueue itself schedules the next execution using setTimeout,
  // creating a loop that runs at approximately RETRY_INTERVAL.
}


/**
 * Starts the Express server after successfully connecting to MongoDB.
 */
async function startServer() {
    const isConnected = await connectToMongo();
    if (isConnected) {
        setupRetryQueue(); // Start the retry queue processor loop
        // Start the Express server listening on the specified port
        app.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
        });
    } else {
        // If MongoDB connection fails, log an error and exit the process
        logger.error('Failed to connect to MongoDB, server not started.');
        process.exit(1); // Exit with a non-zero code to indicate an error
    }
}

// Initiate the server startup process
startServer();

// --- Graceful Shutdown Handling ---
// Handle SIGINT signal (e.g., from Ctrl+C) for graceful shutdown
process.on('SIGINT', async () => {
    logger.info('SIGINT signal received. Server shutting down...');
    // Close the MongoDB connection if it exists
    if (client) {
        await client.close();
        logger.info('MongoDB connection closed.');
    }
    // Exit the process
    process.exit(0);
});

// Handle unhandled promise rejections to prevent process crashes
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Log the error and potentially perform cleanup.
    // Depending on the severity, you might want to shut down the process:
    // process.exit(1);
});

// Handle uncaught exceptions to prevent process crashes
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    // Log the error and potentially perform cleanup.
    // Depending on the severity, you might want to shut down the process:
    // process.exit(1);
});
