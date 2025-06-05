.PHONY: build-frontend start clean deps

# Build the frontend and copy to dist
build-frontend:
	@echo "Building frontend..."
	cd web && npm run build
	@echo "Copying build to dist..."
	mkdir -p web/dist
	cp -r web/build/* web/dist/

# Start development servers (both frontend and backend)
start:
	@echo "Starting development servers..."
	@echo "If you don't have 'air' installed, run: go install github.com/cosmtrek/air@latest"
	# Start frontend dev server (background)
	cd web && npm start &
	# Start Go server with air (auto-reloads on changes)
	GO_ENV=development air

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf web/dist
	rm -rf web/build

# Install dependencies
deps:
	@echo "Installing Go dependencies..."
	go mod download
	@echo "Installing frontend dependencies..."
	cd web && npm install 