/**
 * Typed error classes for CodepilotReview.
 * Provides structured error handling with user-facing messages.
 */

export class CodepilotReviewError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly userMessage?: string,
        public readonly cause?: unknown
    ) {
        super(message);
        this.name = 'CodepilotReviewError';
    }
}

export class AuthError extends CodepilotReviewError {
    constructor(message: string, cause?: unknown) {
        super(
            message,
            'AUTH_ERROR',
            'Authentication failed. Please check your credentials and try again.',
            cause
        );
        this.name = 'AuthError';
    }
}

export class AuthRequiredError extends CodepilotReviewError {
    constructor(providerName: string) {
        super(
            `Authentication required for ${providerName}`,
            'AUTH_REQUIRED',
            `Please sign in to ${providerName} to continue.`
        );
        this.name = 'AuthRequiredError';
    }
}

export class ProviderError extends CodepilotReviewError {
    constructor(message: string, public readonly providerName: string, cause?: unknown) {
        super(
            message,
            'PROVIDER_ERROR',
            `Provider "${providerName}" encountered an error: ${message}`,
            cause
        );
        this.name = 'ProviderError';
    }
}

export class ToolError extends CodepilotReviewError {
    constructor(message: string, public readonly toolName: string, cause?: unknown) {
        super(
            message,
            'TOOL_ERROR',
            `Review tool "${toolName}" failed: ${message}`,
            cause
        );
        this.name = 'ToolError';
    }
}

export class AiError extends CodepilotReviewError {
    constructor(message: string, cause?: unknown) {
        super(
            message,
            'AI_ERROR',
            'AI service encountered an error. Is GitHub Copilot installed and signed in?',
            cause
        );
        this.name = 'AiError';
    }
}

export class AiNotAvailableError extends CodepilotReviewError {
    constructor() {
        super(
            'No AI model available',
            'AI_NOT_AVAILABLE',
            'No language model found. Please install GitHub Copilot and sign in.'
        );
        this.name = 'AiNotAvailableError';
    }
}

export class ConfigError extends CodepilotReviewError {
    constructor(message: string, cause?: unknown) {
        super(
            message,
            'CONFIG_ERROR',
            `Configuration error: ${message}`,
            cause
        );
        this.name = 'ConfigError';
    }
}
