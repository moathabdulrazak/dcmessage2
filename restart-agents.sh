#!/bin/bash
# restart-agents.sh

echo "Restarting message agents..."

# Kill any existing agents
echo "Stopping existing agents..."
sudo pkill -f "node /Users/debtconnects/message-agent.js" || true
sudo pkill -f "node /Users/georgedc/message-agent.js" || true

# Ensure node_modules are installed
echo "Checking dependencies..."
cd /Users/debtconnects
npm install express axios
cd /Users/georgedc
npm install express axios

# Make sure log directories exist
echo "Setting up log directories..."
mkdir -p /Users/debtconnects/Library/Logs
sudo mkdir -p /Users/georgedc/Library/Logs
chmod 755 /Users/debtconnects/Library/Logs
sudo chmod 755 /Users/georgedc/Library/Logs
sudo chown georgedc:staff /Users/georgedc/Library/Logs

# Start debtconnects agent
echo "Starting debtconnects agent..."
sudo -u debtconnects nohup /usr/local/bin/node /Users/debtconnects/message-agent.js 3001 http://localhost:3000 > /Users/debtconnects/Library/Logs/messageagent.log 2>&1 &
echo "debtconnects agent started"

echo "To start the georgedc agent, please log in as georgedc and run:"
echo "nohup /usr/local/bin/node /Users/georgedc/message-agent.js 3002 http://localhost:3000 > /Users/georgedc/Library/Logs/messageagent.log 2>&1 &"

echo "Restart completed!"