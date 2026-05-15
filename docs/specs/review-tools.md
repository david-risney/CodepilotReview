# Review Tools Specification

## Overview

Review tools analyze code changes and produce potential issues for the reviewer to triage. Tools can be built-in or custom.

## Tool Interface

```typescript
interface IReviewTool {
    name: string;
    description: string;
    run(input: ReviewToolInput, context: ReviewToolContext): Promise<ReviewIssue[]>;
}
```

### Input
- `pullRequestId` - The PR being reviewed
- `diff` - Parsed diff files
- `existingIssues` - Already identified issues (to avoid duplicates)

### Context
- `cancellationToken` - For user cancellation
- `progress` - Progress reporting
- `workspaceRoot` - Workspace root path

## Built-in Tools

### Historic Review Tool
Analyzes code based on previous changes and code review feedback in related files.

**Prompt approach**: "Based on previous changes and previous code review feedback in related files, are there any issues with this change?"

### Meta Questions Tool
Asks high-level questions about the change:
- Does this change make sense?
- Does it match the bug/task description?
- Is the bug/task ready to be implemented?
- Are the correct people involved in the code review?

## Custom Tools

### Command-Based Tools
Configuration:
```json
{
    "name": "my-linter",
    "description": "Custom linting rules",
    "command": "my-linter --diff ${diffFile}",
    "outputParsePattern": "${file}:${line}: ${message}",
    "postParseScript": "optional-transform.js"
}
```

### Prompt-Based Tools
Configuration:
```json
{
    "name": "security-review",
    "description": "Security-focused review",
    "isPromptTool": true,
    "prompt": "Review this code change for security vulnerabilities..."
}
```

Output is reformatted into ReviewIssue[] via a built-in AI transformation step.

## Issue Lifecycle

1. Tool produces `ReviewIssue` with status `suggested`
2. User sees issue with:
   - TLDR summary
   - Detailed description
   - "Really?" button (to challenge/dismiss)
   - "Fix" button (to apply suggested fix)
   - Chat interface (to discuss with AI)
3. User promotes to `draft` or dismisses
4. Draft issues can be published to provider
