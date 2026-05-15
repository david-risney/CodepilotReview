import * as vscode from 'vscode';
import { TokenStore } from './tokenStore';
import { IAuthProvider } from '../providers/provider';
import { AuthError, AuthRequiredError } from '../errors';
import { logger } from '../logging/logger';

/**
 * Orchestrates authentication across providers.
 * Handles login/logout flows, token storage, and auth state notifications.
 */
export class AuthManager {
    private tokenStore: TokenStore;
    private _onDidChangeAuth = new vscode.EventEmitter<string>();
    readonly onDidChangeAuth = this._onDidChangeAuth.event;

    constructor() {
        this.tokenStore = new TokenStore();
    }

    initialize(context: vscode.ExtensionContext): void {
        this.tokenStore.initialize(context);
    }

    getTokenStore(): TokenStore {
        return this.tokenStore;
    }

    /** Ensure a provider is authenticated, prompting if needed */
    async ensureAuthenticated(providerName: string, authProvider?: IAuthProvider): Promise<boolean> {
        if (!authProvider) {
            // Provider doesn't require auth (e.g., local)
            return true;
        }

        try {
            const isAuth = await authProvider.isAuthenticated();
            if (isAuth) {
                return true;
            }

            const action = await vscode.window.showWarningMessage(
                `${providerName} requires authentication.`,
                'Sign In',
                'Cancel'
            );

            if (action === 'Sign In') {
                const success = await authProvider.authenticate();
                if (success) {
                    this._onDidChangeAuth.fire(providerName);
                    vscode.window.showInformationMessage(`Signed in to ${providerName}`);
                }
                return success;
            }

            return false;
        } catch (error) {
            logger.error(`Authentication failed for ${providerName}`, error);
            throw new AuthError(`Authentication failed for ${providerName}`, error);
        }
    }

    /** Sign out of a provider */
    async signOut(providerName: string, authProvider?: IAuthProvider): Promise<void> {
        if (authProvider) {
            await authProvider.signOut();
        }
        await this.tokenStore.deleteToken(providerName);
        this._onDidChangeAuth.fire(providerName);
        logger.info(`Signed out of ${providerName}`);
    }

    dispose(): void {
        this._onDidChangeAuth.dispose();
    }
}
