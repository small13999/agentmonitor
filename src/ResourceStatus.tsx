import type { ManagedSession, SessionResources, SystemResources } from "./agentctl";

type PressureLevel = "normal" | "warning" | "critical";

interface ResourceStatusProps {
  error: string | null;
  resources: SystemResources | null;
  sessions: ManagedSession[];
}

function formatBytes(bytes: number) {
  const gib = bytes / 1_024 ** 3;
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB`;
  return `${Math.round(bytes / 1_024 ** 2)} MiB`;
}

function usagePercent(used: number, total: number) {
  return total > 0 ? used / total : 0;
}

function pressureLevel(ratio: number, warning: number, critical: number): PressureLevel {
  if (ratio >= critical) return "critical";
  if (ratio >= warning) return "warning";
  return "normal";
}

function memoryLevel(session: SessionResources) {
  if (session.memoryUsageBytes === null || session.memoryLimitBytes <= 0) return "normal";
  return pressureLevel(session.memoryUsageBytes / session.memoryLimitBytes, 0.8, 0.9);
}

function UsageMeter({
  label,
  level,
  total,
  used,
}: {
  label: string;
  level: PressureLevel;
  total: number;
  used: number;
}) {
  const percent = usagePercent(used, total);
  return (
    <div className={`resource-meter resource-meter--${level}`}>
      <div>
        <strong>{label}</strong>
        <span>{formatBytes(used)} / {formatBytes(total)}</span>
      </div>
      <div aria-label={`${label} ${Math.round(percent * 100)}% used`} className="resource-meter__track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent * 100)}>
        <span style={{ width: `${Math.min(100, percent * 100)}%` }} />
      </div>
    </div>
  );
}

export function sessionMemoryLabel(session: SessionResources | undefined) {
  if (session === undefined || session.runtimeState !== "running") return "Memory —";
  if (session.memoryUsageBytes === null) return `Memory unavailable · ${formatBytes(session.memoryLimitBytes)} limit`;
  return `Memory ${formatBytes(session.memoryUsageBytes)} / ${formatBytes(session.memoryLimitBytes)}`;
}

export function ResourceStatus({ error, resources, sessions }: ResourceStatusProps) {
  if (resources === null) {
    return (
      <section className="resource-panel resource-panel--loading" aria-label="Resource pressure">
        <strong>Resources</strong>
        <span>{error ?? "Collecting host and container memory…"}</span>
      </section>
    );
  }

  const memoryRatio = usagePercent(resources.host.memoryUsedBytes, resources.host.memoryTotalBytes);
  const swapRatio = usagePercent(resources.host.swapUsedBytes, resources.host.swapTotalBytes);
  const hostMemoryLevel = pressureLevel(memoryRatio, 0.8, 0.9);
  const swapLevel = pressureLevel(swapRatio, 0.5, 0.8);
  const runningResources = resources.sessions.filter((session) => session.runtimeState === "running");
  const sessionNames = new Map(sessions.map((session) => [session.id, session.title || session.id]));
  const warningSessions = runningResources.filter((session) => memoryLevel(session) !== "normal");
  const critical = hostMemoryLevel === "critical"
    || swapLevel === "critical"
    || warningSessions.some((session) => memoryLevel(session) === "critical");
  const warning = critical
    || hostMemoryLevel === "warning"
    || swapLevel === "warning"
    || warningSessions.length > 0;
  const overallLevel: PressureLevel = critical ? "critical" : warning ? "warning" : "normal";

  return (
    <section className={`resource-panel resource-panel--${overallLevel}`} aria-label="Resource pressure" aria-live="polite">
      <header>
        <div>
          <p className="eyebrow">RESOURCE PRESSURE</p>
          <strong>{overallLevel === "normal" ? "Headroom normal" : overallLevel === "critical" ? "Action required" : "Memory pressure rising"}</strong>
        </div>
        <span>Updated {new Date(resources.collectedAtEpochMs).toLocaleTimeString()}</span>
      </header>
      <div className="resource-panel__host">
        <UsageMeter label="WSL memory" level={hostMemoryLevel} total={resources.host.memoryTotalBytes} used={resources.host.memoryUsedBytes} />
        <UsageMeter label="WSL swap" level={swapLevel} total={resources.host.swapTotalBytes} used={resources.host.swapUsedBytes} />
      </div>
      {runningResources.length > 0 && (
        <div className="resource-panel__sessions">
          {runningResources.map((session) => {
            const level = memoryLevel(session);
            return (
              <span className={`session-memory session-memory--${level}`} key={session.id}>
                <strong>{sessionNames.get(session.id) ?? session.id}</strong>
                {sessionMemoryLabel(session).replace(/^Memory\s*/, "")}
              </span>
            );
          })}
        </div>
      )}
      {(resources.collectionError || error) && <p className="resource-panel__error">{resources.collectionError ?? error}</p>}
    </section>
  );
}
