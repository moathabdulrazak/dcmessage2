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

# Start agents with the new code
sudo -u debtconnects nohup /usr/local/bin/node /Users/debtconnects/message-agent.js 3001 http://localhost:3000 > /Users/debtconnects/Library/Logs/messageagent.log 2>&1 &
sudo -u georgedc nohup /usr/local/bin/node /Users/georgedc/message-agent.js 3002 http://localhost:3000 > /Users/georgedc/Library/Logs/messageagent.log 2>&1 &

# Check logs to verify it's working
tail -f /Users/debtconnects/Library/Logs/messageagent.log