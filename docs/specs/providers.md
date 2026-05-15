# Code Review Providers Specification

## Overview

CodepilotReview supports multiple code review providers through a pluggable interface system. Each provider implements the capabilities it supports.

## Provider Interface

### IPullRequestProvider
- `getPullRequests(filter?)` - List PRs with optional filtering
- `getPullRequest(id)` - Get a single PR by ID

### IDiffProvider
- `getDiff(pullRequestId)` - Get unified diff for a PR
- `getFileContent(filePath, revision)` - Get file at specific revision

### ICommentProvider
- `getComments(pullRequestId)` - List existing comments
- `publishComment(pullRequestId, issue)` - Publish a draft comment
- `updateComment(pullRequestId, issue)` - Update a published comment
- `deleteComment(pullRequestId, commentId)` - Delete a comment
- `updateCommentStatus(pullRequestId, commentId, status)` - Change comment status

### IAuthProvider
- `isAuthenticated()` - Check authentication status
- `authenticate()` - Start auth flow
- `signOut()` - Clear credentials
- `getCurrentUser()` - Get current user display name

## Supported Providers

### Local
- Uses `git diff` between current branch and configured base branch
- Creates synthetic PR from git log
- Stores draft comments in VSCode workspace storage
- No authentication required
- Cannot publish to external service

### Azure DevOps
- Connects to ADO REST API
- Supports threads, draft comments, review votes, labels
- Requires PAT or Azure Identity authentication
- Supports advanced filtering (since ADO doesn't natively support complex queries)

### GitHub
- Connects to GitHub API (Octokit)
- Supports threads, suggested changes, labels, draft reviews
- Uses VSCode GitHub authentication session
- Full comment lifecycle support

### Chromium (Gerrit)
- Connects to Gerrit REST API
- Uses Gerrit "changes" mapped to PR abstraction
- Supports patchsets, inline comments, review labels
- Requires Gerrit authentication (HTTP credentials)

## Provider Capabilities

Each provider declares its capabilities via `ProviderCapabilities`:
- `supportsDraftComments` - Can hold comments before publishing
- `supportsPublishing` - Can push comments to external service
- `supportsThreads` - Supports threaded conversations
- `supportsSuggestedFixes` - Can attach code suggestions
- `supportsReviewVotes` - Supports approve/reject votes
- `supportsLabels` - Supports PR labels/tags
- `requiresAuthentication` - Needs auth to function
