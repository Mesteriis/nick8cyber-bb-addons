export interface ResolveDevinBinOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  usrLocalBin?: string | null;
}

export declare const KNOWN_BAD_VERSIONS: string[];
export declare function resolveDevinBin(options?: ResolveDevinBinOptions): string;
