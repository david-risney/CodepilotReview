import * as vscode from 'vscode';
import { logger } from '../logging/logger';

/**
 * Manages authentication tokens using VSCode SecretStorage.
 * Provides a secure, persistent store for provider credentials.
 */
export class TokenStore {
    private secrets: vscode.SecretStorage | undefined;
    private static readonly KEY_PREFIX = 'codepilotReview.token.';

    initialize(context: vscode.ExtensionContext): void {
        this.secrets = context.secrets;
    }

    async getToken(providerName: string): Promise<string | undefined> {
        if (!this.secrets) {
            logger.warn('TokenStore not initialized');
            return undefined;
        }
        return this.secrets.get(TokenStore.KEY_PREFIX + providerName);
    }

    async setToken(providerName: string, token: string): Promise<void> {
        if (!this.secrets) {
            logger.warn('TokenStore not initialized');
            return;
        }
        await this.secrets.store(TokenStore.KEY_PREFIX + providerName, token);
        logger.info(`Token stored for ${providerName}`);
    }

    async deleteToken(providerName: string): Promise<void> {
        if (!this.secrets) {
            return;
        }
        await this.secrets.delete(TokenStore.KEY_PREFIX + providerName);
        logger.info(`Token deleted for ${providerName}`);
    }

    async hasToken(providerName: string): Promise<boolean> {
        const token = await this.getToken(providerName);
        return token !== undefined && token.length > 0;
    }
}
