# CodepilotReview

VSCode extension for using Copilot to help with manual code review. This extension doesn't automate code reviews — it enhances the human review process with AI-powered analysis, partitioning, and guided walkthroughs.

## Features

- **Multi-Provider Support**: Local git, Azure DevOps, GitHub, and Chromium (Gerrit)
- **PR List View**: Browse pull requests with AI-generated summaries, priority, and relevant links
- **Advanced Filtering**: Search by title, author, date range, labels (especially useful for ADO)
- **Inline Comments**: Review issues displayed as inline code comments via VSCode Comments API
- **Review Tools**: Built-in and custom tools that analyze code and surface potential issues
  - **Historic Review**: AI analysis of past changes and review feedback in related files
  - **Meta Questions**: AI evaluation of scope, task alignment, and reviewer coverage
  - **Custom Command Tools**: Run external commands and parse output into review issues
  - **Custom Prompt Tools**: Run AI prompts against the diff to find issues
- **Issue Triage**: Each issue has "Really?" (challenge), "Fix", and chat actions
- **Draft-First Workflow**: Issues start as drafts, giving you control over what gets published
- **AI Chat**: WebView-based chat panel to discuss the code change with Copilot
- **Dependency Partitioning**: AI splits code changes into logically related chunks ordered by dependency
- **Ownership Partitioning**: Separate code you own from code others own (uses CODEOWNERS + git history)
- **Custom Partitioning**: Describe partition criteria in natural language and AI groups the changes
- **Code Tours**: AI-generated guided walkthroughs of each partition with inline descriptions
- **Common Reviewers**: Git history analysis to suggest the most relevant reviewers
- **Read-Only Diff View**: Virtual document provider for viewing remote file diffs
- **Authentication**: Provider-specific auth with SecretStorage for secure token management

## Prerequisites

- VSCode ^1.90.0
- GitHub Copilot extension (for AI features — extension works without it, but AI features are disabled)

## Getting Started

1. Install the extension
2. Open a workspace with a git repository
3. Open the CodepilotReview sidebar (activity bar icon)
4. The local provider shows your current branch vs main as a review

### Selecting a Provider

Use the command palette: `CodepilotReview: Select Code Review Provider`

### Configuration

Settings can be configured in multiple locations (highest priority first):
1. VSCode workspace settings
2. VSCode user settings
3. `~/.codepilotreview/config.json` (personal defaults)
4. `.codepilotreview/config.json` in your project (team defaults)

Use `CodepilotReview: Open Configuration` to edit config files.

### Custom Review Tools

Add custom tools in your config file:

```json
{
  "reviewTools": [
    {
      "name": "eslint-review",
      "description": "Run ESLint on changed files",
      "command": "npx eslint --format compact ${files}",
      "outputParsePattern": "${file}: line ${line}, col ${column}, ${severity} - ${message}"
    },
    {
      "name": "security-prompt",
      "description": "Check for security issues",
      "isPromptTool": true,
      "prompt": "Review this code change for security vulnerabilities including XSS, injection, auth bypass, and data exposure."
    }
  ]
}
```

## Commands

| Command | Description |
|---------|-------------|
| `Select Code Review Provider` | Switch between Local, ADO, GitHub, Chromium |
| `Open Review` | Start reviewing a pull request |
| `Run Review Tools` | Run all configured review tools |
| `Filter Pull Requests` | Search/filter the PR list |
| `Partition by Dependency` | Split changes into dependency-ordered chunks |
| `Partition by Ownership` | Split changes by code ownership |
| `Custom Partition` | AI-powered partition with custom criteria |
| `Start Code Tour` | Begin a guided walkthrough of a partition |
| `Suggest Reviewers` | Find common reviewers from git history |
| `Open Chat` | Chat with Copilot about the code change |
| `Open Configuration` | Edit project or user config file |
| `Publish Draft Comments` | Publish all draft review comments |

## Development

```bash
npm install        # Install dependencies
npm run compile    # Build
npm run watch      # Build on change
npm run lint       # Lint
npm test           # Run tests (requires VSCode)
```

## Architecture

See [docs/knowledge-base/architecture.md](docs/knowledge-base/architecture.md) for detailed architecture documentation.

## Specifications

- [Providers](docs/specs/providers.md)
- [Review Tools](docs/specs/review-tools.md)
- [Partitioning](docs/specs/partitioning.md)
