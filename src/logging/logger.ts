import * as vscode from 'vscode';

export class Logger {
    private outputChannel: vscode.OutputChannel;

    constructor(channelName: string = 'CodepilotReview') {
        this.outputChannel = vscode.window.createOutputChannel(channelName);
    }

    info(message: string, ...args: unknown[]): void {
        this.log('INFO', message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        this.log('WARN', message, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        this.log('ERROR', message, ...args);
    }

    debug(message: string, ...args: unknown[]): void {
        this.log('DEBUG', message, ...args);
    }

    show(): void {
        this.outputChannel.show();
    }

    dispose(): void {
        this.outputChannel.dispose();
    }

    private log(level: string, message: string, ...args: unknown[]): void {
        const timestamp = new Date().toISOString();
        const formatted = args.length > 0
            ? `[${timestamp}] [${level}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
            : `[${timestamp}] [${level}] ${message}`;
        this.outputChannel.appendLine(formatted);
    }
}

export const logger = new Logger();
