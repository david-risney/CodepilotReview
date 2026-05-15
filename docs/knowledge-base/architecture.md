# CodepilotReview Architecture

## Overview

CodepilotReview is a VSCode extension that assists developers in performing manual code reviews using AI. It does not automate code reviews, but enhances the human review process with AI-powered analysis, partitioning, and guided walkthroughs.

## Directory Structure

```
src/
├── extension.ts                 # Extension entry point — wires everything together
├── types.ts                     # Shared type definitions
├── errors.ts                    # Typed error classes (AuthError, ProviderError, etc.)
├── providers/
│   ├── provider.ts              # Provider interfaces (split by capability)
│   ├── localProvider.ts         # Local git-based provider (fully implemented)
│   ├── adoProvider.ts           # Azure DevOps provider (stub — REST API pending)
│   ├── githubProvider.ts        # GitHub provider (stub — Octokit pending)
│   └── chromiumProvider.ts      # Chromium/Gerrit provider (stub — Gerrit API pending)
├── core/
│   ├── pullRequestService.ts    # PR fetching and advanced filtering
│   ├── reviewSessionService.ts  # Review session lifecycle orchestration
│   ├── partitionService.ts      # AI-powered code change partitioning
│   ├── codeTourService.ts       # Guided walkthrough generation and navigation
│   └── reviewerSuggestionService.ts  # Git history-based reviewer suggestions
├── views/
│   ├── prListView.ts            # PR list TreeDataProvider
│   ├── reviewIssuesView.ts      # Review issues TreeDataProvider with triage actions
│   └── partitionView.ts         # Partition TreeDataProvider
├── comments/
│   └── commentController.ts     # VSCode CommentController for inline comments
├── reviewTools/
│   ├── reviewTool.ts            # Review tool interface
│   ├── reviewToolManager.ts     # Tool registration, execution, custom tool loading
│   └── customTools.ts           # Custom command and prompt tool implementations
├── config/
│   └── configuration.ts         # Multi-source configuration manager
├── ai/
│   └── aiService.ts             # Copilot LM API integration + stub fallback
├── auth/
│   ├── authManager.ts           # Authentication orchestration
│   └── tokenStore.ts            # VSCode SecretStorage token management
├── storage/
│   └── reviewStore.ts           # Persistent storage (issues, sessions, partitions, tours)
├── logging/
│   └── logger.ts                # Output channel logging
└── test/
    ├── runTest.ts               # Test runner entry point
    └── suite/
        ├── index.ts             # Mocha test suite setup
        ├── pullRequestService.test.ts
        ├── reviewSessionService.test.ts
        ├── configuration.test.ts
        ├── errors.test.ts
        ├── aiService.test.ts
        └── reviewerSuggestion.test.ts
```

## Architecture Layers

```
┌─────────────────────────────────────────┐
│              extension.ts               │  Wiring & command registration
├─────────────────────────────────────────┤
│   Views (PR list, Issues, Partitions)   │  TreeDataProviders
│   Comments (CommentController)          │  VSCode Comments API
├─────────────────────────────────────────┤
│   Core Services                         │  Business logic
│   (PR, Session, Partition, Tour, etc.)  │
├─────────────────────────────────────────┤
│   Providers (Local, ADO, GH, Chromium)  │  Data access
│   AI Service (Copilot LM API)           │  Intelligence
│   Review Tools (built-in + custom)      │  Analysis
├─────────────────────────────────────────┤
│   Auth, Config, Storage, Logging        │  Infrastructure
└─────────────────────────────────────────┘
```

## Key Design Patterns

### Provider Abstraction (Capability-Based)
Providers implement sub-interfaces based on what they support:
- `IPullRequestProvider` — PR listing
- `IDiffProvider` — Diff and file content
- `ICommentProvider` — Comment CRUD
- `IAuthProvider` — Authentication

Each provider declares `ProviderCapabilities` so the UI can adapt.

### Service Layer
Services sit between providers and UI, keeping views decoupled:
- `PullRequestService` — PR fetching + advanced filtering
- `ReviewSessionService` — Review lifecycle + issue management
- `PartitionService` — AI-powered diff partitioning
- `CodeTourService` — Guided walkthrough generation
- `ReviewerSuggestionService` — Git history analysis

### AI Integration (vscode.lm API)
Uses `vscode.lm.selectChatModels({ vendor: 'copilot' })` for language model access:
- Streaming responses via `AsyncIterable<string>`
- Graceful fallback to `StubAiService` when Copilot is unavailable
- No system messages — uses leading User message for persona
- Cancellation support via `CancellationToken`

### Review Issue Lifecycle
```
suggested → draft → published → resolved
     ↓         ↓
  dismissed  dismissed
```

### Review Tools
Built-in tools (historic-review, meta-questions) use AI prompts.
Custom tools support:
- Command-based: run external command + parse output
- Prompt-based: user prompt → AI → structured issues

### Configuration Precedence
From lowest to highest priority:
1. Built-in defaults
2. Project config (`.codepilotreview/config.json`)
3. User config (`~/.codepilotreview/config.json`)
4. VSCode user settings
5. VSCode workspace settings
