import { NextResponse } from "next/server";
import {
  deleteApiKey,
  getApiKeyById,
  updateApiKey,
  evaluateApiKeyLimitState,
  buildApiKeyLimitPresentation,
} from "@/lib/localDb";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";

function validateAllowlist(body, fieldName) {
  if (!Object.prototype.hasOwnProperty.call(body, fieldName)) return null;
  const value = body[fieldName];
  if (value == null) return null;
  if (!Array.isArray(value)) return `${fieldName} must be an array of strings`;
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    return `${fieldName} must contain only non-empty strings`;
  }
  return null;
}

function parseLimit(body) {
  if (body.limitEnabled !== true) return null;
  return {
    metricType: body.metricType,
    periodType: body.periodType,
    limitValue: body.limitValue,
  };
}

function validateLimit(body) {
  if (body.limitEnabled !== true) return null;
  if (!body.metricType) return "Metric type is required";
  if (!body.periodType) return "Period type is required";
  if (
    body.limitValue === undefined ||
    body.limitValue === null ||
    body.limitValue === ""
  ) {
    return "Limit value is required";
  }
  return null;
}

async function decorateKey(key) {
  return buildApiKeyLimitPresentation(key, await evaluateApiKeyLimitState(key));
}

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key: await decorateKey(key) });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, name, access } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const limitError = validateLimit(body);
    if (limitError) {
      return NextResponse.json({ error: limitError }, { status: 400 });
    }
    const allowlistError =
      validateAllowlist(body, "allowedProviders") ||
      validateAllowlist(body, "allowedModels");
    if (allowlistError) {
      return NextResponse.json({ error: allowlistError }, { status: 400 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (typeof name === "string" && name.trim()) updateData.name = name.trim();
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.access = checked.value;
    }
    if (
      Object.prototype.hasOwnProperty.call(body, "limitEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "metricType") ||
      Object.prototype.hasOwnProperty.call(body, "periodType") ||
      Object.prototype.hasOwnProperty.call(body, "limitValue")
    ) {
      updateData.limit = parseLimit(body);
    }
    if (Object.prototype.hasOwnProperty.call(body, "allowedProviders")) {
      updateData.allowedProviders = body.allowedProviders;
    }
    if (Object.prototype.hasOwnProperty.call(body, "allowedModels")) {
      updateData.allowedModels = body.allowedModels;
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: await decorateKey(updated) });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update key" },
      { status: 500 },
    );
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json(
      { error: "Failed to delete key" },
      { status: 500 },
    );
  }
}
