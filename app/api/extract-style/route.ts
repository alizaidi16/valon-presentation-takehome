import { NextResponse } from "next/server";
import { MissingApiKeyError } from "@/lib/ai/client";
import { extractStyle, type ExtractStyleInput } from "@/lib/ai/extract-style";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ExtractStyleInput;
    const result = await extractStyle(body);

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const message =
      error instanceof Error ? error.message : "Something went wrong while extracting style.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
