.PHONY: build-frontend start clean

# Build the frontend and copy to dist
build-frontend:
	@echo "Building frontend..."
	cd web && npm run build
	@echo "Copying build to dist..."
	mkdir -p web/dist
	cp -r web/build/* web/dist/

# Start the server
start: build-frontend
	@echo "Starting server..."
	go run cmd/server/main.go

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf web/dist
	rm -rf web/build

# Development mode with hot reloading
dev:
	@echo "Starting development mode..."
	cd web && npm start

# Install dependencies
deps:
	@echo "Installing Go dependencies..."
	go mod download
	@echo "Installing frontend dependencies..."
	cd web && npm install 