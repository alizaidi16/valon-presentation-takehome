import { NextResponse } from "next/server";
import { MissingApiKeyError } from "@/lib/ai/client";
import { generateSlide, type GenerateSlideInput } from "@/lib/ai/generate-slide";

/**
 * Thin HTTP adapter. All business logic lives in lib/ai/generate-slide.ts.
 * This file's only jobs: parse the request body, dispatch, and shape the response.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as GenerateSlideInput;
    const result = await generateSlide(body);

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const message =
      error instanceof Error ? error.message : "Something went wrong while generating.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
