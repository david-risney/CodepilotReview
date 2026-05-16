import * as vscode from 'vscode';
import { ProviderInstanceConfig, ProviderType, ProviderView } from '../types';
import { ICodeReviewProvider, ProviderInstance } from './provider';
import { LocalProvider } from './localProvider';
import { AzureDevOpsProvider } from './adoProvider';
import { GitHubProvider } from './githubProvider';
import { ChromiumProvider } from './chromiumProvider';
import { AuthManager } from '../auth/authManager';
import { logger } from '../logging/logger';

/**
 * Manages multiple provider instances simultaneously.
 * Handles creation, initialization, lifecycle, and config normalization.
 */
export class ProviderManager {
    private instances = new Map<string, ProviderInstance>();
    private context: vscode.ExtensionContext | undefined;
    private authManager: AuthManager | undefined;

    private _onDidChangeProviders = new vscode.EventEmitter<void>();
    readonly onDidChangeProviders = this._onDidChangeProviders.event;

    setContext(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    setAuthManager(authManager: AuthManager): void {
        this.authManager = authManager;
    }

    /**
     * Initialize providers from config. Normalizes legacy single-provider
     * settings into the multi-provider format for backward compatibility.
     */
    async initializeFromConfig(): Promise<void> {
        const configs = this.getProviderConfigs();
        await this.initializeAll(configs);
    }

    /**
     * Read provider configs, preferring the `providers` array setting.
     * Falls back to the legacy single `provider` + type-specific settings.
     */
    getProviderConfigs(): ProviderInstanceConfig[] {
        const vsConfig = vscode.workspace.getConfiguration('codepilotReview');
        return vsConfig.get<ProviderInstanceConfig[]>('providers', []);
    }

    /** Initialize all providers from an array of configs. Disposes any existing providers first. */
    async initializeAll(configs: ProviderInstanceConfig[]): Promise<void> {
        this.disposeAll();

        const results = await Promise.allSettled(
            configs.map(cfg => this.addProvider(cfg)),
        );

        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'rejected') {
                const reason = (results[i] as PromiseRejectedResult).reason;
                logger.error(`Failed to initialize provider "${configs[i].id}"`, reason);
                vscode.window.showWarningMessage(
                    `Failed to initialize provider "${configs[i].label}": ${reason?.message ?? reason}`,
                );
            }
        }

        this._onDidChangeProviders.fire();
    }

    /** Add and initialize a single provider instance. */
    async addProvider(config: ProviderInstanceConfig): Promise<ProviderInstance> {
        if (this.instances.has(config.id)) {
            // Remove existing instance with same ID
            this.removeProvider(config.id);
        }

        const provider = this.createProvider(config);
        if (!this.context) {
            throw new Error('ProviderManager context not set');
        }

        await provider.initialize(this.context);

        // Authenticate if needed
        if (provider.capabilities.requiresAuthentication && this.authManager) {
            await this.authManager.ensureAuthenticated(config.id, provider.auth);
        }

        // Normalize views — ensure at least a default "All" view
        const views = this.normalizeViews(config);

        const instance: ProviderInstance = {
            id: config.id,
            displayName: config.label,
            type: config.type,
            provider,
            views,
        };

        this.instances.set(config.id, instance);
        logger.info(`Provider "${config.id}" (${config.type}) initialized with ${views.length} view(s)`);
        return instance;
    }

    /** Ensure views array is populated; create default "All" view if empty. */
    private normalizeViews(config: ProviderInstanceConfig): ProviderView[] {
        if (config.views && config.views.length > 0) {
            return config.views;
        }
        return [{ id: 'all', label: 'All', query: { type: config.type } as any }];
    }

    /** Update views for a provider instance (for view management commands). */
    updateProviderViews(providerId: string, views: ProviderView[]): void {
        const instance = this.instances.get(providerId);
        if (instance) {
            instance.views = views.length > 0 ? views : [{ id: 'all', label: 'All', query: { type: instance.type } as any }];
            this._onDidChangeProviders.fire();
        }
    }

    /** Remove and dispose a provider by ID. */
    removeProvider(id: string): void {
        const instance = this.instances.get(id);
        if (instance) {
            instance.provider.dispose();
            this.instances.delete(id);
            this._onDidChangeProviders.fire();
            logger.info(`Provider "${id}" removed`);
        }
    }

    /** Get a provider instance by ID. */
    getProvider(id: string): ProviderInstance | undefined {
        return this.instances.get(id);
    }

    /** Get all active provider instances. */
    getAllProviders(): ProviderInstance[] {
        return Array.from(this.instances.values());
    }

    /** Check if any provider of the given type is active. */
    hasProviderOfType(type: ProviderType): boolean {
        return this.getAllProviders().some(p => p.type === type);
    }

    /** Dispose all providers. */
    disposeAll(): void {
        for (const instance of this.instances.values()) {
            instance.provider.dispose();
        }
        this.instances.clear();
    }

    dispose(): void {
        this.disposeAll();
        this._onDidChangeProviders.dispose();
    }

    private createProvider(config: ProviderInstanceConfig): ICodeReviewProvider {
        switch (config.type) {
            case 'azureDevOps': return new AzureDevOpsProvider(config);
            case 'github': return new GitHubProvider(config);
            case 'chromium': return new ChromiumProvider(config);
            case 'local':
            default: return new LocalProvider(config);
        }
    }
}
