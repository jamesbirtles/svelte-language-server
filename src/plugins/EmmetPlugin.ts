import { Document, Position, CompletionsProvider, CompletionItem } from '../api';
import { doComplete } from 'vscode-emmet-helper';

export class EmmetPlugin implements CompletionsProvider {
    getCompletions(document: Document, position: Position): CompletionItem[] {
        const result = doComplete(document, position, 'html', {});
        return result ? result.items : [];
    }
}
