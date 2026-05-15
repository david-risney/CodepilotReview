# PR List & AI Enrichment Spec

## Overview
The PR list view displays pull requests from the configured provider with AI-generated metadata.

## PR Table Columns
Each PR shows:
- **Title**: From provider
- **Brief description**: AI-generated summary (`aiSummary`)
- **User Need**: How much the user's attention is needed (`userNeed`): blocking, required, optional, fyi
- **Priority**: AI-assessed review priority (`priority`): blocking, yes, interest, no
- **Relevant links**: AI-extracted references to other PRs, bugs, documents

## AI Enrichment
After fetching PRs, the `PullRequestService` calls `enrichPrsWithAi()` in the background.
This calls `aiService.summarizeDiff()` and parses structured fields from the response:
- `SUMMARY:` → `pr.aiSummary`
- `PRIORITY:` → `pr.priority`
- `USER_NEED:` → `pr.userNeed`
- `LINKS:` → `pr.relevantLinks`

Enrichment is non-blocking — the PR list renders immediately and refreshes via `onDidEnrich`.

## Advanced Filtering
The filter command offers multi-field filtering:
- **Text search**: title, author, description, labels
- **Status**: open, closed, merged, draft, abandoned
- **User Need**: blocking, required, optional, fyi
- **Priority**: blocking, yes, interest, no
- **Clear**: removes all filters

The `PullRequestService.filterPullRequests()` method supports all filter dimensions programmatically.
