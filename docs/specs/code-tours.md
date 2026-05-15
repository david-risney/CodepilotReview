# Code Tours Spec

## Overview
Code tours provide a guided walkthrough of code changes, organized by partition chunks.

## Tour Generation
`CodeTourService.generateTour()` uses AI to create a logical walk-through of the diff:
- Each step targets a specific file and line
- Steps include title (what) and description (why/how)
- Steps can be grouped by partition

## Tour Navigation
- **Next/Previous**: Step through the tour sequentially
- **Stop Tour**: End the tour and clear all decorations
- **Inline annotations**: Each step shows a persistent decoration next to the code line
- **Line highlighting**: The current step's line is highlighted

## UI
- `codepilotReview.startCodeTour`: Generate and start a new tour
- `codepilotReview.nextTourStep` / `codepilotReview.prevTourStep`: Navigate
- Information message shows step description with action buttons
- Inline decorations show step number and title in the editor
