# Design Decisions

## Decision Log

### 1. Split Provider Interface by Capability

**Context**: Different code review platforms (GitHub, ADO, Gerrit, local git) have different capabilities. A single monolithic interface would force stub implementations.

**Decision**: Split into `IPullRequestProvider`, `IDiffProvider`, `ICommentProvider`, and `IAuthProvider`. Each provider declares its `ProviderCapabilities`.

**Rationale**: The UI can check capabilities and gracefully degrade. Local provider doesn't need to fake authentication or publishing.

### 2. Review Issue Lifecycle (Draft-First)

**Context**: Review tools generate potential issues. Users need to triage before publishing.

**Decision**: Issues flow through: `suggested` → `draft` → `published` (or `dismissed`). Published issues can be `resolved`.

**Rationale**: Prevents noisy AI-generated comments from being published without human review. Aligns with the goal of AI-assisted (not automated) reviews.

### 3. Configuration Precedence

**Context**: Need to support team configs, personal configs, and VSCode settings.

**Decision**: Precedence (lowest to highest): defaults < project config < user config < VSCode settings.

**Rationale**: VSCode settings win because users expect their editor settings to take priority. Project config provides team defaults.

### 4. Service Layer Between Providers and UI

**Context**: Direct provider-to-view coupling makes testing hard and creates tight dependencies.

**Decision**: `PullRequestService` and `ReviewSessionService` mediate between providers and views.

**Rationale**: Services can be tested without VSCode APIs. Views only depend on service interfaces.

### 5. Local Provider as Primary Development Target

**Context**: Need a provider that works without external services for development and self-review scenarios.

**Decision**: Local provider compares current branch against a configured base branch, creating a synthetic "PR" from git history.

**Rationale**: Enables the "review your own code before submitting" scenario without any external setup.
