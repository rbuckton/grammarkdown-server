/// <reference types="node" />
import {
    IConnection,
    ITextDocument,
    TextDocuments,
    TextDocumentChangeEvent,
    TextDocumentContentChangeEvent,
    TextDocumentIdentifier,
    TextDocumentSyncKind,
    Files,
    FileEvent,
    FileChangeType,
    DidChangeWatchedFilesParams,
    DidOpenTextDocumentParams,
    DidChangeTextDocumentParams,
} from 'vscode-languageserver';
import { Emitter } from 'vscode-languageserver/lib/utils/events'
import {
    Host,
    Grammar,
    SourceFile,
    DiagnosticMessages,
    Dictionary
} from 'grammarkdown';
import * as url from 'url';

export class GrammarDocument {
    public uri: string;
    public filename: string;
    public text: string;
    public isOpenOnClient: boolean;
    public isOpenOnServer: boolean;
    public marked: boolean;

    constructor(filename: string) {
        this.filename = filename;
    }
}

export class DocumentManager {
    private _didOpen = new Emitter<GrammarDocument>();
    private _didOpenOnClient = new Emitter<GrammarDocument>();
    private _didOpenOnServer = new Emitter<GrammarDocument>();
    private _didChangeContent = new Emitter<GrammarDocument>();
    private _didClose = new Emitter<GrammarDocument>();
    private _didCloseOnClient = new Emitter<GrammarDocument>();
    private _didCloseOnServer = new Emitter<GrammarDocument>();
    private _didUpdate = new Emitter<DocumentManager>();
    private _documents = new Dictionary<GrammarDocument>();
    private _connection: IConnection;
    private _rootNames: string[];
    private _grammar: Grammar;
    private _host: Host;
    private _nativeHost: Host;
    private _updateSuspended: number = 0;
    private _updateRequested: boolean = false;
    private _updating: boolean = false;

    constructor() {
        this._nativeHost = Host.getHost();
        this._host = Host.getHost(filename => this.readFile(filename));
    }

    public get onDidOpen() { return this._didOpen.event; }
    public get onDidOpenOnClient() { return this._didOpenOnClient.event; }
    public get onDidOpenOnServer() { return this._didOpenOnServer.event; }
    public get onDidChangeContent() { return this._didChangeContent.event; }
    public get onDidClose() { return this._didClose.event; }
    public get onDidCloseOnClient() { return this._didCloseOnClient.event; }
    public get onDidCloseOnServer() { return this._didCloseOnServer.event; }
    public get onDidUpdate() { return this._didUpdate.event; }

    public get syncKind() {
        return TextDocumentSyncKind.Full;
    }

    public get rootNames() {
        if (!this._rootNames) {
            this.refreshGrammar();
        }

        return this._rootNames;
    }

    public get grammar() {
        if (!this._grammar) {
            this.refreshGrammar();
        }

        return this._grammar;
    }

    public get sourceFiles() {
        if (!this._grammar) {
            this.refreshGrammar();
        }

        return this._grammar.sourceFiles;
    }

    public listen(connection: IConnection) {
        this._connection = connection;
        this._connection.onDidOpenTextDocument(params => this.handleOpenClientDocument(params));
        this._connection.onDidChangeTextDocument(params => this.handleUpdateClientDocument(params));
        this._connection.onDidCloseTextDocument(params => this.handleCloseClientDocument(params));
        // this._connection.onDidChangeWatchedFiles(params => this.handleServerDocumentsChanged(params));
    }

    public getSourceFile(id: string | TextDocumentIdentifier): SourceFile {
        return this.grammar.getSourceFile(this.normalizeFilename(id));
    }

    public has(id: string | TextDocumentIdentifier): boolean {
        return this.getDocument(this.normalizeFilename(id)) !== undefined;
    }

    public get(id: string | TextDocumentIdentifier): GrammarDocument {
        return this.getDocument(this.normalizeFilename(id));
    }

    public open(id: string | TextDocumentIdentifier): GrammarDocument {
        const filename = this.normalizeFilename(id)
        const text = this._nativeHost.readFile(filename);
        if (text !== undefined) {
            const { created, document } = this.getOrCreateDocument(filename);
            const changed = document.text !== text;
            const wasOpenOnServer = document.isOpenOnServer;
            document.uri = this.normalizeUri(id);
            document.text = text;

            this.openDocumentOnServer(document);
            if (changed) {
                this.invalidateGrammar();
            }

            if (created) {
                this._didOpen.fire(document);
            }

            if (!wasOpenOnServer) {
                this._didCloseOnServer.fire(document);
            }

            if (changed) {
                this._didChangeContent.fire(document);
                this.requestUpdate();
            }

            return document;
        }

        return undefined;
    }

    public close(id: string | TextDocumentIdentifier) {
        const filename = this.normalizeFilename(id);
        const document = this.getDocument(filename);
        if (document !== undefined) {
            const wasOpenOnServer = document.isOpenOnServer;
            if (this.closeDocumentOnServer(document)) {
                this.invalidateGrammar();
            }

            if (!wasOpenOnServer) {
                this._didCloseOnServer.fire(document);
            }

            if (!document.isOpenOnClient) {
                this._didClose.fire(document);
                this.requestUpdate();
            }
        }
    }

    public all() {
        return Dictionary.values(this._documents);
    }

    public keys() {
        return Dictionary.keys(this._documents);
    }

    public suspendUpdates() {
        this._updateSuspended++;
    }

    public resumeUpdates() {
        if (this._updateSuspended > 0) {
            this._updateSuspended--;
            if (this._updateSuspended === 0 && this._updateRequested) {
                this.reportUpdate();
            }
        }
    }

    public normalizeFilename(id: string | TextDocumentIdentifier): string {
        const filename = TextDocumentIdentifier.is(id)
            ? Files.uriToFilePath(id.uri)
            : id;
        const resolved = this._nativeHost.resolveFile(filename);
        const normalized = this._nativeHost.normalizeFile(resolved);
        return normalized;
    }

    public normalizeUri(id: string | TextDocumentIdentifier): string {
        if (TextDocumentIdentifier.is(id)) {
            return id.uri;
        }
        else {
            const pathname = id.split(/[\\/]/).map(encodeURIComponent).join("/");
            return pathname.charAt(0) === "/"
                ? "file://" + pathname
                : "file:///" + pathname;
        }
    }

    private getDocument(filename: string) {
        return Dictionary.get(this._documents, filename);
    }

    private createDocument(filename: string) {
        const document = new GrammarDocument(filename);
        Dictionary.set(this._documents, filename, document);
        return document;
    }

    private getOrCreateDocument(filename: string) {
        const document = this.getDocument(filename);
        if (document !== undefined) {
            return { created: false, document };
        }
        else {
            const document = this.createDocument(filename);
            return { created: true, document };
        }
    }

    private closeDocument(filename: string) {
        return delete this._documents[filename];
    }

    private openDocumentOnClient(document: GrammarDocument) {
        // If the document is already open on the server, we need
        // to stop listening for file change notifications.
        if (!document.isOpenOnClient) {
            document.isOpenOnClient = true;
            if (document.isOpenOnServer) {
                // this.unwatchServerDocument(document.filename);
            }
        }
    }

    private closeDocumentOnClient(document: GrammarDocument) {
        // If the document is already open on the server, we
        // need to start listening for file change notifications again.
        //
        // If the document is not also open on the server, we can
        // remove the document.
        if (document.isOpenOnClient) {
            document.isOpenOnClient = false;
            if (document.isOpenOnServer) {
                // this.watchServerDocument(document.filename);
            }
            else {
                return this.closeDocument(document.filename);
            }
        }

        return false;
    }

    private openDocumentOnServer(document: GrammarDocument) {
        // When a document is open on the client, we will receieve
        // content change notifications from the client.
        //
        // When a document is only open on the server, we need
        // to listen for file change notifications instead.
        if (!document.isOpenOnServer) {
            document.isOpenOnServer = true;
            if (!document.isOpenOnClient) {
                // this.watchServerDocument(document.filename);
            }
        }
    }

    private closeDocumentOnServer(document: GrammarDocument) {
        // If the document is not also open on the client,
        // we need to stop listening for file change notifications
        // and remove the document.
        if (document.isOpenOnServer) {
            document.isOpenOnServer = false;
            if (!document.isOpenOnClient) {
                // this.unwatchServerDocument(document.filename);
                return this.closeDocument(document.filename);
            }
        }

        return false;
    }

    // private watchServerDocument(filename: string) {
    //     this.log(`watchServerDocument(): filename=${filename}`);
    //     this._connection.sendNotification({ method: "watch-file" }, filename);
    // }

    // private unwatchServerDocument(filename: string) {
    //     this.log(`unwatchServerDocument(): filename=${filename}`);
    //     this._connection.sendNotification({ method: "unwatch-file" }, filename);
    // }

    private readFile(filename: string) {
        let document = this.getDocument(filename);
        if (document === undefined) {
            const text = this._nativeHost.readFile(filename);
            if (text !== undefined) {
                document = this.createDocument(filename);
                document.text = text;
                this.openDocumentOnServer(document);
            }
        }

        if (document !== undefined) {
            document.marked = true;
            return document.text;
        }

        return undefined;
    }

    private handleOpenClientDocument({ uri, text }: DidOpenTextDocumentParams) {
        const filename = this.normalizeFilename(TextDocumentIdentifier.create(uri));
        const { created, document } = this.getOrCreateDocument(filename);
        const changed = document.text !== text;
        const wasOpenOnClient = document.isOpenOnClient;
        document.uri = uri;
        document.text = text;
        this.openDocumentOnClient(document);
        if (changed) {
            this.invalidateGrammar();
        }

        if (created) {
            this._didOpen.fire(document);
        }

        if (!wasOpenOnClient) {
            this._didOpenOnClient.fire(document);
        }

        if (changed) {
            this._didChangeContent.fire(document);
            this.requestUpdate();
        }
    }

    private handleUpdateClientDocument({ uri, contentChanges }: DidChangeTextDocumentParams) {
        const change = contentChanges.length > 0 ? contentChanges[contentChanges.length - 1] : null;
        if (change) {
            const text = change.text;
            const filename = this.normalizeFilename(TextDocumentIdentifier.create(uri));
            const { created, document } = this.getOrCreateDocument(filename);
            const changed = document.text !== text;
            const wasOpenOnClient = document.isOpenOnClient;
            document.uri = uri;
            document.text = text;
            this.openDocumentOnClient(document);
            if (changed) {
                this.invalidateGrammar();
            }

            if (created) {
                this._didOpen.fire(document);
            }

            if (!wasOpenOnClient) {
                this._didOpenOnClient.fire(document);
            }

            if (changed) {
                this._didChangeContent.fire(document);
                this.requestUpdate();
            }
        }
    }

    private handleCloseClientDocument({ uri }: TextDocumentIdentifier) {
        const filename = this.normalizeFilename(TextDocumentIdentifier.create(uri));
        const document = this.getDocument(filename);
        if (document !== undefined) {
            const wasOpenOnClient = document.isOpenOnClient;
            if (this.closeDocumentOnClient(document)) {
                this.invalidateGrammar();
            }

            if (!wasOpenOnClient) {
                this._didCloseOnClient.fire(document);
            }

            if (!document.isOpenOnServer) {
                this._didClose.fire(document);
                this.requestUpdate();
            }
        }
    }

    // private handleServerDocumentsChanged(params: DidChangeWatchedFilesParams) {
    //     this.log(`handleServerDocumentsChanged()`);

    //     this.suspendUpdates();
    //     for (const change of params.changes) {
    //         switch (change.type) {
    //             case FileChangeType.Created:
    //             case FileChangeType.Changed:
    //                 return this.handleCreateOrUpdateServerDocument(change);
    //             case FileChangeType.Deleted:
    //                 return this.handleDeleteServerDocument(change);
    //         }
    //     }

    //     this.resumeUpdates();
    // }

    // private handleCreateOrUpdateServerDocument({ uri }: FileEvent) {
    //     this.log("handleCreateOrUpdateServerDocument");
    //     this.open(TextDocumentIdentifier.create(uri));
    // }

    // private handleDeleteServerDocument({ uri }: FileEvent) {
    //     this.log("handleDeleteServerDocument");

    //     const filename = this.normalizeFilename(TextDocumentIdentifier.create(uri));
    //     const document = this.getDocument(filename);
    //     if (document) {
    //         const wasOpenOnServer = document.isOpenOnServer;
    //         if (this.closeDocumentOnServer(document)) {
    //             this.invalidateGrammar();
    //         }

    //         if (!wasOpenOnServer) {
    //             this._didCloseOnServer.fire(document);
    //         }

    //         if (!document.isOpenOnClient) {
    //             this._didClose.fire(document);
    //         }
    //     }
    // }

    private invalidateGrammar() {
        this._rootNames = undefined;
        this._grammar = undefined;
    }

    private refreshGrammar() {
        const wasUpdating = this._updating;
        this._updating = true;
        try {
            const rootNames: string[] = [];
            for (const document of Dictionary.values(this._documents)) {
                if (document.isOpenOnClient) {
                    document.marked = true;
                    rootNames.push(document.filename);
                }
                else {
                    document.marked = false;
                }
            }

            this._rootNames = rootNames;
            this._grammar = new Grammar(rootNames, { }, this._host, this._grammar);
            this._grammar.check();

            for (const document of Dictionary.values(this._documents)) {
                if (!document.marked && !document.isOpenOnClient) {
                    this.close(document.filename);
                }
            }
        }
        finally {
            this._updating = wasUpdating;
        }
    }

    private requestUpdate() {
        if (this._updateSuspended > 0) {
            this._updateRequested = true;
        }
        else {
            this.reportUpdate();
        }
    }

    private reportUpdate() {
        if (!this._updating) {
            this._updating = true;
            try {
                this._updateRequested = false;
                this._didUpdate.fire(this);
            }
            finally {
                this._updating = false;
            }
        }
    }

    private log(message: string) {
        message = `DocumentManager: ${message}`;
        if (this._connection) {
            this._connection.console.log(message);
        }

        console.log(message);
    }
}