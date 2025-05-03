#!/bin/bash

echo "Starting message agents..."

# Stop any existing agents first
echo "Stopping any existing agents..."
pkill -f "node /Users/debtconnects/message-agent.js" || true
pkill -f "node /Users/georgedc/message-agent.js" || true

# Ensure log directories exist
echo "Setting up log directories..."
mkdir -p /Users/debtconnects/Library/Logs
sudo mkdir -p /Users/georgedc/Library/Logs
chmod 755 /Users/debtconnects/Library/Logs
sudo chmod 755 /Users/georgedc/Library/Logs
sudo chown georgedc:staff /Users/georgedc/Library/Logs

# Start debtconnects agent
echo "Starting debtconnects agent on port 3001..."
sudo -u debtconnects nohup /usr/local/bin/node /Users/debtconnects/message-agent.js 3001 > /Users/debtconnects/Library/Logs/messageagent.log 2>&1 &
echo "debtconnects agent started"

echo "To start the georgedc agent, please log in as georgedc and run:"
echo "nohup /usr/local/bin/node ~/message-agent.js 3002 > ~/Library/Logs/messageagent.log 2>&1 &"

echo "Once both agents are running, you can test with:"
echo "node test-message-agents.js"