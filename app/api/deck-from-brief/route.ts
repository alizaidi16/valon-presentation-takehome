import { NextResponse } from "next/server";
import { MissingApiKeyError } from "@/lib/ai/client";
import { generateOutline, type GenerateOutlineInput } from "@/lib/ai/generate-outline";

/**
 * Thin HTTP adapter. All business logic lives in lib/ai/generate-outline.ts.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as GenerateOutlineInput;
    const result = await generateOutline(body);

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const message =
      error instanceof Error
        ? error.message
        : "Something went wrong while generating the outline.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
