// Gemini helper functions for translator

// Unsupported JSON Schema constraints that should be removed for Antigravity
export const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  // Basic constraints (not supported by Gemini API)
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "format",
  // Claude rejects these in VALIDATED mode
  "default",
  "multipleOf", // strip before sending to Gemini/Antigravity — causes HTTP 400 (PR #2317)
  "examples",
  // JSON Schema meta keywords
  "$schema",
  "$defs",
  "definitions",
  "const",
  "$ref",
  "$comment",
  // Object validation keywords (not supported)
  "additionalProperties",
  "propertyNames",
  "patternProperties",
  "enumDescriptions",
  // Complex schema keywords (handled by flattenAnyOfOneOf/mergeAllOf)
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  // Dependency keywords (not supported)
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
  // Annotation keywords (rejected by Gemini/Antigravity - e.g. MCP tool schemas set these)
  // Upstream fix from open-sse commits 319caa2d7, 3d20a4ccd
  "deprecated",
  "readOnly",
  "writeOnly",
  // Other unsupported keywords
  "title",
  "optional",
  "if",
  "then",
  "else",
  "contentMediaType",
  "contentEncoding",
  // UI/Styling properties (from Cursor tools - NOT JSON Schema standard)
  "cornerRadius",
  "fillColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "gap",
  "padding",
  "strokeColor",
  "strokeThickness",
  "textColor",
];

// Default safety settings
export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
];

// Convert OpenAI content to Gemini parts
export function convertOpenAIContentToParts(content) {
  const parts = [];

  if (typeof content === "string") {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "text") {
        parts.push({ text: item.text });
      } else if (
        item.type === "image_url" &&
        item.image_url?.url?.startsWith("data:")
      ) {
        const url = item.image_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex); // skip "data:"
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];

          parts.push({
            inlineData: { mime_type: mimeType, data: data },
          });
        }
      } else if (
        item.type === "image_url" &&
        item.image_url?.url &&
        (item.image_url.url.startsWith("http://") ||
          item.image_url.url.startsWith("https://"))
      ) {
        parts.push({
          fileData: { fileUri: item.image_url.url, mimeType: "image/*" },
        });
      } else if (item.type === "input_audio" && item.input_audio?.data) {
        const format = item.input_audio.format || "wav";
        const mimeType = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
        parts.push({
          inlineData: { mime_type: mimeType, data: item.input_audio.data },
        });
      } else if (
        item.type === "audio_url" &&
        item.audio_url?.url?.startsWith("data:")
      ) {
        const url = item.audio_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex);
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];
          parts.push({
            inlineData: { mime_type: mimeType, data: data },
          });
        }
      }
    }
  }

  return parts;
}

// Extract text content from OpenAI content
export function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

// Try parse JSON safely
export function tryParseJSON(str) {
  if (typeof str !== "string") return str;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// Generate request ID
export function generateRequestId() {
  return `agent-${crypto.randomUUID()}`;
}

// Generate session ID (binary-compatible format: UUID + timestamp)
export function generateSessionId() {
  return crypto.randomUUID() + Date.now().toString();
}

// Generate project ID (deterministic if seed provided, e.g. connectionId or email)
export function generateProjectId(seed = "") {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  if (seed) {
    const hash = crypto.createHash("sha256").update(String(seed)).digest("hex");
    const num1 = parseInt(hash.slice(0, 4), 16);
    const num2 = parseInt(hash.slice(4, 8), 16);
    const adj = adjectives[num1 % adjectives.length];
    const noun = nouns[num2 % nouns.length];
    return `${adj}-${noun}-${hash.slice(8, 13)}`;
  }
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

// Helper: Remove unsupported keywords recursively from object/array
// Also strips all vendor extension fields (x- prefixed) not supported by Gemini
function removeUnsupportedKeywords(obj, keywords) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      removeUnsupportedKeywords(item, keywords);
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    if (keywords.includes(key) || key.startsWith("x-")) {
      delete obj[key];
      continue;
    }

    const value = obj[key];
    if (value && typeof value === "object") {
      removeUnsupportedKeywords(value, keywords);
    }
  }
}

// Convert const to enum
function convertConstToEnum(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.const !== undefined && !obj.enum) {
    obj.enum = [obj.const];
    delete obj.const;
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      convertConstToEnum(value);
    }
  }
}

// Convert enum values to strings (Gemini requires string enum values + explicit type:"string")
function convertEnumValuesToStrings(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.enum && Array.isArray(obj.enum)) {
    obj.enum = obj.enum.map((v) => String(v));
    // Gemini API requires type:"string" when enum is present — without it returns 400
    if (!obj.type) {
      obj.type = "string";
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      convertEnumValuesToStrings(value);
    }
  }
}

// Merge allOf schemas
function mergeAllOf(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.allOf && Array.isArray(obj.allOf)) {
    const merged = {};

    for (const item of obj.allOf) {
      if (item.properties) {
        if (!merged.properties) merged.properties = {};
        Object.assign(merged.properties, item.properties);
      }
      if (item.required && Array.isArray(item.required)) {
        if (!merged.required) merged.required = [];
        for (const req of item.required) {
          if (!merged.required.includes(req)) {
            merged.required.push(req);
          }
        }
      }
    }

    delete obj.allOf;
    if (merged.properties)
      obj.properties = { ...obj.properties, ...merged.properties };
    if (merged.required)
      obj.required = [...(obj.required || []), ...merged.required];
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      mergeAllOf(value);
    }
  }
}

// Select best schema from anyOf/oneOf
function selectBest(items) {
  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;
    const type = item.type;

    if (type === "object" || item.properties) {
      score = 3;
    } else if (type === "array" || item.items) {
      score = 2;
    } else if (type && type !== "null") {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// Flatten anyOf/oneOf
function flattenAnyOfOneOf(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.anyOf && Array.isArray(obj.anyOf) && obj.anyOf.length > 0) {
    const nonNullSchemas = obj.anyOf.filter((s) => s && s.type !== "null");
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      const selected = nonNullSchemas[bestIdx];
      delete obj.anyOf;
      Object.assign(obj, selected);
    }
  }

  if (obj.oneOf && Array.isArray(obj.oneOf) && obj.oneOf.length > 0) {
    const nonNullSchemas = obj.oneOf.filter((s) => s && s.type !== "null");
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      const selected = nonNullSchemas[bestIdx];
      delete obj.oneOf;
      Object.assign(obj, selected);
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      flattenAnyOfOneOf(value);
    }
  }
}

// Flatten type arrays
function flattenTypeArrays(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.type && Array.isArray(obj.type)) {
    const nonNullTypes = obj.type.filter((t) => t !== "null");
    obj.type = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      flattenTypeArrays(value);
    }
  }
}

// Dereference internal $ref pointers in JSON Schema (e.g. #/properties/foo, #/$defs/bar, #/definitions/baz)
function resolveJsonPointer(root, pointer) {
  if (!pointer || typeof pointer !== "string") return null;
  if (!pointer.startsWith("#/")) return null;
  const parts = pointer
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let curr = root;
  for (const part of parts) {
    if (curr && typeof curr === "object" && part in curr) {
      curr = curr[part];
    } else {
      return null;
    }
  }
  return curr;
}

function dereferenceSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  function resolveRefs(obj, root, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 10) return;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item && typeof item === "object") {
          resolveRefs(item, root, depth + 1);
        }
      }
      return;
    }

    if (typeof obj.$ref === "string") {
      const target = resolveJsonPointer(root, obj.$ref);
      if (target && typeof target === "object") {
        const resolvedTarget = structuredClone(target);
        resolveRefs(resolvedTarget, root, depth + 1);
        const { $ref, ...currentOverrides } = obj;
        delete obj.$ref;
        Object.assign(obj, resolvedTarget, currentOverrides);
      }
    }

    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === "object") {
        resolveRefs(val, root, depth + 1);
      }
    }
  }

  resolveRefs(schema, schema);
  return schema;
}

// Convert draft 2020-12 prefixItems to items
function convertPrefixItems(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.prefixItems && Array.isArray(obj.prefixItems)) {
    if (!obj.items) {
      obj.items = obj.prefixItems[0] || { type: "string" };
    }
    delete obj.prefixItems;
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      convertPrefixItems(value);
    }
  }
}

// Gemini requires items on every type:"array" schema — fill a permissive placeholder
function ensureArrayItems(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.type === "array" && !obj.items) {
    obj.items = { type: "string" };
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") ensureArrayItems(v);
  }
}

// Ensure all schema properties and array items have a valid type field (Gemini 400 rejection prevention)
function ensurePropertyTypes(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      ensurePropertyTypes(item);
    }
    return;
  }

  if (obj.properties && typeof obj.properties === "object") {
    if (!obj.type) obj.type = "object";
    for (const propVal of Object.values(obj.properties)) {
      if (propVal && typeof propVal === "object") {
        if (!propVal.type) {
          if (propVal.properties) {
            propVal.type = "object";
          } else if (propVal.items) {
            propVal.type = "array";
          } else if (propVal.enum) {
            propVal.type = "string";
          } else {
            propVal.type = "string";
          }
        }
        ensurePropertyTypes(propVal);
      }
    }
  }

  if (obj.items && typeof obj.items === "object") {
    if (!obj.type) obj.type = "array";
    if (!obj.items.type && !Array.isArray(obj.items)) {
      if (obj.items.properties) {
        obj.items.type = "object";
      } else if (obj.items.items) {
        obj.items.type = "array";
      } else if (obj.items.enum) {
        obj.items.type = "string";
      } else {
        obj.items.type = "string";
      }
    }
    ensurePropertyTypes(obj.items);
  }

  for (const [k, v] of Object.entries(obj)) {
    if (k !== "properties" && k !== "items" && v && typeof v === "object") {
      ensurePropertyTypes(v);
    }
  }
}

// Infer missing type=object when properties exist (Gemini requires explicit type)
function ensureObjectType(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.properties && !obj.type) obj.type = "object";
  for (const v of Object.values(obj))
    if (v && typeof v === "object") ensureObjectType(v);
}

// Clean JSON Schema for Antigravity API compatibility - removes unsupported keywords recursively
export function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object") return schema;

  // Mutate directly (schema is only used once per request)
  let cleaned = schema;

  // Phase 0: Resolve internal $ref pointers before $defs/definitions/$ref are stripped
  dereferenceSchema(cleaned);

  // Phase 1: Convert and prepare
  convertConstToEnum(cleaned);
  convertEnumValuesToStrings(cleaned);

  // Phase 2: Flatten complex structures
  mergeAllOf(cleaned);
  convertPrefixItems(cleaned);
  flattenAnyOfOneOf(cleaned);
  flattenTypeArrays(cleaned);

  // Phase 2.5: Infer missing type=object / type=array when properties/items exist
  ensureObjectType(cleaned);
  ensureArrayItems(cleaned);
  ensurePropertyTypes(cleaned);

  // Phase 3: Remove all unsupported keywords at ALL levels (including inside arrays)
  removeUnsupportedKeywords(cleaned, UNSUPPORTED_SCHEMA_CONSTRAINTS);

  // Phase 4: Cleanup required fields recursively
  function cleanupRequired(obj) {
    if (!obj || typeof obj !== "object") return;

    if (obj.required && Array.isArray(obj.required) && obj.properties) {
      const validRequired = obj.required.filter((field) =>
        Object.prototype.hasOwnProperty.call(obj.properties, field),
      );
      if (validRequired.length === 0) {
        delete obj.required;
      } else {
        obj.required = validRequired;
      }
    }

    // Recurse into nested objects
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        cleanupRequired(value);
      }
    }
  }

  cleanupRequired(cleaned);

  // Phase 4.5: Re-verify all property types after keyword stripping
  ensurePropertyTypes(cleaned);

  // Phase 5: Add placeholder for empty object schemas (Antigravity requirement)
  function addPlaceholders(obj) {
    if (!obj || typeof obj !== "object") return;

    // Empty schema {} (no type, no properties) after $ref removal — treat as object with placeholder
    if (Object.keys(obj).length === 0) {
      obj.type = "object";
      obj.properties = {
        reason: {
          type: "string",
          description: "Brief explanation of why you are calling this tool",
        },
      };
      obj.required = ["reason"];
      return;
    }

    if (obj.type === "object") {
      if (!obj.properties || Object.keys(obj.properties).length === 0) {
        obj.properties = {
          reason: {
            type: "string",
            description: "Brief explanation of why you are calling this tool",
          },
        };
        obj.required = ["reason"];
      }
    }

    // Recurse into nested objects
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        addPlaceholders(value);
      }
    }
  }

  addPlaceholders(cleaned);

  return cleaned;
}

// Recursively replace reserved "$ref" keys in function response data to avoid
// Gemini Protobuf parser rejecting unresolved display_name references (HTTP 400).
export function sanitizeFunctionResponseData(data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeFunctionResponseData(item));
  }
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    const safeKey = key === "$ref" ? "_ref" : key;
    result[safeKey] = sanitizeFunctionResponseData(value);
  }
  return result;
}
