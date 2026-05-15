# CodepilotReview Architecture

## Overview

CodepilotReview is a VSCode extension that assists developers in performing manual code reviews using AI. It does not automate code reviews, but enhances the human review process.

## Directory Structure

```
src/
├── extension.ts                 # Extension entry point
├── types.ts                     # Shared type definitions
├── providers/
│   ├── provider.ts              # Provider interfaces (split by capability)
│   ├── localProvider.ts         # Local git-based provider
│   ├── adoProvider.ts           # Azure DevOps provider (stub)
│   ├── githubProvider.ts        # GitHub provider (stub)
│   └── chromiumProvider.ts      # Chromium/Gerrit provider (stub)
├── core/
│   ├── pullRequestService.ts    # PR fetching and filtering service
│   └── reviewSessionService.ts  # Review session orchestration
├── views/
│   └── prListView.ts            # PR list TreeDataProvider
├── comments/
│   └── commentController.ts     # VSCode CommentController wrapper
├── reviewTools/
│   ├── reviewTool.ts            # Review tool interface
│   └── reviewToolManager.ts     # Tool registration and execution
├── config/
│   └── configuration.ts         # Multi-source configuration
├── ai/
│   └── aiService.ts             # AI/Copilot integration interface
├── storage/
│   └── reviewStore.ts           # Persistent storage abstraction
├── logging/
│   └── logger.ts                # Output channel logging
└── test/
    ├── runTest.ts               # Test runner entry point
    └── suite/
        ├── index.ts             # Mocha test suite setup
        ├── pullRequestService.test.ts
        └── reviewSessionService.test.ts
```

## Architecture Principles

### Provider Abstraction

Providers are split into capability-based interfaces:
- `IPullRequestProvider` - Fetch PRs
- `IDiffProvider` - Fetch diffs and file contents
- `ICommentProvider` - CRUD for review comments
- `IAuthProvider` - Authentication

Each provider declares its `ProviderCapabilities` so the UI can adapt.

### Service Layer

The `core/` directory contains services that sit between providers and UI:
- `PullRequestService` - Coordinates PR fetching with advanced filtering
- `ReviewSessionService` - Manages the lifecycle of a single review session

### Review Issue Lifecycle

```
suggested → draft → published
              ↓
          dismissed
              
published → resolved
```

Issues track their `source` (tool, AI, user, provider) and `status`.

### Configuration Precedence

From lowest to highest priority:
1. Built-in defaults
2. Project config (`.codepilotreview/config.json`)
3. User config (`~/.codepilotreview/config.json`)
4. VSCode user settings
5. VSCode workspace settings

## Design Decisions

- **Split provider interfaces**: Avoids forcing providers to fake capabilities they don't support (e.g., local provider can't publish to a remote service).
- **Service layer**: Keeps views decoupled from providers, making testing easier.
- **Draft-first comments**: All review issues start as drafts, giving reviewers control over what gets published.
- **Multi-source config**: Supports team-level config (project), personal config (user home), and VSCode settings.
