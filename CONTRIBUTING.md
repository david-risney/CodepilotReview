# Contributing to CodepilotReview

## Development Setup

1. Clone the repository
2. Run `npm install`
3. Open in VSCode
4. Press F5 to launch the Extension Development Host

## Building

```bash
npm run compile    # Build TypeScript
npm run watch      # Watch mode
npm run lint       # Run ESLint
npm test           # Run tests (requires VSCode)
```

## Project Structure

See [docs/knowledge-base/architecture.md](docs/knowledge-base/architecture.md) for the full architecture overview.

Key directories:
- `src/providers/` — Code review provider implementations
- `src/core/` — Business logic services
- `src/views/` — TreeView providers and WebView panels
- `src/ai/` — Copilot AI integration
- `src/reviewTools/` — Built-in and custom review tool implementations
- `src/test/` — Unit and integration tests

## Adding a New Provider

1. Create a new file in `src/providers/`
2. Implement `ICodeReviewProvider` (and relevant sub-interfaces)
3. Register in `extension.ts` provider factory
4. Add to `package.json` provider picker
5. Add tests

## Adding a Custom Review Tool Type

1. Add the tool class in `src/reviewTools/`
2. Register in `ReviewToolManager`
3. Update `CustomReviewToolConfig` in `src/types.ts` if needed
4. Add tests

## Code Style

- TypeScript strict mode
- ESLint for linting
- Prefer async/await over callbacks
- Use typed errors from `src/errors.ts`
- Log with `logger` from `src/logging/logger.ts`

## Testing

Tests use Mocha and run inside a VSCode test host. Pure logic tests that don't need VSCode APIs can use standard assertions.

## Commit Messages

Use conventional commit style:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation
- `refactor:` for code restructuring
- `test:` for test additions/changes
