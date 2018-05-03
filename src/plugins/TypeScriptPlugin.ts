import ts from 'typescript';
import { join, resolve, basename, dirname, extname } from 'path';
import * as prettier from 'prettier';
import detectIndent from 'detect-indent';
import indentString from 'indent-string';
import {
    DiagnosticsProvider,
    Document,
    Diagnostic,
    Range,
    DiagnosticSeverity,
    Fragment,
    HoverProvider,
    Position,
    Hover,
    MarkedString,
    FormattingProvider,
    TextEdit,
} from '../api';
import { SvelteDocument } from '../lib/documents/SvelteDocument';

export class TypeScriptPlugin implements DiagnosticsProvider, HoverProvider, FormattingProvider {
    public static matchFragment(fragment: Fragment) {
        return fragment.details.attributes.tag == 'script';
    }

    private lang = getLanguageService();

    getDiagnostics(document: Document): Diagnostic[] {
        const lang = this.lang.updateDocument(document);
        const syntaxDiagnostics = lang.getSyntacticDiagnostics(document.getFilePath()!);
        const semanticDiagnostics = lang.getSemanticDiagnostics(document.getFilePath()!);
        return [...syntaxDiagnostics, ...semanticDiagnostics].map(diagnostic => ({
            range: convertRange(document, diagnostic),
            severity: DiagnosticSeverity.Error,
            source:
                getScriptKindFromTypeAttribute(document.getAttributes().type) === ts.ScriptKind.TS
                    ? 'ts'
                    : 'js',
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        }));
    }

    doHover(document: Document, position: Position): Hover | null {
        const lang = this.lang.updateDocument(document);
        const info = lang.getQuickInfoAtPosition(
            document.getFilePath()!,
            document.offsetAt(position),
        );
        if (!info) {
            return null;
        }
        let contents = ts.displayPartsToString(info.displayParts);
        return {
            range: convertRange(document, info.textSpan),
            contents: { language: 'ts', value: contents },
        };
    }

    async formatDocument(document: Document): Promise<TextEdit[]> {
        if (document.getTextLength() === 0) {
            return [];
        }

        const config = await prettier.resolveConfig(document.getFilePath()!);
        const formattedCode = prettier.format(document.getText(), {
            ...config,
            parser: getParserFromTypeAttribute(document.getAttributes().type), // TODO: select babylon if js only
        });

        let indent = detectIndent(document.getText());
        return [
            TextEdit.replace(
                Range.create(document.positionAt(0), document.positionAt(document.getTextLength())),
                '\n' +
                    indentString(formattedCode, indent.amount, indent.type == 'tab' ? '\t' : ' '),
            ),
        ];
    }
}

interface DocumentSnapshot extends ts.IScriptSnapshot {
    version: number;
    scriptKind: ts.ScriptKind;
}

namespace DocumentSnapshot {
    export function fromDocument(document: Document): DocumentSnapshot {
        const text = document.getText();
        const length = document.getTextLength();
        return {
            version: document.version,
            scriptKind: getScriptKindFromTypeAttribute(document.getAttributes().type),
            getText: (start, end) => text.substring(start, end),
            getLength: () => length,
            getChangeRange: () => undefined,
        };
    }
}

function getLanguageService() {
    const workspacePath = '/Users/jamesb/projects/Aircast/frontend';
    const documents = new Map<string, DocumentSnapshot>();

    let compilerOptions: ts.CompilerOptions = {
        allowNonTsExtensions: true,
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        allowJs: true,
    };

    // Grab tsconfig file
    const configFilename =
        ts.findConfigFile(workspacePath, ts.sys.fileExists, 'tsconfig.json') ||
        ts.findConfigFile(workspacePath, ts.sys.fileExists, 'jsconfig.json');
    const configJson = configFilename && ts.readConfigFile(configFilename, ts.sys.readFile).config;
    let files: string[];
    if (configJson) {
        const parsedConfig = ts.parseJsonConfigFileContent(
            configJson,
            ts.sys,
            workspacePath,
            compilerOptions,
            configFilename,
            undefined,
            [
                { extension: 'html', isMixedContent: true },
                { extension: 'svelte', isMixedContent: true },
            ],
        );
        files = parsedConfig.fileNames;
        compilerOptions = { ...compilerOptions, ...parsedConfig.options };
    }

    const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => compilerOptions,
        getScriptFileNames: () => Array.from(new Set([...files, ...Array.from(documents.keys())])),
        getScriptVersion(fileName: string) {
            const doc = documents.get(fileName);
            return doc ? String(doc.version) : '0';
        },
        getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
            const doc = documents.get(fileName);
            if (doc) {
                return doc;
            }

            return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) || '');
        },
        getCurrentDirectory: () => '/Users/jamesb/projects/Aircast/frontend',
        getDefaultLibFileName: ts.getDefaultLibFilePath,

        resolveModuleNames(moduleNames: string[], containingFile: string): ts.ResolvedModule[] {
            return moduleNames.map(name => {
                const resolved = ts.resolveModuleName(
                    name,
                    containingFile,
                    compilerOptions,
                    ts.sys,
                );

                if (!resolved.resolvedModule && isSvelte(name)) {
                    return {
                        resolvedFileName: resolve(dirname(containingFile), name),
                        extension: extname(name),
                    };
                }

                return resolved.resolvedModule!;
            });
        },
    };
    let languageService = ts.createLanguageService(host);

    return {
        getService: () => languageService,
        updateDocument,
    };

    function updateDocument(document: Document): ts.LanguageService {
        const preSnapshot = documents.get(document.getFilePath()!);
        const newSnapshot = DocumentSnapshot.fromDocument(document);
        if (preSnapshot && preSnapshot.scriptKind !== newSnapshot.scriptKind) {
            // Restart language service as it doesn't handle script kind changes.
            languageService.dispose();
            languageService = ts.createLanguageService(host);
        }

        documents.set(document.getFilePath()!, newSnapshot);
        return languageService;
    }
}

function getScriptKindFromFileName(fileName: string): ts.ScriptKind {
    const ext = fileName.substr(fileName.lastIndexOf('.'));
    switch (ext.toLowerCase()) {
        case ts.Extension.Js:
            return ts.ScriptKind.JS;
        case ts.Extension.Jsx:
            return ts.ScriptKind.JSX;
        case ts.Extension.Ts:
            return ts.ScriptKind.TS;
        case ts.Extension.Tsx:
            return ts.ScriptKind.TSX;
        case ts.Extension.Json:
            return ts.ScriptKind.JSON;
        default:
            return ts.ScriptKind.Unknown;
    }
}

function getScriptKindFromTypeAttribute(type: string): ts.ScriptKind {
    switch (type) {
        case 'text/typescript':
            return ts.ScriptKind.TS;
        case 'text/javascript':
        default:
            return ts.ScriptKind.JS;
    }
}

function getParserFromTypeAttribute(type: string): prettier.BuiltInParserName {
    switch (type) {
        case 'text/typescript':
            return 'typescript';
        case 'text/javascript':
        default:
            return 'babylon';
    }
}

function convertRange(document: Document, range: { start?: number; length?: number }) {
    return Range.create(
        document.positionAt(range.start || 0),
        document.positionAt((range.start || 0) + (range.length || 0)),
    );
}

function isSvelte(filePath: string) {
    return filePath.endsWith('.html') || filePath.endsWith('.svelte');
}
