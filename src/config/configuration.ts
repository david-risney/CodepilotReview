import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodepilotReviewConfig, CustomReviewToolConfig } from '../types';
import { logger } from '../logging/logger';

/**
 * Configuration manager that merges settings from multiple sources.
 *
 * Precedence (highest to lowest):
 *   1. VSCode workspace settings
 *   2. VSCode user settings
 *   3. User config (~/.codepilotreview/config.json)
 *   4. Project config (<workspace>/.codepilotreview/config.json)
 *   5. Built-in defaults
 */
export class Configuration {
    private projectConfig: Partial<CodepilotReviewConfig> = {};
    private userConfig: Partial<CodepilotReviewConfig> = {};
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private configWatcher?: vscode.FileSystemWatcher;
    private userConfigWatcher?: vscode.FileSystemWatcher;

    async initialize(): Promise<void> {
        await this.loadConfigs();
        this.watchConfigs();
    }

    dispose(): void {
        this._onDidChange.dispose();
        this.configWatcher?.dispose();
        this.userConfigWatcher?.dispose();
    }

    /** Get the merged configuration */
    getConfig(): CodepilotReviewConfig {
        const vscodeConfig = vscode.workspace.getConfiguration('codepilotReview');

        const defaults: CodepilotReviewConfig = {
            provider: 'local',
            localBaseBranch: 'main',
            reviewTools: [],
        };

        // Merge: defaults < project < user < vscode
        const merged: CodepilotReviewConfig = {
            ...defaults,
            ...this.projectConfig,
            ...this.userConfig,
            provider: vscodeConfig.get<string>('provider', defaults.provider),
            localBaseBranch: vscodeConfig.get<string>('local.baseBranch', defaults.localBaseBranch!),
        };

        // Merge review tools from all sources
        merged.reviewTools = [
            ...(this.projectConfig.reviewTools || []),
            ...(this.userConfig.reviewTools || []),
        ];

        return merged;
    }

    /** Get custom review tool configurations */
    getReviewTools(): CustomReviewToolConfig[] {
        return this.getConfig().reviewTools || [];
    }

    /** Validate config and return any errors */
    validate(): string[] {
        const errors: string[] = [];
        const config = this.getConfig();

        const validProviders = ['local', 'azureDevOps', 'github', 'chromium'];
        if (!validProviders.includes(config.provider)) {
            errors.push(`Invalid provider: "${config.provider}". Must be one of: ${validProviders.join(', ')}`);
        }

        for (const tool of config.reviewTools || []) {
            if (!tool.name) {
                errors.push('Review tool is missing a name');
            }
            if (tool.isPromptTool && !tool.prompt) {
                errors.push(`Prompt tool "${tool.name}" is missing a prompt`);
            }
            if (!tool.isPromptTool && !tool.command) {
                errors.push(`Command tool "${tool.name}" is missing a command`);
            }
        }

        return errors;
    }

    /** Open config file for editing */
    async openConfigFile(scope: 'project' | 'user'): Promise<void> {
        const filePath = scope === 'project'
            ? this.getProjectConfigPath()
            : this.getUserConfigPath();

        if (!filePath) {
            vscode.window.showWarningMessage('No workspace folder open');
            return;
        }

        // Create the file if it doesn't exist
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
        }
        if (!fs.existsSync(filePath)) {
            const template: Partial<CodepilotReviewConfig> = {
                reviewTools: [],
            };
            await fs.promises.writeFile(filePath, JSON.stringify(template, null, 2), 'utf-8');
        }

        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
    }

    private async loadConfigs(): Promise<void> {
        this.projectConfig = await this.loadConfigFile(this.getProjectConfigPath());
        this.userConfig = await this.loadConfigFile(this.getUserConfigPath());
        logger.info('Configuration loaded');
    }

    private async loadConfigFile(filePath: string | undefined): Promise<Partial<CodepilotReviewConfig>> {
        if (!filePath) {
            return {};
        }
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return JSON.parse(content);
        } catch {
            // File doesn't exist or is invalid - that's fine
            return {};
        }
    }

    private getProjectConfigPath(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        return path.join(folders[0].uri.fsPath, '.codepilotreview', 'config.json');
    }

    private getUserConfigPath(): string {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        return path.join(home, '.codepilotreview', 'config.json');
    }

    private watchConfigs(): void {
        // Watch for VSCode config changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('codepilotReview')) {
                this._onDidChange.fire();
            }
        });

        // Watch project config file
        const projectPath = this.getProjectConfigPath();
        if (projectPath) {
            const pattern = new vscode.RelativePattern(
                path.dirname(projectPath),
                path.basename(projectPath)
            );
            this.configWatcher = vscode.workspace.createFileSystemWatcher(pattern);
            this.configWatcher.onDidChange(() => this.reload());
            this.configWatcher.onDidCreate(() => this.reload());
            this.configWatcher.onDidDelete(() => this.reload());
        }

        // Watch user config file (~/.codepilotreview/config.json)
        const userPath = this.getUserConfigPath();
        const userDir = path.dirname(userPath);
        try {
            if (fs.existsSync(userDir)) {
                const userPattern = new vscode.RelativePattern(userDir, path.basename(userPath));
                this.userConfigWatcher = vscode.workspace.createFileSystemWatcher(userPattern);
                this.userConfigWatcher.onDidChange(() => this.reload());
                this.userConfigWatcher.onDidCreate(() => this.reload());
                this.userConfigWatcher.onDidDelete(() => this.reload());
            }
        } catch {
            logger.warn('Could not watch user config file');
        }
    }

    private async reload(): Promise<void> {
        await this.loadConfigs();
        this._onDidChange.fire();
    }
}
