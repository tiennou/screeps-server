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

interface CompletionCatalog {
    /** `null` means the list has not been loaded from the server yet. */
    envKeys: string[] | null;
    pubsubKeys: string[] | null;
    collections: string[] | null;
    /** Missing key: fields for that collection are not loaded. `[]`: loaded, empty. */
    fields: Record<string, string[]>;
    values: {
        username: string[] | null;
        usernameLower: string[] | null;
        email: string[] | null;
        userId: string[] | null;
        room: string[] | null;
        type: string[] | null;
    };
}

type ArgContext = {
    line: string;
    callee: string;
    receiver: string;
    arg: string;
    collection: string;
    catalog: CompletionCatalog;
};

type ArgCompleter = ((ctx: ArgContext) => import("readline").CompleterResult | null) & {
    kind: "args";
};

type CompletionNode = '' | CompletionResult | ArgCompleter | CompletionTree;
interface CompletionTree {
    [key: string]: CompletionNode
}
type ResolvedConfig = Required<Config>;
