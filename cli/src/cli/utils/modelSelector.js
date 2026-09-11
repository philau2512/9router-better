const api = require("../api/client");
const { prompt } = require("./input");
const { clearScreen } = require("./display");

// Provider alias order: OAuth first, then API Key (matches ModelSelectModal)
const PROVIDER_ALIAS_ORDER = [
  "cc",
  "ag",
  "cx",
  "if",
  "qw",
  "gc",
  "gh",
  "kr",
  "openrouter",
  "glm",
  "kimi",
  "minimax",
  "openai",
  "anthropic",
  "gemini",
  "mimo",
  "xmtp",
  "mmf",
];

// Alias to display name mapping
const PROVIDER_ALIAS_NAMES = {
  cc: "Claude Code",
  ag: "Antigravity",
  cx: "OpenAI Codex",
  if: "iFlow AI",
  qw: "Qwen Code",
  gc: "Gemini CLI",
  gh: "GitHub Copilot",
  kr: "Kiro AI",
  openrouter: "OpenRouter",
  glm: "GLM Coding",
  kimi: "Kimi Coding",
  minimax: "Minimax Coding",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  mimo: "Xiaomi MiMo",
  xmtp: "Xiaomi MiMo (Token Plan)",
  mmf: "MiMo Code Free",
};

/**
 * Get all available models grouped by provider + combos
 * @returns {Promise<{combos: Array, groups: Object}>}
 */
async function getAvailableModelsGrouped() {
  const result = await api.getAvailableModels();
  if (!result.success) return { combos: [], groups: {} };

  const models = result.data?.data || [];
  const combos = [];
  const groups = {};

  models.forEach((m) => {
    if (m.owned_by === "combo") {
      combos.push(m.id);
    } else {
      const provider = m.owned_by;
      if (!groups[provider]) {
        groups[provider] = [];
      }
      groups[provider].push(m.id);
    }
  });

  return { combos, groups };
}

/**
 * Display model list and prompt for selection with provider grouping & search
 * @param {string} title - Title to display
 * @param {string} currentValue - Current selected value (optional)
 * @param {Object} options - { excludeCombos?: boolean }
 * @returns {Promise<string|null>} Selected model ID or null if cancelled
 */
async function selectModelFromList(title, currentValue = "", options = {}) {
  const { excludeCombos = false } = options;
  const { combos: rawCombos, groups } = await getAvailableModelsGrouped();
  const combos = excludeCombos ? [] : rawCombos;
  const allModelsList = [...combos, ...Object.values(groups).flat()];

  if (allModelsList.length === 0) return null;

  const categories = [];
  if (combos.length > 0) {
    categories.push({ id: "combos", name: "[Combos]", models: combos });
  }

  const sortedProviders = Object.keys(groups).sort((a, b) => {
    const idxA = PROVIDER_ALIAS_ORDER.indexOf(a);
    const idxB = PROVIDER_ALIAS_ORDER.indexOf(b);
    return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
  });

  sortedProviders.forEach((provider) => {
    categories.push({
      id: provider,
      name: PROVIDER_ALIAS_NAMES[provider] || provider,
      models: groups[provider],
    });
  });

  let filterQuery = null;

  while (true) {
    clearScreen();
    console.log(`\n🎯 ${title}`);
    console.log("=".repeat(50));
    if (currentValue) console.log(`Current: ${currentValue}\n`);
    else console.log();

    if (filterQuery !== null) {
      const q = filterQuery.toLowerCase().trim();
      const matched = allModelsList.filter((m) => m.toLowerCase().includes(q));
      console.log(`🔍 Search results for "${filterQuery}": (${matched.length} found)\n`);
      if (matched.length === 0) {
        console.log("  No matching models found.\n  0. ← Back to providers\n  s. Search again\n");
        const act = await prompt("Select option: ");
        if (act.toLowerCase() === "s") {
          const newQ = await prompt("Enter search keyword: ");
          filterQuery = newQ.trim() || null;
        } else filterQuery = null;
        continue;
      }
      matched.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
      console.log("\n  0. ← Back to providers\n  s. Search again\n");
      const input = await prompt("Enter number to select (or 0/s): ");
      if (input.toLowerCase() === "s") {
        const newQ = await prompt("Enter search keyword: ");
        filterQuery = newQ.trim() || null;
        continue;
      }
      const num = parseInt(input, 10);
      if (num > 0 && num <= matched.length) return matched[num - 1];
      filterQuery = null;
      continue;
    }

    if (categories.length === 1) {
      const category = categories[0];
      console.log(`[${category.name}]`);
      category.models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
      console.log("\n  s. 🔍 Search models\n  m. ✍️  Enter custom model ID\n  0. Cancel\n");
      const input = await prompt("Enter choice (number / s / m / 0): ");
      const trimmed = input.trim();
      if (!trimmed || trimmed === "0") return null;
      if (trimmed.toLowerCase() === "s") {
        const q = await prompt("Enter search keyword: ");
        filterQuery = q.trim() || null;
        continue;
      }
      if (trimmed.toLowerCase() === "m") {
        const customModel = await prompt("Enter custom model ID: ");
        if (customModel.trim()) return customModel.trim();
        continue;
      }
      const num = parseInt(trimmed, 10);
      if (num > 0 && num <= category.models.length) return category.models[num - 1];
      filterQuery = trimmed;
      continue;
    }

    console.log("[Providers & Groups]");
    categories.forEach((cat, i) => console.log(`  ${i + 1}. ${cat.name} (${cat.models.length} models)`));
    console.log("\n  s. 🔍 Search models\n  m. ✍️  Enter custom model ID\n  0. Cancel\n");
    const input = await prompt("Enter choice (number / keyword / s / m): ");
    const trimmed = input.trim();
    if (!trimmed || trimmed === "0") return null;
    if (trimmed.toLowerCase() === "s") {
      const q = await prompt("Enter search keyword: ");
      filterQuery = q.trim() || null;
      continue;
    }
    if (trimmed.toLowerCase() === "m") {
      const customModel = await prompt("Enter custom model ID: ");
      if (customModel.trim()) return customModel.trim();
      continue;
    }

    const num = parseInt(trimmed, 10);
    if (num > 0 && num <= categories.length) {
      const category = categories[num - 1];
      while (true) {
        clearScreen();
        console.log(`\n🎯 ${title} > ${category.name}`);
        console.log("=".repeat(50));
        if (currentValue) console.log(`Current: ${currentValue}\n`);
        category.models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
        console.log("\n  0. ← Back\n");
        const modelChoice = await prompt("Enter number to select (0 to back): ");
        const modelNum = parseInt(modelChoice, 10);
        if (modelNum > 0 && modelNum <= category.models.length) return category.models[modelNum - 1];
        if (modelNum === 0 || Number.isNaN(modelNum)) break;
      }
      continue;
    }
    filterQuery = trimmed;
  }
}

module.exports = {
  selectModelFromList,
  getAvailableModelsGrouped,
  PROVIDER_ALIAS_ORDER,
  PROVIDER_ALIAS_NAMES,
};
