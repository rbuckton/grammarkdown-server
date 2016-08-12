/// <reference types="node" />
import {
    createConnection,
    IPCMessageReader,
    IPCMessageWriter,
    IConnection,
    ITextDocument,
    TextDocuments,
    TextDocumentChangeEvent,
    TextDocumentIdentifier,
    TextDocumentPosition,
    Diagnostic,
    DiagnosticSeverity,
    InitializeParams,
    InitializeResult,
    Definition,
    ReferenceParams,
    Location,
    RenameParams,
    WorkspaceEdit,
    TextEdit,
    SignatureHelp
} from 'vscode-languageserver';
import {
    Host,
    Grammar,
    Resolver,
    NodeNavigator,
    SyntaxKind,
    Node,
    Identifier,
    SourceFile,
    Production,
    Parameter,
    Dictionary
} from 'grammarkdown';
import { GrammarDocument, DocumentManager } from "./documents";

const connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const documents = new DocumentManager();

function onInitialized(params: InitializeParams): InitializeResult {
    return {
        capabilities: {
            textDocumentSync: documents.syncKind,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: true,

            // TODO(rbuckton): Signature help
            // signatureHelpProvider: true,

            // TODO(rbuckton): completion
            // completionProvider: {
            //     resolveProvider: true
            // }
        }
    };
}

connection.onInitialize(onInitialized);

function onDocumentsUpdated() {
    const grammar = documents.grammar;
    grammar.check();

    for (const document of documents.all()) {
        const sourceFile = documents.getSourceFile(document.filename);
        if (sourceFile !== undefined) {
            const diagnostics: Diagnostic[] = [];
            const infos = grammar.diagnostics.getDiagnosticInfosForSourceFile(sourceFile, { formatMessage: true, detailedMessage: false });
            for (const { code, warning, range, formattedMessage: message, node, pos } of infos) {
                const severity = warning ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error;
                diagnostics.push({ code, severity, range, message });
            }

            connection.sendDiagnostics({
                uri: document.uri,
                diagnostics
            });
        }
    }
}

documents.onDidUpdate(onDocumentsUpdated);

// TODO(rbuckton): Completion
// function onCompletion(params: TextDocumentIdentifier): CompletionItem[] {
//     log("onCompletion")
//     return undefined;
// }
//
// connection.onCompletion(onCompletion);
//
// function onCompletionResolved(item: CompletionItem): CompletionItem {
//     log("onCompletionResolved")
//     return item;
// }
//
// connection.onCompletionResolve(onCompletionResolved);

// TODO(rbuckton): Incremental parser
// function onTextDocumentOpened(params: DidOpenTextDocumentParams) {
//     log("onTextDocumentOpened")
// }
//
// connection.onDidOpenTextDocument(onTextDocumentOpened);
//
// function onTextDocumentChanged(params: DidChangeTextDocumentParams) {
//     log("onTextDocumentChanged")
// }
//
// connection.onDidChangeTextDocument(onTextDocumentChanged);
//
// function onTextDocumentClosed(params: TextDocumentIdentifier) {
//     log("onTextDocumentClosed")
// }
//
// connection.onDidCloseTextDocument(onTextDocumentClosed);

// TODO(rbuckton): Signature Help
// function onSignatureHelp(params: TextDocumentIdentifier): SignatureHelp {
//     log("onSignatureHelp");
//     return undefined;
// }
//
// connection.onSignatureHelp(onSignatureHelp);

function onDefinition(params: TextDocumentPosition): Definition {
    let declarations: (SourceFile | Production | Parameter)[];
    const grammar = documents.grammar;
    const sourceFile = documents.getSourceFile(TextDocumentIdentifier.create(params.uri));
    const resolver = grammar.resolver;
    const navigator = resolver.createNavigator(sourceFile);
    if (navigator.moveToPosition(params.position)) {
        if (navigator.moveToName()) {
            declarations = resolver.getDeclarations(<Identifier>navigator.getNode());
        }
    }

    return getLocationsOfNodes(declarations, resolver);
}

connection.onDefinition(onDefinition);

function onReferences(params: ReferenceParams): Location[] {
    let references: Node[];
    const grammar = documents.grammar;
    const sourceFile = documents.getSourceFile(TextDocumentIdentifier.create(params.uri));
    const resolver = grammar.resolver;
    const navigator = resolver.createNavigator(sourceFile);
    if (navigator.moveToPosition(params.position) && navigator.moveToName()) {
        references = resolver.getReferences(<Identifier>navigator.getNode());
    }

    return getLocationsOfNodes(references, resolver);
}

connection.onReferences(onReferences);

function onRenameRequest(params: RenameParams): WorkspaceEdit {
    const grammar = documents.grammar;
    const sourceFile = documents.getSourceFile(params.textDocument);
    grammar.check(sourceFile);

    const resolver = grammar.resolver;
    const navigator = resolver.createNavigator(sourceFile);
    if (navigator && navigator.moveToPosition(params.position) && navigator.getKind() === SyntaxKind.Identifier) {
        const references = resolver.getReferences(<Identifier>navigator.getNode());
        const locations = getLocationsOfNodes(references, resolver);
        const workspaceEdit: WorkspaceEdit = { changes: {} };
        for (const location of locations) {
            const changes = Dictionary.has(workspaceEdit.changes, location.uri)
                ? workspaceEdit.changes[location.uri]
                : workspaceEdit.changes[location.uri] = [];
            changes.push({ newText: params.newName, range: location.range });
        }

        return workspaceEdit;
    }

    return undefined;
}

connection.onRenameRequest(onRenameRequest);

function getLocationsOfNodes(nodes: Node[], resolver: Resolver) {
    const locations: Location[] = [];
    if (nodes) {
        for (const node of nodes) {
            const navigator = resolver.createNavigator(node);
            if (navigator && navigator.moveToName()) {
                const sourceFile = navigator.getRoot();
                const name = <Identifier>navigator.getNode();
                const isQuotedName = name.text.length + 2 === name.end - name.pos;
                const start = sourceFile.lineMap.getLineAndCharacterOfPosition(isQuotedName ? name.pos + 1 : name.pos);
                const end = sourceFile.lineMap.getLineAndCharacterOfPosition(isQuotedName ? name.end - 1 : name.end);
                locations.push({ uri: documents.normalizeUri(sourceFile.filename), range: { start, end } });
            }
        }
    }

    return locations;
}

function log(message: string) {
    console.log(`grammarkdown-server: ${message}`);
    connection.console.log(`grammarkdown-server: ${message}`);
}

// start listening
documents.listen(connection);
connection.listen();