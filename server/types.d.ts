
interface LauncherOptions {
    autoUpdate: boolean;
    logConsole: boolean;
    runnerThreads: number;
    processorCount: number;
    storageTimeout: number;
    logRotateKeep: number;
    restartInterval: number;
    custom: {
        backend: string;
        common: string;
        driver: string;
        engine: string;
        isolatedVM: string;
        launcher: string;
        pathfinding: string;
        screeps: string;
        storage: string;
    }
}

interface Config {
    steamKey: string;
    mods: string[];
    bots: Record<string, string>;
    launcherOptions: LauncherOptions;
}