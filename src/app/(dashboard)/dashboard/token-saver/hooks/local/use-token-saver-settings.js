import { useState, useEffect, useCallback } from "react";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import {
  WENYAN_LOCALES,
  CAVEMAN_LEVELS,
} from "../../../endpoint/endpointConstants";

export function useTokenSaverSettings(patchSetting, callbacks = {}) {
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [ponytailEnabled, setPonytailEnabled] = useState(false);
  const [ponytailLevel, setPonytailLevel] = useState("full");
  const [locale, setLocale] = useState(() => getCurrentLocale() || "en");

  useEffect(() => {
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  const isWenyanLocale = WENYAN_LOCALES.includes(locale);
  const visibleCavemanLevels = isWenyanLocale
    ? CAVEMAN_LEVELS
    : CAVEMAN_LEVELS.filter((lvl) => !lvl.wenyan);

  useEffect(() => {
    const current = CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel);
    if (current?.wenyan && !isWenyanLocale) {
      queueMicrotask(() => {
        setCavemanLevel("ultra");
        patchSetting({ cavemanLevel: "ultra" });
      });
    }
  }, [isWenyanLocale, cavemanLevel, patchSetting]);

  const handleRtkEnabled = useCallback(async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: value }),
      });
      if (res.ok) setRtkEnabledState(value);
    } catch (error) {
      console.log("Error updating rtkEnabled:", error);
    }
  }, []);

  const handleCavemanEnabled = useCallback((value) => {
    setCavemanEnabled(value);
    patchSetting({ cavemanEnabled: value });
  }, [patchSetting]);

  const handleCavemanLevel = useCallback((level) => {
    setCavemanLevel(level);
    patchSetting({ cavemanLevel: level });
  }, [patchSetting]);

  const handlePonytailEnabled = useCallback((value) => {
    setPonytailEnabled(value);
    patchSetting({ ponytailEnabled: value });
  }, [patchSetting]);

  const handlePonytailLevel = useCallback((level) => {
    setPonytailLevel(level);
    patchSetting({ ponytailLevel: level });
  }, [patchSetting]);

  const [customPromptEnabled, setCustomPromptEnabled] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");

  const handleCustomPromptEnabled = useCallback((value) => {
    setCustomPromptEnabled(value);
    patchSetting({ customPromptEnabled: value });
  }, [patchSetting]);

  const handleCustomPromptBlur = useCallback(() => {
    patchSetting({ customPrompt });
  }, [customPrompt, patchSetting]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setRtkEnabledState(data.rtkEnabled !== false);
          setCavemanEnabled(!!data.cavemanEnabled);
          setCavemanLevel(data.cavemanLevel || "full");
          setPonytailEnabled(!!data.ponytailEnabled);
          setPonytailLevel(data.ponytailLevel || "full");
          setCustomPromptEnabled(!!data.customPromptEnabled);
          setCustomPrompt(data.customPrompt || "");

          if (callbacks.setHeadroomEnabled) callbacks.setHeadroomEnabled(!!data.headroomEnabled);
          if (callbacks.setHeadroomUrl) callbacks.setHeadroomUrl(data.headroomUrl || "http://localhost:8787");
          if (callbacks.setCodeAware) callbacks.setCodeAware(data.headroomCodeAware === true);
          if (callbacks.setKompress) callbacks.setKompress(data.headroomKompress !== false);
          if (callbacks.setPxpipeEnabled) callbacks.setPxpipeEnabled(!!data.pxpipeEnabled);
          if (typeof data.pxpipeMinChars === "number" && callbacks.setPxpipeMinChars) {
            callbacks.setPxpipeMinChars(data.pxpipeMinChars);
          }

          if (callbacks.refreshHeadroomStatus) callbacks.refreshHeadroomStatus();
          if (callbacks.refreshPxpipeStatus && callbacks.runPxpipeHealth) {
            callbacks.refreshPxpipeStatus().then(callbacks.runPxpipeHealth);
          }
        }
      } catch {}
    };
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    rtkEnabled,
    cavemanEnabled,
    cavemanLevel,
    ponytailEnabled,
    ponytailLevel,
    customPromptEnabled,
    customPrompt,
    setCustomPrompt,
    handleCustomPromptEnabled,
    handleCustomPromptBlur,
    locale,
    isWenyanLocale,
    visibleCavemanLevels,
    patchSetting,
    handleRtkEnabled,
    handleCavemanEnabled,
    handleCavemanLevel,
    handlePonytailEnabled,
    handlePonytailLevel,
  };
}