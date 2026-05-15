# Chat & Knowledge Base Spec

## Overview
The chat panel provides a WebView-based conversation interface backed by Copilot AI.
Users can ask questions about the current code change with full knowledge base context.

## Knowledge Base
Markdown files in `docs/knowledge-base/` and `.codepilotreview/knowledge-base/` are loaded
as context for every AI chat interaction. This gives the AI awareness of:
- Architecture and design decisions
- Project conventions and gotchas
- Tool usage guides
- Historical context

## Chat Features
- Persistent conversation history within a session
- Knowledge base content injected as context
- Diff context from the current review
- Existing issues context
- Streaming responses from Copilot

## Chat Panel Commands
- `codepilotReview.openChat`: Opens the chat WebView panel
- `codepilotReview.askAboutChange`: Quick chat about the current change
