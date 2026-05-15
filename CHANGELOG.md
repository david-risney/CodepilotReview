# Changelog

## [0.2.0] - 2025-01-01

### Added
- **GitHub Provider**: Full REST API integration with auth, PR listing, diff, comments, pagination
- **Azure DevOps Provider**: Full REST API with Microsoft auth + PAT fallback, threads, iterations
- **Chromium/Gerrit Provider**: Full REST API with HTTP credentials + .gitcookies support
- **AI Integration**: Copilot Language Model API (vscode.lm) for chat, summarize, explain, fix, partition
- **Chat Panel**: WebView-based conversation UI for discussing code changes with Copilot
- **Dependency Partitioning**: AI-powered grouping of code changes into logically related chunks
- **Ownership Partitioning**: Split changes by CODEOWNERS and git history ownership
- **Custom Partitioning**: Natural language criteria for AI-powered partitioning
- **Code Tours**: AI-generated guided walkthroughs with editor navigation
- **Review Issues View**: TreeView with triage actions (challenge, fix, accept, dismiss)
- **Partition View**: TreeView showing partitions and their chunks
- **Common Reviewers**: Git history analysis for reviewer suggestions
- **Custom Command Tools**: Run external commands and parse output into review issues
- **Custom Prompt Tools**: AI prompt-based review tools
- **Auth System**: Provider authentication with SecretStorage
- **Config Validation**: Validate config and report errors
- **Open Config Command**: Edit project or user config files
- **Read-Only Diff View**: Virtual document provider for remote file diffs
- **Typed Error Handling**: Structured error classes with user-facing messages

## [0.1.0] - 2025-01-01

### Added
- Initial scaffolding
- Local provider with git diff parsing
- PR list TreeView
- Comment controller using VSCode Comments API
- Multi-source configuration (project, user, VSCode settings)
- Review tool manager with built-in tool stubs
- Provider interface split by capability (PR, Diff, Comment, Auth)
- Service layer (PullRequestService, ReviewSessionService)
- Logging via output channel
- Persistent storage abstraction
