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
- `replyToComment?(pullRequestId, parentProviderCommentId, body)` - Reply to a published comment (optional)
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
- Full edit/delete of local comments

### Azure DevOps
- Connects to ADO REST API
- Supports threads, draft comments, review votes, labels
- Requires PAT or Azure Identity authentication
- Thread statuses: Active, Pending, Fixed (Resolved), Closed, Won't Fix, By Design
- Status is on the thread, not individual comments
- Edit/delete own comments; editing others requires elevated permissions
- Delete is a soft delete (`isDeleted` flag)

### GitHub
- Connects to GitHub REST + GraphQL APIs
- Supports threads, suggested changes, labels, draft reviews
- Uses VSCode GitHub authentication session
- Thread resolution via GraphQL (`resolveReviewThread`/`unresolveReviewThread`)
- REST API has no thread resolution support
- Edit/delete own comments via REST
- Cross-repo mode: leave `owner` and `repo` empty to search all PRs involving you

### Chromium (Gerrit)
- Connects to Gerrit REST API
- Uses Gerrit "changes" mapped to PR abstraction
- Supports patchsets, inline comments, review labels
- Requires Gerrit authentication (HTTP credentials)
- Thread resolution via `unresolved` boolean (last comment's value determines thread state)
- **Cannot edit or delete published comments** (immutable once published)
- Drafts have full CRUD; published via `Set Review` endpoint
- Admin-only "deletion" is actually redaction (replaces body text)

## Provider Capabilities

Each provider declares its capabilities via `ProviderCapabilities`:

| Capability | Local | GitHub | ADO | Chromium |
|-----------|-------|--------|-----|----------|
| `supportsDraftComments` | ✅ | ✅ | ✅ | ✅ |
| `supportsPublishing` | ❌ | ✅ | ✅ | ✅ |
| `supportsThreads` | ❌ | ✅ | ✅ | ✅ |
| `supportsSuggestedFixes` | ✅ | ✅ | ❌ | ❌ |
| `supportsReviewVotes` | ❌ | ✅ | ✅ | ✅ |
| `supportsLabels` | ❌ | ✅ | ✅ | ✅ |
| `requiresAuthentication` | ❌ | ✅ | ✅ | ✅ |
| `supportsCommentEdit` | ✅ | ✅ | ✅ | ❌ |
| `supportsCommentDelete` | ✅ | ✅ | ✅ | ❌ |
| `supportsCommentResolve` | ✅ | ✅ | ✅ | ✅ |

### Comment Statuses by Provider

| Status | Local | GitHub | ADO | Chromium |
|--------|-------|--------|-----|----------|
| `suggested` | ✅ | — | — | — |
| `draft` | ✅ | — | — | — |
| `published` (active) | — | ✅ | ✅ | ✅ |
| `pending` | — | — | ✅ | — |
| `resolved` | ✅ | ✅ | ✅ | ✅ |
| `closed` | — | — | ✅ | — |
| `wontFix` | — | — | ✅ | — |
| `byDesign` | — | — | ✅ | — |
| `dismissed` | ✅ | — | — | — |
