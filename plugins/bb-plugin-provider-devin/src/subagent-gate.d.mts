export function parseSubagentsEnabled(text: string): boolean | null;
export function applyDisabled(text: string): string;
export function applyRestore(text: string, prior: boolean | null): string;
export function writeConfigFileSafely(targetPath: string, content: string): void;
