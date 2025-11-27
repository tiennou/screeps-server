interface LauncherOptions {
    autoUpdate?: boolean;
    logConsole?: boolean;
    runnerThreads?: number;
    processorCount?: number;
    storageTimeout?: number;
    logRotateKeep?: number;
    restartInterval?: number;
}

interface Config {
    steamKey?: string;
    mods?: string[];
    bots?: Record<string, string>;
    launcherOptions?: LauncherOptions;
}

type CompletionResult = (line: string) => import("readline").CompleterResult | null;
type CompletionNode = '' | CompletionResult | CompletionTree;
interface CompletionTree {
    [key: string]: CompletionNode
}
type CompletionResult = (line: string) => import("readline").CompleterResult | null;
type CompletionNode = '' | CompletionResult | CompletionTree;
interface CompletionTree {
    [key: string]: CompletionNode
}
type ResolvedConfig = Required<Config>;
