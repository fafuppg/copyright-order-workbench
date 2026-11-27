export interface LaunchChecks {
  appListening(): Promise<boolean>;
  tunnelListening(): Promise<boolean>;
  databaseReady(): Promise<boolean>;
  appHealthy(): Promise<boolean>;
  startTunnel(): Promise<void> | void;
  startServer(): Promise<void> | void;
  useTunnel: boolean;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  timeoutMs?: number;
  intervalMs?: number;
  onProgress?(message: string): void;
}
export function prepareWorkbench(
  checks: LaunchChecks,
): Promise<{ existing: boolean; repaired: boolean }>;
