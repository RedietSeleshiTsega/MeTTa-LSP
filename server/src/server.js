const {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    DiagnosticSeverity,
    TextDocumentSyncKind,
    SymbolKind,
    CompletionItemKind,
} = require('vscode-languageserver/node');

const { TextDocument } = require('vscode-languageserver-textdocument');
const Parser = require('tree-sitter');
const Metta = require('tree-sitter-metta');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager
const documents = new TextDocuments(TextDocument);

// Initialize Tree-sitter
const parser = new Parser();
parser.setLanguage(Metta);

// Global Index: SymbolName -> [{ uri, range, kind, context, op }]
const globalIndex = new Map();

// Helper to convert URI to local path
function uriToPath(uri) {
    try {
        const url = new URL(uri);
        if (url.protocol === 'file:') {
            let decodedPath = decodeURIComponent(url.pathname);
            if (process.platform === 'win32' && decodedPath.startsWith('/')) {
                decodedPath = decodedPath.substring(1);
            }
            return decodedPath;
        }
    } catch (e) {
        connection.console.error(`Failed to convert URI to path: ${uri}`);
    }
    return null;
}

// Load highlighting queries
// New path: server/src/server.js -> ../../grammar/queries/metta/highlights.scm
const queriesPath = path.resolve(__dirname, '../../grammar/queries/metta/highlights.scm');
let highlightQuery;
try {
    const queryContent = fs.readFileSync(queriesPath, 'utf8');
    highlightQuery = new Parser.Query(Metta, queryContent);
} catch (e) {
    console.error(`Failed to load highlights.scm from ${queriesPath}`, e);
}

// Query for symbols (definitions and type declarations)
const symbolQuery = new Parser.Query(Metta, `
  (list
    head: (atom (symbol) @op (#any-of? @op "=" ":"))
    argument: (list head: (atom (symbol) @name)))
  
  (list
    head: (atom (symbol) @op (#any-of? @op "=" ":"))
    argument: (atom (symbol) @name))
`);

function indexFile(uri, content) {
    const tree = parser.parse(content);
    const matches = symbolQuery.matches(tree.rootNode);

    // Clear old entries for this URI
    for (const [name, symbols] of globalIndex.entries()) {
        const filtered = symbols.filter(s => s.uri !== uri);
        if (filtered.length === 0) {
            globalIndex.delete(name);
        } else {
            globalIndex.set(name, filtered);
        }
    }

    for (const match of matches) {
        const nameNode = match.captures.find(c => c.name === 'name')?.node;
        const opNode = match.captures.find(c => c.name === 'op')?.node;

        if (nameNode && opNode) {
            const name = nameNode.text;
            const kind = opNode.text === '=' ? SymbolKind.Function : SymbolKind.Interface;

            let parent = nameNode.parent;
            while (parent && parent.type !== 'list') parent = parent.parent;
            const context = parent ? parent.text : name;

            const entry = {
                uri,
                kind,
                context,
                op: opNode.text,
                range: {
                    start: { line: nameNode.startPosition.row, character: nameNode.startPosition.column },
                    end: { line: nameNode.endPosition.row, character: nameNode.endPosition.column },
                }
            };

            const existing = globalIndex.get(name) || [];
            existing.push(entry);
            globalIndex.set(name, existing);
        }
    }
}

async function scanWorkspace(folders) {
    for (const folder of folders) {
        const rootPath = uriToPath(folder.uri);
        if (!rootPath) continue;

        connection.console.log(`Scanning workspace folder: ${rootPath}`);
        crawlDirectory(rootPath);
    }
}

function crawlDirectory(dir) {
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (file !== 'node_modules' && file !== '.git' && file !== 'vscode-metta') {
                    crawlDirectory(fullPath);
                }
            } else if (file.endsWith('.metta')) {
                const content = fs.readFileSync(fullPath, 'utf8');
                const uri = `file:///${fullPath.replace(/\\/g, '/')}`;
                indexFile(uri, content);
            }
        }
    } catch (e) {
        connection.console.error(`Error crawling directory ${dir}: ${e.message}`);
    }
}

connection.onInitialize(async (params) => {
    connection.console.log('MeTTa LSP Server Initialized');
    if (params.workspaceFolders) {
        setTimeout(() => scanWorkspace(params.workspaceFolders), 0);
    }

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            semanticTokensProvider: {
                legend: {
                    tokenTypes: ['comment', 'string', 'keyword', 'number', 'operator', 'variable', 'function', 'regexp', 'type', 'boolean', 'punctuation', 'parameter', 'property'],
                    tokenModifiers: []
                },
                full: true
            },
            documentSymbolProvider: true,
            definitionProvider: true,
            hoverProvider: true,
            completionProvider: {
                resolveProvider: true
            }
        },
    };
});

connection.onHover((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const offset = document.offsetAt(params.position);
    const tree = parser.parse(document.getText());
    const nodeAtCursor = tree.rootNode.descendantForIndex(offset);
    if (!nodeAtCursor || (nodeAtCursor.type !== 'symbol' && nodeAtCursor.type !== 'variable')) return null;
    const symbolName = nodeAtCursor.text;
    const entries = globalIndex.get(symbolName);
    if (entries) {
        const bestMatch = entries.find(s => s.op === ':' && s.uri === params.textDocument.uri)
            || entries.find(s => s.op === ':')
            || entries.find(s => s.uri === params.textDocument.uri)
            || entries[0];
        return { contents: { kind: 'markdown', value: `\`\`\`metta\n${bestMatch.context}\n\`\`\`` } };
    }
    return null;
});

connection.onDefinition((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const offset = document.offsetAt(params.position);
    const tree = parser.parse(document.getText());
    const nodeAtCursor = tree.rootNode.descendantForIndex(offset);
    if (!nodeAtCursor || (nodeAtCursor.type !== 'symbol' && nodeAtCursor.type !== 'variable')) return null;
    const symbolName = nodeAtCursor.text;
    const entries = globalIndex.get(symbolName);
    if (entries) {
        return entries.map(s => ({ uri: s.uri, range: s.range }));
    }
    return null;
});

connection.onDocumentSymbol((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    const tree = parser.parse(document.getText());
    const matches = symbolQuery.matches(tree.rootNode);
    const symbols = [];
    for (const match of matches) {
        const nameNode = match.captures.find(c => c.name === 'name')?.node;
        const opNode = match.captures.find(c => c.name === 'op')?.node;
        if (nameNode && opNode) {
            symbols.push({
                name: nameNode.text,
                kind: opNode.text === '=' ? SymbolKind.Function : SymbolKind.Interface,
                location: { uri: params.textDocument.uri, range: { start: { line: nameNode.startPosition.row, character: nameNode.startPosition.column }, end: { line: nameNode.endPosition.row, character: nameNode.endPosition.column } } }
            });
        }
    }
    return symbols;
});

connection.onCompletion((params) => {
    const keywords = ['if', 'let', 'let*', 'match', 'case', 'collapse', 'superpose', 'Cons', 'Nil', 'True', 'False', 'empty', 'Error']
        .map(k => ({ label: k, kind: CompletionItemKind.Keyword }));
    const projectSymbols = Array.from(globalIndex.keys()).map(s => ({ label: s, kind: CompletionItemKind.Function }));
    const all = [...keywords, ...projectSymbols];
    const seen = new Set();
    return all.filter(item => {
        if (seen.has(item.label)) return false;
        seen.add(item.label);
        return true;
    });
});

connection.onCompletionResolve((item) => item);

connection.languages.semanticTokens.on((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { data: [] };
    const tree = parser.parse(document.getText());
    const tokens = [];
    const tokenTypeMap = { 'comment': 0, 'string': 1, 'keyword': 2, 'number': 3, 'operator': 4, 'variable': 5, 'function.call': 6, 'function.definition': 6, 'boolean': 9, 'symbol': 5, 'punctuation.bracket': 10, 'parameter': 11, 'constant': 12 };
    if (highlightQuery) {
        const captures = highlightQuery.captures(tree.rootNode);
        captures.sort((a, b) => (a.node.startPosition.row - b.node.startPosition.row) || (a.node.startPosition.column - b.node.startPosition.column) || (a.index - b.index));
        let prevLine = 0, prevChar = 0;
        for (const capture of captures) {
            const typeIndex = tokenTypeMap[capture.name];
            if (typeIndex !== undefined) {
                const node = capture.node;
                const line = node.startPosition.row, char = node.startPosition.column, length = node.endPosition.column - node.startPosition.column;
                if (length <= 0) continue;
                const deltaLine = line - prevLine, deltaChar = deltaLine === 0 ? char - prevChar : char;
                if (deltaLine < 0 || (deltaLine === 0 && deltaChar < 0)) continue;
                tokens.push(deltaLine, deltaChar, length, typeIndex, 0);
                prevLine = line; prevChar = char;
            }
        }
    }
    return { data: tokens };
});

documents.onDidChangeContent((change) => {
    indexFile(change.document.uri, change.document.getText());
    validateTextDocument(change.document);
});

async function validateTextDocument(textDocument) {
    const tree = parser.parse(textDocument.getText());
    const diagnostics = [];
    function findErrors(node) {
        if (node.type === 'ERROR' || node.isMissing) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: { start: { line: node.startPosition.row, character: node.startPosition.column }, end: { line: node.endPosition.row, character: node.endPosition.column } },
                message: node.type === 'ERROR' ? 'Syntax error' : `Missing node: ${node.type}`,
                source: 'metta-lsp',
            });
        }
        for (let i = 0; i < node.childCount; i++) findErrors(node.child(i));
    }
    findErrors(tree.rootNode);
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

documents.listen(connection);
connection.listen();
