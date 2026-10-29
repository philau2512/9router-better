import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const oldGuidance = "This is the only time you will see this key. Store it securely.";
const guidance = "Store this key securely. You can view or copy it later from the API Keys list.";
const readSafe = (relPath) => {
  try {
    return readFileSync(new URL(relPath, import.meta.url), "utf-8");
  } catch {
    return "";
  }
};

const source = [
  readSafe("../../src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js"),
  readSafe("../../src/app/(dashboard)/dashboard/endpoint/components/ApiKeyModals.js"),
  readSafe("../../src/app/(dashboard)/dashboard/endpoint/components/ApiKeysCard.js"),
].join("\n");

describe("API key visibility guidance source verification", () => {
  it("explains that created keys remain available in the API Keys list", () => {
    const modal = source.match(/title="API Key Created"[\s\S]*?<\/Modal>/)?.[0];
    expect(modal).toBeDefined();
    expect(modal).toContain(guidance);
    expect(modal).not.toContain(oldGuidance);
  });

  it("retains the list's reveal and copy controls", () => {
    expect(source).toContain("visibleKeys.has(key.id) ? key.key : maskKey(key.key)");
    expect(
      source.includes("onClick={() => toggleKeyVisibility(key.id)}") ||
      source.includes("onClick={() => onToggleVisibility(key.id)}")
    ).toBe(true);
    expect(
      source.includes("onClick={() => copy(key.key, key.id)}") ||
      source.includes("onClick={() => onCopy(key.key, key.id)}")
    ).toBe(true);
  });

  it.each(["fa", "id", "km", "pt-BR", "th", "zh-CN"])(
    "updates the existing %s translation without retaining the one-time claim",
    (locale) => {
      const translations = JSON.parse(readFileSync(
        new URL(`../../public/i18n/literals/${locale}.json`, import.meta.url),
        "utf-8"
      ));
      expect(translations).not.toHaveProperty(oldGuidance);
      expect(translations[guidance]).toEqual(expect.any(String));
      expect(translations[guidance].trim()).not.toBe("");
      expect(translations[guidance]).not.toBe(guidance);
    }
  );
});
