# CodepilotReview

VSCode extension for using Copilot to help with manual code review.

## Features

- **Multi-Provider Support**: Local git, Azure DevOps, GitHub, and Chromium (Gerrit)
- **PR List View**: Browse pull requests with advanced filtering
- **Inline Comments**: Review issues displayed as inline code comments via VSCode Comments API
- **Review Tools**: Built-in and custom tools that analyze code and surface potential issues
- **Draft-First Workflow**: Issues start as drafts, giving you control over what gets published
- **AI Integration**: Copilot-powered summaries, explanations, and fix suggestions (coming soon)
- **Partitioning**: Split code changes into logical chunks for easier review (coming soon)
- **Code Tours**: Guided walkthroughs of code changes (coming soon)

## Getting Started

1. Open a workspace with a git repository
2. Open the CodepilotReview sidebar
3. The local provider will show your current branch vs main as a review

### Selecting a Provider

Use the command palette: `CodepilotReview: Select Code Review Provider`

### Configuration

Settings can be configured in:
- `.codepilotreview/config.json` in your project (team defaults)
- `~/.codepilotreview/config.json` (personal defaults)
- VSCode settings (highest priority)

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
