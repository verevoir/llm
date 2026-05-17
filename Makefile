.PHONY: build test lint format clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

build: ## Compile TypeScript to dist/
	npx tsc

test: ## Run vitest
	npx vitest run

lint: ## Prettier check
	npx prettier --check .

format: ## Prettier write
	npx prettier --write .

clean: ## Remove build artefacts
	rm -rf dist node_modules
