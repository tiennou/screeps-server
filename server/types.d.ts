type CompletionResult = (line: string) => import("readline").CompleterResult | null;
type CompletionNode = '' | CompletionResult | CompletionTree;
interface CompletionTree {
    [key: string]: CompletionNode
}