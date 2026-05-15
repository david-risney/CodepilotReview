# Partitioning Specification

## Overview

Partitioning divides a code change into logically related chunks to make review easier. Chunks are ordered in a dependency tree and can be reviewed separately.

## Partition Types

### Dependency Partition
Partitions code into logically related chunks ordered by dependency.
- Chunks represent logical units (e.g., "data model changes", "API changes", "UI changes")
- Dependency ordering helps reviewers understand the change bottom-up
- Strict partitioning is NOT required — some overlap is OK
- All code must be included in at least one chunk
- Chunks are NOT file-level — different parts of a file may belong to different chunks

### Ownership Partition
Partitions code by ownership:
- "Things you own and are required to review"
- "Things owned by others"
- Uses CODEOWNERS or similar ownership files if available

### Custom Partition
User-defined partitioning criteria via AI chat:
- User describes criteria (e.g., "separate upstream vs downstream changes")
- AI produces partition based on criteria
- Iterative refinement through chat

## Data Model

```typescript
interface Partition {
    id: string;
    name: string;
    description: string;
    chunks: PartitionChunk[];
    dependsOn: string[];  // Other partition IDs
}

interface PartitionChunk {
    filePath: string;
    lineRanges?: Array<{ start: number; end: number }>;
}
```

## Code Tour

Each partition can generate a guided walkthrough:
- Sequential steps through each file/region in the partition
- Inline description of "why" and "how" for each step
- Next/Previous navigation buttons
- AI-generated explanations

```typescript
interface CodeTour {
    id: string;
    name: string;
    steps: CodeTourStep[];
}

interface CodeTourStep {
    title: string;
    description: string;
    filePath: string;
    line: number;
    partitionId?: string;
}
```
