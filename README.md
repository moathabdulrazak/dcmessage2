# dcmessage2

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.js
```

This project was created using `bun init` in bun v1.2.11. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.


nohup /usr/local/bin/node /Users/georgedc/message-agent.js 3002 http://localhost:3000 > /Users/georgedc/Library/Logs/messageagent.log 2>&1 &

cat /Users/debtconnects/Library/Logs/messageagent.log

cat /Users/georgedc/Library/Logs/messageagent.log



# Stop existing agents
sudo kill -9 $(sudo lsof -ti:3001)
sudo kill -9 $(sudo lsof -ti:3002)
sudo kill -9 $(sudo lsof -ti:3003)

# Start agents with the new code
sudo -u debtconnects nohup /usr/local/bin/node /Users/debtconnects/message-agent.js 3001 http://localhost:3000 > /Users/debtconnects/Library/Logs/messageagent.log 2>&1 &
sudo -u georgedc nohup /usr/local/bin/node /Users/georgedc/message-agent.js 3002 http://localhost:3000 > /Users/georgedc/Library/Logs/messageagent.log 2>&1 &

# Check logs to verify it's working
tail -f /Users/debtconnects/Library/Logs/messageagent.log



# First create the directories (without the comment)
sudo -u johndc mkdir -p /Users/johndc/Library/LaunchAgents /Users/johndc/Library/Logs

# Copy the script
sudo cp ./message-agent.js /Users/johndc/
sudo chown johndc:staff /Users/johndc/message-agent.js
sudo chmod 755 /Users/johndc/message-agent.js

# Copy the plist file
sudo cp com.johndc.messageagent.plist /Users/johndc/Library/LaunchAgents/
sudo chown johndc:staff /Users/johndc/Library/LaunchAgents/com.johndc.messageagent.plist



ngrok http --url=cheaply-wealthy-monkey.ngrok-free.app 3000

<!-- to setup phone mapping -->

curl -X POST http://localhost:3000/api/page-phone-mapping \
-H "Content-Type: application/json" \
-d '{"pageId": "591545190708497", "agentPhoneNumber": "2087614687"}'