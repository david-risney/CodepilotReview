# Tool Usage Guide

## Building
```bash
npm run compile    # TypeScript compilation
npm run lint       # ESLint
npm run watch      # Watch mode for development
npm test           # Run tests (requires VSCode test host)
```

## Development Workflow
1. Open the repo in VSCode
2. `npm install` to install dependencies
3. `npm run watch` for continuous compilation
4. Press F5 to launch the Extension Development Host
5. Use the CodepilotReview sidebar views to test

## Packaging
```bash
npx vsce package   # Create .vsix file
npx vsce publish   # Publish to marketplace (requires token)
```

## Debugging
- Set breakpoints in TypeScript source files
- Use the "Run Extension" launch configuration
- Extension Host output channel shows logs
- Use `logger.info/warn/error` for structured logging

## Adding a New Provider
1. Create `src/providers/newProvider.ts`
2. Implement `ICodeReviewProvider` (and capability interfaces)
3. Add to `createProvider()` in `extension.ts`
4. Add provider enum value in `package.json` configuration
5. Add specs in `docs/specs/providers.md`

## Adding a Custom Review Tool
1. Create `.codepilotreview/config.json` in your project
2. Add a tool entry under `reviewTools` array
3. For command tools: provide `command` and `outputParsePattern`
4. For prompt tools: set `isPromptTool: true` and provide `prompt`
5. Use `codepilotReview.generateParsePattern` to auto-generate parse patterns
