# Custom Review Tools Spec

## Overview
Users can define custom review tools via configuration files.

## Tool Types

### Command Tools
Run an external command, parse output into issues.

Configuration:
```json
{
  "name": "eslint-check",
  "description": "Run ESLint on changed files",
  "command": "npx eslint --format json ${files}",
  "outputParsePattern": "regexp pattern to extract file:line:message",
  "postParseScript": "optional JS to transform parsed results"
}
```

### Prompt Tools
Send a user-defined prompt to AI with the diff, then parse the response into issues.

Configuration:
```json
{
  "name": "security-review",
  "description": "Check for security issues",
  "isPromptTool": true,
  "prompt": "Review this diff for security vulnerabilities..."
}
```

## Parse Pattern Generation
`codepilotReview.generateParsePattern` uses AI to generate an `outputParsePattern`
from example command output. The user provides example output and the AI creates
a regex pattern and optional post-parse script.

## Configuration Locations
Tools can be configured in:
1. `.codepilotreview/config.json` (project-level)
2. `~/.codepilotreview/config.json` (user-level)
3. VSCode settings (`codepilotReview.reviewTools`)
