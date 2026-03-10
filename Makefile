.PHONY: server client build clean

# Start the UDP server
server:
	npx tsx src/server/index.ts

# Start with simulated packet loss (20%)
server-lossy:
	LOSS_RATE=0.2 npx tsx src/server/index.ts

# Start the UDP client
client:
	npx tsx src/client/index.ts

# Build TypeScript
build:
	npx tsc

# Clean build artifacts
clean:
	rm -rf dist

# Install dependencies
install:
	npm install

# Test with netcat (send raw UDP)
# Usage: echo "test" | nc -u localhost 9001
nc-test:
	@echo "Sending raw UDP datagram with netcat..."
	@echo '{"id":"test1","type":"REQUEST","command":"PING","payload":"","timestamp":0}' | nc -u -w 2 localhost 9001
