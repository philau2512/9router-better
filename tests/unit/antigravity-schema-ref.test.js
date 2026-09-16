import { describe, expect, it } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/helpers/geminiHelper.js";
import { cleanJSONSchemaForAntigravity as cleanGeminiFormat } from "../../open-sse/translator/formats/gemini.js";

describe("cleanJSONSchemaForAntigravity $ref dereferencing and type protection", () => {
  it("dereferences internal $ref pointers targeting sibling properties", () => {
    const schema = {
      type: "object",
      properties: {
        current_step: {
          type: "string",
          minLength: 1,
          description: "Current step description",
        },
        completed_subtitle: {
          $ref: "#/properties/current_step",
          description: "Summary subtitle",
        },
        final_summary: {
          $ref: "#/properties/current_step",
          description: "Final summary text",
        },
      },
      required: ["current_step"],
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));

    expect(cleaned.properties.completed_subtitle.type).toBe("string");
    expect(cleaned.properties.completed_subtitle.description).toBe("Summary subtitle");
    expect(cleaned.properties.completed_subtitle.$ref).toBeUndefined();
    expect(cleaned.properties.completed_subtitle.minLength).toBeUndefined();

    expect(cleaned.properties.final_summary.type).toBe("string");
    expect(cleaned.properties.final_summary.description).toBe("Final summary text");
    expect(cleaned.properties.final_summary.$ref).toBeUndefined();

    expect(cleaned.properties.current_step.type).toBe("string");
    expect(cleaned.properties.current_step.minLength).toBeUndefined();
  });

  it("dereferences $defs / definitions pointers", () => {
    const schema = {
      type: "object",
      $defs: {
        ItemDetail: {
          type: "object",
          properties: {
            id: { type: "string" },
            count: { type: "integer" },
          },
          required: ["id"],
        },
      },
      properties: {
        item: {
          $ref: "#/$defs/ItemDetail",
        },
      },
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));

    expect(cleaned.$defs).toBeUndefined();
    expect(cleaned.properties.item.type).toBe("object");
    expect(cleaned.properties.item.properties.id.type).toBe("string");
    expect(cleaned.properties.item.properties.count.type).toBe("integer");
    expect(cleaned.properties.item.required).toEqual(["id"]);
  });

  it("ensures fallback type for properties completely missing type", () => {
    const schema = {
      type: "object",
      properties: {
        untypedText: {
          description: "Only description provided",
        },
        untypedNested: {
          properties: {
            child: { type: "string" },
          },
        },
      },
    };

    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));

    expect(cleaned.properties.untypedText.type).toBe("string");
    expect(cleaned.properties.untypedNested.type).toBe("object");
  });

  it("formats/gemini.js also handles $ref resolution identically", () => {
    const schema = {
      type: "object",
      properties: {
        base_param: {
          type: "string",
        },
        alias_param: {
          $ref: "#/properties/base_param",
          description: "Alias param",
        },
      },
    };

    const cleaned = cleanGeminiFormat(structuredClone(schema));
    expect(cleaned.properties.alias_param.type).toBe("string");
    expect(cleaned.properties.alias_param.description).toBe("Alias param");
  });

  it("normalizeGeminiContents does not merge functionResponse turns with user follow-up text and preserves alternating roles", async () => {
    const { normalizeGeminiContents } = await import("../../open-sse/translator/formats/gemini.js");
    const contents = [
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "Write",
              response: { result: "ok" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            text: "tiếp tục đi bạn",
          },
        ],
      },
    ];

    const normalized = normalizeGeminiContents(contents);
    expect(normalized).toHaveLength(3);
    expect(normalized[0].role).toBe("user");
    expect(normalized[0].parts[0].functionResponse).toBeDefined();
    expect(normalized[1].role).toBe("model");
    expect(normalized[2].role).toBe("user");
    expect(normalized[2].parts[0].text).toBe("tiếp tục đi bạn");
  });
});

