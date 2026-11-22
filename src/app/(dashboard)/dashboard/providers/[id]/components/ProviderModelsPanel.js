import { Button, Card } from "@/shared/components";

export default function ProviderModelsPanel({
  isCompatible,
  models,
  kiloFreeModels,
  disabledModelIds,
  modelsTestError,
  renderModelsSection,
  handleEnableAll,
  handleDisableAll,
  thinkingMode = "auto",
  onThinkingModeChange,
  thinkingLevelOptions = null,
  onRefreshModels = null,
  isRefreshingModels = false,
}) {
  const allIds = [
    ...models,
    ...kiloFreeModels.filter((fm) => !models.some((m) => m.id === fm.id)),
  ]
    .filter((m) => !m.type || m.type === "llm")
    .map((m) => m.id);
  const activeIds = allIds.filter((id) => !disabledModelIds.includes(id));

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">{"Available Models"}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {!isCompatible && onRefreshModels && (
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              onClick={onRefreshModels}
              loading={isRefreshingModels}
              title="Bypass 5-minute cache and fetch live models from Provider API"
            >
              Refresh Models
            </Button>
          )}
          {!isCompatible && thinkingLevelOptions?.length > 0 && onThinkingModeChange && (
            <select
              value={thinkingMode || "auto"}
              onChange={(e) => onThinkingModeChange(e.target.value)}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-main"
              title="Default thinking level appended as model(level) when copying"
            >
              {thinkingLevelOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {`Thinking: ${opt.charAt(0).toUpperCase() + opt.slice(1)}`}
                </option>
              ))}
            </select>
          )}
          {!isCompatible && (
            <>
              {disabledModelIds.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="restart_alt"
                  onClick={handleEnableAll}
                >
                  Active All
                </Button>
              )}
              {activeIds.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="block"
                  onClick={() => handleDisableAll(activeIds)}
                >
                  Disable All
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {!!modelsTestError && (
        <div className="mb-3">
          <p className="break-words text-xs text-red-500">
            {modelsTestError}
          </p>
          {/RegionError|hosted in China|regionNotAllowed/i.test(modelsTestError) && (() => {
            const str = typeof modelsTestError === "string" ? modelsTestError : JSON.stringify(modelsTestError);
            const linkMatch = str.match(/https:\/\/opencode\.ai\/workspace\/[^\s"')]+/);
            const wrkMatch = str.match(/wrk_[0-9A-Za-z]+/);
            const targetUrl = linkMatch
              ? (linkMatch[0].endsWith("/go") ? linkMatch[0] : `${linkMatch[0]}/go`)
              : (wrkMatch ? `https://opencode.ai/workspace/${wrkMatch[0]}/go` : null);
            if (!targetUrl) return null;
            return (
              <div className="mt-1.5 flex items-center gap-1.5">
                <a
                  href={targetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 hover:bg-amber-500/20 dark:text-amber-400 transition-colors"
                >
                  <span>Allow China-hosted models</span>
                  <span className="material-symbols-outlined text-[13px]">open_in_new</span>
                </a>
              </div>
            );
          })()}
        </div>
      )}
      {renderModelsSection()}
    </Card>
  );
}