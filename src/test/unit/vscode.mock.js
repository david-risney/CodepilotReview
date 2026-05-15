/**
 * Minimal mock of the vscode module for running unit tests in plain Node.js.
 * Provides just enough stubs for our source modules to import without crashing.
 */

class EventEmitter {
    constructor() {
        this._listeners = [];
    }

    get event() {
        const self = this;
        return (listener) => {
            self._listeners.push(listener);
            return { dispose: () => { self._listeners = self._listeners.filter(l => l !== listener); } };
        };
    }

    fire(data) {
        for (const listener of this._listeners) {
            listener(data);
        }
    }

    dispose() {
        this._listeners = [];
    }
}

class Uri {
    static file(path) { return { fsPath: path, path, scheme: 'file', toString: () => path }; }
    static joinPath(base, ...segments) {
        const sep = process.platform === 'win32' ? '\\' : '/';
        const joined = [base.fsPath || base.path, ...segments].join(sep);
        return Uri.file(joined);
    }
    static parse(str) { return Uri.file(str); }
}

class ThemeIcon {
    constructor(id) { this.id = id; }
}

class ThemeColor {
    constructor(id) { this.id = id; }
}

class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
        this.startLine = startLine;
        this.startCharacter = startCharacter;
        this.endLine = endLine;
        this.endCharacter = endCharacter;
    }
}

class MarkdownString {
    constructor() {
        this.value = '';
        this.isTrusted = false;
    }
    appendMarkdown(text) { this.value += text; return this; }
    appendText(text) { this.value += text; return this; }
}

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const CommentMode = { Preview: 0, Editing: 1 };
const ProgressLocation = { Notification: 15, SourceControl: 1, Window: 10 };

class TreeItem {
    constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}

const window = {
    createTextEditorDecorationType: () => ({ dispose: () => {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    withProgress: async (_opts, task) => {
        const token = { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event };
        const progress = { report: () => {} };
        return task(progress, token);
    },
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createOutputChannel: () => ({
        appendLine: () => {},
        append: () => {},
        show: () => {},
        dispose: () => {},
    }),
};

const workspace = {
    getConfiguration: () => ({
        get: (_key, defaultValue) => defaultValue,
        update: async () => {},
        has: () => false,
        inspect: () => undefined,
    }),
    workspaceFolders: undefined,
    onDidChangeConfiguration: new EventEmitter().event,
    openTextDocument: async (uri) => ({
        getText: () => '',
        lineCount: 100,
        uri: typeof uri === 'string' ? Uri.file(uri) : uri,
    }),
    createFileSystemWatcher: () => ({
        onDidChange: new EventEmitter().event,
        onDidCreate: new EventEmitter().event,
        onDidDelete: new EventEmitter().event,
        dispose: () => {},
    }),
    asRelativePath: (pathOrUri) => typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath,
    fs: {
        readFile: async () => Buffer.from(''),
        writeFile: async () => {},
    },
};

class RelativePattern {
    constructor(base, pattern) { this.base = base; this.pattern = pattern; }
}

const commands = {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: async () => undefined,
};

const comments = {
    createCommentController: () => ({
        commentingRangeProvider: null,
        createCommentThread: () => ({
            comments: [],
            dispose: () => {},
            label: '',
            contextValue: '',
            canReply: true,
        }),
        dispose: () => {},
    }),
};

const languages = {
    registerHoverProvider: () => ({ dispose: () => {} }),
};

const authentication = {
    getSession: async () => ({ accessToken: 'mock-token' }),
};

const lm = {
    selectChatModels: async () => [],
};

const LanguageModelChatMessage = {
    User: (content) => ({ role: 'user', content }),
    Assistant: (content) => ({ role: 'assistant', content }),
};

module.exports = {
    EventEmitter,
    Uri,
    ThemeIcon,
    ThemeColor,
    Range,
    MarkdownString,
    TreeItem,
    TreeItemCollapsibleState,
    CommentMode,
    ProgressLocation,
    RelativePattern,
    window,
    workspace,
    commands,
    comments,
    languages,
    authentication,
    lm,
    LanguageModelChatMessage,
};
