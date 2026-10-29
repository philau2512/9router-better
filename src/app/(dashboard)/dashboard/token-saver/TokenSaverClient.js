"use client";

import {
  Card,
  Toggle,
  ConfirmModal,
} from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
} from "../endpoint/endpointConstants";
import { useHeadroomState } from "./hooks/local/use-headroom-state";
import { usePxpipeState } from "./hooks/local/use-pxpipe-state";
import { useTokenSaverSettings } from "./hooks/local/use-token-saver-settings";
import { HeadroomSetupModal } from "./components/local/headroom-setup-modal";
import { PxpipeSetupModal } from "./components/local/pxpipe-setup-modal";

const patchSetting = async (patch) => {
  try {
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch (error) {
    console.log("Error updating setting:", error);
  }
};

export default function TokenSaverClient() {

  const { copied, copy } = useCopyToClipboard();

  // Create state hooks
  const pxpipe = usePxpipeState(patchSetting);
  const headroom = useHeadroomState(patchSetting);

  // Create settings hook
  const settings = useTokenSaverSettings(patchSetting, {
    refreshHeadroomStatus: headroom.refreshHeadroomStatus,
    refreshPxpipeStatus: pxpipe.refreshPxpipeStatus,
    runPxpipeHealth: pxpipe.runPxpipeHealth,
    setHeadroomEnabled: headroom.setHeadroomEnabled,
    setHeadroomUrl: headroom.setHeadroomUrl,
    setCodeAware: headroom.setCodeAware,
    setKompress: headroom.setKompress,
    setPxpipeEnabled: pxpipe.setPxpipeEnabled,
    setPxpipeMinChars: pxpipe.setPxpipeMinChars,
  });

  // Helper Labels & Classes
  const headroomRunning = !!headroom.headroomStatus.running;
  const headroomStatusLabel = headroom.headroomStatus.loading
    ? "Checking…"
    : headroomRunning
      ? "Running"
      : headroom.headroomStatus.localUrl !== false && !headroom.headroomStatus.installed
        ? "Not installed"
        : headroom.headroomStatus.localUrl !== false
          ? "Stopped"
          : "External";
  const headroomLocalUrl = headroom.headroomStatus.localUrl !== false;
  const headroomCanStart = !!headroom.headroomStatus.canStart;
  const headroomManaged = headroomLocalUrl && !!headroom.headroomStatus.managedPid;

  const pxpipeHealthy = pxpipe.pxpipeHealth?.healthy === true;
  const pxpipeStatusLabel = pxpipe.pxpipeStatus.loading
    ? "Checking…"
    : pxpipe.pxpipeStatus.installing
      ? "Installing…"
      : !pxpipe.pxpipeStatus.installed
        ? "Not installed"
        : pxpipeHealthy
          ? "Healthy"
          : pxpipe.pxpipeStatus.running
            ? "Running"
            : "Stopped";
  const pxpipeChipClass =
    pxpipeHealthy || pxpipe.pxpipeStatus.running
      ? "bg-success/15 text-success"
      : "bg-warning/15 text-warning";

  return (
    <div className="space-y-6 p-6">
      <Card id="rtk">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">bolt</span>
            Token Saver
          </h2>
        </div>
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress tool output{" "}
              <a
                href="https://github.com/rtk-ai/rtk"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (RTK)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              git/grep/ls/tree/logs → 60-90% fewer input tokens
            </p>
          </div>
          <Toggle
            checked={settings.rtkEnabled}
            onChange={() => settings.handleRtkEnabled(!settings.rtkEnabled)}
          />
        </div>
        <div className="flex items-center justify-between py-4 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-medium">
                Compress context{" "}
                <a
                  href="https://github.com/chopratejas/headroom"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-primary underline hover:opacity-80"
                >
                  (Headroom)
                </a>
              </p>
              <span
                className={`text-xs px-2 py-0.5 rounded ${headroomRunning ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}
              >
                {headroomStatusLabel}
              </span>
              <button
                type="button"
                onClick={() => headroom.setShowHeadroomInstallModal(true)}
                className="text-xs text-primary underline hover:opacity-80"
              >
                {headroomRunning ? "Manage" : "Setup"}
              </button>
            </div>
            <p className="text-sm text-text-muted mt-1">
              Compress prompts via /v1/compress before routing to the model
            </p>
          </div>
          <Toggle
            checked={settings.cavemanEnabled ? false : headroom.headroomEnabled && headroomRunning}
            disabled={!headroomRunning}
            onChange={() => headroom.handleHeadroomEnabled(!headroom.headroomEnabled)}
          />
        </div>
        {headroom.headroomStatus.installed && (
          <div className="mb-3 ml-1 pl-3 pb-4 border-l-2 border-border">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-text-muted">
                Compression extras
                {headroom.headroomExtras.version ? ` · v${headroom.headroomExtras.version}` : ""}:
              </span>
              {headroom.headroomExtras.available.map((extra) => {
                const installed = !!headroom.headroomExtras.extras[extra];
                const pending = headroom.pendingExtras.includes(extra);
                const extraTitle =
                  extra === "code"
                    ? "tree-sitter AST compression for code responses"
                    : "Kompress-v2 HF model for prose/agentic traces (~+1GB)";

                if (installed) {
                  const active = extra === "code" ? headroom.codeAware : headroom.kompress;
                  return (
                    <div
                      key={extra}
                      className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-success/40 bg-success/5 text-text"
                      title={extraTitle}
                    >
                      <Toggle
                        size="sm"
                        checked={active}
                        disabled={headroom.restartingProxy}
                        onChange={() => headroom.toggleExtraActive(extra, !active)}
                      />
                      <span className="font-medium">[{extra}]</span>
                      <button
                        type="button"
                        onClick={() => headroom.handleRemoveExtra(extra)}
                        disabled={headroom.removingExtra === extra}
                        className="ml-1 text-error underline hover:opacity-80 disabled:opacity-50"
                        title={`Uninstall [${extra}]`}
                      >
                        {headroom.removingExtra === extra
                          ? "Uninstalling…"
                          : "Uninstall"}
                      </button>
                    </div>
                  );
                }

                return (
                  <label
                    key={extra}
                    className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded border cursor-pointer transition-colors ${
                      pending
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-text-muted hover:bg-surface-2"
                    }`}
                    title={extraTitle}
                  >
                    <input
                      type="checkbox"
                      className="w-3 h-3"
                      checked={pending}
                      onChange={() => headroom.togglePendingExtra(extra)}
                    />
                    <span className="font-medium">[{extra}]</span>
                    <span className="opacity-70">not installed</span>
                  </label>
                );
              })}
              {headroom.pendingExtras.length > 0 && (
                <button
                  onClick={headroom.handleInstallExtras}
                  disabled={headroom.extrasActionLoading}
                  className="text-xs px-2.5 py-1 rounded bg-primary text-white hover:opacity-90 disabled:opacity-50"
                >
                  {headroom.extrasActionLoading
                    ? "Installing…"
                    : `Install [proxy,${headroom.pendingExtras.join(",")}]`}
                </button>
              )}
            </div>
            {headroom.extrasActionError && (
              <p className="text-xs text-error mt-1">{headroom.extrasActionError}</p>
            )}
            {headroom.restartingProxy && (
              <p className="text-xs text-text-muted mt-1">Restarting proxy…</p>
            )}
            {(headroom.extrasActionLoading || headroom.removingExtra) && headroom.installLog && (
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-surface-2 p-2 text-[10px] leading-tight text-text-muted whitespace-pre-wrap">
                {headroom.installLog}
              </pre>
            )}
            <p className="text-xs text-text-muted mt-1">
              Installing adds the package; use <code>on</code>/<code>off</code>{" "}
              to activate it (restarts the proxy). Default install is{" "}
              <code>[proxy]</code> only (SmartCrusher for JSON). Adding{" "}
              <code>[code]</code> enables AST compression
              (Python/JS/TS/Go/Rust/Java/C/C++/Perl). Adding <code>[ml]</code>{" "}
              enables the Kompress-v2 HF model for prose/agentic traces but adds
              ~1 GB (torch + huggingface-hub).
            </p>
          </div>
        )}
        <div className="flex items-center justify-between pt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress LLM output{" "}
              <a
                href="https://github.com/JuliusBrussee/caveman"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Caveman)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Terse-style system prompt → ~65% fewer output tokens (up to 87%)
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {settings.cavemanEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {settings.visibleCavemanLevels.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => settings.handleCavemanLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        settings.cavemanLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {CAVEMAN_LEVELS.find((lvl) => lvl.id === settings.cavemanLevel)?.desc}
                </p>
              </div>
            )}
            <Toggle
              checked={settings.cavemanEnabled}
              onChange={() => settings.handleCavemanEnabled(!settings.cavemanEnabled)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Lazy senior dev{" "}
              <a
                href="https://github.com/DietrichGebert/ponytail"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Ponytail)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Bias the model toward minimal code: YAGNI, reuse stdlib, deletion
              over addition
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {settings.ponytailEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {PONYTAIL_LEVELS.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => settings.handlePonytailLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        settings.ponytailLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    PONYTAIL_LEVELS.find((lvl) => lvl.id === settings.ponytailLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={settings.ponytailEnabled}
              onChange={() => settings.handlePonytailEnabled(!settings.ponytailEnabled)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Custom system prompt</p>
            <p className="text-sm text-text-muted">
              Appends your own instruction to every request, independently of
              the savers above
            </p>
          </div>
          <Toggle
            checked={settings.customPromptEnabled}
            onChange={() => settings.handleCustomPromptEnabled(!settings.customPromptEnabled)}
          />
        </div>
        {settings.customPromptEnabled && (
          <div className="pt-3">
            <textarea
              id="custom-prompt"
              aria-label="Custom system prompt"
              value={settings.customPrompt}
              onChange={(e) => settings.setCustomPrompt(e.target.value)}
              onBlur={settings.handleCustomPromptBlur}
              rows={4}
              placeholder="e.g. Prefer editing existing files over creating new ones."
              className="w-full rounded border border-border bg-transparent p-2 text-xs"
            />
            <p className="text-xs text-text-muted mt-1">
              Applied to every provider and model. Sent as-is to upstream; an
              empty prompt injects nothing.
            </p>
          </div>
        )}
        {/* PXPIPE hidden from UI — experimental, not exposed to users yet */}
        {false && (
          <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 flex-wrap">
                <p className="font-medium">
                  Compress prompts as images{" "}
                  <a
                    href="https://github.com/teamchong/pxpipe"
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-normal text-primary underline hover:opacity-80"
                  >
                    (PXPIPE)
                  </a>
                </p>
                <span
                  className={`text-xs px-2 py-0.5 rounded ${pxpipeChipClass}`}
                >
                  {pxpipeStatusLabel}
                </span>
                <button
                  type="button"
                  onClick={() => pxpipe.setShowPxpipeModal(true)}
                  className="text-xs text-primary underline hover:opacity-80"
                >
                  {pxpipe.pxpipeStatus.installed ? "Manage" : "Setup"}
                </button>
                <a
                  href="/dashboard/pxpipe"
                  className="text-xs text-primary underline hover:opacity-80"
                >
                  Dashboard
                </a>
              </div>
              <p className="text-sm text-text-muted mt-1">
                Transforms large textual context into optimized images before
                sending to the LLM. Ideal for huge prompts, tool outputs and
                long conversations.
              </p>
            </div>
            <Toggle
              checked={pxpipe.pxpipeEnabled}
              disabled={!pxpipe.pxpipeStatus.installed}
              onChange={() => pxpipe.handlePxpipeEnabled(!pxpipe.pxpipeEnabled)}
            />
          </div>
        )}
      </Card>

      <HeadroomSetupModal
        isOpen={headroom.showHeadroomInstallModal}
        onClose={() => headroom.setShowHeadroomInstallModal(false)}
        headroomRunning={headroomRunning}
        headroomStatusLabel={headroomStatusLabel}
        headroomUrl={headroom.headroomUrl}
        setHeadroomUrl={headroom.setHeadroomUrl}
        handleHeadroomUrlBlur={headroom.handleHeadroomUrlBlur}
        headroomManaged={headroomManaged}
        handleHeadroomStop={headroom.handleHeadroomStop}
        headroomActionLoading={headroom.headroomActionLoading}
        headroomCanStart={headroomCanStart}
        handleHeadroomStart={headroom.handleHeadroomStart}
        headroomLocalUrl={headroomLocalUrl}
        headroomStatus={headroom.headroomStatus}
        copy={copy}
        copied={copied}
        headroomActionError={headroom.headroomActionError}
        refreshHeadroomStatus={headroom.refreshHeadroomStatus}
      />

      <PxpipeSetupModal
        isOpen={pxpipe.showPxpipeModal}
        onClose={() => pxpipe.setShowPxpipeModal(false)}
        pxpipeStatus={pxpipe.pxpipeStatus}
        pxpipeStatusLabel={pxpipeStatusLabel}
        pxpipeHealthy={pxpipeHealthy}
        pxpipeHealth={pxpipe.pxpipeHealth}
        pxpipeAction={pxpipe.pxpipeAction}
        pxpipeActionLoading={pxpipe.pxpipeActionLoading}
        pxpipeActionError={pxpipe.pxpipeActionError}
        pxpipeMinChars={pxpipe.pxpipeMinChars}
        setPxpipeMinChars={pxpipe.setPxpipeMinChars}
        handlePxpipeMinCharsBlur={pxpipe.handlePxpipeMinCharsBlur}
        refreshPxpipeStatus={pxpipe.refreshPxpipeStatus}
        runPxpipeHealth={pxpipe.runPxpipeHealth}
      />

      <ConfirmModal
        isOpen={!!headroom.extrasConfirm}
        onClose={() => headroom.setExtrasConfirm(null)}
        onConfirm={() => {
          const fn = headroom.extrasConfirm?.onConfirm;
          headroom.setExtrasConfirm(null);
          fn?.();
        }}
        title={headroom.extrasConfirm?.title}
        message={headroom.extrasConfirm?.message}
        confirmText={headroom.extrasConfirm?.confirmText}
        variant={headroom.extrasConfirm?.variant}
      />
    </div>
  );
}