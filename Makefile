.PHONY: build-frontend start clean dev deps

# Build the frontend and copy to dist
build-frontend:
	@echo "Building frontend..."
	cd web && npm run build
	@echo "Copying build to dist..."
	mkdir -p web/dist
	cp -r web/build/* web/dist/

# Start the server with hot reload and frontend build watch
start:
	@echo "If you don't have 'air' installed, run: go install github.com/cosmtrek/air@latest"
	# Start frontend build in watch mode (background)
	cd web && npm run build -- --watch &
	# Start Go server with air (auto-reloads on changes)
	air

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