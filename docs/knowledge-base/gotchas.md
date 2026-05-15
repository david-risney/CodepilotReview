# Gotchas & Workarounds

## Copilot API
- **No system messages**: The `vscode.lm` API does not support system messages. Use a leading `User` message with persona/instructions instead.
- **Consent dialog**: `selectChatModels()` must be called from a user-initiated action; VSCode shows a consent dialog on first use.
- **Rate limits**: Copilot may rate-limit requests. The extension gracefully degrades when AI is unavailable.
- **o1 models**: Don't support tool calling — stick to gpt-4o family.
- **`@github/copilot-sdk`**: This is NOT for VSCode extensions. It's for standalone Node.js apps. Always use `vscode.lm.selectChatModels()`.

## TypeScript / Build
- **TypeScript version warning**: TypeScript 5.9+ is newer than `@typescript-eslint/typescript-estree` supports. This produces a warning but does not cause lint failures.
- **glob package**: Breaking API changes in newer versions. The test runner uses manual `fs.readdirSync` instead of glob.

## Testing
- **VSCode test host required**: Tests use `vscode.` APIs and must run in the VSCode test host via `npm test`. They cannot run in plain Node.js.
- **EventEmitter in tests**: `vscode.EventEmitter` works in the test host. Tests can verify event firing by subscribing before the action.

## Configuration
- **Config precedence**: defaults < project config < user config < VSCode settings
- **File watchers**: Both project and user config files are watched for changes at runtime.
- **Config validation**: Invalid config values are logged as warnings but don't crash the extension.

## Providers
- **ADO authentication**: Uses Microsoft auth provider with PAT fallback. The scope `499b84ac-1321-427f-aa17-267ca6975798/.default` is for Azure DevOps API access.
- **Chromium XSSI prefix**: All Gerrit API responses are prefixed with `)]}'` which must be stripped before JSON parsing.
- **GitHub pagination**: Uses `Link` header parsing for paginated responses.
