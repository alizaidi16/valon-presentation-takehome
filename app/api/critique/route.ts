import { NextResponse } from "next/server";
import { MissingApiKeyError } from "@/lib/ai/client";
import { critiqueSlide, type CritiqueSlideInput } from "@/lib/ai/critique";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CritiqueSlideInput;
    const result = await critiqueSlide(body);

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const message =
      error instanceof Error ? error.message : "Something went wrong while critiquing.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
